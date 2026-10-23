#!/usr/bin/env python3
"""Add private CPU transcription to an existing tenant with native config admission."""

import argparse
import copy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import subprocess
import time
import uuid

import yaml


OWNER = "local-speech"
MODEL = "Systran/faster-whisper-tiny"
MODEL_REVISION = "d90ca5fe260221311c53c58e660288d3deb8d356"
MODEL_SHA256 = "dcb76c6586fc06cbdac6dd21f14cfd129cc4cdd9dce19bf4ffa62e59cbe6e6d1"
SPEECH_IMAGE = ("ghcr.io/speaches-ai/speaches:0.9.0-rc.3-cpu@sha256:"
                "c26e287cbfbd77d7035f80a297f3695f8d33c797c894e4555cc258f5a4a5dd07")
PLUGIN_PATH = "/opt/openclaw/local-whisper"
EXPORT = 'export LOCAL_WHISPER_API_KEY="$(cat /run/secrets/local_speech_api_key)"\n'
ANCHOR = "exec node dist/index.js gateway"
ERROR_LOG = None
HEALTH = ("import json,urllib.request; "
          "j=json.load(urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=5)); "
          "assert j.get('message')=='OK'")
WARM = """import json,urllib.error,urllib.request
key=open('/run/secrets/local_speech_api_key').read().strip()
headers={'Authorization':'Bearer '+key}
request=urllib.request.Request('http://127.0.0.1:8000/api/ps/""" + MODEL + """',data=b'',headers=headers,method='POST')
try:
    response=urllib.request.urlopen(request,timeout=180)
    assert response.status==201
except urllib.error.HTTPError as error:
    if error.code!=409:
        raise
request=urllib.request.Request('http://127.0.0.1:8000/api/ps',headers=headers)
with urllib.request.urlopen(request,timeout=5) as response:
    assert '""" + MODEL + """' in json.load(response).get('models',[])
"""


def run(args, *, data=None, optional=False, timeout=900):
    try:
        result = subprocess.run(args, input=data, text=True, capture_output=True, timeout=timeout)
        if not result.returncode:
            return result.stdout.strip()
        if optional:
            return None
        failure = {"command": " ".join(args[:2]), "returncode": result.returncode,
                   "stdout": result.stdout, "stderr": result.stderr}
    except subprocess.TimeoutExpired as error:
        def decoded(value):
            return value.decode(errors="replace") if isinstance(value, bytes) else value or ""
        failure = {"command": " ".join(args[:2]), "timed_out_seconds": timeout,
                   "stdout": decoded(error.stdout), "stderr": decoded(error.stderr)}
    # Keep potentially expanded credentials only inside root-owned operator storage.
    for key in ("stdout", "stderr"):
        failure[key] = failure[key][-1048576:]
    if ERROR_LOG:
        private_write(ERROR_LOG, json.dumps(failure, indent=2) + "\n", replace=True)
    location = f"; diagnostics retained at {ERROR_LOG}" if ERROR_LOG else ""
    raise RuntimeError(f"Command failed: {args[0]} {args[1]}{location}")


def private_write(path, content, *, replace=False, uid=0, gid=0):
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp") if replace else path
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write(content if isinstance(content, bytes) else content.encode())
        os.chown(temporary, uid, gid)
        if replace:
            os.replace(temporary, path)
    finally:
        if replace and temporary.exists():
            temporary.unlink()


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def private_directory(path):
    if path.is_symlink() or (path.exists() and (not path.is_dir() or path.stat().st_uid != 0
                                               or path.stat().st_mode & 0o077)):
        raise RuntimeError("Operator storage must be a root-owned private directory")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)


def container_id(service):
    value = run(["docker", "ps", "--filter", f"label=com.docker.swarm.service.name={service}",
                 "--format", "{{.ID}}"])
    if not value or "\n" in value:
        raise RuntimeError(f"Exactly one {service} container must be running on this manager")
    return value


