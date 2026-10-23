"""Exercise the deployment CLI with real files and only external commands faked.

Run as root on Linux: python tests/deploy_contract.py [--source /path/deploy.py]
The optional source selects a pre-fix implementation for regression proof.
"""

import argparse
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
from contextlib import redirect_stdout
from types import SimpleNamespace
import tempfile
from unittest.mock import patch

import yaml


OLD_IMAGE = "registry.example/ads@sha256:" + "1" * 64
NEW_IMAGE = "registry.example/ads@sha256:" + "2" * 64


def exercise(source, *, owned, skill_only=False, unsafe_destination=False):
    # openclaw-temp-dir: allow real operator files and canonical stack replacement are the tested contract.
    with tempfile.TemporaryDirectory(prefix="openclaw-ads-deploy-contract-") as temporary:
        base = Path(temporary)
        release = base / "release/deploy/ads-broker"
        release.mkdir(parents=True)
        shutil.copyfile(source, release / "deploy.py")
        skill_source = release / "skill/ads-relatorios/SKILL.md"
        skill_source.parent.mkdir(parents=True)
        skill_source.write_bytes(b"---\nname: ads-relatorios\n---\nUse the connected Ads tools for campaign questions.\n")
        original_source = skill_source.read_bytes()
        (release / "stack.yaml").write_text("services: {}\n")
        cli = release.parent / "clients/cli.sh"
        cli.parent.mkdir()
        cli.write_text("# synthetic external CLI boundary\n")
        root = base / "operator/clients"
        tenant = root / "fixture"
        ads = tenant / "ads"
        ads.mkdir(parents=True)
        state = base / "state"
        state.mkdir()
        # The more specific workspace volume must win over the parent state mount.
        (state / "custom-workspace").mkdir()
        workspace = base / "workspace"
        workspace.mkdir()
        skill = workspace / "skills/ads-relatorios/SKILL.md"
        skill.parent.mkdir(parents=True)
        skill.write_bytes(b"Previous user-edited skill\r\n")
        previous_skill = skill.read_bytes()
        unknown = skill.parent / "notes.txt"
        unknown.write_bytes(b"Keep tenant notes\n")
        other_skill = workspace / "skills/another-skill"
        other_skill.mkdir()
        (other_skill / "SKILL.md").write_bytes(b"Keep another skill\n")
        if unsafe_destination:
            skill.unlink()
            skill.symlink_to(unknown)
        key = ads / "api-key.secret"
        key.write_text("synthetic-existing-key-0123456789abcdef")
        credentials = ads / "credentials.json"
        credentials.write_text("{}")
        config = state / "openclaw.json"
        servers = {"library": {"enabled": True}}
        if skill_only:
            servers["ads"] = {"enabled": True, "transport": "streamable-http",
                              "url": "http://openclaw-fixture-ads:8080/mcp",
                              "headers": {"Authorization": "${ADS_MCP_AUTHORIZATION}"}}
        config.write_text(json.dumps({"mcp": {"servers": servers}}))
        for private in (key, credentials, config):
            private.chmod(0o600)
        old = {"services": {
            "gateway": {"image": "gateway:unchanged", "command": ["exec node dist/index.js gateway"],
                        "secrets": [{"source": "gateway_token", "target": "gateway_token"}], "volumes": []},
            "library": {"image": "library:unchanged", "networks": ["private"]},
            "ads": {"image": OLD_IMAGE, "deploy": {"labels": {"openclaw.capability": "ads-reports" if owned else "someone-else"}}},
        }, "secrets": {"gateway_token": {"external": True}}}
        merged = copy.deepcopy(old)
        merged["services"]["ads"] = {"image": NEW_IMAGE, "deploy": {"labels": {"openclaw.capability": "ads-reports"}}}
        merged["services"]["gateway"]["secrets"].append({"source": "ads_key", "target": "ads_api_key"})
        stack = tenant / "stack.yaml"
        stack.write_text(yaml.safe_dump(old, sort_keys=False))
        original_stack = stack.read_bytes()
        original_key = key.read_bytes()
        original_config = config.read_bytes()
        original_credentials = credentials.read_bytes()
        deployment = ads / "deployment.json"
        if skill_only:
            deployment.write_text('{"phase":"complete","image":"existing"}\n')
        original_record = deployment.read_bytes() if deployment.exists() else None
        events = []

        def external(command, *, data=None, env=None):
            if skill_only:
                assert command[:2] in (["docker", "info"], ["docker", "volume"], ["docker", "service"], ["docker", "ps"]), "Skill repair attempted an external mutation"
            if command[:3] == ["docker", "service", "inspect"]:
                return json.dumps([{"Spec": {"TaskTemplate": {"ContainerSpec": {
                    "Env": ["OPENCLAW_WORKSPACE_DIR=/home/node/.openclaw/custom-workspace"],
                    "Mounts": [
                        {"Type": "volume", "Source": "openclaw-fixture-state", "Target": "/home/node/.openclaw"},
                        {"Type": "volume", "Source": "openclaw-fixture-workspace", "Target": "/home/node/.openclaw/custom-workspace"},
                    ],
                }}}}])
            if command[:3] == ["docker", "stack", "config"]:
                if len(command) == 7:
                    return yaml.safe_dump(merged)
                if Path(command[-1]).name == "candidate-stack.yaml":
                    events.append("compose-validated")
                    return Path(command[-1]).read_text()
                return yaml.safe_dump(old)
            if command[:3] == ["docker", "secret", "create"]:
                events.append(("secret-create", command[3]))
                return "synthetic-secret-id"
            if command[:2] == ["docker", "info"]:
                return "true"
            if command[:3] == ["docker", "volume", "inspect"]:
                return str(workspace if command[3].endswith("-workspace") else state)
            if command[:2] == ["docker", "ps"]:
                return "fixture-container"
            if command[:2] == ["docker", "inspect"]:
                return json.dumps([{"State": {"Running": True, "Health": {"Status": "healthy"}}}])
            if command[0] == "sh":
                events.append(("native-cli", command[3:]))
                if command[3:5] == ["config", "patch"]:
                    payload = json.loads(data)
                    assert payload["mcp"]["servers"]["ads"]["headers"] == {"Authorization": "${ADS_MCP_AUTHORIZATION}"}
                if command[3:5] == ["mcp", "probe"]:
                    return json.dumps({"diagnostics": [], "servers": {"ads": {"tools": 3}}})
                return ""
            if command[:2] in (["docker", "pull"], ["docker", "run"]) or command[:3] == ["docker", "stack", "deploy"]:
                return ""
            raise AssertionError("Unexpected external command: " + repr(command[:3]))

        def inspect_secret(command, **kwargs):
            assert not skill_only, "Skill repair must not inspect or rotate credentials"
            assert command[:3] == ["docker", "secret", "inspect"]
            return SimpleNamespace(returncode=0 if command[3].endswith("api-key-v1") else 1)

        spec = importlib.util.spec_from_file_location("ads_deploy_contract", release / "deploy.py")
        deploy = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(deploy)
        argv = [str(release / "deploy.py"), "--tenant", "fixture", "--image", NEW_IMAGE, "--version", "fixture-v2", "--root", str(root)]
        if skill_only:
            argv = [str(release / "deploy.py"), "--tenant", "fixture", "--skill-only", "--root", str(root)]
        with patch("sys.argv", argv), patch.object(deploy, "run", side_effect=external), patch.object(deploy.subprocess, "run", side_effect=inspect_secret), redirect_stdout(io.StringIO()):
            if unsafe_destination:
                try:
                    deploy.main()
                except RuntimeError as error:
                    assert "regular file" in str(error), str(error)
                else:
                    raise AssertionError("Skill repair followed an existing SKILL.md symlink")
            elif owned:
                deploy.main()
            else:
                try:
                    deploy.main()
                except RuntimeError as error:
                    assert "ads" in str(error).lower(), str(error)
                else:
                    raise AssertionError("An existing ads service owned by another integration was overwritten")
        assert key.read_bytes() == original_key
        assert credentials.read_bytes() == original_credentials
        assert skill_source.read_bytes() == original_source
        assert unknown.read_bytes() == b"Keep tenant notes\n"
        assert (other_skill / "SKILL.md").read_bytes() == b"Keep another skill\n"
        assert not any((state / "custom-workspace").iterdir())
        created = [event[1] for event in events if isinstance(event, tuple) and event[0] == "secret-create"]
        if skill_only:
            assert stack.read_bytes() == original_stack and config.read_bytes() == original_config
            assert deployment.read_bytes() == original_record and not created
            assert not events
            if unsafe_destination:
                assert skill.is_symlink()
                assert not (root.parent / "backups").exists()
                return
            backups = list((root.parent / "backups/fixture").glob("before-ads-skill-*/SKILL.md"))
            assert len(backups) == 1 and backups[0].read_bytes() == previous_skill
            assert backups[0].stat().st_mode & 0o077 == 0
        elif not owned:
            assert stack.read_bytes() == original_stack and not created
            assert not any(isinstance(event, tuple) and event[0] == "native-cli" for event in events)
            return
        assert skill.read_bytes() == original_source, "Deployment did not install the Ads discovery skill into the mounted Gateway workspace"
        assert skill.stat().st_uid == 1000 and skill.stat().st_gid == 1000
        assert skill.stat().st_mode & 0o777 == 0o644
        if skill_only:
            return
        assert created == ["openclaw-fixture-ads-credentials-fixture-v2"]
        assert events.index("compose-validated") < events.index(("secret-create", created[0]))
        deployed = yaml.safe_load(stack.read_text())
        assert deployed["services"]["ads"]["image"] == NEW_IMAGE
        assert deployed["services"]["library"] == old["services"]["library"]
        assert deployed["services"]["gateway"]["image"] == old["services"]["gateway"]["image"]
        assert old["services"]["gateway"]["secrets"][0] in deployed["services"]["gateway"]["secrets"]
        record = json.loads((ads / "deployment.json").read_text())
        assert record["phase"] == "complete" and record["image"] == NEW_IMAGE
        backup = Path(record["backup"])
        assert backup.is_relative_to(root.parent / "backups") and (backup / "stack.yaml").read_bytes() == original_stack
        assert (backup / "skill/SKILL.md").read_bytes() == previous_skill


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1] / "deploy.py")
    source = parser.parse_args().source.resolve(strict=True)
    if not hasattr(os, "geteuid") or os.geteuid() != 0:
        parser.error("Run this isolated filesystem contract as root on Linux")
    exercise(source, owned=True)
    exercise(source, owned=False)
    exercise(source, owned=True, skill_only=True)
    exercise(source, owned=True, skill_only=True, unsafe_destination=True)
    print("PASS: CLI upgrades owned Ads service and installs its workspace skill; skill-only repair preserves configuration, credentials and unrelated workspace files and rejects symlinks")
