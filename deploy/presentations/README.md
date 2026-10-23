# Academic presentations for an isolated OpenClaw tenant

This optional presentation service renders a structured roteiro into editable PowerPoint, PDF, and slide previews. The tenant's reasoning model remains behind OmniRoute. Magnific is called through its existing authenticated OpenClaw MCP for conceptual illustrations. Presentation rendering uses its own private MCP; no change to OpenClaw core is needed.

## Responsibilities

- `skill/apresentacoes-erika/` owns Erika's presentation workflow, source discipline, and composition examples. Install this complete folder at `<tenant-workspace>/skills/apresentacoes-erika/`. It is intended for workspace discovery and automatic use on presentation requests; no credentials belong in the bundle.
- `manifest.mjs` owns the version 1 external artifact contract and validation. The manifest is a named deck input artifact, not another application state database.
- `render.mjs` owns the executable `erika-dark-v1` theme, native editable shapes/tables/charts, image embedding, and export. The skill's design reference describes this owner; it does not provide a competing theme implementation.
- The private presentation service exposes `presentations__presentations_render` and `presentations__presentations_check`. Inspect the advertised tool schemas before calling. Rendering uses files in the current tenant's workspace and writes a new output folder for each revision.
- Magnific owns generation jobs, authentication, models, and credit consumption. The skill records image provenance and uses completed local files. The renderer does not fetch remote images.

The skill's `scripts/download_image.py` bridges a completed Magnific asset URL to a local workspace file using Python 3's standard library. Pass the temporary signed HTTPS URL on stdin and a new relative PNG/JPEG filename with `--output`; the optional `--workspace` overrides `OPENCLAW_WORKSPACE_DIR` or cwd. It pins validated public DNS addresses while retaining TLS hostname verification, revalidates up to five redirects, bypasses proxy environment variables, enforces a 20 MiB limit and matching image signature, and publishes without overwriting files or following parent symlinks. Its JSON output contains the relative path, bytes, SHA-256, and format; signed URL queries are never logged or included in provenance. Downloading an existing creation needs no new image generation or browser control.

## User workflow

Erika can ask in Portuguese, for example:

> Use este roteiro para montar 12 slides. Mantenha a ordem, use o estilo das minhas apresentações e crie as ilustrações necessárias com o Magnific. Entregue o PPTX e o PDF com notas e referências.

The assistant reads the supplied document through authorized tools, maps sources, creates the manifest, downloads completed images, renders the deck, inspects every preview, corrects issues, checks the PowerPoint package, and attaches the usable files. Private Drive sources continue through the tenant's authenticated biblioteca/Drive access. They do not need public sharing. RAG enrichment is optional; the supplied roteiro remains the primary input.

An explicit slide count and sequence are preserved. Missing evidence is recorded as a source gap. Numeric charts and tables remain native; image generation supplies conceptual illustration, not clinical evidence or plotted measurements. Existing image-generation authorization and task budget apply without asking again for each image.

## Pilot and visual examples

The skill includes five inspected reference PNGs from the supplied chapter 21, 22, and 23 presentations. They are composition examples, not reusable scientific evidence or finished slide screenshots. The workspace bundle is approximately 2 MiB. Its cover reference exceeds 1 MiB, so use the documented workspace installation rather than importing this bundle unchanged into a managed skill library with a 1 MiB per-file limit.

`skill/apresentacoes-erika/references/pilot-manifest.json` exercises all eight layouts. Its table and chart use visibly synthetic values. Academic concepts cite the supplied chapter 23 roteiro items, without inventing bibliographic pagination or claiming that the pilot independently verifies clinical claims. Image paths assume the skill has been installed under the tenant workspace's `skills/` folder. A real-model integration test may replace a cover image with one newly generated Magnific illustration and record its actual provenance.

## Verification and delivery

`presentations__presentations_render` accepts a workspace-relative `manifestPath` and an optional `outputDirectory`; it returns PPTX, PDF, PNG, validation, and count results. Use the actual returned paths. The service keeps outputs below the tenant workspace; the operator must not share another client's workspace or add a public file server.

`presentations__presentations_check` accepts the generated `presentationPath` and checks the package. Package and text-fit validation do not establish scientific correctness or visual quality. Open every slide PNG, check source/value mapping, and inspect editable objects and speaker notes before attaching the final PPTX and PDF through the current channel. Do not claim successful delivery from a server path alone.

The stack needs the presentation service's pinned dependencies, LibreOffice, Poppler, and installed Inter/JetBrains Mono fonts for reproducible export. PPTX files reference these fonts without embedding them; install both fonts on the editing desktop to preserve the intended typography. PDF exports retain the server-rendered appearance. Keep the service private and use the same isolated workspace already owned by the tenant. Install the skill as workspace files; there is no new cron, public plugin publication, patient database, or model configuration in this feature.

## Install on an existing Swarm tenant

Run `deploy.py` as root on the Swarm manager where exactly one instance of the tenant's Gateway is running. Use Python 3.10 or newer and keep this deployment folder intact, including `stack.yaml` and `skill/`. Build and publish the approved image first, then pass its immutable digest:

```bash
python3 deploy/presentations/deploy.py \
  --tenant example \
  --image 'registry.example/presentations@sha256:<64-hex-digest>'
```

This phase installs only the presentation service and workspace skill. It submits the `presentations` service to the existing `openclaw-example` stack without `--prune`; other services remain owned by their existing deployment. It discovers the actual workspace from the longest matching Gateway mount, including a workspace nested in its state volume, and binds only that workspace into the renderer. It creates an internal private overlay and a dedicated Docker secret. The recovery secret and deployment records are kept under `/opt/openclaw/clients/example/presentations/`, with a private directory and files. An existing secret with a missing or mismatched recovery file is refused rather than rotated.

When the Gateway connection is authorized, repeat with `--connect`:

```bash
python3 deploy/presentations/deploy.py \
  --tenant example \
  --image 'registry.example/presentations@sha256:<64-hex-digest>' \
  --connect
```

`--root` selects another operator client root, and `--cli-helper` selects its canonical tenant CLI helper. The default is `<root>/cli.sh`; that helper must export `PRESENTATIONS_MCP_AUTHORIZATION` from the mounted secret. The connection phase backs up the current Gateway service, config, and replaced skill; adds the private network and secret; and inserts the authorization export into the known Gateway shell command. It waits for the native service update to converge. It then registers only the `presentations` MCP through the native OpenClaw CLI, preserving other named servers such as Magnific and biblioteca. It does not print secret values. Unknown Gateway commands, persistence layouts, or a presentation MCP owned by another endpoint require explicit reconciliation instead of a guessed mutation.

The private `gateway.override.yaml` is a Compose fragment containing the updated command and the presentation network/secret additions. Future canonical Gateway redeployments must include **the original base, all existing tenant overrides, and this presentation override last**. Do not deploy the fragment alone or replace the base with it: native Compose merging preserves the original networks, mounts, routes, and other secrets. The full prior service inspection remains in the private backup for recovery.

After connection, run a live MCP probe and a real-model render, inspect the returned previews, check the PPTX package, and verify attachment/download delivery. A successful deployment command establishes installation, not presentation quality or completed file delivery.
