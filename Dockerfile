FROM oven/bun:1
WORKDIR /app

COPY package.json ./
RUN bun install

COPY tsconfig.json bunfig.toml ./
COPY src ./src

EXPOSE 3000
CMD ["bun", "run", "start"]
