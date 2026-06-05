# @mailordomo/server — shared metadata service

Layer 2 of Mailordomo (PROJECT.md §3): a small, Dockerized, token-authenticated HTTP API that is
the **source of truth for everything that is not raw email and needs sharing** between Jan and
Simona — task state & transitions (with actor attribution), deadlines/follow-ups, the 3-way promise
records, per-thread notes, repo pointers, draft **metadata**, **locks**, the learning changelog,
tone-file sync, and the `subject`/`snippet`/`sender` shared-digest surface.

It **never stores raw email bodies or draft bodies** (Golden rule #3). The wire contracts are the
strict zod schemas in [`@mailordomo/shared`](../shared); a strict object rejects any undeclared key,
so a payload carrying a body field fails validation before it can be stored. The only large-text
fields are the two sanctioned exceptions: a user `Note.body` and a `ToneFile.content`.

There is **no two-way sync** (Golden rule #2): this service is the metadata truth; clients mirror
from it and never reconcile back.

## Stack

- **Hono** + `@hono/node-server` (Node 22).
- **better-sqlite3** in WAL mode, behind a **repository layer** (`src/repo/repository.ts` interface +
  `src/repo/sqlite.ts` implementation) so a SQLite→Postgres swap stays mechanical.
- **Plain SQL migrations** (`migrations/*.sql`) applied idempotently on startup by a tiny migrator
  (`src/db/migrate.ts`), tracked in a `schema_migrations` table.

## Run locally

```bash
# from the repo root
npm run build -w @mailordomo/server   # bundle to packages/server/dist/index.js
node packages/server/dist/index.js     # or: npm start -w @mailordomo/server (if added)

# during development, tests + checks for this package only:
npx tsc --noEmit -p packages/server
npm test  -w @mailordomo/server
npx eslint packages/server
npx prettier --check "packages/server/**/*.{ts,tsx,json,md}"
```

The server listens on `http://0.0.0.0:8787` by default and exposes `GET /health` → `200 {"status":"ok"}`.

## Environment variables

| Variable                 | Default              | Purpose                                                          |
| ------------------------ | -------------------- | ---------------------------------------------------------------- |
| `METADATA_PORT`          | `8787`               | Listen port.                                                     |
| `METADATA_HOST`          | `0.0.0.0`            | Bind host (container-reachable).                                 |
| `METADATA_DB_PATH`       | `./data/metadata.db` | SQLite file path (the parent dir is created if missing).         |
| `MIGRATIONS_DIR`         | _(auto-resolved)_    | Override the migrations directory (set in the Docker image).     |
| `METADATA_PROJECT_ID`    | _(unset)_            | Optional boot-seed: id of the shared project to provision.       |
| `METADATA_PROJECT_NAME`  | _(= id)_             | Optional boot-seed: display name.                                |
| `METADATA_PROJECT_TOKEN` | _(unset)_            | Optional boot-seed: **plaintext** token (only its hash is kept). |

Setting `METADATA_PROJECT_ID` + `METADATA_PROJECT_TOKEN` provisions a pairable project on startup —
the convenient way to bootstrap a fresh deployment.

## Auth & pairing

A `Project` stores only a `token_hash` (sha256 of the shared secret — **never the plaintext**,
Golden rule #4). A project is provisioned out of band (the `METADATA_PROJECT_*` boot-seed above, or
any process that calls the repository's `upsertProject`).

Requests authenticate by presenting the plaintext token **as a bearer token** alongside the project
id:

```
Authorization: Bearer <project-token>
X-Project-Id: <project-id>
```

The server hashes the presented token and compares it to the stored hash with a **constant-time**
comparison (`crypto.timingSafeEqual`). Every data endpoint requires this and is **scoped to the
authenticated project**; a missing/bad token → `401`. A body `project_id` that disagrees with the
authenticated project → `403`.

**Pairing** confirms credentials and echoes the client-safe project:

```bash
curl -X POST http://localhost:8787/pair \
  -H 'content-type: application/json' \
  -d '{"project_id":"acme","token":"s3cr3t"}'
# → 200 {"project":{"id":"acme","name":"Acme"}}     (never returns token_hash)
```

## Endpoints

All endpoints below require the `Authorization` + `X-Project-Id` headers. Each request body is
validated by the named `@mailordomo/shared` schema; single-item success responses are the
corresponding entity schema.

| Method & path                  | Request schema                  | Notes                                                       |
| ------------------------------ | ------------------------------- | ----------------------------------------------------------- |
| `GET /health`                  | —                               | Public liveness probe.                                      |
| `POST /pair`                   | `PairRequest`                   | Public; verifies the token, returns `PairResponse`.         |
| `POST /threads`                | `UpsertThreadRequest`           | Upsert by `(project_id, root_message_id)` → `Thread`.       |
| `GET /threads`                 | —                               | `Thread[]` for the project.                                 |
| `GET /threads/:id`             | —                               | `Thread` or 404.                                            |
| `POST /tasks`                  | `CreateTaskRequest`             | → `Task` (201); 404 if the thread is unknown.               |
| `GET /tasks?thread_id=`        | —                               | `Task[]` (optional thread filter).                          |
| `GET /tasks/:id`               | —                               | `Task` or 404.                                              |
| `PATCH /tasks/:id`             | `UpdateTaskRequest`             | Field edits → `Task`.                                       |
| `POST /tasks/:id/transitions`  | `CreateTaskTransitionRequest`  | Actor-attributed state change → `TaskTransition`; `409` if `expected_from` is stale. |
| `GET /tasks/:id/transitions`   | —                               | `TaskTransition[]` or 404.                                  |
| `POST /promises`               | `CreatePromiseRequest`          | → `Promise` (201).                                          |
| `GET /promises?thread_id=`     | —                               | `Promise[]`.                                                |
| `PATCH /promises/:id`          | `UpdatePromiseRequest`          | Reconciler updates → `Promise`.                             |
| `POST /notes`                  | `CreateNoteRequest`             | The sanctioned user `body` → `Note` (201).                  |
| `GET /notes?thread_id=`        | —                               | `Note[]`.                                                   |
| `POST /repos`                  | `CreateRepoPointerRequest`      | Shared identity only → `RepoPointer` (201).                 |
| `GET /repos`                   | —                               | `RepoPointer[]`.                                            |
| `POST /drafts`                 | `CreateDraftMetaRequest`        | Draft **metadata** only → `DraftMeta` (201).                |
| `GET /drafts?thread_id=`       | —                               | `DraftMeta[]`.                                              |
| `POST /locks/acquire`          | `AcquireLockRequest`            | `200 {acquired:true, lock}` / `409 {acquired:false, lock}` / 404. |
| `POST /locks/refresh`          | `RefreshLockRequest`            | Heartbeat → `200 Lock`; `409` if held by another; `404` if none. |
| `POST /locks/release`          | `ReleaseLockRequest`            | → `200 {released}`.                                         |
| `GET /locks`                   | —                               | Active (unexpired) `Lock[]`.                                |
| `PUT /tone`                    | `PutToneFileRequest`            | Last-write-wins → `200 {accepted, file}`.                   |
| `GET /tone`                    | —                               | `ToneFile[]`.                                               |
| `POST /learning`               | `CreateLearningEntryRequest`    | → `LearningEntry` (201).                                    |
| `GET /learning`                | —                               | `LearningEntry[]`.                                          |
| `POST /learning/:id/revert`    | `RevertLearningEntryRequest`   | Sets `reverted_at` (idempotent) → `LearningEntry`.          |
| `POST /digest`                 | `DigestMetadataRequest`         | Metadata-only read model → `DigestMetadata`.                |

### Lock semantics (the Jan/Simona double-handling guard)

- **acquire**: sets `locked_by`/`locked_at`/`expires_at` (TTL default **30 min**, override per call
  with `ttl_seconds`). Re-acquiring as the **same holder** acts as a heartbeat. An **expired** lock
  is acquirable by anyone. A contending acquire by a **different** holder while unexpired → `409`,
  with the current holder returned for presence.
- **refresh**: extends `expires_at` for the holder; `409` if a different actor holds it.
- **release**: frees the lock for the holder (or if already expired); a different active holder's
  lock is not released (`{released:false}`).

### Tone-file sync (last-write-wins)

The file identity is `(project_id, scope, path)`. The server arbitrates per file: the write with the
newer `updated_at` wins; ties break deterministically by `version_hash`. A stale write is a no-op and
the response returns the current authoritative `file` for the client to adopt.

## Docker

The image is multi-stage (see `Dockerfile`): the builder runs `npm ci` across the workspace and
tsup-bundles the server (inlining `@mailordomo/shared`); the runtime is `node:22-bookworm-slim`
carrying `dist/`, the native better-sqlite3 module, and the SQL migrations. The DB lives on a `/data`
volume and the server runs as the unprivileged `node` user.

Build from the **repo root** (the build context must include `packages/shared`):

```bash
docker build -f packages/server/Dockerfile -t mailordomo-metadata-service .

docker run --rm -p 8787:8787 \
  -v mailordomo-data:/data \
  -e METADATA_PROJECT_ID=acme \
  -e METADATA_PROJECT_NAME=Acme \
  -e METADATA_PROJECT_TOKEN=s3cr3t \
  mailordomo-metadata-service
```

CI (`.github/workflows/server-image.yml`) re-runs `npm run verify`, then on push to `main`/tags
builds this image and **publishes it to GHCR** as
`ghcr.io/<owner>/mailordomo-metadata-service` (no deploy step).
