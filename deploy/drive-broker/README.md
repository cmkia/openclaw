# Private central Drive broker

The broker uses one operator Google account and a server-owned folder grant for
each customer. The model receives only a customer-specific broker key. That key
cannot choose another folder, call arbitrary Google endpoints or access Google
OAuth credentials. The central root and customer folders must remain in their
configured ancestry; moved or inaccessible folders abort the inventory.

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

Build the image, push it to the deployment registry and record its digest. Set
`BROKER_IMAGE` to that digest, `NODE_HOSTNAME` to the volume-owning server and
`CENTRAL_ROOT_FOLDER_ID` to the operator's central folder, and
`GOOGLE_CREDENTIALS_SECRET` to the protected credential secret. Run:

```bash
docker stack deploy -c stack.yaml cmkia-drive
```

The service has no published port or Traefik router. It uses the existing private
overlay alias `cmkia-drive-broker:8090`. All operations except `/healthz` require
the customer's Bearer key. `GET /v1/status` proves authorization; `GET /v1/files`
must return a complete authorized inventory before the library may reconcile
deletions. `GET /v1/files/{id}/download` verifies folder ancestry again.

To revoke a client, remove its grant and secret mount, deploy the versioned
config, then revoke the library's broker secret. To revoke the central account,
revoke the Google OAuth authorization and replace the credential secret after
reauthorization. Other services must never mount this credential.
