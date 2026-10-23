# Private central Drive broker

The broker uses one operator Google account and a server-owned grant for each
customer. Folder access is the default. An operator can explicitly grant one
customer read-only access to the connected account's Drive. The model receives
only a customer-specific broker key; it cannot change its grant, call arbitrary
Google endpoints or access Google OAuth credentials. Folder grants require the
central root and customer folders to remain in their configured ancestry;
moved or inaccessible folders abort the inventory.

The broker offers read-only inventory and downloads. It skips Drive shortcuts,
exports native Google documents as PDF, enforces download size limits and
returns version metadata so the library can reject changed downloads. It never
publishes an incomplete inventory as complete. Google's native document export
limit is 10 MB; uploaded PDFs use the configured 512 MiB download limit.

## Authorize the central account

Use an existing Google Cloud project with Drive API enabled. Create a dedicated
desktop OAuth client in that project. Save its downloaded JSON to a protected
operator directory outside the repository and Docker build context. Do not
change organization policies to create service-account keys.

Install `google-auth-oauthlib==1.2.3` in an operator virtual environment. Forward
loopback port 15003 from the operator workstation to the server and run:

```bash
python authorize.py --client /opt/cmkia-drive/oauth-client.json \
  --output /opt/cmkia-drive/credentials.json --login-hint operator@example.com
```

Open the printed Google authorization URL in the operator's browser. Google
redirects to the loopback callback; passwords and authorization codes never go
through chat. The helper saves an `authorized_user` JSON with offline refresh
token using mode 0600. A service-account credential is also supported when an
organization explicitly permits it and the account has folder access. An OAuth
app in external testing can issue short-lived refresh tokens; check the project's
publishing status before relying on unattended synchronization.

Create the credential Docker secret and one random broker key per customer.
Set `GOOGLE_CREDENTIALS_SECRET` to the credential secret's versioned name.
It can contain either supported credential format. Keep recovery files private.

## Deploy

Create Docker config `cmkia-drive-client-grants-v1` from an operator-only JSON:

```json
{
  "customer_slug": {
    "folder_id": "CUSTOMER_FOLDER_ID",
    "api_key_file": "/run/secrets/customer_broker_key"
  }
}
```

Add each key as a distinct secret mount in the stack. The example stack mounts
Erika's key; its grant must use `/run/secrets/erika_broker_key`. The grant name is
the client identifier returned by the broker. Rotate the Docker config version
when adding a grant, rather than silently changing an existing config.
Set `BROKER_CLIENTS_CONFIG` to that new versioned config name; it defaults to
`cmkia-drive-client-grants-v1` for existing deployments.

For an explicitly authorized customer that needs the entire connected Drive,
add a separate grant and secret mount:

```json
{
  "customer_slug": {
    "access_scope": "drive",
    "api_key_file": "/run/secrets/customer_broker_key"
  }
}
```

Omitting `access_scope` retains folder access; `"access_scope": "folder"` is
also accepted with a valid `folder_id`. Drive grants must omit `folder_id`.
Unknown or conflicting grants prevent startup. Other customers' grants remain
unchanged. The existing Google `drive.readonly` permission is sufficient; this
grant does not permit editing, deleting, changing sharing or accessing files the
connected Google account cannot read. It does not start a library import.

Drive inventory uses Google's `allDrives` corpus, including shared drives where
the account is a member, and skips folders and shortcuts. It follows every page and rejects an
incomplete search, repeated pagination token or configured inventory limit
without publishing partial results as complete. The default limit counts up to
20,000 inspected items. Google Workspace documents are exported as PDF in both
grant modes. File links use an individual metadata lookup and download, so they
remain usable when the account exceeds the full synchronization inventory limit.
The individual lookup never claims to be a complete account inventory and must
not be used to reconcile unrelated library sources.

Build the image, push it to the deployment registry and record its digest. Set
`BROKER_IMAGE` to that digest, `NODE_HOSTNAME` to the volume-owning server and
`CENTRAL_ROOT_FOLDER_ID` to the operator's central folder, and
`GOOGLE_CREDENTIALS_SECRET` to the protected credential secret. Run:

```bash
docker stack deploy -c stack.yaml cmkia-drive
```

The service has no published port or Traefik router. It uses the existing private
overlay alias `cmkia-drive-broker:8090`. All operations except `/healthz` require
the customer's Bearer key. `GET /v1/status` proves authorization and reports
`access_scope`, `read_only: true` and `folder_id` (null for Drive grants). Drive
status performs a live Google list request. `GET /v1/files`
must return a complete authorized inventory before the library may reconcile
deletions. `GET /v1/files/{id}` returns one authorized document's normalized
metadata under `file`, with its grant scope and no `complete` flag.
`GET /v1/files/{id}/download` verifies Google download permission,
size and version in both modes, and folder ancestry again for folder grants.

To revoke a client, remove its grant and secret mount, deploy the versioned
config, then revoke the library's broker secret. To revoke the central account,
revoke the Google OAuth authorization and replace the credential secret after
reauthorization. Other services must never mount this credential.

## Verify grants

With the broker's pinned requirements installed, run:

```bash
python tests/scope_contract.py
```

The tests exercise the real ASGI routes and credential matching with synthetic
credentials, replacing only Google HTTP responses. They require no live account
or additional test dependencies and can run in the broker image with networking
disabled and this directory mounted read-only.
