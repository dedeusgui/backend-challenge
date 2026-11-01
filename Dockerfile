# Bun version is pinned to match .github/workflows/ci.yml and the local toolchain.
# The digest keeps the base image reproducible: the publisher can move a tag, but not a digest.
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json bunfig.toml ./
COPY src ./src
COPY docs/openapi.json ./docs/openapi.json

# The process needs no root: it reads the code and talks to the network only.
USER bun
EXPOSE 3000
CMD ["bun", "run", "start"]