def wait_healthy(service, timeout=600, previous_id=None):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        ids = run(["docker", "ps", "--filter", f"label=com.docker.swarm.service.name={service}",
                   "--format", "{{.ID}}"])
        if ids and "\n" not in ids and ids != previous_id:
            current = json.loads(run(["docker", "inspect", ids]))[0]
            desired = json.loads(run(["docker", "service", "inspect", service]))[0]["Spec"]["TaskTemplate"]["ContainerSpec"]
            state = current["State"]
            environment = set(current["Config"].get("Env", []))
            if (state.get("Running") and state.get("Health", {}).get("Status") == "healthy"
                    and current["Config"]["Image"] == desired["Image"]
                    and set(desired.get("Env", [])).issubset(environment)):
                return ids
        time.sleep(3)
    raise RuntimeError(f"{service} did not become healthy; inspect the recorded recovery state")


def host_config(container):
    environment = dict(item.split("=", 1) for item in container.get("Env", []) if "=" in item)
    destination = PurePosixPath(environment.get("OPENCLAW_CONFIG_PATH", "/home/node/.openclaw/openclaw.json"))
    if not destination.is_absolute() or ".." in destination.parts:
        raise RuntimeError("Gateway config must have an absolute normalized path")
    matches = [(PurePosixPath(m["Target"]), m) for m in container.get("Mounts", [])
               if destination == PurePosixPath(m["Target"]) or PurePosixPath(m["Target"]) in destination.parents]
    if not matches:
        raise RuntimeError("Gateway config requires an existing persistent mount")
    target, mount = max(matches, key=lambda item: len(item[0].parts))
    if mount.get("ReadOnly") or mount["Type"] not in ("bind", "volume"):
        raise RuntimeError("Gateway config mount must be writable")
    base = Path(run(["docker", "volume", "inspect", mount["Source"], "--format", "{{.Mountpoint}}"])
                if mount["Type"] == "volume" else mount["Source"]).resolve(strict=True)
    path = base / str(destination.relative_to(target))
    if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(base):
        raise RuntimeError("Gateway config must be a regular file inside its persistent mount")
    return path, destination, environment


def config_patch(config):
    plugins = config.get("plugins", {})
    paths = plugins.get("load", {}).get("paths", [])
    if not isinstance(paths, list) or any(not isinstance(value, str) for value in paths):
        raise RuntimeError("Existing plugin load paths must be a list")
    result = {"load": {"paths": paths if PLUGIN_PATH in paths else [*paths, PLUGIN_PATH]},
              "entries": {"local-whisper": {"enabled": True, "config": {
                  "baseUrl": "http://speech:8000/v1", "model": MODEL, "language": "pt",
                  "apiKey": {"source": "env", "provider": "default", "id": "LOCAL_WHISPER_API_KEY"}}},
                          "voice-call": {"config": {"streaming": {"provider": "local-whisper"}}}}}
    if "allow" in plugins:
        allowed = plugins["allow"]
        if not isinstance(allowed, list):
            raise RuntimeError("Existing plugin allowlist must be a list")
        result["allow"] = allowed if "local-whisper" in allowed else [*allowed, "local-whisper"]
    if "local-whisper" in plugins.get("deny", []):
        raise RuntimeError("Local transcription is explicitly denied; reconcile its policy first")
    return {"plugins": result}


def model_cached(cache):
    model_cache = cache / "models--Systran--faster-whisper-tiny"
    weights = model_cache / f"snapshots/{MODEL_REVISION}/model.bin"
    reference = model_cache / "refs/main"
    return (reference.is_file() and reference.resolve().is_relative_to(cache)
            and reference.read_text().strip() == MODEL_REVISION and weights.is_file()
            and weights.resolve().is_relative_to(cache) and digest(weights) == MODEL_SHA256)


def startup_prefix(gateway):
    command = gateway.get("command")
    if (gateway.get("entrypoint") != ["/bin/sh", "-ec"] or not isinstance(command, list)
            or len(command) != 1 or not isinstance(command[0], str) or command[0].count(ANCHOR) != 1):
        raise RuntimeError("Gateway must retain its standard shell entrypoint and final exec")
    prefix = command[0].split(ANCHOR, 1)[0]
    if "LOCAL_WHISPER_API_KEY" not in prefix:
        prefix += EXPORT
    elif prefix.count(EXPORT) != 1:
        raise RuntimeError("Gateway transcription credential export has another owner")
    return prefix


