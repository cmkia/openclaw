# Private local microphone transcription

This deployment adds CPU speech recognition for the browser microphone. The
`local-whisper` plugin registers an existing OpenClaw realtime transcription
provider, backed by a private Speaches service. Audio travels from the browser
through its authenticated Gateway connection to the tenant's speech container.
The service uses a multilingual Whisper tiny model with Portuguese selected.
There is no external transcription API or usage charge; CPU and storage belong
to the existing server.

Transcription produces text for the composer. Speech synthesis and a complete
spoken Talk conversation need their own configured providers. They are separate
capabilities from microphone transcription.

Press Stop to insert the complete dictation into the draft. The adapter keeps
native utterance results in order and delivers one final text after closing, so
the composer's existing final-result drain retains the last spoken phrase.
Review the text and send it explicitly.
The draft stays editable and shows the finishing status while queued audio and
the final result drain, with a bounded wait of 60 seconds after Stop.

## Reviewed runtime

- Speaches `0.9.0-rc.3-cpu`, Linux amd64, pinned in `deploy.py` to
  `sha256:c26e287cbfbd77d7035f80a297f3695f8d33c797c894e4555cc258f5a4a5dd07`.
- `Systran/faster-whisper-tiny`, multilingual, revision
  `d90ca5fe260221311c53c58e660288d3deb8d356`. Its `model.bin` SHA-256 is
  `dcb76c6586fc06cbdac6dd21f14cfd129cc4cdd9dce19bf4ffa62e59cbe6e6d1`.
- CPU inference uses `int8`, two threads, one worker, a two-CPU limit and a
  2 GiB memory limit. Model cache storage is a dedicated tenant Docker volume.
- Speaches runs as UID/GID `1000:1000`, drops capabilities and receives no host
  port or Traefik route. Only the tenant's private capabilities network is used.

