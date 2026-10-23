#!/usr/bin/env python3
"""Authorize only Calendar using native gog and a loopback OAuth callback."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess


def private_file(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_uid != 0 or path.stat().st_mode & 0o077:
        raise RuntimeError("OAuth inputs must be root-owned regular files with mode 0600 or stricter")
    return path.read_bytes()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant", required=True)
    parser.add_argument("--client", required=True, type=Path, help="Protected installed-app OAuth client JSON")
    parser.add_argument("--root", type=Path, default=Path("/opt/openclaw/clients"))
    parser.add_argument("--port", type=int, default=15004)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,30}[a-z0-9]|[a-z]", args.tenant) or not 1024 <= args.port <= 65535:
        parser.error("provide a valid tenant slug and an unprivileged callback port")
    if not hasattr(os, "geteuid") or os.geteuid() != 0:
        parser.error("run as root on the tenant's Swarm manager")
    directory = args.root.resolve() / args.tenant / "calendar"
    record = json.loads(private_file(directory / "deployment.json"))
    prefix = f"openclaw-{args.tenant}"
    if (record.get("owner") != "google-calendar-gog" or record.get("tenant") != args.tenant
            or record.get("phase") != "deployed" or record.get("volume") != f"{prefix}-calendar-auth"
            or not re.fullmatch(r"[^\s]+@sha256:[0-9a-f]{64}", record.get("image", ""))):
        parser.error("complete the Calendar deployment before authorizing its account")
    client = private_file(args.client)
    if not isinstance(json.loads(client).get("installed"), dict):
        parser.error("use a Google installed-app OAuth client with loopback redirects")
    password = private_file(directory / "keyring.secret").strip()
    if not password or b"\n" in password or b"\r" in password:
        parser.error("the protected keyring password must be a nonempty single line")
    helper = Path(__file__).resolve().parent / "auth.sh"
    imported = subprocess.run(["sh", str(helper), args.tenant, "auth", "credentials", "/dev/stdin"],
                              input=client, capture_output=True)
    if imported.returncode:
        raise RuntimeError("Unable to import the OAuth client into the tenant's native gog store")
    # Read the password from stdin inside the temporary container, so neither
    # Docker metadata nor command arguments carry it. Native gog owns PKCE,
    # state validation, token exchange, identity checks and encrypted storage.
    command = ["docker", "run", "--rm", "-i", "--name", f"{prefix}-calendar-consent",
               "--network", "host", "--user", "1000:1000", "--cap-drop", "ALL",
               "--security-opt", "no-new-privileges", "--read-only",
               "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
               "--mount", f"type=volume,src={record['volume']},dst=/home/node/.config/gogcli",
               "-e", "HOME=/home/node", "-e", "GOG_HOME=/home/node/.config/gogcli",
               "-e", "GOG_CONFIG_DIR=/home/node/.config/gogcli",
               "-e", "GOG_KEYRING_BACKEND=file", "--entrypoint", "/bin/sh", record["image"], "-ec",
               'IFS= read -r GOG_KEYRING_PASSWORD; export GOG_KEYRING_PASSWORD; exec gog "$@"', "--",
               "auth", "add", record["account"], "--services", "calendar",
               "--drive-scope", "readonly", "--force-consent",
               "--listen-addr", f"127.0.0.1:{args.port}", "--timeout", "30m"]
    result = subprocess.run(command, input=password + b"\n")
    if result.returncode:
        raise RuntimeError("Google Calendar authorization did not complete; inspect the protected operator output")
    print("Google Calendar authorization stored. Verify a real Calendar request before declaring it connected.")


if __name__ == "__main__":
    main()
