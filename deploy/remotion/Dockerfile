FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl libnss3 libdbus-1-3 libatk1.0-0 libgbm-dev \
    libasound2 libxrandr2 libxkbcommon-dev libxfixes3 libxcomposite1 \
    libxdamage1 libatk-bridge2.0-0 libpango-1.0-0 libcairo2 libcups2 \
    fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && chown -R node:node /app
USER node
RUN npx --no-install remotion browser ensure
COPY --chown=node:node server.mjs ./
ENV NODE_ENV=production \
    WORKSPACE_DIR=/home/node/.openclaw/workspace
EXPOSE 8080
CMD ["node", "server.mjs"]