The image's native configuration and startup are documented by
[Speaches configuration](https://github.com/speaches-ai/speaches/blob/v0.9.0-rc.3/src/speaches/config.py),
[application startup](https://github.com/speaches-ai/speaches/blob/v0.9.0-rc.3/src/speaches/main.py)
and the [model router](https://github.com/speaches-ai/speaches/blob/v0.9.0-rc.3/src/speaches/routers/models.py).
The [Whisper model repository](https://huggingface.co/Systran/faster-whisper-tiny/tree/d90ca5fe260221311c53c58e660288d3deb8d356)
owns model artifacts. The installer seeds the dedicated cache through the
image's own `huggingface_hub.snapshot_download` on a temporary Docker bridge
container, verifies the revision and weights, then starts Speaches with Hugging
Face offline mode. The download container receives only
the model cache, with no credentials, Gateway state or published ports. Runtime
speech therefore works on an internal overlay without Internet access.

Speaches rc.3's `PRELOAD_MODELS` first enumerates remote models, so it is omitted
from offline startup. After the local `/health` endpoint responds, the installer
uses authenticated `POST /api/ps/<model>` to load the cached model and checks
`GET /api/ps` for its in-memory presence. These native routes resolve the local
model card and cached weights, without remote registry enumeration. The periodic
health probe checks only `/health`: idle model eviction after 300 seconds does
not restart an otherwise healthy service; the next audio request loads the same
reviewed cache.

`LOOPBACK_HOST_URL=http://127.0.0.1:8000` selects the image's supported internal
HTTP transcription client. Its default client targets a raw ASGI router, which
fails FastAPI middleware admission during WebSocket transcription in this
release. The [native client owner](https://github.com/speaches-ai/speaches/blob/v0.9.0-rc.3/src/speaches/dependencies.py#L160-L182)
uses this loopback URL for the full authenticated application. It adds no
external listener or provider API; real offline WebSocket verification must use
the same setting as the deployed service.

## Build the Gateway derivative

Build the Control UI through the repository's existing `pnpm ui:build` command.
The image uses those generated assets and the plugin in this directory. It
extends the tenant's current immutable Gateway image, including the existing
Calendar CLI and any other reviewed additions. It does not rebuild OpenClaw.

Run from the repository root:

```sh
pnpm ui:build
docker build -f deploy/local-speech/Gateway.Dockerfile \
  --build-arg OPENCLAW_IMAGE='registry.example.com/current-gateway@sha256:<current-digest>' \
  -t registry.example.com/openclaw-local-speech:<release> .
docker push registry.example.com/openclaw-local-speech:<release>
```

Record the pushed immutable digest. `Gateway.Dockerfile.dockerignore` restricts
the build context to the plugin and generated UI assets. No credentials, state
volumes or operator configuration belong in that context. The base-image label
is checked against the tenant's recorded current image before deployment.
The plugin-local `node_modules/openclaw` link points to that same `/app` host
installation, following the documented [host peer dependency](../../docs/plugins/dependency-resolution.md#host-peer-dependency)
contract. No second OpenClaw package or runtime is installed.

## Install an existing tenant

Copy this deployment to a protected release directory on the Linux amd64 Swarm
manager. Python 3.11+, PyYAML, Docker and the tenant's complete canonical stack
are required. Exactly one tenant Gateway must run on this manager. The helper
uses the current mounted config path and existing startup exports; it preserves
the Gateway's other secret references, routes, volumes and environment settings.

```sh
python3 deploy/local-speech/deploy.py --tenant example \
  --gateway-image 'registry.example.com/openclaw-local-speech:<release>@sha256:<digest>'
```

The default operator root is `/opt/openclaw/clients`; select another installation
with `--root`. The installer performs these serialized operations:

1. Save exact previous stack and config bytes beneath
   `/opt/openclaw/backups/<tenant>/before-local-speech-<timestamp>`.
2. Run the candidate image's native `config patch --stdin` and `config validate`
   against a private copy of the config. Only copied secret files are mounted;
   the container has no network or live state databases.
3. Seed and verify the model cache, then add and warm only the private `speech`
   service in offline mode, keeping the Gateway image and config unchanged.
   Verify server health, then load the cached model through the native
   authenticated in-memory model endpoint before changing the Gateway.
4. Switch the Gateway to the reviewed derivative image with its unchanged
   config. Wait for the desired image, environment and container health.
5. Apply the same targeted patch through the running Gateway's native CLI and
   validate it. Follow the native restart hint when required, then verify health.

The patch appends `/opt/openclaw/local-whisper` to existing plugin load paths,
preserves any explicit allowlist and adds this plugin to it, enables the plugin,
and selects `local-whisper` through the existing Voice Call streaming provider
configuration consumed by browser transcription. Other plugin configuration is
merged by the native config owner. Explicit plugin denial is respected.

The plugin receives `baseUrl: http://speech:8000/v1`, the reviewed model,
`language: pt` and a SecretRef for `LOCAL_WHISPER_API_KEY`. The Gateway and speech
container read the same dedicated Docker secret at startup. Its random recovery
copy is `local-speech/api-key.secret`, root-owned with mode `0600`; it is reused,
not rotated on repeat installations. Never print or commit it.

Native maintenance uses the shared CLI owner, which conditionally exports the
same secret when this optional capability is installed:

```sh
sh deploy/clients/cli.sh example config validate --json
```

`local-speech/deployment.json` records the immutable image pins, reviewed model,
backup path, owned config/stack hashes and last phase. `complete` proves native
config admission and desired container health. It does not prove a browser
permission grant, Portuguese recognition accuracy or a real microphone round
trip; verify those through the browser and Gateway transcription session.

Failed native commands retain their bounded stdout/stderr only in protected
`local-speech/last-command-error.log`, mode `0600`. These diagnostics can contain
expanded secrets; inspect them privately and never paste or commit the file.
The helper reports the command identity and log path without printing its
arguments or diagnostics. Native commands have a 15-minute deadline; image
pulls and model downloads allow 20 minutes. A timeout is an uncertain operation:
inspect the deployment phase and live containers before retrying.

## Recovery

If installation stops, inspect the phase and live service before another write.
An incomplete deployment refuses a blind repeat. Restore the preceding exact
stack and config through this deployment owner:

```sh
python3 deploy/local-speech/deploy.py --tenant example --rollback
```

Recovery refuses when stack or config hashes differ from this deployment's
recorded states. Reconcile newer operator changes first. The previous config is
restored atomically with its existing UID/GID, then the previous canonical stack
is submitted and Gateway health is verified. If the speech service was absent
before installation, only that owner-labeled service is removed. Its dedicated
model volume, credential and protected backups remain available for recovery.

No cleanup removes customer documents, conversations, Google authorization,
Ads credentials, Calendar keyrings or another tenant's services.

The isolated deployment contract runs as root on Linux and uses no live Docker
daemon, network or credentials:

```sh
python3 deploy/local-speech/tests/deploy_contract.py
```

It covers unrelated service preservation, admission with copied config, model
verification failure before Gateway activation, and exact recovery. Provider
protocol and real microphone verification belong to their separate owners.
