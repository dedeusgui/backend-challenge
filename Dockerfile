# Bun version is pinned to match .github/workflows/ci.yml and the local toolchain.
FROM oven/bun:1.4.4
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json bunfig.toml ./
COPY src ./src

# The process needs no root: it reads the code and talks to the network only.
USER bun
EXPOSE 3000
CMD ["bun", "run", "start"]
