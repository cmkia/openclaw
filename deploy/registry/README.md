# Single-node private image registry

The Contabo manager uses this loopback-only registry to deploy private library
images by immutable manifest digest. It stores application images, not client
documents or credentials. Builds must exclude runtime secret files.

Copy `compose.yaml` to `/opt/cmkia-image-registry/compose.yaml`, then run
`docker compose -f /opt/cmkia-image-registry/compose.yaml up -d`.
Push images to `127.0.0.1:15002/cmkia/<application>:<version>` and record the
reported digest in the corresponding customer deployment.

This setup is for services pinned to this manager. Another node cannot reach
this loopback endpoint; multi-node deployment needs a private authenticated
registry reachable from every approved node. Do not publish this HTTP endpoint
on a public interface. Preserve the registry volume when updating the service.
