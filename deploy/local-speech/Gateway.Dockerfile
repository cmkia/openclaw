ARG OPENCLAW_IMAGE
FROM ${OPENCLAW_IMAGE}

ARG OPENCLAW_IMAGE
LABEL io.openclaw.local-speech.base-image="${OPENCLAW_IMAGE}"
USER root
COPY --chown=0:0 deploy/local-speech/plugin/ /opt/openclaw/local-whisper/
COPY --chown=1000:1000 dist/control-ui/ /app/dist/control-ui/
RUN test -f /app/package.json \
    && mkdir -p /opt/openclaw/local-whisper/node_modules \
    && ln -s /app /opt/openclaw/local-whisper/node_modules/openclaw
USER 1000:1000
