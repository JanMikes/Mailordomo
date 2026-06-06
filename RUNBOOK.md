# RUNBOOK — Connect your first real mailbox (Seznam) end-to-end

> Goal: get real mail flowing **IMAP → cache → triage → 3-way promises → Today view**, locally and
> privately. This is the operational guide for the seam wired in **D35** (the daemon's live source).
>
> Scope note (read first): this connects the **inbound** path — the daemon reads your mail, triages
> it, and surfaces it. **Sending is still a stub** in this build (the manual "Send" button composes a
> draft and exercises the flow but does not transmit — golden rule #1 keeps the daemon send-proof, and
> real SMTP is a deliberate follow-up). Nothing you do here sends email.
>
> Credentials are **yours to enter** — this runbook never asks anyone but you to type them. They go to
> the macOS **Keychain** (mailbox password) and a gitignored **`.env`** (the metadata token), never to
> git, the config file, the metadata server, or logs.

---

## 0. What you need

- **Node 22+** and the repo built (`npm install && npm run build`).
- The headless **`claude`** binary on `PATH` (`claude --version` works). Mailordomo runs it under your
  **subscription** — do **not** set `ANTHROPIC_API_KEY` (the app warns if it's set; it would divert to
  paid API billing).
- **Docker** (for the metadata service), or any way to run the bundled `packages/server/dist/index.js`.
- A **Seznam app-password** (Step 1).
- Pick two values now and reuse them everywhere below:
  - `METADATA_PROJECT_ID` — any short id, e.g. `personal`.
  - `METADATA_PROJECT_TOKEN` — a long random secret, e.g. `openssl rand -hex 24`.

---

## 1. Seznam app-password + provider settings (provider-specific)

Seznam does **not** accept your normal web password over IMAP/SMTP — you must generate a dedicated one:

1. Sign in at **email.seznam.cz** → **Nastavení (Settings)** → **Souhrnné nastavení** →
   **„IMAP/POP3/SMTP a Exchange ActiveSync"**.
2. Enable IMAP access and **generate a password for external clients** ("heslo pro IMAP/POP3/SMTP").
   Copy it — you'll paste it into the wizard once (Step 5). It is shown only once.

Seznam endpoints (you'll enter these in the wizard's **Custom** preset):

| Protocol | Host             | Port | Security                 |
| -------- | ---------------- | ---- | ------------------------ |
| IMAP     | `imap.seznam.cz` | 993  | SSL/TLS (secure = **on**)|
| SMTP     | `smtp.seznam.cz` | 465  | SSL/TLS (secure = on)    |

Provider quirks already verified live against Seznam (PLAN.md D23) and handled by the code:

- **No CONDSTORE.** Incremental new-mail sync works everywhere; externally-made flag changes (read/star
  in another client) only surface on a periodic full rescan — a known, recorded v1 limitation, not a blocker.
- **SPECIAL-USE by flag, not name.** Seznam's `spam` folder is resolved by its `\Junk` flag, never by an
  English name. The daemon watches **INBOX** only (where new mail lands), so this doesn't affect triage.
- **Connection caps.** One IMAP connection per mailbox (the design); Seznam is fine with the single
  resilient IDLE connection the daemon opens.

---

## 2. Start the metadata service (Layer 2), seeded with your project

The service stores **only** the token's hash; seeding it with `METADATA_PROJECT_*` provisions a pairable
project on startup.

```bash
# from the repo root — build + run the image (see packages/server/README.md for Docker details)
docker build -t mailordomo-metadata -f packages/server/Dockerfile .
docker run -d --name mailordomo-metadata \
  -p 8787:8787 \
  -v "$HOME/.mailordomo/metadata-data:/app/data" \
  -e METADATA_PROJECT_ID="personal" \
  -e METADATA_PROJECT_TOKEN="<the token you generated>" \
  -e METADATA_PROJECT_NAME="Personal" \
  mailordomo-metadata
```

(No Docker? `npm run build -w @mailordomo/server` then run `node packages/server/dist/index.js` with the
same `METADATA_*` env.)

**You should see / verify:**

```bash
curl -s http://localhost:8787/health
# → {"status":"ok"}

curl -s -X POST http://localhost:8787/pair \
  -H 'content-type: application/json' \
  -d '{"project_id":"personal","token":"<the token>"}'
# → {"project":{"id":"personal","name":"Personal"}}   (credentials accepted)
```

---

## 3. Configure the backend `.env`

Copy `.env.example` → `.env` (gitignored) and set at least:

```bash
METADATA_SERVICE_URL=http://127.0.0.1:8787
METADATA_PROJECT_ID=personal
METADATA_PROJECT_TOKEN=<the same token>

# Local app
BACKEND_HOST=127.0.0.1
BACKEND_PORT=4317
MAILORDOMO_CONFIG_DIR=~/.mailordomo
MAILORDOMO_CREDENTIALS=keychain          # macOS Keychain holds the mailbox password (preferred)

# Daemon — keep OFF for the wizard step; we turn it on in Step 6.
MAILORDOMO_DAEMON=off
MAILORDOMO_DAEMON_INITIAL_BACKLOG=25     # on the FIRST sync, triage the 25 most-recent INBOX messages
# MAILORDOMO_DAEMON_INTERVAL_MS=300000   # cold-poll cadence (default 5 min); IDLE handles new mail sooner
```

> Do **not** put your Seznam password in `.env` when using the Keychain — the wizard stores it in the
> Keychain in Step 5. (The `IMAP_PASSWORD` line in `.env.example` is only the dev fallback for
> `MAILORDOMO_CREDENTIALS=env`.)

---

## 4. Start the backend + frontend (daemon still OFF)

```bash
npm run build

# Foreground dev run. `npm start` reads process env (it does NOT auto-load .env), so source it first:
set -a; . ./.env; set +a
npm start
# → mailordomo-backend api listening on http://127.0.0.1:4317 (ws /api/ws)

# in a second terminal — the UI (Vite dev server, proxies /api → 127.0.0.1:4317):
npm run dev --workspace=@mailordomo/frontend
# → open the printed URL (http://localhost:5173)
```

**You should see:** the app loads; the **wiring** is green for the metadata service (it paired with your
token). The Today view is empty — no mail has been triaged yet. That's expected.

---

## 5. Run the setup wizard — add the Seznam mailbox

In the UI, open the **Setup** view and walk the stepper:

1. **Project** — name it (e.g. "Personal"). (This is a *local* grouping; it need not equal
   `METADATA_PROJECT_ID`.)
2. **Mailbox** — pick the **Custom** provider preset, then enter:
   - **Email / address:** your full `you@seznam.cz` (this becomes the mailbox login user and the thread's
     `mailbox_address`).
   - **IMAP:** host `imap.seznam.cz`, port `993`, **secure on**.
   - **SMTP:** host `smtp.seznam.cz`, port `465`, **secure on** (used only when real send lands later).
   - **Password:** paste the **Seznam app-password** from Step 1. (It's `type=password`, write-only —
     cleared after save, never echoed back, never logged.) "Use same password for SMTP" is fine.
   - Click **Test connection** → expect a green **ok** (a read-only IMAP login; no mail is changed).
3. **Repo** (optional) — skip or link a local repo path for repo-aware answers.
4. **Claude health** — expect green (the `claude` binary resolves and `--version` works).
5. **Finish.**

**What just happened (and where things live):**

- Non-secret mailbox config → `~/.mailordomo/config.json` (host/port/user/address — **no password**).
- The app-password → macOS **Keychain**, under service `mailordomo:<mailboxId>:imap`. Verify:
  ```bash
  security find-generic-password -s "mailordomo:$(node -e "console.log(require('os').homedir())" >/dev/null 2>&1; echo)" >/dev/null 2>&1 || true
  # simpler — list what config knows, then look it up by the printed mailbox id:
  cat ~/.mailordomo/config.json | python3 -c 'import json,sys; m=json.load(sys.stdin)["mailboxes"]; print([x["id"] for x in m])'
  security find-generic-password -s "mailordomo:<that-mailbox-id>:imap" >/dev/null && echo "keychain entry present (value not printed)"
  ```

---

## 6. Turn the daemon on → first sync → Today renders real threads

The daemon reads its mailbox config + Keychain password **at startup**, so after the wizard you must
(re)start with it enabled.

**Foreground (quickest to watch):**

```bash
set -a; . ./.env; set +a
MAILORDOMO_DAEMON=on npm start
```

**Or install the always-on launchd service** (it sets `MAILORDOMO_DAEMON=on` and sources `.env` for you):

```bash
npm run build
bash ops/install-launchd.sh
# logs: ~/.mailordomo/logs/backend.{out,err}.log
# stop: launchctl bootout gui/$(id -u)/com.mailordomo.backend
```

**What you should see, in order (foreground stdout, or the launchd `*.out.log`):**

```
[daemon] live: watching you@seznam.cz INBOX via imap.seznam.cz (cold poll 300000ms, IDLE-hot on new mail).
[daemon] cycle complete { processed: 25, tasksCreated: 25, transitions: 0, promisesCreated: N, summarized: M, nudgesDrafted: 0, deferred: K, errors: [] }
```

- On the **first** cycle it triages the **25 most-recent** INBOX messages (the `INITIAL_BACKLOG` bound);
  the rest are cached and browsable but not force-triaged. Thereafter only **new** arrivals are processed
  (idempotent — re-running never double-triages or duplicates promises).
- The local cache fills: `~/.mailordomo/cache.sqlite` + raw `.eml` bodies under `~/.mailordomo/cache-blobs/`
  (**bodies live here, locally, and never leave**).
- Refresh the UI: the **Today** view now shows real threads — 3-way promise metric cards, done-vs-remaining
  counts, and ranked do-next cards. New mail appears within seconds (IDLE) or within the cold-poll interval.

If instead you see `"[daemon] enabled but not fully configured"` or `"no IMAP password stored"`, the
wizard config or the Keychain entry isn't visible to this process — recheck Steps 3/5 and that you
restarted with the env sourced.

---

## 7. Verify it's actually working (and that nothing leaked)

### A. Today view (the product surface)

- **Real threads, real senders/subjects** appear as do-next cards. Each card shows a state badge
  (needs-reply / drafted / waiting / follow-up / done), the sender, a snippet, and a deadline if one was
  extracted.
- **Ranking reads right** (PROJECT.md §8): your own promises (green) lead, then their requests (amber),
  then sender importance, then staleness. The metric cards (my promises / they asked / awaiting them)
  reflect what the daemon extracted.
- Opening a thread shows the locally-read body and (once summarized) a pinned Sonnet summary.

### B. Metadata service (what crossed the privacy boundary — should be metadata only)

```bash
ID=personal; TOK="<the token>"
H=(-H "Authorization: Bearer $TOK" -H "X-Project-Id: $ID")

curl -s "${H[@]}" http://localhost:8787/threads  | python3 -m json.tool | head -40
curl -s "${H[@]}" http://localhost:8787/tasks    | python3 -m json.tool | head -40
curl -s "${H[@]}" http://localhost:8787/promises | python3 -m json.tool | head -40
```

- `/threads` should list your real threads with **only** `subject`, `snippet` (≤200 chars), `sender`,
  `mailbox_address`, `root_message_id`, timestamps — and **no body/text/html field anywhere**.
- `/tasks` shows states the daemon inferred; `/promises` shows the 3-way records it extracted.
- **Privacy spot-check** — pick a sentence that appears *deep* in one email's body (past the first ~200
  chars) and grep the entire metadata surface for it; it must **not** appear (only the bounded snippet may):
  ```bash
  curl -s "${H[@]}" http://localhost:8787/threads | grep -i "<a phrase from deep in a body>" && echo "LEAK ❌" || echo "no body leaked ✓"
  ```