def validate_candidate(image, gateway, running, source_config, destination, environment, backup, key_file, patch):
    probe = backup / "validation"
    probe.mkdir(mode=0o700)
    state, secret_directory = probe / "state", probe / "secrets"
    for directory in (state, secret_directory):
        directory.mkdir(mode=0o700)
        os.chown(directory, 1000, 1000)
    private_write(state / destination.name, source_config.read_bytes(), uid=1000, gid=1000)
    pid = json.loads(run(["docker", "inspect", running]))[0]["State"]["Pid"]
    for entry in gateway.get("secrets", []):
        name = entry.get("target", entry.get("source"))
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+", name):
            raise RuntimeError("Gateway secret targets must be regular filenames")
        private_write(secret_directory / name, (Path(f"/proc/{pid}/root/run/secrets") / name).read_bytes(),
                      uid=1000, gid=1000)
    target_key = secret_directory / "local_speech_api_key"
    if not target_key.exists():
        private_write(target_key, key_file.read_bytes(), uid=1000, gid=1000)
    args = ["docker", "run", "--rm", "-i", "--network", "none", "--user", "1000:1000",
            "--mount", f"type=bind,src={state},dst={destination.parent}",
            "--mount", f"type=bind,src={secret_directory},dst=/run/secrets,readonly"]
    for name, value in environment.items():
        args.extend(["--env", f"{name}={value}"])
    # Isolated CLI admission sees only a copied config, never the live state databases.
    args.extend(["--env", f"OPENCLAW_STATE_DIR={destination.parent}", "--entrypoint", "/bin/sh", image,
                 "-ec", startup_prefix(gateway) + 'exec node dist/index.js "$@"', "--"])
    run([*args, "config", "patch", "--stdin"], data=json.dumps(patch))
    run([*args, "config", "validate", "--json"])


