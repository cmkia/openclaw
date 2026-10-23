#!/usr/bin/env python3
"""Exercise the deployment entry point with real files and only Docker I/O faked.

Run as root on Linux with PyYAML. No live Docker daemon or Google credentials.
"""

from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import tempfile
import time
from types import SimpleNamespace
from unittest.mock import patch

import yaml


IMAGE = "registry.example/calendar@sha256:" + "a" * 64


def exercise(source, conflict=None, *, legacy_root=False):
    # openclaw-temp-dir: allow verifies real protected operator files and atomic workspace/canonical stack writes.
    with tempfile.TemporaryDirectory(prefix="openclaw-calendar-contract-") as temporary:
        base = Path(temporary)
        release = base / "release/deploy/google-calendar"
        release.mkdir(parents=True)
        shutil.copyfile(source, release / "deploy.py")
        source_skill = release / "skill/gog/SKILL.md"
        source_skill.parent.mkdir(parents=True)
        source_skill.write_bytes(b"---\nname: gog\n---\nUse native Calendar commands.\n")
        root = base / "operator/clients"
        tenant = root / "fixture"
        tenant.mkdir(parents=True)
        state = base / "state"
        (state / "custom-workspace").mkdir(parents=True)
        config = state / "openclaw.json"
        config.write_bytes(b'{"keep":"synthetic existing config"}\n')
        workspace = base / "workspace"
        skill = workspace / "skills/gog/SKILL.md"
        skill.parent.mkdir(parents=True)
        skill.write_bytes(b"Previous user skill\r\n")
        old_skill = skill.read_bytes()
        note = skill.parent / "notes.txt"
        note.write_bytes(b"Keep local user notes\n")
        auth = base / "calendar-auth"
        auth.mkdir()
        token = auth / "synthetic-keyring"
        token.write_bytes(b"Existing encrypted auth bytes\x00\x01")
        original_token = token.read_bytes()
        old = {"version": "3.8", "services": {
            "gateway": {"image": "gateway@sha256:" + "b" * 64,
                        "entrypoint": ["/bin/sh", "-ec"],
                        "command": ['export EXISTING="$(cat /run/secrets/existing)"\nexec node dist/index.js gateway --bind lan'],
                        "environment": {"TZ": "America/Sao_Paulo", "KEEP_SETTING": "unchanged"},
                        "volumes": [{"type": "volume", "source": "state", "target": "/home/node/.openclaw"}],
                        "secrets": [{"source": "existing", "target": "existing", "uid": "1000", "mode": 256}],
                        "networks": ["private"], "deploy": {"replicas": 1, "labels": {"keep.router": "unchanged"}}},
            "library": {"image": "library:unchanged", "networks": ["private"]},
            "ads": {"image": "ads:unchanged", "environment": {"KEEP_ADS": "yes"}},
        }, "volumes": {"state": {"external": True, "name": "existing-state"}},
           "secrets": {"existing": {"external": True, "name": "existing-secret"}},
           "networks": {"private": {"external": True, "name": "existing-network"}}}
        if conflict == "environment":
            old["services"]["gateway"]["environment"]["GOG_ACCOUNT"] = "another@example.com"
        if conflict == "mount":
            old["services"]["gateway"]["volumes"].append({"type": "volume", "source": "foreign",
                                                            "target": "/home/node/.config/gogcli"})
        if conflict == "skill-symlink":
            skill.unlink()
            skill.symlink_to(note)
        stack = tenant / "stack.yaml"
        stack.write_text(yaml.safe_dump(old, sort_keys=False))
        old_stack, old_config = stack.read_bytes(), config.read_bytes()
        events, secrets_created, volumes = [], {}, {}
        if conflict == "volume-labels":
            volumes["openclaw-fixture-calendar-auth"] = {"Labels": {"owner": "other"}, "Mountpoint": str(auth)}

        def docker(command, **kwargs):
            assert command[0] == "docker", "Installer attempted an unexpected external command"
            events.append(command)
            result = ""
            code = 0
            if command[:2] == ["docker", "info"]:
                result = "true"
            elif command[:3] == ["docker", "service", "inspect"]:
                result = json.dumps([{"Spec": {"TaskTemplate": {"ContainerSpec": {
                    "Env": ["OPENCLAW_WORKSPACE_DIR=/home/node/.openclaw/custom-workspace"],
                    "Mounts": [{"Type": "volume", "Source": "state", "Target": "/home/node/.openclaw"},
                               {"Type": "volume", "Source": "workspace", "Target": "/home/node/.openclaw/custom-workspace"}],
                }}}}])
            elif command[:2] == ["docker", "ps"]:
                result = "synthetic-gateway"
            elif command[:3] == ["docker", "stack", "config"]:
                # Docker owns Compose interpolation. Render escaped literal dollars
                # back to their runtime bytes, including on a repeated install.
                parsed = yaml.safe_load(Path(command[-1]).read_text().replace("$$", "$"))
                result = yaml.safe_dump(parsed, sort_keys=False)
            elif command[:3] == ["docker", "volume", "inspect"]:
                name = command[3]
                if "--format" in command:
                    result = str({"state": state, "workspace": workspace}.get(name, auth))
                elif name in volumes:
                    result = json.dumps([volumes[name]])
                else:
                    code = 1
            elif command[:3] == ["docker", "volume", "create"]:
                labels = dict(command[index + 1].split("=", 1) for index, value in enumerate(command) if value == "--label")
                volumes[command[-1]] = {"Labels": labels, "Mountpoint": str(auth)}
                result = command[-1]
            elif command[:3] == ["docker", "secret", "inspect"]:
                code = 0 if command[3] in secrets_created else 1
                result = json.dumps([{"ID": "synthetic-secret"}]) if not code else ""
            elif command[:3] == ["docker", "secret", "create"]:
                assert command[3] not in secrets_created, "Installer rotated an existing keyring secret"
                secrets_created[command[3]] = Path(command[4]).read_bytes()
                result = "synthetic-secret-id"
            elif command[:2] == ["docker", "pull"]:
                assert command[-1] == IMAGE
                code = 1 if conflict == "docker-failure" else 0
            elif command[:3] == ["docker", "stack", "deploy"]:
                assert command[3:5] == ["--resolve-image", "never"] and command[-1] == "openclaw-fixture"
                assert "--prune" not in command
            else:
                raise AssertionError("Unexpected Docker operation: " + repr(command[:3]))
            return SimpleNamespace(returncode=code, stdout=result, stderr="synthetic-sensitive-diagnostic")

        spec = importlib.util.spec_from_file_location("calendar_deploy_contract", release / "deploy.py")
        deploy = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(deploy)
        argv = [str(release / "deploy.py"), "--tenant", "fixture", "--image", IMAGE,
                "--account", "calendar@example.com", "--root", str(root)]
        output = io.StringIO()
        with patch("sys.argv", argv), patch.object(deploy.subprocess, "run", side_effect=docker), redirect_stdout(output):
            if conflict:
                try:
                    deploy.main()
                except RuntimeError as error:
                    assert 'synthetic-sensitive-diagnostic' not in str(error), 'Docker diagnostics leaked from an error'
                else:
                    raise AssertionError("Installer overwrote conflicting Calendar ownership")
                assert stack.read_bytes() == old_stack and config.read_bytes() == old_config
                assert not secrets_created and not any(event[:3] == ["docker", "stack", "deploy"] for event in events)
                assert token.read_bytes() == original_token and note.read_bytes() == b"Keep local user notes\n"
                return
            deploy.main()
            calendar = tenant / "calendar"
            password = (calendar / "keyring.secret").read_bytes()
            first_record = (calendar / "deployment.json").read_bytes()
            first_stack = stack.read_bytes()
            record = json.loads(first_record)
            backup = Path(record["backup"])
            assert record["phase"] == "deployed" and record["image"] == IMAGE
            assert (backup / "stack.yaml").read_bytes() == old_stack
            assert (backup / "SKILL.md").read_bytes() == old_skill
            if legacy_root:
                # A config-only deployment can have native auth outside the
                # persistent volume. Refuse before a replacement loses it.
                config_only = yaml.safe_load(stack.read_text())
                del config_only["services"]["gateway"]["environment"]["GOG_HOME"]
                stack.write_text(yaml.safe_dump(config_only, sort_keys=False))
                config_only_bytes = stack.read_bytes()
                event_count = len(events)
                try:
                    deploy.main()
                except RuntimeError as error:
                    assert 'data must be preserved' in str(error), 'Refusal must explain the native auth data risk'
                else:
                    raise AssertionError('A config-only Gateway was replaced before its native auth was preserved')
                assert stack.read_bytes() == config_only_bytes
                assert (calendar / "deployment.json").read_bytes() == first_record
                assert (calendar / "keyring.secret").read_bytes() == password
                assert len(secrets_created) == 1 and next(iter(secrets_created.values())) == password
                assert token.read_bytes() == original_token and config.read_bytes() == old_config
                assert skill.read_bytes() == source_skill.read_bytes()
                assert all(event[:2] == ['docker', 'info'] or event[:3] in (
                    ['docker', 'service', 'inspect'], ['docker', 'volume', 'inspect'],
                    ['docker', 'stack', 'config'], ['docker', 'ps', '--filter'],
                ) for event in events[event_count:]), 'Config-only refusal performed an external mutation'
                return
            # Second invocation resolves the account from the record and must
            # reuse the existing encrypted authorization and immutable secret.
            argv_without_account = argv[:]
            index = argv_without_account.index("--account")
            del argv_without_account[index:index + 2]
            with patch("sys.argv", argv_without_account):
                deploy.main()

        assert stack.read_bytes() == first_stack, "Repeated installation changed canonical runtime command or settings"
        assert len(secrets_created) == 1 and next(iter(secrets_created.values())) == password
        assert (calendar / "keyring.secret").read_bytes() == password
        assert token.read_bytes() == original_token and config.read_bytes() == old_config
        assert password.decode() not in output.getvalue() and password not in stack.read_bytes()
        assert all(password.decode() not in argument for event in events for argument in event)
        assert (calendar / "keyring.secret").stat().st_mode & 0o777 == 0o600
        assert calendar.stat().st_mode & 0o777 == 0o700
        assert auth.stat().st_uid == 1000 and auth.stat().st_mode & 0o777 == 0o700
        assert skill.read_bytes() == source_skill.read_bytes()
        assert (skill.stat().st_uid, skill.stat().st_gid, skill.stat().st_mode & 0o777) == (1000, 1000, 0o644)
        assert note.read_bytes() == b"Keep local user notes\n" and not any((state / "custom-workspace").iterdir())
        current = yaml.safe_load(stack.read_text().replace("$$", "$"))
        assert current["services"]["library"] == old["services"]["library"]
        assert current["services"]["ads"] == old["services"]["ads"]
        gateway = current["services"]["gateway"]
        assert gateway["image"] == IMAGE and gateway["environment"]["TZ"] == "America/Sao_Paulo"
        assert gateway["environment"]["GOG_ACCOUNT"] == "calendar@example.com"
        assert gateway["environment"]["GOG_KEYRING_BACKEND"] == "file"
        # Native gog separates config from durable OAuth/keyring data and mutable
        # state/cache. Its public GOG_HOME contract must put every kind beneath
        # the persisted mount; GOG_CONFIG_DIR alone cannot do that.
        assert gateway["environment"]["GOG_HOME"] == "/home/node/.config/gogcli"
        assert gateway["environment"]["GOG_CONFIG_DIR"] == "/home/node/.config/gogcli"
        assert gateway["command"][0].count('export GOG_KEYRING_PASSWORD=') == 1
        assert old["services"]["gateway"]["command"][0].splitlines()[0] in gateway["command"][0]
        for key, value in old["services"]["gateway"].items():
            if key not in ("image", "environment", "command", "volumes", "secrets"):
                assert gateway[key] == value
        for kind in ("volumes", "secrets"):
            assert all(entry in gateway[kind] for entry in old["services"]["gateway"][kind])
            assert all(current[kind][name] == value for name, value in old[kind].items())
        assert current["networks"] == old["networks"]
        second_record = json.loads((calendar / "deployment.json").read_text())
        assert (Path(second_record["backup"]) / "deployment.json").read_bytes() == first_record
        assert len([event for event in events if event[:3] == ["docker", "volume", "create"]]) == 1


if __name__ == "__main__":
    if not hasattr(os, "geteuid") or os.geteuid() != 0:
        raise SystemExit("Run the isolated filesystem contract as root on Linux")
    started = time.monotonic()
    source = Path(__file__).resolve().parents[1] / "deploy.py"
    exercise(source)
    exercise(source, legacy_root=True)
    for conflict in ("environment", "mount", "volume-labels", "skill-symlink", "docker-failure"):
        exercise(source, conflict)
    print(json.dumps({"passed": True, "checks": ["preserves_existing_stack_config_and_auth",
          "uses_most_specific_workspace_mount_and_backs_up_exact_skill",
          "refuses_config_only_replacement_before_native_auth_is_preserved",
          "idempotent_private_password_volume_and_secret", "rejects_conflicting_ownership_and_symlinks"],
          "wall_seconds": round(time.monotonic() - started, 3)}))
