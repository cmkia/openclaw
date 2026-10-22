# Deploy isolated OpenClaw assistants with OmniRoute

Run one Docker Swarm stack per customer. Each stack has its own state volume
(SQLite databases, conversations, memory, workspace, uploads, generated images,
channel credentials and configuration), auth volume, Gateway token and OmniRoute
API key. The base deployment shares the reverse proxy and OmniRoute service. Customer data
does not use a shared OpenClaw database, Redis instance or workspace.

The optional [academic library](../library/README.md) adds tenant-owned
PostgreSQL/pgvector, original documents, processing jobs and local embedding
models. Its [central Drive broker](../drive-broker/README.md) shares only the
operator's read-only Google authorization; server-owned customer folder grants
and separate keys constrain access. Curated study notes stay in the tenant's
native wiki. These services require their own deployment and live validation;
the base provisioner does not silently install them.

The deployment uses the official stable `2026.10.5` image pinned by digest in
`provision.py`. The fork adds deployment configuration; it does not rebuild or
modify the OpenClaw runtime. Review the upstream release and repeat the live
checks below before changing that pin.

## Requirements

- A Linux Docker Swarm manager with Python 3, a working image registry connection
  and the existing Traefik Swarm provider.
- An external, attachable overlay network named `traefik-proxy`, a `websecure`
  entrypoint, and a `letsencrypt` certificate resolver. Network and resolver names
  can be overridden through script arguments.
- Two DNS names per customer pointing to the server: the Gateway and a dedicated
  MCP Apps sandbox. The sandbox must have a different origin and serve no other
  sensitive application. Both listeners stay behind HTTPS; no host ports are
  published by the stack.
