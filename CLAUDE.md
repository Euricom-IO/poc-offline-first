# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A Bun-workspaces POC that compares **three offline/sync strategies for the same
multi-user todo app against one shared backend**. The interesting content is the
comparison, not the app: `packages/db` + `packages/api` are shared, and each
`web*` package implements a different read/write sync path. When changing shared
code, keep all three frontends working.

| Frontend             | Port | Reads                                     | Writes                                            |
| -------------------- | ---- | ----------------------------------------- | ------------------------------------------------- |
| `@app/web`           | 5173 | REST via TanStack Query collections       | REST (`/api/todos`, `/api/users`), optimistic     |
| `@app/web-electric`  | 5174 | ElectricSQL shape stream (host port 3010) | Dexie/IndexedDB event queue → `POST /api/events`  |
| `@app/web-powersync` | 5175 | PowerSync → local wa-sqlite, via `@app/proxy` | PowerSync CRUD queue → `POST /api/data`, via `@app/proxy` |

`packages/proxy` is a fourth, non-frontend package: a fault-injection dev proxy
in front of the API (`:3100`, control plane `:3101`) used to break the
`web-powersync` write path on demand. It is a test tool, never part of a
deployment.

## Commands

```bash
bun install
cp .env.example .env

bun run db:up            # docker compose: postgres 5432, electric 3010, powersync 8080
bun run db:migrate       # drizzle-kit migrate
bun run db:seed          # admin user  name: peter  pin: 12345 (no-op if it exists)

bun run dev              # API :3000 + web            :5173
bun run dev2             # API :3000 + web-electric   :5174
bun run dev3             # API :3000 + proxy :3100 (+ control :3101) + web-powersync :5175
bun run dev:api          # API only (bun --hot)
bun run dev:proxy        # fault-injection proxy only (bun --hot)

bun run build            # every package; web builds run vite build, api/db run tsc --noEmit
bun run db:generate      # generate a migration after editing packages/db/src/schema.ts
bun run db:studio
bun run lint / fmt / check   # Vite+ (`vp`) — NOT a workspace dependency, must be installed globally
```

### `.env` and the package scripts

Bun loads `.env` from the **process cwd**, and `bun run --filter` runs each
package from its own directory — so the repo-root `.env` never reached `@app/api`,
`@app/db` or `@app/proxy`. Every script that needs it therefore passes
`--env-file=../../.env` explicitly (a missing file is a no-op, not an error).

This was invisible for months because **every `process.env.X ?? default` in the
repo defaults to the same value `.env` sets** — `DATABASE_URL`, `JWT_SECRET`,
`API_PORT` all match, so nothing ever looked broken. The first var whose default
differed was `POWERSYNC_URL`: the API kept handing browsers
`http://localhost:8080`, so the PowerSync download stream bypassed the proxy
entirely and no `/powersync/*` fault could ever match. When adding an env var,
assume it is NOT reaching the process until you have checked.

`vite.config.ts` has the same trap for values read at **config time**: `envDir`
only covers `import.meta.env` in the browser bundle. `web-powersync` therefore
reads the root env with `loadEnv` for its dev-server proxy target;
`web`/`web-electric` still use `process.env.VITE_API_URL`, which is always
undefined — latent only because the fallback matches.

There are **no tests** in this repo. Typechecking is the only automated check:
`bun run build`, or `tsc --noEmit` inside a package. `tsconfig.base.json` is
strict in ways that fail builds on otherwise harmless edits —
`noUnusedLocals`/`noUnusedParameters` (a leftover import breaks the build) and
`verbatimModuleSyntax` (type-only imports must use `import type`). Lint config
lives in `.oxlintrc.json` but `vp` is not installed by `bun install`.

To verify a change, run the relevant `dev*` script and exercise the UI — offline
behaviour is tested by toggling the browser's offline mode.

## Architecture

### Layering (`packages/db` → `packages/api` → `packages/web*`)

- `@app/db` exports three entry points. **`@app/db/types` has no runtime
  dependencies** — it is the only one the browser bundles are allowed to import,
  which is what keeps drizzle/postgres out of the frontends. `@app/db` and
  `@app/db/schema` are server-only.
