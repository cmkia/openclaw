#!/usr/bin/env python3
"""Initialize a new, isolated OpenClaw tenant on a Docker Swarm manager."""

import argparse
import http.cookiejar
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import urllib.error
import urllib.request


IMAGE = "ghcr.io/openclaw/openclaw:2026.10.5@sha256:f40d1e66fd14d8c5b49c832f4100f83b53fdc01f5108f7db11de38fd0ee6dbe5"


def run(args, *, data=None, env=None):
    result = subprocess.run(args, input=data, text=True, capture_output=True, env=env)
    if result.returncode:
        # Native onboarding output may include credentials; do not echo it.
        raise RuntimeError(f"Command failed ({result.returncode}): {args[0]} {args[1]}")
    return result.stdout.strip()


class OmniRoute:
    def __init__(self, base, password):
        self.base = base.rstrip("/")
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
        )
        self.call("POST", "/api/auth/login", {"password": password})

    def call(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(
            self.base + path, data=data, method=method,
            headers={"Content-Type": "application/json"},
        )
        try:
            with self.opener.open(request, timeout=60) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"OmniRoute {method} {path}: HTTP {error.code}") from None


def private_write(path, text):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        stream.write(text)


def config(args):
    secret = {"source": "env", "provider": "default", "id": "OMNIROUTE_API_KEY"}
    return {
        "gateway": {
            "mode": "local", "bind": "lan",
            "publicOrigin": f"https://{args.host}",
            "trustedProxies": [args.proxy_cidr],
            "auth": {"mode": "token", "token": {
                "source": "env", "provider": "default", "id": "OPENCLAW_GATEWAY_TOKEN"
            }},
            "controlUi": {"allowedOrigins": [f"https://{args.host}"]},
        },
        "mcp": {"apps": {
            "enabled": True, "sandboxPort": 18790,
            "sandboxOrigin": f"https://{args.sandbox_host}",
        }},
        "memory": {"search": {"provider": "none"}},
        "models": {"mode": "merge", "providers": {
            "omniroute": {
                "baseUrl": args.omniroute_url.rstrip("/") + "/v1",
                "apiKey": secret, "api": "openai-responses",
                "models": [{
                    "id": f"oc-{args.tenant}-chat", "name": "Personal assistant",
                    "reasoning": True, "input": ["text", "image"],
                    "contextWindow": 64000, "maxTokens": 8192,
                }],
            },
            "openai": {
                "baseUrl": args.omniroute_url.rstrip("/") + "/v1",
                "apiKey": secret, "api": "openai-responses", "models": [],
            },
        }},
        "agents": {"defaults": {
            "model": {"primary": f"omniroute/oc-{args.tenant}-chat"},
            "mediaModels": {"image": {
                "primary": f"openai/oc-{args.tenant}-image", "timeoutMs": 240000,
            }},
        }},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant", required=True)
    parser.add_argument("--host", required=True)
    parser.add_argument("--sandbox-host", required=True)
    parser.add_argument("--chat-model", required=True, help="OmniRoute provider/model identifier")
    parser.add_argument("--image-model", required=True, help="OmniRoute image backend identifier")
    parser.add_argument("--omniroute-url", required=True)
    parser.add_argument("--proxy-cidr", required=True)
    parser.add_argument("--proxy-network", default="traefik-proxy")
    parser.add_argument("--cert-resolver", default="letsencrypt")
    parser.add_argument("--root", type=Path, default=Path("/opt/openclaw/clients"))
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,30}[a-z0-9]|[a-z]", args.tenant):
        parser.error("tenant must be a lowercase DNS slug, at most 32 characters")
    for host in (args.host, args.sandbox_host):
        if not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", host) or ".." in host:
            parser.error("hosts must be lowercase DNS names, without a scheme or path")
    if args.host == args.sandbox_host:
        parser.error("gateway and sandbox require different origins")
    ipaddress.ip_network(args.proxy_cidr)
    if not args.omniroute_url.startswith("https://"):
        parser.error("OmniRoute requires HTTPS")
    if os.geteuid() != 0:
        parser.error("run on the Linux Swarm manager as root")
    password = os.environ.get("OMNIROUTE_ADMIN_PASSWORD")
    if not password:
        parser.error("set OMNIROUTE_ADMIN_PASSWORD for this invocation")
    if run(["docker", "info", "--format", "{{.Swarm.ControlAvailable}}"]) != "true":
        parser.error("Docker must be a Swarm manager")
    run(["docker", "network", "inspect", args.proxy_network])
    prefix = f"openclaw-{args.tenant}"
    for suffix in ("state", "auth"):
        if subprocess.run(["docker", "volume", "inspect", f"{prefix}-{suffix}"], capture_output=True).returncode == 0:
            parser.error(f"volume {prefix}-{suffix} already exists; refusing to initialize over existing data")
    omni = OmniRoute(args.omniroute_url, password)
    combos = omni.call("GET", "/api/combos")["combos"]
    names = [f"oc-{args.tenant}-chat", f"oc-{args.tenant}-image"]
    if any(combo["name"] in names for combo in combos):
        parser.error("tenant routes already exist; inspect the previous deployment before resuming")
    os.umask(0o077)
    args.root.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory = args.root / args.tenant
    directory.mkdir(mode=0o700)
    record = {"tenant": args.tenant, "combos": []}
    private_write(directory / "provision.json", json.dumps(record, indent=2) + "\n")
    for name, model in zip(names, (args.chat_model, args.image_model)):
        combo = omni.call("POST", "/api/combos", {
            "name": name, "models": [model], "strategy": "priority",
        })
        record["combos"].append({"id": combo["id"], "name": name})
        (directory / "provision.json").write_text(json.dumps(record, indent=2) + "\n")
    key = omni.call("POST", "/api/keys", {
        "name": prefix, "modelAccessMode": "restricted", "allowedModels": [],
        "allowedCombos": names, "scopes": ["self:usage"], "noLog": True,
    })
    record["keyId"] = key["id"]
    (directory / "provision.json").write_text(json.dumps(record, indent=2) + "\n")
    token = secrets.token_hex(32)
    private_write(directory / "gateway.token", token)
    private_write(directory / "omniroute.key", key["key"])
    private_write(directory / "bootstrap.env", f"OPENCLAW_GATEWAY_TOKEN={token}\nOMNIROUTE_API_KEY={key['key']}\n")
    stack_env = {
        "TENANT": args.tenant, "GATEWAY_HOST": args.host, "SANDBOX_HOST": args.sandbox_host,
        "OPENCLAW_IMAGE": IMAGE, "NODE_HOSTNAME": socket.gethostname(),
        "PROXY_NETWORK": args.proxy_network, "CERT_RESOLVER": args.cert_resolver,
    }
    private_write(directory / "deployment.env", "".join(f"{k}={v}\n" for k, v in stack_env.items()))
    shutil.copyfile(Path(__file__).with_name("stack.yaml"), directory / "stack.yaml")
    run(["docker", "pull", IMAGE])
    for suffix in ("state", "auth"):
        run(["docker", "volume", "create", "--label", f"openclaw.tenant={args.tenant}", f"{prefix}-{suffix}"])
    mounts = ["--mount", f"type=volume,src={prefix}-state,dst=/home/node/.openclaw",
              "--mount", f"type=volume,src={prefix}-auth,dst=/home/node/.config/openclaw"]
    run(["docker", "run", "--rm", "--user", "0:0", *mounts, "--entrypoint", "sh", IMAGE,
         "-ec", "chown 1000:1000 /home/node/.openclaw /home/node/.config/openclaw"])
    cli = ["docker", "run", "--rm", "-i", "--user", "1000:1000", *mounts,
           "--env-file", str(directory / "bootstrap.env"), "--entrypoint", "node", IMAGE, "dist/index.js"]
    print("Initializing isolated OpenClaw state...", flush=True)
    run([*cli, "onboard", "--non-interactive", "--accept-risk", "--skip-health", "--mode", "local",
         "--auth-choice", "skip", "--gateway-auth", "token", "--gateway-token-ref-env", "OPENCLAW_GATEWAY_TOKEN",
         "--gateway-bind", "lan", "--skip-channels", "--skip-skills", "--skip-search", "--skip-ui",
         "--skip-hooks", "--no-install-daemon"])
    run([*cli, "config", "patch", "--stdin"], data=json.dumps(config(args)))
    for name, filename in (("gateway-token", "gateway.token"), ("omniroute-key", "omniroute.key")):
        run(["docker", "secret", "create", f"{prefix}-{name}-v1", str(directory / filename)])
    run(["docker", "stack", "deploy", "--resolve-image", "never", "-c", str(directory / "stack.yaml"), prefix],
        env={**os.environ, **stack_env})
    (directory / "bootstrap.env").unlink()
    print(json.dumps({"tenant": args.tenant, "url": f"https://{args.host}",
                      "sandbox": f"https://{args.sandbox_host}", "directory": str(directory),
                      "routes": names, "keyId": key["id"]}, indent=2))


if __name__ == "__main__":
    main()
