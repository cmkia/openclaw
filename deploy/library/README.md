# Add a private textbook library to an OpenClaw tenant

This deployment adds PostgreSQL with pgvector, a library API/MCP server, and a
background ingestion worker to an existing customer stack. OpenClaw continues to
own its conversations, SQLite databases, workspace and wiki. Docling remains an
independent container in that stack. The library does not replace OpenClaw memory.

New customers receive these services through the
[standard client provisioner](../clients/README.md), which also installs Docling,
private Chromium and Remotion and configures the Gateway's MCP connections.
The additive workflow below remains available for existing stacks.

The stack file is an **additive overlay**. Deploy it without `--prune`: it contains
only the three new library services, so pruning would remove the existing Gateway
and Docling services. The deployment script never changes either service.

## Components and storage

- `library-db`: PostgreSQL 17 and pgvector 0.8.7, pinned to the upstream Docker
  manifest digest. It joins only the tenant's internal library network. The
  database owns the catalog, document versions, chunks, embeddings and job state.
- `library-api`: authenticated REST and MCP endpoint on container port 8080.
  `/healthz` is available without credentials for the container health check;
  document and tool operations require the tenant's Bearer key. The API joins the
  tenant network and the existing proxy overlay so the Gateway can call it.
- `library-worker`: downloads authorized materials, calls Docling and builds the
  index. It shares the tenant's original/extraction volume and model cache with
  the API. The worker's job state persists in PostgreSQL.
- The Google Drive broker is a separate integration. Its customer-specific key
  limits access to the configured folder; the library receives no general Drive
  OAuth credential. A pending OAuth connection must be reported as pending rather
  than as a successful synchronization.

There are no published host ports. Traefik exposes only the
`/library/download/` path on the customer's Gateway/origin hostnames; the API
validates a short-lived, document-specific download grant. These links contain no
API key and expire after ten minutes. API/MCP/status endpoints remain private.
The proxy overlay is shared transport, not a customer authentication boundary.
The API key remains required for tools even on that network. PostgreSQL is absent
from the shared overlay. Containers have no Docker socket or host filesystem mount.

Each tenant receives external volumes named `openclaw-<tenant>-library-postgres`,
`openclaw-<tenant>-library-data` and `openclaw-<tenant>-library-models`, plus its own
`openclaw-<tenant>-library-private` internal overlay. The deployment pins all
services to the current manager because these volumes are local to that node.

The initial limits are 1 CPU/1 GiB for PostgreSQL, 1 CPU/1.5 GiB for the API and
2 CPUs/2.5 GiB for the worker. The API and worker can each load the multilingual
`intfloat/multilingual-e5-small` embedding model. These limits are starting
budgets, not measurements of large-book processing. Docling's existing allocation
is separate; measure peak memory, queue duration and OCR quality on real books
before increasing concurrent jobs.

## Prepare the manager

Requirements:

- Linux Docker Swarm manager, Python 3 and the existing customer's Gateway.
- The attachable proxy overlay, normally `traefik-proxy`.
- A running Docling service reachable over that overlay with its customer key.
- An existing customer-scoped Drive broker Docker secret. The broker can remain
  unconnected until the central OAuth setup is complete.
- A built library image available to that manager, pinned by SHA-256 digest.

Build from this directory and record the source commit and resolved image digest
with the operator release. `requirements.txt` pins direct dependencies; the
Dockerfile defines the Python and CPU PyTorch runtime. A repeatable deployment
reuses the resulting image digest rather than silently rebuilding a release.

```bash
docker build -t registry.example.com/openclaw-library:<release> .
docker push registry.example.com/openclaw-library:<release>
docker image inspect registry.example.com/openclaw-library:<release> \
  --format '{{join .RepoDigests "\n"}}'
```