### C. Logs (daemon behavior)

- `[daemon] cycle complete { ... }` lines show `processed`/`tasksCreated`/`promisesCreated` climbing on
  real mail and `errors: []`. `nudgesDrafted` only rises for genuinely overdue inbound promises (it
  **drafts**, never sends). `deferred` rising under load is the usage throttle protecting your Claude
  subscription window — expected, not an error.
- A dropped connection logs `[daemon imap] imap connection dropped` then a reconnect — the daemon owns
  its backoff/reconnect (ImapFlow doesn't).
- There should be **no send/SMTP activity** of any kind from the daemon.

### D. No secrets / no bodies left the machine

```bash
# Nothing secret in git or the config file:
git -C "$(pwd)" status --porcelain        # .env must NOT appear (it's gitignored)
grep -RIn "<your app-password>" . 2>/dev/null && echo "SECRET IN TREE ❌" || echo "no secret in tree ✓"
python3 -c 'import json;c=json.load(open("'"$HOME"'/.mailordomo/config.json"));print("password" in json.dumps(c) and "PW IN CONFIG ❌" or "no password in config ✓")'

# Bodies are local only — present in the cache, absent from the server:
ls ~/.mailordomo/cache-blobs/ | head        # raw .eml live here (local, never uploaded)
```

- The app-password lives **only** in the Keychain; `config.json` is password-free; `.env` (the metadata
  token) is gitignored. The metadata server holds metadata + the bounded snippet only.

---

## Known limitations in this build (recorded, not bugs)

- **Sending is stubbed** — the manual Send button does not transmit yet (real SMTP is a follow-up). The
  daemon is structurally send-proof regardless (golden rule #1).
- **Restart after config changes** — the daemon reads mailbox config + creds at startup; re-run the
  wizard then restart the backend/launchd service to pick up changes.
- **First-sync fetch** — the first sync downloads the full INBOX to the local cache (bodies for the recent
  backlog are what get triaged); large mailboxes take a moment on first run.
- **Non-CONDSTORE flag sync (Seznam)** — externally-made read/flag changes surface on a periodic rescan,
  not instantly.
- **One mailbox / one project (v1)** — the daemon watches the first configured mailbox's INBOX.