- `packages/api/src/services/*` hold all mutation logic. Each service takes a
  caller-provided transaction `Tx` and **never calls `getTxid`** — the caller
  (REST route, `/api/events`, or `/api/data`) owns the transaction and the txid.
  Update/delete return `null` on no match so the caller decides whether that's a
  404 (REST) or an already-applied no-op (sync replay).
- Services throw `ServiceError(status, message)`; every write path maps it to a
  `{ error }` JSON response. The status matters: the `web-electric` sync engine
  dead-letters 4xx and retries everything else forever, so choosing 4xx vs 5xx
  in a service decides whether a bad command poisons the client's FIFO queue.
- **Row ids are client-generated uuids on every write path.** The client sends
  `id` on insert and the services do `onConflictDoNothing({ target: <pk> })`,
  which is what makes a replayed insert a no-op rather than a duplicate. Don't
  "fix" a route to let Postgres generate the id.
- `mappers.ts` converts snake_case drizzle rows to the camelCase DTOs in
  `@app/db/types`. Only the REST path uses them.

### Frontend duplication

The three `web*` packages are near-copies: `src/lib/api.ts`, `src/lib/auth.ts`,
and `src/components/ui/*` are byte-identical across all three, and the routes
differ only where the sync layer leaks in. There is no shared UI package, so a
fix to any of those files has to be repeated three times.

- Routing is TanStack Router file-based; `src/routeTree.gen.ts` is generated by
  the vite plugin — never hand-edit it.
- Only `web-powersync`'s `vite.config.ts` sets `envDir` to the repo root, so
  only it sees `VITE_*` vars from the root `.env` via `import.meta.env`.
  `VITE_ELECTRIC_URL` placed in the root `.env` is **silently ignored** by
  `web-electric`, which falls back to `http://localhost:3010/v1/shape`. (The
  dev-server proxy target is unaffected — `vite.config.ts` reads
  `process.env.VITE_API_URL` at config time.)

### Naming split between frontends

`@app/web` collections hold **camelCase API DTOs** (`Todo` from `@app/db/types`).
`web-electric` and `web-powersync` collections hold **raw snake_case Postgres
rows** (`user_id`, `created_at`) because rows arrive straight from the
replication stream. `web-powersync` keeps the snake_case keys but exposes rich
values (`boolean`/`Date`), which takes **two zod schemas per collection**:

- `schema` — what the app writes and reads, so its input and output are both the
  rich types. It must accept its own output: on `update`, TanStack DB validates
  `merge(stored row, changes)` against it, so a `z.string().transform(Date)`
  here throws `SchemaValidationError` on *every* update of an untouched
  `created_at`.
- `deserializationSchema` — raw SQLite row (integer/text) → rich types, applied
  to rows arriving from the sync stream.
- `serializer` — rich types → SQLite values on write.

### `web-electric` write path

Reads and writes are on separate channels. `lib/eventStore.ts` (Dexie) persists
every mutation as a `SyncCommand` **before** it is sent; `lib/syncEngine.ts`
drains the queue strictly FIFO one command at a time, with fixed backoff
(1/2/5/10s) then an `/api/health` heartbeat. `submitCommand` returns a promise
that the collection's `onInsert`/`onUpdate`/`onDelete` resolves with the
Postgres `txid`, which is how Electric matches the optimistic row against the
synced one. Note `syncEngine`'s resolver map is in-memory, so it is empty after a
reload while the queue is not.

Two subtleties documented in the code and worth preserving:

- `lib/electric.ts` supplies a custom `fetchClient` that holds requests while
  `navigator.onLine` is false and releases them the instant `online` fires,
  because Electric's own reconnect backoff (up to 32s) ignores the `online`
  event. `ELECTRIC_BACKOFF` caps the unreachable-server case.
- `POST /api/events` is idempotent via the `processed_events` ledger: the
  client-generated event id and the row change commit in one transaction, and a
  replay short-circuits and returns the *original* txid.

### `web-powersync` write path

PowerSync owns the local SQLite DB (wa-sqlite over IndexedDB) and its own CRUD
queue; `ApiConnector.uploadData` in `lib/powersync.ts` POSTs a batch to
`/api/data`, which applies the whole batch in one transaction. Throwing from
`uploadData` (i.e. not calling `batch.complete()`) is the retry mechanism.

