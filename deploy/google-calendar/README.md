# Native Google Calendar access

This deployment adds the official `gog` CLI to the tenant's existing OpenClaw
Gateway image and installs a Calendar-focused workspace skill named `gog`. It
uses the account's native Google OAuth authorization and encrypted file keyring.
The OpenClaw runtime, configuration, other services, and other tenants stay with
their existing owners. Calendar access does not use the Drive broker's grant.

Build and review the derivative Gateway image from this directory, push it to
the registry, and record its immutable digest. Its base must match the tenant's
current pinned OpenClaw runtime. Copy the complete deployment directory,
including `skill/gog/SKILL.md`, to a protected release directory on the Linux
Swarm manager. Python 3 and PyYAML are required.

```sh
python3 deploy/google-calendar/deploy.py \
  --tenant example \
  --account calendar-user@example.com \
  --image registry.example.com/openclaw-calendar@sha256:<reviewed-image-digest>
```

The default operator root is `/opt/openclaw/clients`; use `--root` for a different
installation. Select an existing tenant with a complete canonical `stack.yaml`
and exactly one Gateway running on this manager. The installer preserves every
other service and Gateway setting, adds only its image, gog environment,
keyring secret, and dedicated auth mount, then submits the same stack with
`--resolve-image never`. It does not modify `openclaw.json`.

The first installation requires `--account`. Later runs can omit it and reuse
the recorded account. Changing that account or replacing a conflicting gog
mount/environment requires reconciling its existing authorization first.
Repeated installations reuse the password and auth volume; they never rotate
the secret or overwrite existing OAuth tokens.

Each tenant receives:

- Volume `openclaw-<tenant>-calendar-auth`, mounted at
  `/home/node/.config/gogcli`, owned by UID/GID `1000:1000` with mode `0700`.
- A random password in protected `calendar/keyring.secret`, owned by root with
  mode `0600`, and Docker secret `openclaw-<tenant>-calendar-keyring-v1`.
- Environment `GOG_KEYRING_BACKEND=file`, `GOG_HOME`, `GOG_CONFIG_DIR`, `GOG_ACCOUNT`, and
  `GOG_CALENDAR_ID=primary`. Existing time zone settings are preserved.
- A workspace override at `skills/gog/SKILL.md`, installed atomically with mode
  `0644` and UID/GID `1000:1000`. The most specific live workspace mount wins.

The Gateway reads the keyring password from its Docker secret at startup. Keep
the password file and encrypted auth-volume backups together in protected
operator storage; losing the password can require reauthorization. Never commit
or share these files or print tokens in evidence.

Both `GOG_HOME` and `GOG_CONFIG_DIR` point to the auth-volume mount. The config
override preserves existing configuration there, while `GOG_HOME` keeps gog's
durable OAuth/keyring data, mutable state, and cache beneath that same persistent
root. Setting only the config directory leaves the other paths on their platform
defaults. See the native [gog v0.46 path contract](https://github.com/openclaw/gogcli/blob/v0.46.0/docs/paths.md).
An existing config-only deployment may hold native auth data outside its volume.
The installer refuses to replace that Gateway: preserve and reconcile its native
data while the current container is still running, before changing its image or
environment. Setting a new root alone does not preserve those files.

`calendar/deployment.json` records the image, account, backup path and phase.
`prepared` means installation has not completed; inspect the candidate, canonical
stack and Docker service before resuming. `deployed` means Docker accepted the
stack submission. It does not prove service health or Google authorization.
Complete the separate native `auth.sh` flow, check Gateway health, then use
native gog Calendar commands to verify the selected account. Google scope
consent and a successful real Calendar request are separate from installation.

## Connect the Google account

Enable Calendar API in the existing Google Cloud project and use an installed-app
OAuth client stored outside this repository with root ownership and mode `0600`.
The client registration may be shared with the existing Drive integration; its
refresh tokens are not copied or changed. Do not reuse a Drive-only token.

Forward the callback port from the workstation with the user's browser:

```sh
ssh -N -L 127.0.0.1:15004:127.0.0.1:15004 your-swarm-manager
```

On the manager, run:

```sh
python3 deploy/google-calendar/authorize.py --tenant example \
  --client /protected/operator/google-installed-client.json
```

The helper imports only the client registration into the tenant's own gog store,
then starts the same pinned image as a temporary non-root container. Its native
OAuth listener binds only manager loopback, with no published service port or
public callback. Open the printed Google authorization URL in the workstation
browser and consent with the selected account. The redirect travels through the
SSH tunnel directly to gog; never paste callback URLs, codes or tokens into chat.
Only Calendar is selected. Native gog owns PKCE, OAuth state, identity validation,
refresh and encrypted storage. The keyring password travels through stdin, not
Docker environment metadata or process arguments. Remove the SSH tunnel afterward.

Native maintenance uses the same persistent store and Docker secret as the agent:

```sh
sh deploy/google-calendar/auth.sh example auth list --check --json --no-input
sh deploy/google-calendar/auth.sh example calendar events primary --today --json --no-input
```

Inspect every account/check result as well as the exit status. If Google reports
Calendar API disabled, enable it in that same OAuth project and retry the read;
an unrelated Google connection cannot establish Calendar access. An external
OAuth app left in Testing can issue refresh tokens that expire after seven days;
check the project's publishing status before relying on unattended scheduling.

After consent, ask through the Gateway chat, for example: "Agende um compromisso
amanhã, das 14h às 15h, chamado Revisão de planejamento, sem convidados." Verify
the returned Google event link and reconcile any uncertain write before retrying.
Test events should be clearly identified and removed after verification.

Before changing the canonical stack or skill, the installer records exact
previous bytes under `/opt/openclaw/backups/<tenant>/before-calendar-<timestamp>`.
The previous deployment record is included when present. For recovery, inspect
the live service first, restore the selected protected stack and skill backup,
and redeploy the original stack. Retain the dedicated auth volume and keyring
password while recovering; neither needs to be deleted or reset.

Run the isolated deployment contract as root on Linux with PyYAML installed:

```sh
python3 deploy/google-calendar/tests/deploy_contract.py
```

It uses temporary operator files and a fake Docker process boundary. It verifies
stack preservation, mounted-workspace selection, private secret handling,
idempotence and refusal of conflicting ownership; it does not access Google or a
live Docker daemon.
