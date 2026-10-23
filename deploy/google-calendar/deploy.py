#!/usr/bin/env python3
"""Install the native gog Calendar CLI and workspace skill for an existing tenant."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import subprocess
import uuid

import yaml


OWNER = "google-calendar-gog"
TARGET = "/home/node/.config/gogcli"
PASSWORD_EXPORT = ('if [ -r /run/secrets/calendar_keyring_password ]; then\n'
                   '  export GOG_KEYRING_PASSWORD="$(cat /run/secrets/calendar_keyring_password)"\nfi\n')


def run(args, *, optional=False):
    result = subprocess.run(args, text=True, capture_output=True)
    if result.returncode:
        if optional:
            return None
        # Docker diagnostics may contain live credentials or rendered commands.
        raise RuntimeError(f"Command failed: {args[0]} {args[1]}; inspect the protected Calendar deployment")
    return result.stdout.strip()


def private_write(path, content, *, replace=False):
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp") if replace else path
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write(content)
        if replace:
            os.replace(temporary, path)
    finally:
        if replace and temporary.exists():
            temporary.unlink()


def workspace_for(prefix):
    container = json.loads(run(["docker", "service", "inspect", f"{prefix}_gateway"]))[0]["Spec"]["TaskTemplate"]["ContainerSpec"]
    environment = dict(value.split("=", 1) for value in container.get("Env", []) if "=" in value)
    workspace = PurePosixPath(environment.get("OPENCLAW_WORKSPACE_DIR", "/home/node/.openclaw/workspace"))
    if not workspace.is_absolute() or ".." in workspace.parts:
        raise RuntimeError("Gateway workspace must be an absolute normalized path")
    matches = [(PurePosixPath(mount["Target"]), mount) for mount in container.get("Mounts", [])
               if workspace == PurePosixPath(mount["Target"]) or PurePosixPath(mount["Target"]) in workspace.parents]
    if not matches:
        raise RuntimeError("Gateway workspace requires a persistent writable mount")
    target, mount = max(matches, key=lambda item: len(item[0].parts))
    if mount.get("ReadOnly") or mount["Type"] not in ("bind", "volume"):
        raise RuntimeError("Gateway workspace requires a writable volume or host bind")
    base = Path(run(["docker", "volume", "inspect", mount["Source"], "--format", "{{.Mountpoint}}"])
                if mount["Type"] == "volume" else mount["Source"]).resolve(strict=True)
    resolved = (base / str(workspace.relative_to(target))).resolve(strict=True)
    if not resolved.is_relative_to(base) or not resolved.is_dir():
        raise RuntimeError("Gateway workspace resolves outside its persistent mount")
    running = run(["docker", "ps", "--filter", f"label=com.docker.swarm.service.name={prefix}_gateway", "--format", "{{.ID}}"])
    if len(running.splitlines()) != 1:
        raise RuntimeError("Exactly one tenant Gateway must be running on this manager node")
    return resolved


def skill_destination(workspace):
    directory = workspace
    for component in ("skills", "gog"):
        directory /= component
        if directory.is_symlink() or (directory.exists() and not directory.is_dir()):
            raise RuntimeError("The gog skill destination must use regular directories")
    destination = directory / "SKILL.md"
    if destination.is_symlink() or (destination.exists() and not destination.is_file()):
        raise RuntimeError("Existing gog SKILL.md must be a regular file")
    return destination


def install_skill(destination, content):
    for directory in (destination.parent.parent, destination.parent):
        if not directory.exists():
            directory.mkdir(mode=0o755)
            os.chown(directory, 1000, 1000)
            directory.chmod(0o755)
    temporary = destination.with_name(f".SKILL.md.{uuid.uuid4().hex}.tmp")
    try:
        private_write(temporary, content)
        os.chown(temporary, 1000, 1000)
        temporary.chmod(0o644)
        os.replace(temporary, destination)
    finally:
        if temporary.exists():
            temporary.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant", required=True)
    parser.add_argument("--image", required=True, help="Reviewed derivative Gateway image pinned by digest")
    parser.add_argument("--account", help="Google account email; required on first installation")
    parser.add_argument("--root", type=Path, default=Path("/opt/openclaw/clients"))
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,30}[a-z0-9]|[a-z]", args.tenant):
        parser.error("tenant must be a lowercase DNS slug, at most 32 characters")
    if not re.fullmatch(r"[^\s]+@sha256:[0-9a-f]{64}", args.image):
        parser.error("image requires an immutable @sha256 digest")
    if not hasattr(os, "geteuid") or os.geteuid() != 0:
        parser.error("run as root on the Linux Swarm manager; Python PyYAML is required")
    os.umask(0o077)
    directory = args.root.resolve() / args.tenant
    stack = directory / "stack.yaml"
    calendar = directory / "calendar"
    record_file = calendar / "deployment.json"
    if calendar.is_symlink() or (calendar.exists() and (not calendar.is_dir() or calendar.stat().st_uid != 0
                                                        or calendar.stat().st_mode & 0o077)):
        parser.error("Calendar operator directory must be a root-owned private directory")
    if record_file.is_symlink() or (record_file.exists() and not record_file.is_file()):
        parser.error("Calendar deployment record must be a regular file")
    previous = json.loads(record_file.read_text()) if record_file.exists() else None
    if previous and previous.get("owner") != OWNER:
        parser.error("Calendar deployment record belongs to another owner")
    account = args.account or (previous or {}).get("account")
    if not account or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", account):
        parser.error("provide --account with the Google account email on first installation")
    if previous and account != previous.get("account"):
        parser.error("existing Calendar account differs; reconcile its authorization before changing accounts")
    source = Path(__file__).resolve().parent / "skill/gog/SKILL.md"
    if not stack.is_file() or source.is_symlink() or not source.is_file():
        parser.error("select an existing tenant and copy the complete Calendar deployment including its skill")
    if run(["docker", "info", "--format", "{{.Swarm.ControlAvailable}}"]) != "true":
        parser.error("Docker must be a Swarm manager")
    prefix = f"openclaw-{args.tenant}"
    workspace = workspace_for(prefix)
    destination = skill_destination(workspace)
    original_stack = stack.read_bytes()
    rendered = yaml.safe_load(run(["docker", "stack", "config", "-c", str(stack)]))
    gateway = rendered["services"]["gateway"]
    volume_name, secret_name = f"{prefix}-calendar-auth", f"{prefix}-calendar-keyring-v1"
    expected_environment = {"GOG_HOME": TARGET, "GOG_CONFIG_DIR": TARGET, "GOG_KEYRING_BACKEND": "file",
                            "GOG_ACCOUNT": account, "GOG_CALENDAR_ID": "primary"}
    environment = gateway.get("environment", {})
    if not isinstance(environment, dict):
        raise RuntimeError("Rendered Gateway environment must be a mapping")
    if previous and environment.get("GOG_HOME") != TARGET:
        raise RuntimeError("Existing config-only gog data must be preserved and reconciled before replacing the Gateway. "
                           "Keep its current container running until its native auth data is secured.")
    for key, value in environment.items():
        if key.startswith("GOG_") and (not previous or expected_environment.get(key) != value):
            raise RuntimeError("Existing gog environment has another owner or incompatible configuration")
    volume = {"type": "volume", "source": "calendar-auth", "target": TARGET, "volume": {"nocopy": True}}
    secret = {"source": "calendar_keyring_password", "target": "calendar_keyring_password",
              "uid": "1000", "gid": "1000", "mode": 0o400}
    for kind, expected in (("volumes", volume), ("secrets", secret)):
        entries = gateway.setdefault(kind, [])
        matches = [entry for entry in entries if entry.get("target") == expected["target"]
                   or entry.get("source") == expected["source"]]
        if matches and (not previous or matches != [expected]):
            raise RuntimeError(f"Gateway Calendar {kind} conflict with another owner")
        if not matches:
            entries.append(expected)
    for kind, name, definition in (("volumes", "calendar-auth", {"external": True, "name": volume_name}),
                                   ("secrets", "calendar_keyring_password", {"external": True, "name": secret_name})):
        resources = rendered.setdefault(kind, {})
        if name in resources and (not previous or resources[name] != definition):
            raise RuntimeError(f"Calendar {kind} name is already configured by another owner")
        resources[name] = definition
    command = gateway.get("command")
    if not isinstance(command, list) or len(command) != 1 or not isinstance(command[0], str):
        raise RuntimeError("Gateway must retain its standard shell command")
    if "GOG_KEYRING_PASSWORD" in command[0]:
        if not previous or command[0].count(PASSWORD_EXPORT) != 1:
            raise RuntimeError("Gateway keyring password export has another owner")
    else:
        anchor = "exec node dist/index.js gateway"
        if command[0].count(anchor) != 1:
            raise RuntimeError("Gateway command must contain one standard final exec")
        command[0] = command[0].replace(anchor, PASSWORD_EXPORT + anchor)
    gateway["image"] = args.image
    gateway["environment"] = {**environment, **expected_environment}
    key_file = calendar / "keyring.secret"
    if key_file.is_symlink() or (key_file.exists() and (not key_file.is_file() or key_file.stat().st_uid != 0
                                                      or key_file.stat().st_mode & 0o077)):
        parser.error("keyring.secret must be a root-owned regular private file")
    existing_secret = run(["docker", "secret", "inspect", secret_name], optional=True)
    if existing_secret and not key_file.exists():
        raise RuntimeError("Calendar keyring secret has no protected password file; reconcile before proceeding")
    if existing_secret and not previous:
        raise RuntimeError("Calendar Docker secret exists without this owner's deployment record")
    existing_volume = run(["docker", "volume", "inspect", volume_name], optional=True)
    labels = {"openclaw.tenant": args.tenant, "openclaw.capability": OWNER}
    if existing_volume:
        actual = json.loads(existing_volume)[0].get("Labels") or {}
        if any(actual.get(key) != value for key, value in labels.items()):
            raise RuntimeError("Calendar auth volume belongs to another owner")
    run(["docker", "pull", args.image])
    calendar.mkdir(mode=0o700, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    backup = args.root.resolve().parent / "backups" / args.tenant / f"before-calendar-{stamp}"
    backup.mkdir(parents=True, mode=0o700)
    private_write(backup / "stack.yaml", original_stack)
    if record_file.exists():
        private_write(backup / "deployment.json", record_file.read_bytes())
    if destination.exists():
        private_write(backup / "SKILL.md", destination.read_bytes())
    record = {"owner": OWNER, "tenant": args.tenant, "image": args.image, "account": account,
              "volume": volume_name, "keyring_secret": secret_name, "backup": str(backup), "phase": "prepared"}

    def checkpoint(phase):
        record["phase"] = phase
        private_write(record_file, (json.dumps(record, indent=2) + "\n").encode(), replace=True)

    checkpoint("prepared")
    candidate = calendar / "candidate-stack.yaml"
    private_write(candidate, yaml.safe_dump(rendered, sort_keys=False).replace("$", "$$").encode(), replace=True)
    run(["docker", "stack", "config", "-c", str(candidate)])
    if not key_file.exists():
        private_write(key_file, secrets.token_urlsafe(48).encode())
    if not key_file.read_bytes().strip():
        raise RuntimeError("Calendar keyring password file is empty; reconcile before proceeding")
    if not existing_secret:
        run(["docker", "secret", "create", secret_name, str(key_file)])
    if not existing_volume:
        run(["docker", "volume", "create", "--label", f"openclaw.tenant={args.tenant}",
             "--label", f"openclaw.capability={OWNER}", volume_name])
    auth = Path(run(["docker", "volume", "inspect", volume_name, "--format", "{{.Mountpoint}}"])).resolve(strict=True)
    os.chown(auth, 1000, 1000)
    auth.chmod(0o700)
    if hashlib.sha256(stack.read_bytes()).digest() != hashlib.sha256(original_stack).digest():
        raise RuntimeError("Canonical stack changed during preparation; reconcile the protected candidate")
    install_skill(destination, source.read_bytes())
    private_write(stack, candidate.read_bytes(), replace=True)
    run(["docker", "stack", "deploy", "--resolve-image", "never", "-c", str(stack), prefix])
    checkpoint("deployed")
    print(json.dumps({"tenant": args.tenant, "phase": "deployed", "backup": str(backup),
                      "authorization": "pending native gog authorization or existing encrypted keyring"}))


if __name__ == "__main__":
    main()
