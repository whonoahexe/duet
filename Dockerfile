# duet: one Node process (Fastify) serving the static Next export, /api and /healthz.
# Debian (glibc) base on purpose: better-sqlite3 and @node-rs/argon2 ship prebuilt glibc binaries.
# No ARG carries a secret. The private SDK's BuildKit npm secret mount is added in plan 01-05.

FROM node:24-bookworm-slim AS build
# better-sqlite3 13.0.3 has no prebuilt binary for this Node ABI, so its install falls back to
# node-gyp. The toolchain lives only in the build stage; the compiled addon is copied over.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/package.json
COPY server/package.json server/package.json
COPY shared/package.json shared/package.json
RUN npm ci
COPY . .
RUN NEXT_EXPORT=1 npm run build -w web
# tsx stays (server runtime dependency); drizzle-kit, vitest and typescript go.
RUN npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared ./shared
COPY --from=build /app/server ./server
COPY --from=build /app/web/package.json ./web/package.json
COPY --from=build /app/web/out ./web/out
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3100
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3100/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--import", "tsx", "server/src/index.ts"]
