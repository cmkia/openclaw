# Private Ads reports for OpenClaw

This optional tenant service exposes three read-only MCP tools:

- `ads_status`: check live authorization to the report collector. This does not
  prove that Meta or Google credentials are currently authorized.
- `ads_contas`: list explicitly granted accounts still present in the collector's
  trusted catalog. Unrelated clients and Drive folder fields are omitted.
- `ads_relatorio`: read daily campaign, ad or Google keyword reports, with a
  selected client, platform and inclusive ISO date range of at most 93 days.

The existing agency n8n report workflow remains the owner of Meta/Google
credentials, OAuth renewal, provider queries and normalization. The adapter
calls only `POST /webhook/agency-report-read-v1` on its configured HTTPS host.
It never accepts a caller URL, provider query, credential profile, account ID
override or mutation action. Do not add a second provider credential store here.
An upstream read failure or incomplete response cannot establish period totals.

The report collector credential also authorizes older workflows that can change
campaigns. Only this adapter mounts it. The Gateway receives a separate tenant
key that authorizes these three read-only tools. Neither Meta/Google credentials
nor the collector credential belong in the Gateway, its workspace, a skill,
chat, repository, image or browser. This limits what the model can request; it
does not protect against a compromised host or adapter process.

## Configure a tenant

Use accounts that the existing report owner already authorizes for this
operator. Adding an OpenClaw tenant does not add a client to the upstream
registry or grant access to other advertising accounts. Provision each tenant
separately; do not inherit another tenant's keys or account grants.

Save the following shape as a root-owned mode-0600 file, outside the repository
and build context, normally
`/opt/openclaw/clients/<tenant>/ads/credentials.json`:

```json
{
  "report_url": "https://reports.example.com/webhook/agency-report-read-v1",
  "collector_token": "<existing protected collector credential>",
  "accounts": [
    {
      "client_id": "<existing authorized client>",
      "google_customer_id": "<numeric customer ID without hyphens>",
      "meta_account_id": "<numeric account ID without act_>"
    }
  ]
}
```

An account ID can be empty when that platform is not authorized. An empty
account list denies all reports. The catalog must confirm the nonempty grant
IDs before it lists them. The adapter validates every returned report row
against the requested account and dates, including when the upstream registry
has broader access. An empty credential object starts in a visibly pending
state, rather than pretending to have an authorized connection.

Build and push `deploy/ads-broker` to the deployment registry, and record its
immutable image digest. It uses the same Python dependency versions as the
existing library service, without that service's document or model packages.
Copy the complete `deploy` directory to a protected release directory on the
Swarm manager. The deployment helper requires the manager's existing Python 3
and PyYAML installation. Run:

```bash
python3 deploy/ads-broker/deploy.py --tenant example \
  --image 'registry.example.com/openclaw-ads:<release>@sha256:<digest>' \
  --version v1
```

The helper admits credentials using the image with networking disabled, backs
up the tenant's canonical stack and Gateway config, creates versioned Docker
secrets, and merges this optional overlay into the complete existing stack.
It preserves other services and Gateway secrets, adds the scoped adapter key
export, waits for healthy services, publishes the native MCP config, and checks
all three tools with `openclaw mcp probe ads --json`. It then saves the complete
canonical stack for future redeployment. The Gateway restarts once to mount its
new key; the original conversations, library, browser profile and workspace
remain in their existing volumes. The CLI helper exports the optional key for
maintenance commands too.

There are no published ports, Traefik routes, host mounts, Docker socket,
workspace mounts or persistent adapter database. The runtime uses UID 10001,
an immutable root filesystem, dropped capabilities and a 256 MiB memory limit.
Only the health route is unauthenticated. Keep upstream TLS verification enabled.
The adapter joins only the tenant's capabilities network, which must allow
outbound HTTPS. Its unique `openclaw-<tenant>-ads` DNS alias avoids ambiguity
between tenants; it does not join the shared reverse-proxy network.

## Read reports accurately

Reports contain only returned delivery rows. They are not a full inventory of
campaigns with no activity. Costs are already in currency units; do not divide
them by a million again. Keep `currency_code`, `time_zone` and attribution
definitions when comparing results. Platform conversions do not prove unique
people, CRM leads or sales. URLs, thumbnail bytes, unknown fields and unrelated
client data are excluded from model responses.

`limit` (1–200) and `offset` paginate the full response locally. Each tool call
asks the existing owner for that period again, so pages are not a frozen
snapshot. `source_complete` describes the owner's response; `complete` is true
only when this response includes the whole report. Follow `next_offset` for
remaining rows and honor `pagination_limited` by shortening the period.

## Verification and recovery

Run the deterministic MCP boundary contract in the image, without network:

```bash
docker run --rm --network none --read-only \
  --mount type=bind,src="$PWD/deploy/ads-broker/tests",dst=/opt/ads-broker/tests,readonly \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --entrypoint python '<pinned-image>' tests/contract.py
```

The test runs real MCP initialize/list/call requests through the ASGI app and
replaces only the external report HTTP response. It verifies authentication,
read-only dispatch, account/date scope, fixed request serialization, rejection
of capability overrides, local pagination and error/secret redaction. It does
not prove live provider permissions. After deployment, run real short-period
reports for each selected platform, keeping private metrics out of public logs.

`ads/deployment.json` records the phase, image, secret names and backup location.
On interruption, inspect it and the actual Swarm tasks before repeating any
write. Existing credential versions are immutable and are never overwritten.
Recovery uses the recorded pre-change `stack.yaml` and `openclaw.json`; remove
only this integration's MCP entry through the native config owner before
restoring a stack without its Gateway key. Preserve concurrent unrelated config
edits and keep recovery files private. The helper refuses conflicting MCP
ownership or a canonical stack changed during deployment.

For rotation, replace the protected credential file, use a new `--version`, and
deploy again. The tenant API key is retained. Revoke the adapter by removing its
MCP entry, Gateway secret mount/export and service from the canonical stack, then
redeploying. Remove unused Docker secrets after confirming no services use them.
Keep shared upstream credentials under their existing owner's lifecycle.
