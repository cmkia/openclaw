#!/usr/bin/env python3
"""Back up a tenant library's PostgreSQL database and original/extracted files."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time


def run(command, *, output=None, timeout=3600):
    result = subprocess.run(command, stdout=output or subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"Command failed ({result.returncode}): {command[0]} {command[1]}")
    return result.stdout.decode().strip() if output is None else None


def inspect_service(service):
    return json.loads(run(["docker", "service", "inspect", service]))[0]


def checksum(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def await_stopped(services):
    # Swarm can report zero desired replicas before the old PID 1 has exited.
    # Quiesce actual writers before combining database and filesystem snapshots.
    deadline = time.monotonic() + 300
    while True:
        running = []
        for service in services:
            ids = run(["docker", "ps", "-q", "--filter",
                       "label=com.docker.swarm.service.name=" + service])
            if ids:
                running.append(service)
        if not running:
            return
        if time.monotonic() >= deadline:
            raise RuntimeError("Library writers did not stop; no coordinated backup taken: " + ", ".join(running))
        time.sleep(2)


def database_snapshot(container):
    """Record bounded comparison facts from the same quiescent database as the dump."""
    tables = ("library_documents", "library_sources", "library_jobs", "library_chunks",
              "library_entities", "library_settings")

    def sql(statement):
        return run(["docker", "exec", container, "psql", "-U", "library", "-d", "library",
                    "-X", "-At", "-v", "ON_ERROR_STOP=1", "-c", statement])

    counts = {table: int(sql("SELECT count(*) FROM " + table)) for table in tables}
    documents = json.loads(sql("""SELECT COALESCE(json_agg(json_build_object(
      'sha256',sha256,'byte_size',byte_size) ORDER BY sha256),'[]'::json) FROM library_documents"""))
    chunks = sql("SELECT id::text || ':' || md5(row_to_json(c)::text) FROM library_chunks c ORDER BY id")
    sources = sql("""SELECT s.source_key || ':' || COALESCE(d.sha256,'') || ':' || s.version || ':' || s.active::text
      FROM library_sources s LEFT JOIN library_documents d ON d.id=s.document_id ORDER BY s.source_key""")
    return {"counts": counts, "documents": documents,
            "chunks_projection_sha256": hashlib.sha256(chunks.encode()).hexdigest(),
            "sources_projection_sha256": hashlib.sha256(sources.encode()).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant", required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--quiesce", action="store_true", required=True,
                        help="Pause only the library API and worker during the coordinated snapshot")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,30}[a-z0-9]|[a-z]", args.tenant):
        parser.error("tenant must be a lowercase DNS slug, at most 32 characters")
    if not hasattr(os, "geteuid") or os.geteuid() != 0:
        parser.error("run as root on the node holding the tenant volumes")
    os.umask(0o077)
    prefix = f"openclaw-{args.tenant}"
    services = [f"{prefix}_library-api", f"{prefix}_library-worker"]
    replicas = {
        name: inspect_service(name)["Spec"]["Mode"]["Replicated"]["Replicas"] for name in services
    }
    database_service = inspect_service(f"{prefix}_library-db")
    db_image = database_service["Spec"]["TaskTemplate"]["ContainerSpec"]["Image"]
    containers = run([
        "docker", "ps", "--filter", f"label=com.docker.swarm.service.name={prefix}_library-db",
        "--format", "{{.ID}}",
    ]).splitlines()
    if len(containers) != 1:
        parser.error("exactly one library database container must run on this node")
    destination = args.destination.resolve()
    if destination.exists():
        parser.error("backup destination must be a new directory")
    destination.mkdir(parents=True, mode=0o700)
    try:
        # stop-first shutdown lets in-flight PostgreSQL/filesystem writes settle.
        run(["docker", "service", "scale", "--detach=false", *[f"{name}=0" for name in services]])
        await_stopped(services)
        dump = destination / "library.dump"
        with dump.open("xb") as stream:
            run(["docker", "exec", containers[0], "pg_dump", "-U", "library", "-d", "library", "-Fc"], output=stream)
        snapshot = database_snapshot(containers[0])
        archive = destination / "library-data.tar.gz"
        with archive.open("xb") as stream:
            run([
                "docker", "run", "--rm", "--network", "none", "--read-only",
                "--mount", f"type=volume,source={prefix}-library-data,target=/data,readonly",
                "--entrypoint", "tar", db_image, "-czf", "-", "-C", "/data", ".",
            ], output=stream)
        manifest = {
            "tenant": args.tenant,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "database_image": db_image,
            "library_image": inspect_service(services[0])["Spec"]["TaskTemplate"]["ContainerSpec"]["Image"],
            "database_snapshot": snapshot,
            "files": {path.name: {"bytes": path.stat().st_size, "sha256": checksum(path)}
                      for path in (dump, archive)},
            "excludes": ["model cache (downloadable)", "OpenClaw state/wiki (separate volume)",
                         "Docker secrets and recovery files (separate protected backup)"],
        }
        (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    finally:
        restore_errors = []
        for name, count in replicas.items():
            try:
                run(["docker", "service", "scale", "--detach=false", f"{name}={count}"])
            except (RuntimeError, subprocess.TimeoutExpired):
                restore_errors.append(name)
        if restore_errors:
            raise RuntimeError("Restore previous replica counts manually for: " + ", ".join(restore_errors))
    print(f"Coordinated library backup written to {destination}; verify restore before relying on it.")


if __name__ == "__main__":
    main()
