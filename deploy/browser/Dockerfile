FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium ca-certificates curl fonts-liberation tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /home/node/.config/chromium \
    && chown -R node:node /home/node/.config

COPY --chown=node:node entrypoint.mjs /opt/browser/entrypoint.mjs

USER node
ENV HOME=/home/node
EXPOSE 9222
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl --fail --silent http://127.0.0.1:9222/json/version >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/browser/entrypoint.mjs"]
