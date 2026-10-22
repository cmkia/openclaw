# Private browser

This image provides one persistent Chromium browser per OpenClaw stack. It is
independent of the Chromium used by Remotion to render videos.

Build from this directory:

```sh
docker build -t app-openclaw-browser:local deploy/browser
```

Attach the service only to that stack's private network, with the `browser`
network alias. Do not publish port 9222 or attach Traefik labels: CDP grants full
control of the browser and its signed-in sessions. The browser needs outbound
Internet access to open websites.

Mount a dedicated persistent volume at `/home/node/.config/chromium`, writable by
UID/GID `1000:1000`. Never share it across tenants or replicas. Run one replica,
use stop-first updates, and allow a 30-second stop grace period so Chromium can
flush its profile. Keep local volumes pinned to their owning Swarm node. Startup
preserves cookies, local storage, and profile data; it never resets the profile.

Configure the owning OpenClaw instance:

```json
{
  "browser": {
    "enabled": true,
    "defaultProfile": "private",
    "ssrfPolicy": { "allowedHostnames": ["browser"] },
    "profiles": {
      "private": {
        "cdpUrl": "http://browser:9222",
        "attachOnly": true
      }
    }
  }
}
```

The built-in proxy rewrites Chromium's discovery and WebSocket endpoint to the
hostname requested by the client. Chromium itself listens on loopback port 9223
and runs as `node`; the container endpoint listens on port 9222. This also avoids
Chromium rejecting a Docker service name in the HTTP Host header. No environment
variables or npm dependencies are required.

Chromium runs with `--no-sandbox` for compatibility with ordinary Docker/Swarm
hosts. The container and private tenant network provide its isolation boundary;
do not grant it privileged mode, host networking, or access to the Docker socket.
Its profile contains credentials after login: protect volume access and backups.

Health checks verify `/json/version`. Verify a deployment from the OpenClaw
container with `openclaw browser --browser-profile private status` and an actual
browser navigation; HTTP discovery alone does not prove WebSocket attachment.
See [remote browsers](https://docs.openclaw.ai/tools/browser/remote).