The database image is
`pgvector/pgvector:0.8.7-pg17-bookworm@sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d`.
The tag and manifest were checked against the
[upstream project](https://github.com/pgvector/pgvector) and Docker Hub registry
metadata. Keep the PostgreSQL major version fixed for existing volumes; a major
upgrade requires a separately planned backup and migration.

## Deploy the library services

Copy this directory into a protected release directory on the manager. Run:

```bash
python3 scripts/deploy.py \
  --tenant example \
  --image 'registry.example.com/openclaw-library:<release>@sha256:<digest>' \
  --docling-url http://docling-example:5001 \
  --docling-secret '<EXISTING_DOCLING_DOCKER_SECRET>' \
  --broker-secret 'openclaw-example-drive-broker-key-v1' \
  --origin-host origin.example.com \
  --enable-gliner
```

The broker URL defaults to `http://cmkia-drive-broker:8090`; use `--broker-url`
to change it. The public hostname, proxy network and certificate resolver default
to `GATEWAY_HOST`, `PROXY_NETWORK` and `CERT_RESOLVER` in the existing customer's
`deployment.env`. Override them through `--public-host`, `--proxy-network` and
`--cert-resolver`. Supply `--origin-host` when an upstream edge proxy forwards the
origin's hostname. The public base URL passed to the library is
`https://<public-host>/library`. A higher-priority Traefik route strips `/library`
only on `/library/download/`; all other paths continue to the existing Gateway.

`--enable-gliner` enables optional biomedical entity extraction as a separate
post-ingestion job. It uses `Ihor/gliner-biomed-small-v1.0` pinned to revision
`9892e7cd16b9a4aa33572b8b80271cd178f1059a`. Only the worker loads that model;
enrichment failures preserve access to the converted document. Its scored entity
candidates remain unreviewed and do not establish clinical relationships. Measure
the combined embedding/entity model memory on representative books. Omit the flag
to leave enrichment disabled; it does not block basic retrieval.

`--prepare-only` creates the protected resources and rendered stack
without starting services. It still creates volumes, secrets and the network.
It also supports preparation before a new Gateway exists, allowing the standard
provisioner to submit the complete stack once. Ordinary additive deployment
continues to require an existing Gateway.

The script creates three library Docker secrets: database password, database DSN
and library API key. Recovery copies are mode 0600 under
`/opt/openclaw/clients/<tenant>/library`; keep that operator directory private and
out of Git. It records non-secret deployment parameters and the rendered stack
there, retaining the previous definitions for recovery. Repeated runs reuse
existing secrets and data. If a Docker secret already exists but its original
recovery file is missing, deployment refuses to generate a conflicting value.

The API and worker read secrets from files owned by UID 1000, matching the image
user. The stack specifies only secret names and paths, not secret values.

Docker submits the services asynchronously. Deployment submission is not proof
that the migration, model loading, Drive connection or MCP tools work. Check:

```bash
docker service ps openclaw-example_library-db
docker service ps openclaw-example_library-api
docker service ps openclaw-example_library-worker
```

Expect one running task per service. Check the API container's `/healthz`, then
exercise an authenticated MCP call, a small document import, chapter listing and
a search with an original page citation. Confirm that an incorrect API key is
rejected. Test a not-found query and keep its result distinguishable from an
extraction or connection failure. Use synthetic materials for proof logs.

Connect OpenClaw separately through its supported MCP configuration. On the shared
overlay the endpoint is `http://openclaw-<tenant>-library:8080/mcp`. Mount that
tenant's `openclaw-<tenant>-library-api-key-v1` secret into its Gateway and resolve
the Authorization header through the deployed OpenClaw version's supported
environment/secret mechanism. Never place the literal key in a committed config
or log it. Validate the config before the controlled Gateway restart and confirm
tool discovery afterward. This script intentionally does not edit Gateway state.

The MCP server exposes twelve `biblioteca_*` tools covering status/jobs, book and
chapter inventory, scoped search, paginated section reading, chapter coverage,
URL import, Drive synchronization, original-page links, entity candidates and
study-note preparation. `biblioteca_preparar_fichamento` returns a cited Markdown
bundle with `persisted: false`; use the enabled memory-wiki tools to save and
curate it. The wiki remains the sole owner of study notes, with no second notes
database in PostgreSQL.

## Use the library

Put large books in the assigned Drive folder, then ask OpenClaw to synchronize
the library and report ingestion jobs. Synchronization is on demand; this
deployment does not install a polling schedule. The current original-file limit
is 512 MiB. Chat attachment limits are a separate transport contract.

Pasting a Google Drive file link into `biblioteca_importar_url` uses the same
authorized folder API, including files in its subfolders. Files remain
Restricted; no browser login or public sharing is required. A link to the
assigned root folder queues synchronization. Links outside that scope are
rejected before queueing, and ordinary public document URLs retain their public
download path. Poll the returned job and document status before reporting that
an import is complete. A broker or Google connection failure returns an
actionable HTTP 503 response, distinct from an out-of-scope link. Retry through
the private connection; if the failure persists, the operator should check that
connection. Changing file sharing is not a recovery step.

For an opt-in live routing regression, run
`python3 tests/drive_link_contract.py --config /private/proof-config.json` against
an approved tenant with a private synthetic fixture. The script creates import
jobs, including a full folder synchronization, so use a tenant whose current
folder contents are approved for ingestion. The protected configuration holds
`base_url`, `key_file`, `private_file_url` and `assigned_folder_url`; the report
contains check results without credentials or resource URLs.

The offline `tests/drive_unavailable_contract.py` regression exercises file and
folder imports through the authenticated ASGI app with a loopback broker that
returns HTTP 503. Run it in the library image with `--network none`; it needs no
Google credentials, PostgreSQL or model downloads.

If conversion fails after an original was saved, inspect Docling task history
for out-of-memory exits before retrying. Size its memory from the real book,
then retry the failed conversion job through the API. The saved original and
persisted Docling task identifier are reused; another Drive download is unnecessary.

Select the book, edition and chapter before preparing a weekly class. Ask for
the chapter coverage manifest, read every section through its final page, and
retain evidence IDs and physical page references. An inferred chapter structure
is visible as `pending_review`; a successful conversion does not approve it.
Check OCR, tables and numerical values against the original.

Use the study-note tool to prepare a cited bundle and the native wiki to persist
and curate it. Wiki notes remain derived material awaiting human review. The
library supplies evidence and chapter coverage; a presentation export pipeline
and validation with the resident's actual textbooks are separate next steps.

## Publish the book's reading maps in the wiki

Ingestion populates the library index. It does not create wiki pages. Native
`wiki ingest` creates a source, and `wiki compile` builds indexes from existing
pages; neither operation writes a chapter synthesis. The Memory Wiki tab shows
syntheses, concepts and entities rather than raw source imports.

After conversion reaches `ready` or `pending_review`, the manager can use
Python 3.10 or newer to publish the book's catalog and chapter maps through the
native wiki owner:

```bash
python3 deploy/library/scripts/project_wiki.py \
  --tenant example --document-id '<DOCUMENT_UUID>'
# Inspect the generated plan and Markdown under the tenant's private library directory.
python3 deploy/library/scripts/project_wiki.py \
  --tenant example --document-id '<DOCUMENT_UUID>' --apply
```

Run from a checkout containing `deploy/clients/cli.sh`. An installed copy can
select that same canonical helper with `--cli-helper /path/to/cli.sh`; the helper
receives the tenant explicitly. The Gateway must have the memory-wiki plugin
enabled. `--agent` defaults to `main`; `--workspace` selects a nonstandard
workspace path when needed. No database or Gateway restart is required.

The script reads the authenticated library API, prepares one source outline,
chapter maps, a book index and a library catalog. Maps contain extracted section
names, physical page ranges, coverage gaps and provenance. They remain marked
`review`. They are navigation material; preparing study notes still requires
reading and checking the chapter. An optional protected `--provenance-file`
can attach a matching prior source/version observation without claiming that
the Drive version was checked again.

Existing source and study pages are preserved on reruns. New books are merged
into the managed catalog through native mutations, preserving its metadata and
human notes. At completion the script calls Gateway `wiki.compile`, then checks
`wiki.overview` against the published page IDs. This refreshes the live dashboard
snapshot that a separate CLI process's compile may leave cached.

Publication is on demand; this command does not install a background schedule.
Run it for each completed book, then use the enabled wiki tools for cited study
notes. PostgreSQL remains the owner of original evidence and retrieval; the
native wiki remains the owner of reading maps and notes.

## Back up and recover

Back up before changing schema or image versions. The backup helper pauses only
the library API and worker, waits for their tasks to stop, makes a PostgreSQL
custom-format dump and archives the original/extracted files. It restores their
previous replica counts afterward. The Gateway and Docling continue running;
library tools are briefly unavailable.

Swarm's replica count can reach zero before an old container exits. The helper
also waits for every matching API/worker container to stop before taking either
snapshot; after five minutes it refuses to call the backup coordinated and
restores the previous replica counts.

```bash
python3 scripts/backup.py \
  --tenant example \
  --destination /srv/private-backups/example-library-<timestamp> \
  --quiesce
```

The backup directory must be new and remains mode 0700. A successful backup has a
`manifest.json` with file sizes, SHA-256 checksums and the image identities.
It also records quiescent table counts, original document hashes/sizes and hashed
chunk/source projections for comparing an isolated restore against that snapshot.
Directories without a manifest are incomplete and must not be treated as valid
backups. There is no automatic backup scheduler or deletion policy.

Back up the protected operator directory and Docker secret recovery files through
the operator's credential backup process. OpenClaw's wiki and SQLite state are in
its existing state volume and need a separate OpenClaw backup. The model cache is
downloadable and excluded from this library backup.

For recovery, verify the checksums, create fresh isolated volumes on a recovery
node, restore `library.dump` with PostgreSQL 17/pgvector installed and extract
`library-data.tar.gz` into the new data volume with ownership preserved. Use the
recorded library image and recovered secrets. Exercise import, search, citations
and job recovery before cutting over. Never restore over active customer volumes
or assume that a successful dump proves a successful restore.

For an image-only rollback with a compatible schema, deploy the protected
`stack.previous.yaml` into the same tenant stack **without `--prune`**. Do not
delete volumes or rotate credentials to recover an application failure. Database
schema rollback needs a reviewed migration or a stopped backup restore; an older
image alone cannot reverse a schema change.

To undo the Gateway's library connection, first remove only
`mcp.servers.biblioteca` through the native configuration CLI while the Gateway
still has its library secret mount and environment export. Validate the config.
Then restore its previous startup arguments and remove only that library secret
mount, keeping the protected canonical stack consistent with the live service.
Rolling back the service first can leave a configuration referencing an unset
environment variable and prevent admission. Keep the pre-connection config/stack
backups private; restore a whole config only after checking that it would not
discard later unrelated edits. None of these steps requires deleting databases,
originals or wiki state.

## Material quality and current boundaries

Keep the original document and edition authoritative. Chapter boundaries, page
mapping, tables and OCR need validation against real books. A chapter presentation
must inspect all its sections rather than rely solely on top-ranked search
results. Citation existence is necessary but does not prove that the cited text
supports every claim. Numerical and clinical statements require original-source
checking and the resident's review.

Wiki entries are derived study artifacts. Keep automatic suggestions separate
from reviewed notes. GLiNER/entity enrichment and cross-book links require their
own validation; deploying the database does not establish their accuracy.

OAuth authorization, Drive synchronization, entity extraction and presentation
generation must each be verified independently before being described as working.
Do not infer a live connection from an installed component or a healthy container.