- For proxied DNS, select a certificate resolver using HTTP-01 or DNS-01 instead
  of TLS-ALPN-01, and keep its configuration in the proxy's deployment source.
  HTTP-01 needs public port 80; HTTP-to-HTTPS redirection is compatible. See
  [Traefik ACME](https://doc.traefik.io/traefik/v3.6/https/acme/).
- If Cloudflare returns error 1010 for native API clients, add a Configuration
  Rule scoped to the customer's two hostnames with Browser Integrity Check
  disabled (`bic: false`). Keep Gateway authentication and pairing enabled.
  [Cloudflare BIC](https://developers.cloudflare.com/waf/tools/browser-integrity-check/)
  documents this per-host exception.
- An authenticated OmniRoute administrator and working provider connections.
  OAuth accounts remain in OmniRoute; OpenClaw receives only its own scoped key.
- Select chat models supporting Responses translation, tools, images as input,
  and at least 64,000 context tokens with an 8,192-token output limit. Select an
  image backend supported by OmniRoute's images endpoint separately.
- Confirm image input in OmniRoute's model catalog, including its **Vision
  capable** setting for manually added models. A successful text request does
  not prove a combo accepts images. After generation, OpenClaw can send the
  generated image back through the chat combo to deliver its completion.

Memory files and SQLite indexes stay local to each tenant. This template sets
`memory.search.provider` to `none` to use keyword search (FTS5), keeping memory
retrieval available without an external embedding API. This subscription-only
deployment does not configure an embeddings endpoint. Semantic vector search requires a
separately configured embedding service or managed local embedding model; do not
grant unrestricted model access to work around an embedding authorization error.

## Provision a customer

Copy this directory to a protected release directory on the manager. Supply the
administrator password through the invocation environment, without putting it in
shell history or this repository. The script authenticates through OmniRoute's
management API; it never writes OmniRoute's database directly.

```bash
read -rsp 'OmniRoute admin password: ' OMNIROUTE_ADMIN_PASSWORD
echo
export OMNIROUTE_ADMIN_PASSWORD
python3 provision.py \
  --tenant example \
  --host assistant.example.com \
  --sandbox-host assistant-apps.example.com \
  --omniroute-url https://route.example.com \
  --chat-model '<CHAT_PROVIDER>/<CHAT_MODEL>' \
  --image-model '<IMAGE_PROVIDER>/<IMAGE_BACKEND_MODEL>' \
  --proxy-cidr '<TRAEFIK_OVERLAY_CIDR>'
unset OMNIROUTE_ADMIN_PASSWORD
```

The script creates `oc-example-chat`, `oc-example-image` and the key
`openclaw-example`. The key permits only those two combos, denies direct models,
and has no administrator scope. Prompt logging is disabled for that key. Usage
metadata and OAuth account quotas remain shared in OmniRoute.

When updating key permissions through the API, retain `modelAccessMode:
"restricted"` explicitly when setting `allowedModels: []`. Clearing the model
list without an explicit restricted mode can normalize the key to allow-all.

The protected operator directory `/opt/openclaw/clients/example` records the
combo IDs, key ID, stack definition, deployment variables and recovery copies of
the two secrets. It contains live secrets: do not commit or share that directory.
The administrator password is not saved. Running services read customer-specific
Docker secrets; they have no Docker socket or host filesystem mount.

Initialization creates fresh data and refuses existing customer volumes or route
names. It never copies the operator's local conversations. If initialization
fails, inspect `provision.json` and the existing volumes, secrets and routes before
resuming manually. Do not delete customer volumes to make initialization pass.
An unused `bootstrap.env` left by a failed initialization is secret and must stay
inside the protected directory until recovery is complete.

The single replica is pinned to the manager hostname because its volumes are
local. Updates stop the old process before starting the new one, so two Gateways
never write the same SQLite databases concurrently. A multi-node migration needs
an explicit stopped backup and restore on the destination node.

## Change a customer's model centrally

In OmniRoute, edit only `oc-example-chat` to change that customer's chat model,
provider, provider connection or fallback policy. Edit `oc-example-image` to
change image generation. Keep both combo names stable. OpenClaw continues to use
`omniroute/oc-example-chat` and `openai/oc-example-image`; no container recreation
or OpenClaw configuration edit is needed. New requests use the new route; an
already running request can complete on its original backend.

Keep the capability contract when changing targets. A chat route still needs
tool calling, image input and the declared token budgets; the image route still
needs image generation. Switching to an incompatible or smaller model requires
adjusting the OpenClaw capability declaration. Audio and other modalities need
their own configured route and OpenClaw capability; changing a chat combo into
an audio model does not add that capability.

Do not rename or share customer combos, and do not grant `combo/*` or allow-all
model access to customer keys. Shared subscription accounts still share provider
limits; per-customer keys do not create independent quotas. Dedicated provider
accounts need their connection selection verified separately for chat and images.

## Verify the deployment

1. Check `docker service ps openclaw-example_gateway` and the container's health.
   Onboarding and the first Gateway boot can take several minutes.
2. Request `https://assistant.example.com/healthz` and `/readyz`; expect HTTP 200.
   Verify the sandbox `/mcp-app-sandbox` independently through its HTTPS origin.
3. Open the Gateway URL. Connect with the customer's `gateway.token` through the
   native UI and approve its device through the native `devices` commands. Keep
   device pairing enabled. Do not send tokens to another customer.
4. Send a normal chat request, run a harmless tool, and generate one real image.
   Confirm the image attachment opens in the customer UI.
5. With that customer's OmniRoute key, verify its two combos work and a direct
   backend model and an unrelated combo are rejected. Check usage attribution.
6. Change only that customer's chat combo to another compatible target, send a
   new request, and verify the selected backend in OmniRoute. Confirm the
   OpenClaw config hash is unchanged, then select the desired final target.
7. Inspect mounts: every customer must have different state/auth volume sources
   and different Docker secrets. Check that no host ports or Docker socket are
   exposed. The proxy overlay is shared transport; each Gateway still requires
   its own authentication and device pairing.

Run native maintenance commands from the deployment source directory on the
node holding the customer's volumes. The helper loads only that customer's
runtime secrets, including for CLI commands that resolve config secret references:

```bash
sh cli.sh example devices list
sh cli.sh example devices approve '<DEVICE_REQUEST_ID>'
sh cli.sh example config validate
```

## Update and back up a customer

Keep a stopped, consistent backup of **both** volumes, the Docker secrets and
the protected deployment directory before upgrades. Back up live SQLite only
through its supported backup mechanism, or stop the Gateway first; copying a
live database without its WAL can lose transactions. Protect backup retention
and restore permissions per customer. This template does not schedule backups.

Redeploy an existing customer from its protected directory, preserving volumes,
secrets, stable combo names and node placement:

```bash
cd /opt/openclaw/clients/example
set -a
. ./deployment.env
set +a
docker stack deploy --resolve-image never -c stack.yaml "openclaw-$TENANT"
```

For a runtime upgrade, first update the reviewed image pin and the customer's
`OPENCLAW_IMAGE`, pull that exact digest and run the validation above. Swarm
rollback restores a service specification, not a database schema or volume;
restore the stopped backup if the old runtime cannot read migrated state.

## Reproduce the local Docker fixes

Copy `local.override.yaml` to the repository root as the ignored
`docker-compose.override.yml`, preserving an existing `.env`. Set `OPENCLAW_IMAGE`
to the reviewed digest in `provision.py`. This override publishes both 18789 and
18790 on loopback, stores Linux-owned data in project-scoped named volumes, and
uses a curl healthcheck with time for the first boot.

```bash
docker compose config --quiet
docker compose up -d --no-build --wait --wait-timeout 480 openclaw-gateway
```

Use a different Compose project name and different host ports for each local
instance. Reusing a project name reuses its volumes. The Gateway chat model and
`agents.defaults.mediaModels.image` must both be configured: a chat subscription
alone does not register the image tool. The remote provisioner configures both
and routes the image provider through OmniRoute's OpenAI-compatible endpoint.

References: [Docker installation](https://docs.openclaw.ai/install/docker),
[MCP Apps](https://docs.openclaw.ai/cli/mcp/apps), and
[Gateway configuration](https://docs.openclaw.ai/gateway/configuration).
