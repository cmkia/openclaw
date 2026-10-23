FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl python3 libreoffice-impress poppler-utils \
    fontconfig fonts-inter fonts-jetbrains-mono fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && chown -R node:node /app
COPY --chown=node:node *.mjs validate.py ./
USER node
ENV NODE_ENV=production WORKSPACE_DIR=/home/node/.openclaw/workspace
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD curl --fail --silent --max-time 4 http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server.mjs"]