- Write-only fields cannot be columns, so the plaintext user `pin` rides as
  PowerSync **operation metadata** (`trackMetadata: true` on the table,
  `{ metadata: { pin } }` at the call site, `extractPin` on the server).
- Uploads carry **raw SQLite values**, so `completed` arrives as `0`/`1`, not as
  a JSON boolean. `decodeTodoData` in `routes/data.ts` converts it at the
  transport boundary; the shared services only ever see the REST-shaped payload.
- **A blocked upload also stops downloads.** PowerSync will not apply a
  checkpoint while the CRUD queue is non-empty (server state could overwrite
  un-uploaded local writes), so a failing `/api/data` makes the client go fully
  stale even though its download stream is connected and healthy. "Break writes
  only" is therefore not observable from the client — unlike `web-electric`,
  where reads and writes are genuinely separate channels.
- `components/SyncStatus.tsx` reports **both** directions for that reason: the
  CRUD queue depth *and* `db.currentStatus.connected`. A queue-only badge showed
  `Synced` while the download stream was dead, and showed `Syncing n` rather
  than an error when the server was unreachable (`navigator.onLine` stays true —
  it only sees the browser's own network). It escalates to `Not syncing` after a
  10s grace period, keyed on elapsed downtime rather than `status.connecting`,
  which flaps on every retry attempt.
- **There is no dead-lettering on this path.** `/api/data` collapses every
  failure — including `ServiceError`s that would be 4xx elsewhere — into a flat
  `400`, and the client just throws and retries, so a genuinely invalid op
  blocks the CRUD queue forever. This is the PowerSync counterpart of the
  poison-message problem in `specs/sync_improvements_v1.md`. Unknown tables in a
  batch are logged and skipped rather than failing it.
- `enableMultiTabs: false` is deliberate: the default SharedWorker gives all
  tabs one connection in a leader tab, and the TanStack DB diff-trigger
  reactivity then doesn't propagate to follower tabs.
- **Two tabs cannot be used to test sync.** Same origin plus same profile means
  the same IndexedDB, so both tabs share one wa-sqlite database *and* one CRUD
  queue — verified with uploads broken: a row written in tab 1 was already in
  tab 2's local DB and tab 2's badge showed the same `1 pending`, though tab 2's
  list did not re-render. A row crossing tabs therefore proves shared storage,
  not a server round-trip. Multi-client testing needs a second browser profile
  (private window, separate browser, or a Playwright MCP server with
  `--isolated`); across real profiles both directions propagate live, inserts
  and updates alike. See scenario 8 of the proxy README's checklist.
- `VITE_POWERSYNC_URL` **is** set in `.env.example`, so the default path is real
  bidirectional sync. If you unset it, `initPowerSync` falls back to a POC-only
  bridge: no `db.connect()`, so there is no download stream, and uploads are
  flushed manually from a `db.onChange` hook.
- PowerSync auth is a second, short-lived (5 min) token minted by
  `GET /api/powersync/token`. `hono/jwt` can't set a `kid` header, so
  `signPowerSyncToken` assembles and HMAC-signs it by hand. Its `kid`/`aud` must
  match `powersync/config.yaml`, and `PS_JWK_K` in `docker-compose.yml` is
  base64url(`JWT_SECRET`) — **changing `JWT_SECRET` requires regenerating it**
  (the command is in the compose comment). That endpoint also returns the
  service `endpoint` from the server-side `POWERSYNC_URL` env var (default
  `http://localhost:8080`, not in `.env.example`), which overrides the client's
  `VITE_POWERSYNC_URL` once credentials are fetched.

### Fault-injection proxy (`packages/proxy`)

`web-powersync`'s vite dev server forwards `/api` to `@app/proxy` on **:3100**,
which forwards to the API on :3000 (`VITE_PROXY_URL=http://localhost:3000`
bypasses it). It exists to break the PowerSync upload path on demand.

**Two upstreams** (`forward.ts` `resolveRoute`): `/powersync/*` goes to the
PowerSync service (`POWERSYNC_TARGET`, prefix stripped), everything else to the
API (`PROXY_TARGET`). So both PowerSync legs — the CRUD upload and the download
stream — are faultable, scoped by `path`.

**Two listeners** (`src/server.ts`): the data plane on `:3100` forwards and is
what faults apply to; the control plane on `:3101` arms them. They are separate
so `POST :3101/down` can stop the data plane — `:3100` then refuses connections
(`ECONNREFUSED`) and `:3101` is still there to call `/up`. `POST /fault` arms
one rule — `offline` (answer 500, never contact the API), `error` (any status),
`delay` (1–30s), `timeout` (never answer), `disconnect` (drop the socket) — and
`/{status,log,online,reset}` read and clear it. The control routes are also
mounted on the data port under `/__proxy` for convenience.
`packages/proxy/http/*.http` drives all of it, as does a dashboard at
`http://localhost:3101/ui`; the package README has the full surface, and its
**Sync fault checklist** is the end-to-end pass over the `web-powersync` path
(both directions, every mode, expected badge and server state per scenario) —
run it after touching the sync layer or `SyncStatus.tsx`.

Things that are load-bearing rather than incidental:

- **Only `POST` is faulted by default** (`methods: ["POST"]`). Reads and
  `GET /api/powersync/token` must keep working or the client cannot stay logged
  in while its writes fail. A rule can also be scoped by `path` prefix and by
  `count` (self-disarming after N requests).
- **`/__proxy/*` is registered before the catch-all and is never faulted**, so a
  fault can always be cleared — including while a `timeout` request hangs.
- **`down` ≠ `disconnect`.** `disconnect` drops one request's socket and the
  proxy keeps serving; `down` stops the listener, and also cuts connections that
  are already open (a held `timeout` request dies with it). Through vite the
  browser still gets a **502**, because vite answers for the connection it could
  not make — only a direct client (the `.http` files, curl) sees `ECONNREFUSED`.
- Listeners are parked on `globalThis` so `bun --hot` swaps the handler instead
  of rebinding the ports, and a data plane you took down **stays down** across a
  reload rather than quietly resurrecting.
- `upstream.ts` keeps the "is the API up" answer. Every forwarded request
  records it for free (the API answered, so it is up — whatever status), and
  `/health` only probes upstream when that is older than 5s. Without this the
  dashboard's status pill put a `GET /health` in the API's log every few
  seconds, which is most of what its log would then contain.
- `log.ts` records a request when it **arrives** (`startRequest` → `pending`,
  `finishRequest` fills in the outcome). Logging on completion instead made a
  stalled or hanging request invisible for exactly as long as it was the
  interesting thing to look at.
- The dashboard rebuilds its request list only when the entries actually change
  (`LogEntry.id` + a signature), and remembers which bodies are expanded —
  re-rendering on every poll collapsed an open body a second after it was
  opened.
- `POST /fault` with `dryRun: true` validates and describes a rule without
  arming it, always answering 200 with `valid`. The dashboard previews rules
  through it rather than reimplementing `describeFault` in the page, so the two
  descriptions cannot drift.
- The dashboard is `public/dashboard.html`, served by the control plane at `/ui`
  and at `/` when the request accepts HTML (curl and the `.http` files still get
  the JSON overview from `/`). It is deliberately **one file with no
  dependencies, no build step and no CDN** — a tool for simulating a dead
  network cannot need one — and it is read from disk per request, so editing it
  only needs a browser refresh.
- `idleTimeout: 0` on the Bun server is required: the default 10s would cut off
  a 30s delay (and `timeout`) before the client ever gave up.
- `disconnect` errors the response body stream, which is what actually drops the
  socket in Bun. The reason is a **string, not an `Error`**, purely so Bun logs
  one line instead of a stack trace that reads like a crash. Through the vite
  dev server it reaches the browser as a **502** (vite answers for the socket it
  lost), not as a `TypeError` — direct calls to :3100 see the real failure.
- `forward.ts` strips `content-encoding`/`content-length` along with the
  hop-by-hop headers: `fetch` hands back a decoded body, so forwarding the
  upstream's `content-encoding: gzip` would leave the client gunzipping JSON.
- A `502` whose body says `proxy: cannot reach …` means the API is genuinely
  down, not that a fault was injected.
- **`web-powersync` connects with PowerSync's HTTP streaming transport**
  (`connectionMethod: SyncStreamConnectionMethod.HTTP`), not the SDK default
  WebSocket, because the proxy speaks HTTP only — a WS upgrade gets a 501 saying
  so. HTTP mode is one long-lived `POST /sync/stream` returning ndjson;
  `VITE_POWERSYNC_TRANSPORT=websocket` switches back, but then
  `POWERSYNC_URL` must point straight at `:8080`.
- **A fault applies to a request as it arrives, so it does not touch an
  established stream.** The download stream connects once and stays open for
  minutes, so arming a fault changes nothing until it breaks — `POST /cut`
  (`streams.ts`) ends open streams on purpose, which is what makes the client
  reconnect into the armed fault. The dashboard's PowerSync presets arm+cut in
  one click.
- The endpoint the browser streams from is the one `GET /api/powersync/token`
  returns, i.e. the API's server-side `POWERSYNC_URL` — it overrides the
  client's `VITE_POWERSYNC_URL`, and the API reads it at **startup**, so
  changing it in `.env` needs an API restart, not just a hot reload. It also
  needs the API to actually see `.env` at all (see "`.env` and the package
  scripts"); when it does not, the value silently falls back to
  `http://localhost:8080` and the download stream goes straight to the service,
  where no fault can reach it. `GET /api/powersync/token` is the way to check
  which endpoint browsers are really being given.
- Unrelated to `specs/proxy.md`, which plans an authenticated Electric shape
  proxy *inside the API*.

### Database notes

- `docker-compose.yml` runs Postgres with `wal_level=logical` for Electric, plus
  a *separate* `powersync-storage` Postgres for PowerSync's buckets.
- Migration `0001` creates the `powersync` publication `FOR ALL TABLES`; without
  it the PowerSync service fails with `PSYNC_S1141`.
- `packages/db/src/schema.ts` is the source of truth — edit it, then
  `bun run db:generate`. Migrations are excluded from lint.

## POC security caveats (intentional, don't "fix" silently)

- Electric runs with `ELECTRIC_INSECURE=true` and the browser talks to it
  directly: **reads are unauthenticated and unscoped**. `pin_hash` is withheld
  only by a client-supplied `columns` param.
- `powersync/sync-config.yaml` streams `SELECT * FROM todos` / `users` globally
  with no `request.user_id()` filter, so every client receives every row (and
  `pin_hash` crosses the wire even though the client schema drops it).
- PIN is the only credential, the JWT is a shared HS256 string in `localStorage`,
  and the token lives 7 days.

`specs/proxy.md` is the written plan for closing the Electric read hole via an
authenticated shape proxy in the API.

## `specs/`

Design docs, not generated output — read them before reworking the sync layer.
`sync_v2.md` (generic offline-first engine design), `sync_improvements_v1.md`
(worst-first critique of the current `web-electric` layer, e.g. the poison-message
head-of-line block), `proxy.md`, `partitioning.md`.

## Known drift

`packages/web2` was renamed to `packages/web-electric`; the root scripts are
already fixed (`dev2`/`dev3`, `dev:web-electric`, `dev:web-powersync`), but the
old name survives in `specs/proxy.md`, `specs/sync_improvements_v1.md`, a
`docker-compose.yml` comment, and code comments in `web-electric/src/lib/`.

One `web2` reference is **load-bearing**: the Dexie database is named
`web2-sync` (`lib/eventStore.ts`). Renaming it orphans every queued event in
browsers that already have the old DB, so it needs a migration, not a rename.

`tsc --noEmit` in `packages/web-powersync` does not currently pass, and
`bun run build` there runs `vite build`, which does not typecheck — so it goes
unnoticed. Two pre-existing failures: an unused `TanStackRouterDevtools` import
in `src/routes/__root.tsx`, and a `TS2769` on both `createCollection` calls
caused by three copies of `@tanstack/db` in the lockfile (`react-db@0.1.96`
resolves `db@0.7.0`, `powersync-db-collection@0.1.67` resolves `db@0.9.0`, whose
`SyncConfig` gained `markError`). It is types-only — the app runs.
