#!/usr/bin/env python3
"""Attach a private, read-only Ads MCP adapter to an existing standard tenant."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import time

import yaml


def run(args, *, data=None, env=None):
    result = subprocess.run(args, input=data, text=True, capture_output=True, env=env)
    if result.returncode:
        # CLI/provider diagnostics can contain credentials; retain only command identity.
        raise RuntimeError(f"Command failed: {args[0]} {args[1]}; inspect the protected deployment state")
    return result.stdout.strip()


def write_private(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        output.write(value)


def replace_private(path, value):
    temporary = path.with_name(path.name + ".ads-new")
    write_private(temporary, value)
    os.replace(temporary, path)


def wait_healthy(service):
    deadline = time.monotonic() + 420
    while time.monotonic() < deadline:
        ids = run(["docker", "ps", "--filter", f"label=com.docker.swarm.service.name={service}",
                   "--format", "{{.ID}}"])
        if ids and "\n" not in ids:
            state = json.loads(run(["docker", "inspect", ids]))[0]["State"]
            if state.get("Running") and state.get("Health", {}).get("Status") == "healthy":
                return
        time.sleep(3)
    raise RuntimeError(f"{service} did not become healthy; use the recorded backup for recovery")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant", required=True)
    parser.add_argument("--image", required=True, help="Reviewed adapter image pinned by digest")
    parser.add_argument("--version", required=True, help="New immutable credential secret version")
    parser.add_argument("--root", type=Path, default=Path("/opt/openclaw/clients"))
    parser.add_argument("--credentials-file", type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,30}[a-z0-9]|[a-z]", args.tenant):
        parser.error("tenant must be a lowercase DNS slug, at most 32 characters")
    if not re.fullmatch(r"[a-zA-Z0-9-]{1,40}", args.version):
        parser.error("version must contain only letters, digits and hyphens")
    if not re.fullmatch(r"[^\s]+@sha256:[0-9a-f]{64}", args.image):
        parser.error("image requires an immutable @sha256 digest")
    if not hasattr(os, "geteuid") or os.geteuid() != 0:
        parser.error("run on the Linux Swarm manager as root; Python PyYAML is required")
    os.umask(0o077)
    source = Path(__file__).resolve().parent
    cli = source.parent / "clients/cli.sh"
    directory = args.root.resolve() / args.tenant
    stack = directory / "stack.yaml"
    ads = directory / "ads"
    if not stack.is_file() or not cli.is_file():
        parser.error("copy the complete deploy directory and select an existing standard tenant")
    if run(["docker", "info", "--format", "{{.Swarm.ControlAvailable}}"]) != "true":
        parser.error("Docker must be a Swarm manager")
    prefix = f"openclaw-{args.tenant}"
    mcp_url = f"http://{prefix}-ads:8080/mcp"
    config = Path(run(["docker", "volume", "inspect", f"{prefix}-state",
                       "--format", "{{.Mountpoint}}"])).resolve() / "openclaw.json"
    credentials = (args.credentials_file or ads / "credentials.json").resolve(strict=True)
    if credentials.stat().st_mode & 0o077 or credentials.stat().st_uid != 0:
        parser.error("credentials must be owned by root with mode 0600 or stricter")
    # Docker secret content remains opaque here; the image owns credential admission.
    run(["docker", "pull", args.image])
    ads.mkdir(mode=0o700, exist_ok=True)
    os.chmod(ads, 0o700)
    key_file = ads / "api-key.secret"
    key_secret = f"{prefix}-ads-api-key-v1"
    credential_secret = f"{prefix}-ads-credentials-{args.version}"
    key_exists = subprocess.run(["docker", "secret", "inspect", key_secret], capture_output=True).returncode == 0
    if key_exists and not key_file.exists():
        parser.error("adapter key file/secret disagree; reconcile the previous attempt before proceeding")
    if subprocess.run(["docker", "secret", "inspect", credential_secret], capture_output=True).returncode == 0:
        parser.error("credential secret version already exists; inspect the previous attempt before resuming")
    initial_config = json.loads(config.read_text())
    existing_mcp = initial_config.get("mcp", {}).get("servers", {}).get("ads")
    if existing_mcp and (existing_mcp.get("url") != mcp_url
                         or existing_mcp.get("headers") != {"Authorization": "${ADS_MCP_AUTHORIZATION}"}):
        parser.error("another owner already configures the ads MCP name; refusing to replace it")
    if not key_file.exists():
        write_private(key_file, secrets.token_urlsafe(36))
    # Admission runs without networking, as a one-shot root solely to read 0600 inputs.
    # Runtime uses UID 10001 and Docker secrets instead of these host mounts.
    run(["docker", "run", "--rm", "--network", "none", "--user", "0:0", "--cap-drop", "ALL",
         "--mount", f"type=bind,src={credentials},dst=/inputs/credentials,readonly",
         "--mount", f"type=bind,src={key_file},dst=/inputs/key,readonly",
         "-e", "ADS_CREDENTIALS_FILE=/inputs/credentials", "-e", "ADS_API_KEY_FILE=/inputs/key",
         "--entrypoint", "python", args.image, "-c", "import app; print('Credential admission passed')"])
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = args.root.resolve().parent / "backups" / args.tenant / f"before-ads-{timestamp}"
    backup.mkdir(parents=True, mode=0o700)
    shutil.copy2(stack, backup / "stack.yaml")
    shutil.copy2(config, backup / "openclaw.json")
    deployment_file = ads / "deployment.json"
    if deployment_file.exists():
        shutil.copy2(deployment_file, backup / "ads-deployment.json")
    record = {"tenant": args.tenant, "image": args.image, "api_key_secret": key_secret,
              "credentials_secret": credential_secret, "backup": str(backup), "phase": "prepared"}

    def checkpoint(phase):
        record["phase"] = phase
        replace_private(deployment_file, json.dumps(record, indent=2) + "\n")
        print(f"Ads deployment: {phase}", flush=True)

    checkpoint("prepared")
    environment = {**os.environ, "TENANT": args.tenant, "ADS_IMAGE": args.image,
                   "ADS_API_KEY_SECRET": key_secret, "ADS_CREDENTIALS_SECRET": credential_secret,
                   "NODE_HOSTNAME": socket.gethostname()}
    old = yaml.safe_load(run(["docker", "stack", "config", "-c", str(stack)]))
    previous_ads = old["services"].get("ads")
    if previous_ads and previous_ads.get("deploy", {}).get("labels", {}).get("openclaw.capability") != "ads-reports":
        raise RuntimeError("The existing ads service has a different owner; refusing to replace it")
    merged = yaml.safe_load(run(["docker", "stack", "config", "-c", str(stack),
                                "-c", str(source / "stack.yaml")], env=environment))
    gateway = merged["services"]["gateway"]
    command = gateway["command"]
    if not isinstance(command, list) or len(command) != 1 or not isinstance(command[0], str):
        raise RuntimeError("Gateway command differs from the standard owner; no service was changed")
    if "ADS_MCP_AUTHORIZATION" not in command[0]:
        anchor = "exec node dist/index.js gateway"
        if command[0].count(anchor) != 1:
            raise RuntimeError("Gateway command has no unique standard entry point; no service was changed")
        command[0] = command[0].replace(anchor,
            'if [ -r /run/secrets/ads_api_key ]; then\n'
            '  export ADS_MCP_AUTHORIZATION="Bearer $(cat /run/secrets/ads_api_key)"\n'
            'fi\n' + anchor)
    # Compose merges must preserve every existing service and Gateway secret.
    for name, definition in old["services"].items():
        if name not in ("gateway", "ads") and merged["services"].get(name) != definition:
            raise RuntimeError(f"Unexpected change to existing service {name}; refusing deployment")
    previous_gateway = old["services"]["gateway"]
    # Compose can reorder mounts when merging a service's secret list. Preserve
    # the original order only after comparing every mount's complete definition.
    mounts = gateway.get("volumes", [])
    previous_mounts = previous_gateway.get("volumes", [])
    if sorted(mounts, key=lambda mount: mount["target"]) == sorted(
        previous_mounts, key=lambda mount: mount["target"]
    ):
        gateway["volumes"] = previous_mounts
    if any(secret not in gateway["secrets"] for secret in previous_gateway["secrets"]):
        raise RuntimeError("Compose removed an existing Gateway secret; refusing deployment")
    if {k: v for k, v in gateway.items() if k not in ("command", "secrets")} != {
        k: v for k, v in previous_gateway.items() if k not in ("command", "secrets")
    }:
        raise RuntimeError("Unexpected Gateway settings changed; refusing deployment")
    candidate = ads / "candidate-stack.yaml"
    replace_private(candidate, yaml.safe_dump(merged, sort_keys=False).replace("$", "$$"))
    stack_hash = hashlib.sha256(stack.read_bytes()).hexdigest()
    run(["docker", "stack", "config", "-c", str(candidate)])
    checkpoint("stack-validated")
    if not key_exists:
        run(["docker", "secret", "create", key_secret, str(key_file)])
    run(["docker", "secret", "create", credential_secret, str(credentials)])
    checkpoint("secrets-created")
    run(["docker", "stack", "deploy", "--resolve-image", "never", "-c", str(candidate), prefix])
    checkpoint("services-submitted")
    wait_healthy(f"{prefix}_ads")
    wait_healthy(f"{prefix}_gateway")
    checkpoint("services-healthy")
    patch = {"mcp": {"servers": {"ads": {
        "enabled": True, "transport": "streamable-http", "url": mcp_url,
        "headers": {"Authorization": "${ADS_MCP_AUTHORIZATION}"},
        "connectionTimeoutMs": 10000, "requestTimeoutMs": 240000,
        "toolFilter": {"include": ["ads_*"]},
    }}}}
    run(["sh", str(cli), args.tenant, "config", "patch", "--stdin"], data=json.dumps(patch))
    checkpoint("mcp-configured")
    run(["sh", str(cli), args.tenant, "config", "validate"])
    probe = json.loads(run(["sh", str(cli), args.tenant, "mcp", "probe", "ads", "--json"]))
    replace_private(ads / "mcp-probe.json", json.dumps(probe, indent=2) + "\n")
    if probe.get("diagnostics") or probe.get("servers", {}).get("ads", {}).get("tools") != 3:
        raise RuntimeError("Native MCP discovery did not confirm all three Ads tools; inspect the protected probe")
    if hashlib.sha256(stack.read_bytes()).hexdigest() != stack_hash:
        raise RuntimeError("Canonical stack changed during deployment; reconcile candidate before replacing it")
    replace_private(stack, candidate.read_text())
    checkpoint("complete")
    print(json.dumps({"tenant": args.tenant, "read_only": True, "backup": str(backup),
                      "image": args.image, "operator_directory": str(ads)}))


if __name__ == "__main__":
    main()
