#!/usr/bin/env python3
"""Exercise real operator files and the deployment CLI with only Docker I/O faked.

Run as root on Linux with Python 3.11+ and PyYAML. No Docker daemon or credentials.
"""

from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

import yaml


BASE = "registry.example/gateway-calendar@sha256:" + "a" * 64
IMAGE = "registry.example/gateway-speech@sha256:" + "b" * 64
WEIGHTS = b"Synthetic local model artifact, never downloaded."


def exercise(module, failure=None):
    # openclaw-temp-dir: allow verifies protected real stack/config files and exact recovery bytes.
    with tempfile.TemporaryDirectory(prefix="openclaw-speech-contract-") as temporary:
        base = Path(temporary)
        root = base / "operator/clients"
        tenant = root / "fixture"
        tenant.mkdir(parents=True)
        state, cache = base / "state", base / "cache"
        state.mkdir()
        cache.mkdir()
        config = state / "openclaw.json"
        config.write_bytes(b'{"browser":{"keep":"existing"},"plugins":{"allow":["existing"]}}\n')
        original_config = config.read_bytes()
        gateway = {"image": BASE, "entrypoint": ["/bin/sh", "-ec"],
                   "command": ["export KEEP='$(preserve literal bytes)'\nexec node dist/index.js gateway --bind lan"],
                   "environment": {"OPENCLAW_CONFIG_PATH": "/home/node/.openclaw/openclaw.json", "TZ": "America/Sao_Paulo"},
                   "volumes": [{"type": "volume", "source": "state", "target": "/home/node/.openclaw"}],
                   "secrets": [], "networks": ["proxy", "capabilities"],
                   "deploy": {"placement": {"constraints": ["node.hostname == fixture-manager"]},
                              "labels": {"existing.route": "unchanged"}}}
        old = {"version": "3.8", "services": {"gateway": gateway,
               **{name: {"image": f"{name}:keep", "environment": {"OWNER": "untouched"}}
                  for name in ["library-api", "library-worker", "library-db", "browser", "docling", "remotion", "ads"]}},
               "volumes": {"state": {"external": True, "name": "existing-state"},
                           "calendar-auth": {"external": True, "name": "keep-calendar-auth"}},
               "secrets": {"calendar": {"external": True, "name": "keep-calendar-key"}},
               "networks": {"proxy": {"external": True, "name": "keep-proxy"},
                            "capabilities": {"external": True, "name": "openclaw-fixture-capabilities"}}}
        stack = tenant / "stack.yaml"
        stack.write_text(yaml.safe_dump(old, sort_keys=False))
        original_stack = stack.read_bytes()
        services = {"openclaw-fixture_gateway": gateway}
        created_secrets, created_volumes, submitted, native_calls = {}, {}, [], []
        generation = 0
        warmed = False

        def spec(service):
            definition = services[service]
            environment = [f"{name}={value}" for name, value in definition.get("environment", {}).items()]
            container = {"Image": definition["image"], "Env": environment,
                         "Mounts": [{"Type": "volume", "Source": "existing-state", "Target": "/home/node/.openclaw"}]}
            return {"Spec": {"TaskTemplate": {"ContainerSpec": container},
                             "Labels": definition.get("deploy", {}).get("labels", {})}}

        def docker(command, **kwargs):
            nonlocal generation, warmed
            assert command[0] == "docker", "Unexpected external command"
            value, status = "", 0
            if command[:2] == ["docker", "info"]:
                value = "x86_64" if command[-1] == "{{.Architecture}}" else "true"
            elif command[:3] == ["docker", "service", "inspect"]:
                service = command[3]
                status = 0 if service in services else 1
                value = json.dumps([spec(service)]) if not status else ""
            elif command[:2] == ["docker", "ps"]:
                service = command[command.index("--filter") + 1].split("=", 1)[1]
                value = f"gateway-{generation}" if service.endswith("_gateway") else "speech-container"
            elif command[:2] == ["docker", "inspect"]:
                service = "openclaw-fixture_gateway" if command[2].startswith("gateway-") else "openclaw-fixture_speech"
                container = spec(service)["Spec"]["TaskTemplate"]["ContainerSpec"]
                value = json.dumps([{"State": {"Pid": os.getpid(), "Running": True, "Health": {"Status": "healthy"}},
                                     "Config": {"Image": container["Image"], "Env": container["Env"]}}])
            elif command[:3] == ["docker", "stack", "config"]:
                value = yaml.safe_dump(yaml.safe_load(Path(command[-1]).read_text().replace("$$", "$")), sort_keys=False)
            elif command[:3] == ["docker", "image", "inspect"]:
                value = json.dumps([{"Config": {"Labels": {"io.openclaw.local-speech.base-image": BASE}}}])
            elif command[:3] == ["docker", "secret", "inspect"]:
                status = 0 if command[3] in created_secrets else 1
            elif command[:3] == ["docker", "secret", "create"]:
                created_secrets[command[3]] = Path(command[4]).read_bytes()
            elif command[:3] == ["docker", "volume", "inspect"]:
                if command[3] == "existing-state":
                    value = str(state)
                elif "--format" in command:
                    value = str(cache)
                elif command[3] in created_volumes:
                    value = json.dumps([{"Labels": created_volumes[command[3]]}])
                else:
                    status = 1
            elif command[:3] == ["docker", "volume", "create"]:
                created_volumes[command[-1]] = dict(command[i + 1].split("=", 1) for i, v in enumerate(command) if v == "--label")
            elif command[:3] == ["docker", "stack", "deploy"]:
                definition = yaml.safe_load(Path(command[command.index("-c") + 1]).read_text().replace("$$", "$"))
                submitted.append(definition)
                if services["openclaw-fixture_gateway"]["image"] != definition["services"]["gateway"]["image"]:
                    if definition["services"]["gateway"]["image"] == IMAGE:
                        assert warmed, "Gateway activated before native offline model admission"
                    generation += 1
                for name, service in definition["services"].items():
                    services[f"openclaw-fixture_{name}"] = service
            elif command[:2] == ["docker", "run"] and command[command.index("--network") + 1] == "bridge":
                assert command[command.index("--entrypoint") + 1] == "/home/ubuntu/speaches/.venv/bin/python"
                assert len([v for v in command if v == "--mount"]) == 1
                assert not any("secret" in v or "openclaw.json" in v for v in command)
                model = cache / "models--Systran--faster-whisper-tiny"
                weights = model / "snapshots" / module.MODEL_REVISION / "model.bin"
                weights.parent.mkdir(parents=True)
                weights.write_bytes(WEIGHTS + (b"corrupt" if failure == "weights" else b""))
                (model / "refs").mkdir()
                (model / "refs/main").write_text(module.MODEL_REVISION)
            elif command[:3] == ["docker", "exec", "speech-container"]:
                if failure == "warm":
                    status = 1
                else:
                    warmed = True
            elif command[:2] in (["docker", "run"], ["docker", "exec"]):
                isolated = command[1] == "run"
                native_calls.append((isolated, command, kwargs.get("input")))
                if isolated:
                    assert command[command.index("--network") + 1] == "none"
                    mounts = [command[i + 1] for i, v in enumerate(command) if v == "--mount"]
                    assert all(f"src={state}" not in mount for mount in mounts), "Candidate mounted live state"
                    if "validate" in command and failure == "admission":
                        status = 1
                elif "patch" in command:
                    assert submitted[-1]["services"]["gateway"]["image"] == IMAGE
                    assert (cache / "models--Systran--faster-whisper-tiny/refs/main").read_text() == module.MODEL_REVISION
                    assert config.read_bytes() == original_config, "Live config changed before native activation"
                    data = json.loads(kwargs["input"])
                    assert data["plugins"]["entries"]["local-whisper"]["config"]["apiKey"]["source"] == "env"
                    config.write_bytes(b'{"native-config-owner":"synthetic admitted change"}\n')
                    value = "Restart the gateway to apply."
            elif command[:3] == ["docker", "service", "update"]:
                generation += 1
            elif command[:3] == ["docker", "service", "rm"]:
                del services[command[-1]]
            elif command[:2] != ["docker", "pull"]:
                raise AssertionError(f"Unexpected Docker operation: {command[:3]}")
            return subprocess.CompletedProcess(command, status, stdout=value, stderr="private fixture detail omitted")

        arguments = [str(Path(module.__file__)), "--tenant", "fixture", "--root", str(root), "--gateway-image", IMAGE]
        with patch.object(module.subprocess, "run", side_effect=docker), patch.object(module, "MODEL_SHA256", hashlib.sha256(WEIGHTS).hexdigest()):
            with patch.object(sys, "argv", arguments), redirect_stdout(io.StringIO()):
                if failure:
                    try:
                        module.main()
                        raise AssertionError("Expected deployment refusal")
                    except RuntimeError:
                        pass
                else:
                    module.main()
            if failure:
                assert config.read_bytes() == original_config
                assert all(item["services"]["gateway"]["image"] == BASE for item in submitted)
                assert not any(not isolated for isolated, _, _ in native_calls)
                if failure == "admission":
                    log = tenant / "local-speech/last-command-error.log"
                    assert log.stat().st_mode & 0o077 == 0
                    assert json.loads(log.read_text())["stderr"] == "private fixture detail omitted"
                return
            assert submitted[0]["services"]["gateway"] == gateway, "Warm-up changed Gateway configuration"
            for name, definition in old["services"].items():
                if name != "gateway":
                    assert submitted[-1]["services"][name] == definition, f"Changed another service: {name}"
            new_gateway = submitted[-1]["services"]["gateway"]
            assert new_gateway["volumes"] == gateway["volumes"]
            assert new_gateway["environment"] == gateway["environment"]
            assert new_gateway["deploy"] == gateway["deploy"]
            assert new_gateway["command"][0].startswith("export KEEP='$(preserve literal bytes)'\n")
            assert submitted[-1]["services"]["speech"]["environment"]["HF_HUB_OFFLINE"] == "1"
            assert submitted[-1]["services"]["speech"]["environment"]["LOOPBACK_HOST_URL"] == "http://127.0.0.1:8000"
            assert not submitted[-1]["services"]["speech"].get("ports")
            assert stack.stat().st_mode & 0o077 == 0
            with patch.object(sys, "argv", [*arguments, "--rollback"]), redirect_stdout(io.StringIO()):
                module.main()
            assert config.read_bytes() == original_config
            assert stack.read_bytes() == original_stack
            assert "openclaw-fixture_speech" not in services
            assert created_volumes and created_secrets, "Recovery deleted persistent resources"


if __name__ == "__main__":
    if not hasattr(os, "geteuid") or os.geteuid() != 0:
        raise SystemExit("Run this isolated contract as root on Linux")
    started = time.monotonic()
    source = Path(__file__).resolve().parents[1] / "deploy.py"
    specification = importlib.util.spec_from_file_location("local_speech_deployment", source)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    for failure in (None, "admission", "weights", "warm"):
        exercise(module, failure)
    print(f"PASS: stack preservation, isolated admission, model refusal and exact recovery ({time.monotonic() - started:.3f}s)")
