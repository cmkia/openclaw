#!/usr/bin/env python3
"""Install the private presentation capability in an existing Swarm tenant."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import uuid


AUTH_EXPORT = 'export PRESENTATIONS_MCP_AUTHORIZATION="Bearer $(cat /run/secrets/presentations_api_key)"'
KEY_LABEL = "cmkia.presentations.key-sha256"


def run(command, *, data=None, env=None, timeout=900):
    result = subprocess.run(command, input=data, text=True, capture_output=True, env=env, timeout=timeout)
    if result.returncode:
        # Docker/native CLI output can contain operator configuration or credentials.
        raise RuntimeError(f"{command[0]} {command[1]} failed ({result.returncode}); inspect the private operator backup and service status")
    return result.stdout.strip()


def inspect(kind, name, optional=False):
    result = subprocess.run(["docker", kind, "inspect", name], text=True, capture_output=True)
    if result.returncode:
        if optional and any(marker in result.stderr.lower() for marker in ("no such", "not found", "notfound")):
            return None
        raise RuntimeError(f"Cannot inspect Docker {kind} {name}")
    return json.loads(result.stdout)[0]


def private_directory(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or not path.is_dir() or path.stat().st_mode & 0o077:
        raise RuntimeError(f"Operator directory must be a private regular directory (0700): {path}")


def save(path, value):
    if path.is_symlink():
        raise RuntimeError(f"Refusing an operator artifact symlink: {path}")
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
        stream.write(value)
    os.replace(temporary, path)


def json_save(path, value):
    save(path, json.dumps(value, indent=2) + "\n")


def host_path(container_path, mounts):
    destination = PurePosixPath(container_path)
    if not destination.is_absolute() or ".." in destination.parts:
        raise RuntimeError("Gateway container paths must be absolute and normalized")
    matching = []
    for mount in mounts:
        target = PurePosixPath(mount["Target"])
        if destination == target or target in destination.parents:
            matching.append((len(target.parts), target, mount))
    if not matching:
        raise RuntimeError(f"No Gateway mount owns {container_path}; configure a supported persistent workspace")
    _, target, mount = max(matching, key=lambda entry: entry[0])
    if mount["Type"] == "volume":
        base = Path(inspect("volume", mount["Source"])["Mountpoint"])
    elif mount["Type"] == "bind":
        base = Path(mount["Source"])
    else:
        raise RuntimeError("Gateway persistence must use a Docker volume or host bind")
    resolved = (base / str(destination.relative_to(target))).resolve(strict=True)
    if not resolved.is_relative_to(base.resolve(strict=True)):
        raise RuntimeError("Gateway persistent path resolves outside its owning mount")
    return resolved


def patched_arguments(container):
    command, arguments = container.get("Command", []), container.get("Args", [])
    if command != ["/bin/sh", "-ec"] or len(arguments) != 1:
        raise RuntimeError("Unsupported Gateway command; expected /bin/sh -ec with one maintained shell argument")
    script = arguments[0]
    if AUTH_EXPORT in script:
        return command, arguments
    if "PRESENTATIONS_MCP_AUTHORIZATION" in script:
        raise RuntimeError("Gateway has an unknown presentation authorization export; reconcile it before deployment")
    marker = re.search(r"(?m)^([ \t]*)exec node dist/index\.js gateway(?:[ \t]|$)", script)
    if not marker:
        raise RuntimeError("Gateway command has no canonical node Gateway exec; no command was changed")
    updated = script[:marker.start()] + marker.group(1) + AUTH_EXPORT + "\n" + script[marker.start():]
    return command, [updated]


def install_skill(source, workspace, backup):
    if not (source / "SKILL.md").is_file() or any(item.is_symlink() for item in source.rglob("*")):
        raise RuntimeError("The source skill must be a complete bundle without symlinks")
    skill_root = workspace / "skills"
    if not skill_root.exists():
        skill_root.mkdir(mode=0o755)
        os.chown(skill_root, 1000, 1000)
        skill_root.chmod(0o755)
    if skill_root.is_symlink() or skill_root.resolve().parent != workspace:
        raise RuntimeError("Workspace skills must be a regular directory inside the tenant workspace")
    destination = skill_root / "apresentacoes-erika"
    if destination.is_symlink() or (destination.exists() and not destination.is_dir()):
        raise RuntimeError("Existing presentation skill is not a regular directory")
    staged = workspace / f".presentations-skill-{uuid.uuid4().hex}"
    old = workspace / f".presentations-previous-{uuid.uuid4().hex}"
    shutil.copytree(source, staged)
    for item in [staged, *staged.rglob("*")]:
        os.chown(item, 1000, 1000)
        item.chmod(0o755 if item.is_dir() else 0o644)
    had_previous = destination.exists()
    if had_previous:
        shutil.copytree(destination, backup / "skill", symlinks=True)
        destination.rename(old)
    try:
        staged.rename(destination)
    except BaseException:
        if had_previous:
            old.rename(destination)
        raise
    if had_previous:
        # The exact prior directory is backed up; never remove sibling skills or assets.
        shutil.rmtree(old)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant", required=True)
    parser.add_argument("--image", required=True, help="Renderer image pinned as repository@sha256:digest")
    parser.add_argument("--root", type=Path, default=Path("/opt/openclaw/clients"))
    parser.add_argument("--cli-helper", type=Path, help="Defaults to ROOT/cli.sh")
    parser.add_argument("--connect", action="store_true", help="Attach the Gateway and register its presentation MCP")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?", args.tenant):
        parser.error("tenant must be a lowercase DNS slug of at most 32 characters")
    if not re.fullmatch(r"[^\s]+@sha256:[a-f0-9]{64}", args.image):
        parser.error("image must be pinned by its complete sha256 digest")
    if not hasattr(os, "geteuid") or os.geteuid() != 0:
        parser.error("run as root on the existing tenant's Linux Swarm manager")
    os.umask(0o077)
    info = json.loads(run(["docker", "info", "--format", "{{json .}}" ]))
    if not info.get("Swarm", {}).get("ControlAvailable"):
        parser.error("Docker must be a Swarm manager")
    stack = f"openclaw-{args.tenant}"
    gateway_name = f"{stack}_gateway"
    gateway = inspect("service", gateway_name)
    task = gateway["Spec"]["TaskTemplate"]
    container = task["ContainerSpec"]
    environment = dict(item.split("=", 1) for item in container.get("Env", []) if "=" in item)
    workspace_container = environment.get("OPENCLAW_WORKSPACE_DIR", "/home/node/.openclaw/workspace")
    workspace = host_path(workspace_container, container.get("Mounts", []))
    if not workspace.is_dir():
        parser.error("the Gateway workspace must already exist")
    # Resolving a local volume on a different node would bind the wrong data.
    running = run(["docker", "ps", "--filter", f"label=com.docker.swarm.service.name={gateway_name}", "--format", "{{.ID}}"])
    if len(running.splitlines()) != 1:
        parser.error("exactly one running tenant Gateway must be on this manager node")
    config_path = host_path(environment.get("OPENCLAW_CONFIG_PATH", "/home/node/.openclaw/openclaw.json"), container.get("Mounts", []))
    config = json.loads(config_path.read_text(encoding="utf-8"))
    expected = {
        "transport": "streamable-http", "url": f"http://openclaw-{args.tenant}-presentations:8080/mcp",
        "headers": {"Authorization": "${PRESENTATIONS_MCP_AUTHORIZATION}"},
        "requestTimeoutMs": 600000, "connectionTimeoutMs": 30000,
        "toolFilter": {"include": ["presentations_*"]},
    }
    previous = config.get("mcp", {}).get("servers", {}).get("presentations")
    if args.connect and previous and previous.get("url") != expected["url"]:
        parser.error("a different presentations MCP exists; reconcile its owner before connecting")
    cli_helper = (args.cli_helper or args.root / "cli.sh").resolve(strict=True)
    if args.connect:
        patched_arguments(container)
        if "PRESENTATIONS_MCP_AUTHORIZATION" not in cli_helper.read_text(encoding="utf-8"):
            parser.error("update the canonical CLI helper to export the mounted presentation secret first")
    directory = args.root / args.tenant / "presentations"
    private_directory(directory)
    backup = directory / ("backup-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:8])
    private_directory(backup)
    json_save(backup / "gateway-service.json", gateway)
    save(backup / "openclaw-config.json", config_path.read_text(encoding="utf-8"))
    if (directory / "deployment.json").exists():
        save(backup / "deployment.json", (directory / "deployment.json").read_text(encoding="utf-8"))

    secret_name = f"{stack}-presentations-api-key-v1"
    secret = inspect("secret", secret_name, optional=True)
    key_path = directory / "api-key.secret"
    if secret and not key_path.exists():
        parser.error("existing presentation secret requires its original api-key.secret recovery file")
    if key_path.exists():
        if key_path.is_symlink() or not key_path.is_file() or key_path.stat().st_mode & 0o077:
            parser.error("api-key.secret must be a private regular file (0600)")
        key = key_path.read_text(encoding="utf-8").strip()
        if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", key):
            parser.error("recovery secret is empty or has an unsupported format")
    else:
        key = secrets.token_urlsafe(48)
        save(key_path, key + "\n")
    fingerprint = hashlib.sha256(key.encode()).hexdigest()
    if secret:
        if secret["Spec"].get("Labels", {}).get(KEY_LABEL) != fingerprint:
            parser.error("Docker secret fingerprint does not match its recovery file; no secret was replaced")
    else:
        run(["docker", "secret", "create", "--label", f"{KEY_LABEL}={fingerprint}", secret_name, "-"], data=key)

    network_name = f"{stack}-presentations-private"
    network = inspect("network", network_name, optional=True)
    if network and (network.get("Driver") != "overlay" or not network.get("Internal") or network.get("Scope") != "swarm"):
        parser.error("existing presentations network must be an internal Swarm overlay")
    if not network:
        run(["docker", "network", "create", "--driver", "overlay", "--internal", "--attachable", network_name])
        network = inspect("network", network_name)
    source = Path(__file__).resolve().parent
    install_skill(source / "skill" / "apresentacoes-erika", workspace, backup)
    deploy_environment = {
        "TENANT": args.tenant, "NODE_HOSTNAME": info["Name"], "PRESENTATIONS_IMAGE": args.image,
        "PRESENTATIONS_WORKSPACE_BIND": str(workspace), "PRESENTATIONS_NETWORK": network_name,
    }
    rendered = run(["docker", "stack", "config", "-c", str(source / "stack.yaml")], env={**os.environ, **deploy_environment})
    save(directory / "stack.yaml", rendered + "\n")
    run(["docker", "stack", "deploy", "--resolve-image", "always", "-c", str(directory / "stack.yaml"), stack])
    record = {**deploy_environment, "secret": secret_name, "installed_at": datetime.now(timezone.utc).isoformat(), "connection_requested": args.connect, "backup": str(backup)}
    json_save(directory / "deployment.json", record)
    if not args.connect:
        print(f"Installed private presentations service and skill for {args.tenant}; Gateway unchanged. Use --connect to attach it, then test the live tools.")
        return

    # Re-read current state after service deployment; never replace the Gateway's unrelated state.
    gateway = inspect("service", gateway_name)
    task = gateway["Spec"]["TaskTemplate"]
    container = task["ContainerSpec"]
    command, arguments = patched_arguments(container)
    network_entries = task.get("Networks", [])
    attached = any(item["Target"] in (network_name, network["Id"]) for item in network_entries)
    mounts = container.get("Secrets", [])
    mounted = [item for item in mounts if item.get("File", {}).get("Name") == "presentations_api_key"]
    if mounted and (len(mounted) != 1 or mounted[0]["SecretID"] != inspect("secret", secret_name)["ID"]):
        raise RuntimeError("Gateway presentation secret mount belongs to another secret; reconcile before connection")
    # Compose merges this one addition into the canonical base and other tenant
    # overrides. Repeating existing networks under new keys duplicates endpoints.
    private_entry = next((entry for entry in network_entries if entry["Target"] in (network_name, network["Id"])), {})
    override_networks = {"presentations_private": {"aliases": private_entry["Aliases"]} if private_entry.get("Aliases") else {}}
    network_definitions = {"presentations_private": {"external": True, "name": network_name}}
    json_save(directory / "gateway.override.yaml", {
        "version": "3.8", "services": {"gateway": {
            "entrypoint": command, "command": [item.replace("$", "$$") for item in arguments],
            "networks": override_networks,
            "secrets": [{"source": "presentations_api_key", "target": "presentations_api_key", "uid": "1000", "gid": "1000", "mode": 256}],
        }}, "networks": network_definitions,
        "secrets": {"presentations_api_key": {"external": True, "name": secret_name}},
    })
    update = ["docker", "service", "update", "--detach=false"]
    if not attached:
        update += ["--network-add", network_name]
    if not mounted:
        update += ["--secret-add", f"source={secret_name},target=presentations_api_key,uid=1000,gid=1000,mode=0400"]
    if arguments != container.get("Args", []):
        update += ["--args", shlex.join(arguments)]
    if len(update) > 4:
        run([*update, gateway_name], timeout=900)
    current_config = json.loads(config_path.read_text(encoding="utf-8"))
    current = current_config.get("mcp", {}).get("servers", {}).get("presentations")
    if current and current.get("url") != expected["url"]:
        raise RuntimeError("A different presentations MCP already exists; preserve it and reconcile its owner before registration")
    cli = ["sh", str(cli_helper), args.tenant, "mcp"]
    if current is None:
        run([*cli, "add", "presentations", "--transport", "streamable-http", "--url", expected["url"],
             "--header", "Authorization=${PRESENTATIONS_MCP_AUTHORIZATION}", "--no-probe", "--timeout", "600",
             "--connect-timeout", "30", "--include", "presentations_*"])
    elif current != expected:
        run([*cli, "set", "presentations", json.dumps(expected)])
    after = json.loads(config_path.read_text(encoding="utf-8"))
    previous_others = {key: value for key, value in current_config.get("mcp", {}).get("servers", {}).items() if key != "presentations"}
    after_others = {key: value for key, value in after.get("mcp", {}).get("servers", {}).items() if key != "presentations"}
    if previous_others != after_others or after.get("mcp", {}).get("servers", {}).get("presentations") != expected:
        raise RuntimeError("Native MCP registration did not match the intended isolated change; inspect the private backup before recovery")
    record["connected"] = True
    record["connected_at"] = datetime.now(timezone.utc).isoformat()
    json_save(directory / "deployment.json", record)
    print(f"Connected the presentation capability for {args.tenant}; verify live MCP tools, render output, and file delivery before declaring completion.")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, OSError, subprocess.SubprocessError) as error:
        print(f"Presentation deployment stopped: {error}", file=sys.stderr)
        sys.exit(1)
