FROM oven/bun:1.4.0-alpine AS dependencies

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM dependencies AS build

COPY tsconfig.json ./
COPY src ./src
RUN bun run build

FROM oven/bun:1.4.0-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production \
    && rm -rf /root/.bun/install/cache

COPY --from=build --chown=bun:bun /app/dist ./dist

USER bun

EXPOSE 3000

HEALTHCHECK --interval=5s --timeout=3s --start-period=20s --retries=20 \
  CMD ["bun", "--eval", "const port = Bun.env.APP_PORT ?? '3000'; const response = await fetch('http://127.0.0.1:' + port); if (response.status >= 500) process.exit(1);"]

CMD ["bun", "dist/main.js"]
