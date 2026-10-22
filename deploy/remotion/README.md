# Private Remotion MCP

This service gives one OpenClaw tenant a private Remotion renderer through the
existing MCP integration. Each tenant runs its own instance and secret. It has
no public route and needs no changes to OpenClaw core or its dependencies.

Build with `docker build -t openclaw-private-remotion deploy/remotion` from the
repository root. The image pins Remotion packages to 4.0.538 and installs Chrome
Headless Shell during the build using the
[official Docker instructions](https://www.remotion.dev/docs/docker).

Mount the tenant workspace at `/home/node/.openclaw/workspace`, writable by UID
1000, and mount a nonempty tenant secret file. Set `REMOTION_API_KEY_FILE` to that
file's container path. `WORKSPACE_DIR` can select another shared mount, provided
it has the same absolute path in the gateway and renderer. The service refuses
to start without its workspace or secret. Recreate the service to rotate the key.

Connect OpenClaw's Streamable HTTP MCP client to `http://remotion:8080/mcp`, with
the `Authorization: Bearer <tenant-secret>` header. Keep port 8080 on the tenant
Docker network; do not publish it or attach a public reverse proxy. `GET
/healthz` returns health and busy status without authentication. MCP requests
use stateless JSON responses, so no session ID or SSE connection is required.

The agent first writes a React/Remotion project with OpenClaw's workspace tools.
Place the entry file at the project root; its sibling `public/` directory supplies
`staticFile()` assets. The entry must call `registerRoot()` and register its compositions. React,
React DOM, and Remotion resolve from the service's installed packages; additional
libraries must be available in the workspace project. A project-local Remotion
configuration file is not executed by this service.

The MCP tools are:

- `get_compositions`: accepts `entryPoint` and optional JSON `inputProps`. Returns
  composition IDs, dimensions, frame rates, and durations.
- `render_media`: accepts the same source arguments, `compositionId`, and an
  optional `outputPath`. Renders H.264 MP4 and returns `outputPath`,
  `workspaceRelativePath`, and `bytes`. The default destination is
  `renders/<unique-id>.mp4`. OpenClaw can read and send the resulting file from
  its shared workspace.

Paths may be relative to the workspace or absolute inside it. Entry files and
output ancestors resolve symlinks and must remain inside that workspace.
Existing output files and final symlinks are rejected. A failed render removes
its partial output. Bundle scratch files are removed after each operation;
finished videos stay in the tenant workspace until the agent/operator removes
them. This is a trusted tenant project execution service, not a sandbox for
untrusted third-party code or a boundary between users sharing one workspace.

One bundle/list/render operation runs at a time. Concurrent requests return a
busy error and should be retried after completion. Rendering uses one Chrome
worker; set suitable CPU/memory limits on each tenant's container. Allow a long
MCP client request timeout for videos. Health checks remain available while a
render runs. Updating the image preserves project source and rendered artifacts
in the shared mount; it does not modify running gateways or operator state.

Remotion has its own [license terms](https://www.remotion.dev/license). Check the
operator's applicable license before commercial use.