def main():
    global ERROR_LOG
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant", required=True)
    parser.add_argument("--gateway-image", help="Reviewed derivative Gateway with rebuilt UI, pinned by digest")
    parser.add_argument("--speech-image", default=SPEECH_IMAGE)
    parser.add_argument("--root", type=Path, default=Path("/opt/openclaw/clients"))
    parser.add_argument("--rollback", action="store_true", help="Restore this owner's last exact stack/config backup")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,30}[a-z0-9]|[a-z]", args.tenant):
        parser.error("tenant must be a lowercase DNS slug, at most 32 characters")
    if not hasattr(os, "geteuid") or os.geteuid() != 0:
        parser.error("run as root on the Linux Swarm manager with Python 3.11+ and PyYAML")
    if not args.rollback and not args.gateway_image:
        parser.error("--gateway-image is required")
    for image in (args.gateway_image, args.speech_image):
        if image and not re.fullmatch(r"[^\s]+@sha256:[0-9a-f]{64}", image):
            parser.error("images require immutable @sha256 digests")
    os.umask(0o077)
    directory = args.root.resolve() / args.tenant
    stack, operator = directory / "stack.yaml", directory / OWNER
    if not stack.is_file() or stack.is_symlink():
        parser.error("select an existing tenant with a complete canonical stack.yaml")
    private_directory(operator)
    ERROR_LOG = operator / "last-command-error.log"
    if ERROR_LOG.is_symlink() or (ERROR_LOG.exists() and not ERROR_LOG.is_file()):
        parser.error("command diagnostics must use a regular private file")
    record_file = operator / "deployment.json"
    if record_file.is_symlink() or (record_file.exists() and not record_file.is_file()):
        parser.error("deployment record must be a regular file")
    previous = json.loads(record_file.read_text()) if record_file.exists() else None
    if previous and previous.get("owner") != OWNER:
        parser.error("deployment record belongs to another owner")
    prefix = f"openclaw-{args.tenant}"
    live = json.loads(run(["docker", "service", "inspect", f"{prefix}_gateway"]))[0]
    container = live["Spec"]["TaskTemplate"]["ContainerSpec"]
    config, destination, environment = host_config(container)
    if args.rollback:
        if not previous or previous.get("phase") == "rolled_back":
            parser.error("no unfinished or completed local speech deployment to roll back")
        backup = Path(previous["backup"])
        if (digest(stack) not in previous["owned_stack_hashes"]
                or digest(config) not in previous["owned_config_hashes"]):
            parser.error("stack or config changed outside this deployment; reconcile before restoring")
        stat = config.stat()
        private_write(config, (backup / "openclaw.json").read_bytes(), replace=True, uid=stat.st_uid, gid=stat.st_gid)
        private_write(stack, (backup / "stack.yaml").read_bytes(), replace=True)
        run(["docker", "stack", "deploy", "--resolve-image", "never", "-c", str(stack), prefix])
        wait_healthy(f"{prefix}_gateway")
        if "speech" not in yaml.safe_load((backup / "stack.yaml").read_bytes()).get("services", {}):
            speech = run(["docker", "service", "inspect", f"{prefix}_speech"], optional=True)
            if speech:
                labels = json.loads(speech)[0]["Spec"].get("Labels", {})
                if labels.get("openclaw.capability") != OWNER or labels.get("openclaw.tenant") != args.tenant:
                    raise RuntimeError("Speech service has another owner; reconcile before removing it")
                run(["docker", "service", "rm", f"{prefix}_speech"])
        previous["phase"] = "rolled_back"
        private_write(record_file, json.dumps(previous, indent=2) + "\n", replace=True)
        print(json.dumps({"tenant": args.tenant, "phase": "rolled_back", "backup": str(backup)}))
        return
    if previous and previous.get("phase") not in ("complete", "rolled_back"):
        parser.error("previous deployment is incomplete; inspect its phase and recover before running again")
    if run(["docker", "info", "--format", "{{.Swarm.ControlAvailable}}"]) != "true":
        parser.error("Docker must be a Swarm manager")
    if run(["docker", "info", "--format", "{{.Architecture}}"]) != "x86_64":
        parser.error("the reviewed Speaches CPU image is pinned for Linux amd64")
    original_stack = stack.read_bytes()
    rendered = yaml.safe_load(run(["docker", "stack", "config", "-c", str(stack)]))
    gateway = rendered["services"]["gateway"]
    network = rendered.get("networks", {}).get("capabilities", {})
    if network.get("name") != f"{prefix}-capabilities" or not network.get("external"):
        parser.error("tenant requires its existing private capabilities overlay")
    if gateway["image"] != container["Image"]:
        parser.error("canonical Gateway image and live service differ; reconcile before continuing")
    for image in (args.gateway_image, args.speech_image):
        run(["docker", "pull", image], timeout=1200)
    labels = json.loads(run(["docker", "image", "inspect", args.gateway_image]))[0]["Config"].get("Labels", {})
    expected_base = (previous or {}).get("base_gateway_image", gateway["image"])
    if labels.get("io.openclaw.local-speech.base-image") != expected_base:
        parser.error("candidate Gateway must extend this tenant's recorded current base image")
    current_config = json.loads(config.read_text())
    if not previous and ("local-whisper" in current_config.get("plugins", {}).get("entries", {})
                         or PLUGIN_PATH in current_config.get("plugins", {}).get("load", {}).get("paths", [])):
        parser.error("existing local-whisper configuration has another owner")
    patch = config_patch(current_config)
    startup_prefix(gateway)
    secret_name, volume_name = f"{prefix}-local-speech-key-v1", f"{prefix}-speech-models"
    key_file = operator / "api-key.secret"
    if key_file.is_symlink() or (key_file.exists() and (not key_file.is_file() or key_file.stat().st_uid != 0
                                                      or key_file.stat().st_mode & 0o077)):
        parser.error("speech key must be a root-owned regular private file")
    existing_secret = run(["docker", "secret", "inspect", secret_name], optional=True)
    if existing_secret and (not previous or not key_file.exists()):
        parser.error("speech Docker secret exists without this owner's record and protected key")
    existing_volume = run(["docker", "volume", "inspect", volume_name], optional=True)
    ownership = {"openclaw.tenant": args.tenant, "openclaw.capability": OWNER}
    if existing_volume:
        actual = json.loads(existing_volume)[0].get("Labels") or {}
        if any(actual.get(key) != value for key, value in ownership.items()):
            parser.error("speech model cache belongs to another owner")
    for kind, name in (("services", "speech"), ("volumes", "speech-models"), ("secrets", "local_speech_api_key")):
        if name in rendered.get(kind, {}) and not previous:
            parser.error(f"{kind} speech resource already belongs to another owner")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    backup = args.root.resolve().parent / "backups" / args.tenant / f"before-local-speech-{stamp}"
    private_directory(backup)
    private_write(backup / "stack.yaml", original_stack)
    private_write(backup / "openclaw.json", config.read_bytes())
    if previous:
        private_write(backup / "deployment.json", record_file.read_bytes())
    record = {"owner": OWNER, "tenant": args.tenant, "base_gateway_image": expected_base,
              "gateway_image": args.gateway_image, "speech_image": args.speech_image,
              "model": MODEL, "model_revision": MODEL_REVISION, "model_sha256": MODEL_SHA256,
              "backup": str(backup), "owned_stack_hashes": [digest(stack)], "owned_config_hashes": [digest(config)]}

    def checkpoint(phase):
        record["phase"] = phase
        private_write(record_file, json.dumps(record, indent=2) + "\n", replace=True)

    checkpoint("prepared")
    if not key_file.exists():
        private_write(key_file, secrets.token_urlsafe(48))
    if not key_file.read_bytes().strip():
        raise RuntimeError("Speech API key is empty; reconcile before continuing")
    validate_candidate(args.gateway_image, gateway, container_id(f"{prefix}_gateway"), config,
                       destination, environment, backup, key_file, patch)
    if digest(config) != record["owned_config_hashes"][0] or digest(stack) != record["owned_stack_hashes"][0]:
        raise RuntimeError("Live config or stack changed during admission; reconcile before deployment")
    checkpoint("candidate_validated")
    if not existing_secret:
        run(["docker", "secret", "create", secret_name, str(key_file)])
    if not existing_volume:
        run(["docker", "volume", "create", "--label", f"openclaw.tenant={args.tenant}",
             "--label", f"openclaw.capability={OWNER}", volume_name])
    cache = Path(run(["docker", "volume", "inspect", volume_name, "--format", "{{.Mountpoint}}"])).resolve(strict=True)
    os.chown(cache, 1000, 1000)
    cache.chmod(0o700)
    checkpoint("seeding_model")
    if not model_cached(cache):
        run(["docker", "run", "--rm", "--user", "1000:1000", "--network", "bridge", "--cap-drop", "ALL",
             "--cpus", "2", "--memory", "2g", "--mount",
             f"type=volume,src={volume_name},dst=/home/ubuntu/.cache/huggingface/hub",
             "--entrypoint", "/home/ubuntu/speaches/.venv/bin/python", args.speech_image, "-c",
             "from huggingface_hub import snapshot_download; "
             f"snapshot_download({MODEL!r}, revision='main')"], timeout=1200)
    if not model_cached(cache):
        raise RuntimeError("Downloaded Whisper model differs from its reviewed revision or weights")
    rendered.setdefault("volumes", {})["speech-models"] = {"external": True, "name": volume_name}
    rendered.setdefault("secrets", {})["local_speech_api_key"] = {"external": True, "name": secret_name}
    secret = {"source": "local_speech_api_key", "target": "local_speech_api_key", "uid": "1000", "gid": "1000", "mode": 0o400}
    rendered["services"]["speech"] = {
        "image": args.speech_image, "user": "1000:1000", "entrypoint": ["/bin/sh", "-ec"],
        "command": ['export API_KEY="$(cat /run/secrets/local_speech_api_key)"\n'
                    'exec uvicorn --factory speaches.main:create_app --host 0.0.0.0 --port 8000'],
        "environment": {"WHISPER__INFERENCE_DEVICE": "cpu", "WHISPER__COMPUTE_TYPE": "int8",
                        "WHISPER__CPU_THREADS": "2", "WHISPER__NUM_WORKERS": "1", "ENABLE_UI": "false",
                        "LOG_LEVEL": "info", "STT_MODEL_TTL": "300",
                        "HF_HUB_OFFLINE": "1", "LOOPBACK_HOST_URL": "http://127.0.0.1:8000"},
        "volumes": [{"type": "volume", "source": "speech-models", "target": "/home/ubuntu/.cache/huggingface/hub"}],
        "secrets": [secret], "networks": ["capabilities"], "cap_drop": ["ALL"],
        "healthcheck": {"test": ["CMD", "/home/ubuntu/speaches/.venv/bin/python", "-c", HEALTH], "interval": "30s", "timeout": "10s",
                        "start_period": "8m", "retries": 4},
        "stop_grace_period": "45s", "deploy": {"replicas": 1,
            "placement": copy.deepcopy(gateway["deploy"]["placement"]),
            "resources": {"limits": {"cpus": "2", "memory": "2G"}, "reservations": {"memory": "256M"}},
            "update_config": {"parallelism": 1, "order": "stop-first", "failure_action": "rollback", "monitor": "5m"},
            "rollback_config": {"order": "stop-first", "monitor": "5m"},
            "restart_policy": {"condition": "any", "delay": "10s"},
            "labels": {"traefik.enable": "false", **ownership}}}

    def submit():
        candidate = operator / "candidate-stack.yaml"
        private_write(candidate, yaml.safe_dump(rendered, sort_keys=False).replace("$", "$$"), replace=True)
        run(["docker", "stack", "config", "-c", str(candidate)])
        if digest(stack) not in record["owned_stack_hashes"]:
            raise RuntimeError("Canonical stack changed outside this deployment; reconcile before submitting")
        private_write(stack, candidate.read_bytes(), replace=True)
        record["owned_stack_hashes"].append(digest(stack))
        checkpoint(record["phase"])
        run(["docker", "stack", "deploy", "--resolve-image", "never", "-c", str(stack), prefix])

    checkpoint("warming_speech")
    submit()
    speech_container = wait_healthy(f"{prefix}_speech", timeout=900)
    # Speaches rc.3 PRELOAD_MODELS enumerates the remote registry before checking
    # the cache. Its native in-memory load endpoint resolves local model cards.
    run(["docker", "exec", speech_container, "/home/ubuntu/speaches/.venv/bin/python", "-c", WARM])
    if digest(config) != record["owned_config_hashes"][0]:
        raise RuntimeError("Live config changed during model warm-up; reconcile before replacing the Gateway")
    gateway["image"] = args.gateway_image
    gateway["command"][0] = startup_prefix(gateway) + ANCHOR + gateway["command"][0].split(ANCHOR, 1)[1]
    mounts = gateway.setdefault("secrets", [])
    matching = [entry for entry in mounts if entry.get("source") == "local_speech_api_key"
                or entry.get("target") == "local_speech_api_key"]
    if matching and matching != [secret]:
        raise RuntimeError("Gateway speech secret mount has another owner")
    if not matching:
        mounts.append(secret)
    checkpoint("switching_gateway")
    submit()
    running = wait_healthy(f"{prefix}_gateway")
    wait_healthy(f"{prefix}_speech")
    if digest(config) != record["owned_config_hashes"][0]:
        raise RuntimeError("Live config changed after admission; reconcile before activating transcription")
    cli = ["docker", "exec", "-i", running, "/bin/sh", "-ec",
           startup_prefix(gateway) + 'exec node dist/index.js "$@"', "--"]
    checkpoint("activating_config")
    result = run([*cli, "config", "patch", "--stdin"], data=json.dumps(patch))
    record["owned_config_hashes"].append(digest(config))
    checkpoint("config_written")
    run([*cli, "config", "validate", "--json"])
    if "Restart the gateway to apply." in result:
        run(["docker", "service", "update", "--detach", "--force", f"{prefix}_gateway"])
        wait_healthy(f"{prefix}_gateway", previous_id=running)
    else:
        wait_healthy(f"{prefix}_gateway")
    checkpoint("complete")
    print(json.dumps({"tenant": args.tenant, "phase": "complete", "backup": str(backup),
                      "provider": "local-whisper", "model": MODEL,
                      "verification": "Native config admitted and containers healthy; verify microphone transcription separately"}))


if __name__ == "__main__":
    main()
