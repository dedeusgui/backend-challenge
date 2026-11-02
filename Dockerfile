# syntax=docker/dockerfile:1
# Bun version is pinned to match .github/workflows/ci.yml and the local toolchain.
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d
WORKDIR /app

COPY --chown=bun:bun package.json bun.lock ./
RUN --mount=type=secret,id=proxy_ca,required=false \
    if [ -s /run/secrets/proxy_ca ]; then \
      NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca bun install --frozen-lockfile --production; \
    else \
      bun install --frozen-lockfile --production; \
    fi

COPY --chown=bun:bun tsconfig.json bunfig.toml ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun docs/openapi.json ./docs/openapi.json

# The process needs no root: it reads the code and talks to the network only.
USER bun
EXPOSE 3000
CMD ["bun", "run", "start"]
