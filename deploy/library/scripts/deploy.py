#!/usr/bin/env python3
"""Add the private library services to an existing tenant's Docker Swarm stack."""

import argparse
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess


def run(command, *, data=None, env=None):
    result = subprocess.run(command, input=data, text=True, capture_output=True, env=env)
    if result.returncode:
        # Docker may echo an interpolated secret; never include its output here.
        raise RuntimeError(f"Command failed ({result.returncode}): {command[0]} {command[1]}")
    return result.stdout.strip()


def exists(kind, name):
    return subprocess.run(
        ["docker", kind, "inspect", name], capture_output=True
    ).returncode == 0


def private_value(path, factory):
    if path.exists():
        if path.is_symlink() or path.stat().st_mode & 0o077:
            raise RuntimeError(f"Recovery secret must be a private regular file: {path}")
        value = path.read_text(encoding="utf-8").strip()
        if not value:
            raise RuntimeError(f"Recovery secret must not be empty: {path}")
        return value
    value = factory()
    with os.fdopen(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "w") as stream:
        stream.write(value + "\n")
    return value


def deployment_defaults(path):
    if not path.exists():
        return {}
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        key, separator, value = line.partition("=")
        if separator and key in ("GATEWAY_HOST", "ORIGIN_HOST", "CERT_RESOLVER", "PROXY_NETWORK"):
            values[key] = value.strip()
    return values


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant", required=True)
    parser.add_argument("--image", required=True, help="Built library image pinned by sha256 digest")
    parser.add_argument("--docling-secret", required=True, help="Existing tenant-specific Docker secret")
    parser.add_argument("--broker-secret", required=True, help="Existing folder-scoped Drive broker secret")
    parser.add_argument("--docling-url", help="Defaults to http://docling-<tenant>:5001")
    parser.add_argument("--broker-url", default="http://cmkia-drive-broker:8090")
    parser.add_argument("--proxy-network")
    parser.add_argument("--public-host", help="Defaults to GATEWAY_HOST in the tenant deployment.env")
    parser.add_argument("--origin-host", help="Optional proxy origin hostname, in addition to the public hostname")
    parser.add_argument("--cert-resolver")
    parser.add_argument("--enable-gliner", action="store_true", help="Queue optional biomedical entity enrichment after conversion")
    parser.add_argument("--root", type=Path, default=Path("/opt/openclaw/clients"))
    parser.add_argument("--prepare-only", action="store_true", help="Prepare resources without starting services")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,30}[a-z0-9]|[a-z]", args.tenant):
        parser.error("tenant must be a lowercase DNS slug, at most 32 characters")
    if not re.fullmatch(r"[^\s]+@sha256:[0-9a-f]{64}", args.image):
        parser.error("image must be pinned with @sha256:<64 hex digits>")
    defaults = deployment_defaults(args.root / args.tenant / "deployment.env")
    public_host = args.public_host or defaults.get("GATEWAY_HOST")
    origin_host = args.origin_host or defaults.get("ORIGIN_HOST")
    if not public_host:
        parser.error("set --public-host or GATEWAY_HOST in the tenant deployment.env")
    for hostname in (public_host, origin_host):
        if hostname is None:
            continue
        if not hostname or not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", hostname) or ".." in hostname:
            parser.error("public/origin hosts must be lowercase DNS names, without scheme or path")
    args.proxy_network = args.proxy_network or defaults.get("PROXY_NETWORK", "traefik-proxy")
    cert_resolver = args.cert_resolver or defaults.get("CERT_RESOLVER", "letsencrypt")
    host_rule = f"Host(`{public_host}`)"
    if origin_host and origin_host != public_host:
        host_rule += f" || Host(`{origin_host}`)"
    if not hasattr(os, "geteuid") or os.geteuid() != 0:
        parser.error("run on the Linux Docker Swarm manager as root")
    if run(["docker", "info", "--format", "{{.Swarm.ControlAvailable}}"]) != "true":
        parser.error("Docker must be a Swarm manager")
    stack = f"openclaw-{args.tenant}"
    if not exists("service", f"{stack}_gateway"):
        parser.error("the tenant Gateway must already exist")
    for name in (args.docling_secret, args.broker_secret):
        if not exists("secret", name):
            parser.error(f"required Docker secret does not exist: {name}")
    run(["docker", "network", "inspect", args.proxy_network])
    directory = args.root / args.tenant / "library"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if directory.is_symlink() or directory.stat().st_mode & 0o077:
        parser.error("library operator directory must be private (0700)")
    os.umask(0o077)
    for suffix, filename in (
        ("db-password", "database-password.secret"),
        ("database-url", "database-url.secret"),
        ("api-key", "api-key.secret"),
    ):
        if exists("secret", f"{stack}-library-{suffix}-v1") and not (directory / filename).exists():
            parser.error(f"existing secret requires its original recovery file: {directory / filename}")
    password = private_value(directory / "database-password.secret", lambda: secrets.token_urlsafe(36))
    values = {
        "db-password": password,
        "database-url": private_value(
            directory / "database-url.secret",
            lambda: f"postgresql://library:{password}@{stack}_library-db:5432/library",
        ),
        "api-key": private_value(directory / "api-key.secret", lambda: secrets.token_urlsafe(36)),
    }
    for suffix, value in values.items():
        name = f"{stack}-library-{suffix}-v1"
        if not exists("secret", name):
            run(["docker", "secret", "create", name, "-"], data=value)
    for suffix in ("postgres", "data", "models"):
        run(["docker", "volume", "create", f"{stack}-library-{suffix}"])
    network = f"{stack}-library-private"
    if not exists("network", network):
        run(["docker", "network", "create", "--driver", "overlay", "--internal", network])
    environment = {
        "TENANT": args.tenant,
        "NODE_HOSTNAME": socket.gethostname(),
        "LIBRARY_IMAGE": args.image,
        "DOCLING_SECRET": args.docling_secret,
        "DOCLING_URL": args.docling_url or f"http://docling-{args.tenant}:5001",
        "DRIVE_BROKER_SECRET": args.broker_secret,
        "DRIVE_BROKER_URL": args.broker_url,
        "PROXY_NETWORK": args.proxy_network,
        "LIBRARY_PUBLIC_BASE_URL": f"https://{public_host}/library",
        "LIBRARY_HOST_RULE": host_rule,
        "CERT_RESOLVER": cert_resolver,
        "GLINER_ENABLED": "true" if args.enable_gliner else "false",
    }
    source = Path(__file__).resolve().parent.parent / "stack.yaml"
    environment_path = directory / "deployment.json"
    if environment_path.exists():
        previous = environment_path.read_bytes()
        backup = directory / "deployment.previous.json"
        backup.write_bytes(previous)
        backup.chmod(0o600)
    environment_path.write_text(json.dumps(environment, indent=2) + "\n", encoding="utf-8")
    env = {**os.environ, **environment}
    rendered = run(["docker", "stack", "config", "-c", str(source)], env=env)
    rendered_path = directory / "stack.yaml"
    if rendered_path.exists():
        (directory / "stack.previous.yaml").write_bytes(rendered_path.read_bytes())
    rendered_path.write_text(rendered + "\n", encoding="utf-8")
    if args.prepare_only:
        print(f"Prepared {stack} library resources; no services started.")
        return
    run(["docker", "stack", "deploy", "--resolve-image", "always", "-c", str(rendered_path), stack], env=env)
    print(f"Submitted library services to {stack}; check health and MCP before declaring completion.")


if __name__ == "__main__":
    main()
