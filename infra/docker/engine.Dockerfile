# Motor de emisión (FFmpeg + agente Node). Misma imagen para Cloudflare Containers, VPS o Kubernetes.
# NO PROBADO en este repositorio todavía: la máquina de desarrollo no tenía Docker (ver docs/ACCEPTANCE_TESTS.md).
FROM node:22-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/engine apps/engine
RUN pnpm install --frozen-lockfile --filter @dni/engine... --ignore-scripts && pnpm --filter @dni/engine build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /src/apps/engine/dist/index.mjs ./index.mjs
COPY --from=build /src/node_modules ./node_modules
ENV NODE_ENV=production FFMPEG_PATH=/usr/bin/ffmpeg FFPROBE_PATH=/usr/bin/ffprobe DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data /app
# Sin privilegios: el proceso que ejecuta FFmpeg nunca es root.
USER node
VOLUME /data
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "index.mjs"]
