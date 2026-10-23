ARG OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:2026.10.5@sha256:f40d1e66fd14d8c5b49c832f4100f83b53fdc01f5108f7db11de38fd0ee6dbe5
FROM ${OPENCLAW_IMAGE}

USER root
ARG TARGETARCH=amd64
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) checksum=d53cf89f0c2a2338211212e380b3efcacadd4e27e500cb8e7ed2cd82a739da2e ;; \
      arm64) checksum=9ae69d117cef895aa1c50b5859d7d3def45c5580886b25dc1c7f3cfe128ed0dd ;; \
      *) echo 'Unsupported gog architecture' >&2; exit 1 ;; \
    esac; \
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      "https://github.com/openclaw/gogcli/releases/download/v0.46.0/gogcli_0.46.0_linux_${TARGETARCH}.tar.gz" \
      --output /tmp/gog.tar.gz; \
    echo "$checksum  /tmp/gog.tar.gz" | sha256sum --check --status; \
    tar -xzf /tmp/gog.tar.gz -C /usr/local/bin ./gog; \
    chmod 0755 /usr/local/bin/gog; \
    rm /tmp/gog.tar.gz; \
    gog --version
USER 1000:1000
