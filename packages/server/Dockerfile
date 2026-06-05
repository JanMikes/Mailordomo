# Mailordomo metadata service — multi-stage image.
#
# Build CONTEXT is the repo root (so the builder can inline @mailordomo/shared's TS source); the
# Dockerfile lives in packages/server. See packages/server/Dockerfile.dockerignore for the context
# filter. The GHCR workflow builds and publishes this image (no deploy step).
#
#   builder  — npm ci across the workspace, then tsup-bundle the server. tsup INLINES
#              @mailordomo/shared (+ zod/hono) into dist/index.js, leaving only the native
#              better-sqlite3 binary external. python3 + build-essential are present ONLY here, as a
#              fallback in case better-sqlite3 has no prebuilt binary for the target platform.
#   runtime  — slim Node 22; carries dist/ + the better-sqlite3 native module (and its tiny runtime
#              deps) + the migrations; runs as the unprivileged `node` user; DB on a /data volume.

# ----------------------------------- builder ----------------------------------------
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Toolchain fallback for a from-source better-sqlite3 build (prebuilt binary is used when available).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

# Pin npm 11 to match the lockfile generator: the repo's lock is npm-11, but node:22 ships npm 10,
# whose `npm ci` would reject the npm-11 lock as out of sync.
RUN npm install -g npm@11

# Install deps first (cached until a manifest or the lockfile changes). npm ci validates the
# lockfile against EVERY workspace, so all workspace manifests must be present.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/
RUN npm ci

# Only the sources the server bundle needs (shared is inlined). Backend/frontend source is not
# copied, so their churn never busts this image's build.
COPY packages/shared packages/shared
COPY packages/server packages/server
RUN npm run build -w @mailordomo/server \
  && cp -r packages/server/migrations packages/server/dist/migrations

# ----------------------------------- runtime ----------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# The only runtime dependency not bundled is the native better-sqlite3 module and its tiny runtime
# closure (bindings → file-uri-to-path). Node resolves these from /app/node_modules.
COPY --from=builder /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=builder /app/node_modules/bindings ./node_modules/bindings
COPY --from=builder /app/node_modules/file-uri-to-path ./node_modules/file-uri-to-path

# Bundled server + the SQL migrations (read at startup; MIGRATIONS_DIR points straight at them).
COPY --from=builder /app/packages/server/dist ./dist

ENV METADATA_PORT=8787 \
    METADATA_HOST=0.0.0.0 \
    METADATA_DB_PATH=/data/metadata.db \
    MIGRATIONS_DIR=/app/dist/migrations

# The SQLite DB lives on a volume; make it writable by the unprivileged runtime user.
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

EXPOSE 8787
USER node
CMD ["node", "dist/index.js"]
