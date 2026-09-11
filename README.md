# poc-offline-first

A Bun monorepo POC: a multi-user todo app with a Hono API, a Drizzle/Postgres
data layer, and **three React frontends that demonstrate three different sync
strategies** against the same backend:

- **`web`** — optimistic TanStack DB collections backed by the Hono REST API.
- **`web-electric`** — TanStack DB collections that **read** live from ElectricSQL's
  shape stream and **write** through a durable, offline-first event queue.
- **`web-powersync`** — a local SQLite database (wa-sqlite/IndexedDB) kept in sync
  by a self-hosted PowerSync service; writes go through PowerSync's durable CRUD
  queue.

## Packages

```
packages/
  db             @app/db             Drizzle schema, migrations, seed, DB client (Postgres)
  api            @app/api            Hono HTTP API + JWT auth (depends on @app/db)
  web            @app/web            React SPA — REST-backed TanStack DB query collections
  web-electric   @app/web-electric   React SPA — ElectricSQL reads + offline event-sync writes
  web-powersync  @app/web-powersync  React SPA — PowerSync local-first SQLite + CRUD upload
```

Bun workspaces only (no Turborepo). Root scripts fan out with `bun run --filter`.

## Stack

- **Runtime / package manager:** Bun
- **Web:** React 19, TanStack Router (file-based), TanStack DB (query collections),
  shadcn/ui, Tailwind CSS 4
- **API:** Hono, `hono/jwt` (HS256)
- **DB:** PostgreSQL via Docker, Drizzle ORM + drizzle-kit
- **Sync (web-electric):** ElectricSQL shape stream (`@electric-sql/client` +
  `@tanstack/electric-db-collection`) for reads; a Dexie/IndexedDB event queue
  for durable offline writes
- **Sync (web-powersync):** self-hosted PowerSync service (`@powersync/web` +
  `@tanstack/powersync-db-collection`) over a local wa-sqlite database; writes
  are uploaded from PowerSync's CRUD queue to `POST /api/data`
- **Lint / format:** [Vite+](https://viteplus.dev/guide/) (`vp lint` / `vp fmt` / `vp check`)

## Getting started

```bash
bun install          # install all workspaces
cp .env.example .env # DATABASE_URL, JWT_SECRET, ports

bun run db:up        # start Postgres + ElectricSQL + PowerSync (docker compose)
bun run db:migrate   # apply migrations
bun run db:seed      # create the initial admin user

bun run dev          # API (:3000) + web           (:5173) — REST-backed frontend
bun run dev2         # API (:3000) + web-electric  (:5174) — ElectricSQL frontend
bun run dev3         # API (:3000) + web-powersync (:5175) — PowerSync frontend
```

Open the frontend you started (http://localhost:5173, `:5174` or `:5175`) and
sign in. `db:up` brings up Postgres, the Electric sync service (host port
`3010`) that `web-electric` reads from, and the PowerSync service (host port
`8080`, plus its own storage Postgres) that `web-powersync` streams from.

### Initial admin

| Name  | PIN     | Role  |
| ----- | ------- | ----- |
| peter | `12345` | admin |

## How it works

- **Login** is name + PIN. The API verifies the PIN (hashed with `Bun.password`)
  and returns a 7-day JWT signed with `JWT_SECRET`. The SPA stores it in
  `localStorage` and sends it as `Authorization: Bearer <token>`.
- **Auth guarding** happens both in the router (`beforeLoad` redirects) and in the
  API (`authMiddleware` / `adminOnly`).
- **Todos** and **users** both use fully optimistic TanStack DB query collections
  ([todos](packages/web/src/collections/todos.ts),
  [users](packages/web/src/collections/users.ts)): `insert`/`update`/`delete` apply
  instantly and are persisted through the API's `onInsert`/`onUpdate`/`onDelete`
  handlers, rolling back if the request fails (e.g. a duplicate user name → 409).
  The user collection carries a write-only `pin` field (never returned by the API).
- **Admin** page (admins only) manages users. Only admins can create users
  (enforced by `adminOnly` on `/api/users`).

The bullets above describe the REST-backed `web` app. `web-electric` and
`web-powersync` share the same login/auth but sync differently — see below.

## web-electric sync architecture

`web-electric` splits reads and writes onto two channels:

- **Reads** stream live from the ElectricSQL shape API. The
  [todos](packages/web-electric/src/collections/todos.ts) and
  [users](packages/web-electric/src/collections/users.ts) collections subscribe directly
  to Electric (host port `3010`); rows arrive as Postgres changes replicate. The
  users shape selects only non-sensitive columns so `pin_hash` never reaches the
  browser.
- **Writes** are captured as durable events. Every `insert`/`update`/`delete`
  is written to an IndexedDB queue ([`eventStore.ts`](packages/web-electric/src/lib/eventStore.ts))
  _before_ it is sent, so nothing is lost across reloads or offline. The
  [sync engine](packages/web-electric/src/lib/syncEngine.ts) drains the queue FIFO to
  `POST /api/events` with backoff + an `/api/health` heartbeat, dead-letters
  terminal (4xx) failures, and resolves each optimistic mutation with the
  Postgres `txid` so Electric can reconcile it. The
  [`SyncStatus`](packages/web-electric/src/components/SyncStatus.tsx) header badge shows
  online/offline state, the pending count, and retry/dismiss controls.

The server applies each command **idempotently**: `POST /api/events` records the
client-generated event id in a `processed_events` ledger inside the write
transaction, so a replayed command (committed but whose response was lost)
short-circuits and returns the original `txid` instead of re-applying.

> **Reconnect note:** Electric's client reconnects on an exponential backoff
> (up to 32s) and doesn't listen for the browser `online` event, so a client
> returning from offline could lag before it resumed streaming. `web-electric` supplies
> a custom `fetchClient` that releases held requests the moment `online` fires,
> plus a capped backoff (see [`lib/electric.ts`](packages/web-electric/src/lib/electric.ts)),
> so reads resync immediately on reconnect.

> **Security:** the POC runs Electric with `ELECTRIC_INSECURE=true` and the
> browser talks to it directly, so **reads are unauthenticated and unscoped** —
> any client can read every user's todos. Only `pin_hash` is withheld. For real
> use, proxy shape requests through the authenticated API and inject a
> server-controlled `where` clause per user.

## web-powersync sync architecture

`web-powersync` is local-first: the app reads and writes a **local SQLite
database** (wa-sqlite, persisted in IndexedDB) that PowerSync keeps in sync with
Postgres. Both directions run through
[`lib/powersync.ts`](packages/web-powersync/src/lib/powersync.ts):

- **Schema** — `todos` and `users` are declared as PowerSync tables (implicit
  `id TEXT` primary key; booleans as integers, timestamps as ISO text). The
  [todos](packages/web-powersync/src/collections/todos.ts) and
  [users](packages/web-powersync/src/collections/users.ts) TanStack DB
  collections (`@tanstack/powersync-db-collection`) wrap those tables and
  transform the SQLite-shaped rows into rich JS types.
- **Auth** — the connector's `fetchCredentials` calls
  `GET /api/powersync/token`, which mints a short-lived HS256 token for the
  current user and returns the service endpoint. PowerSync verifies it with the
  same secret as the app (`PS_JWK_K` is the base64url of `JWT_SECRET`).
- **Reads** stream from the self-hosted PowerSync service (host port `8080`,
  configured by [`powersync/config.yaml`](powersync/config.yaml) and the sync
  streams in [`powersync/sync-config.yaml`](powersync/sync-config.yaml)), which
  replicates from the app Postgres into its own storage Postgres.
- **Writes** land in PowerSync's durable CRUD queue and are drained by
  `uploadData`, which POSTs the batch to
  [`POST /api/data`](packages/api/src/routes/data.ts). The server maps
  `PUT`/`PATCH`/`DELETE` onto the same todo/user services the REST API uses, in
  one transaction per batch. Write-only fields that are never synced back (the
  user `pin`) travel as per-operation metadata via `trackMetadata`.

> **Security:** the POC's sync streams (`SELECT * FROM todos` / `users`) are
> global and unfiltered, so every client syncs every row. Scope the streams by
> the token's user id before any real use.

## Scripts (run from the repo root)

| Script                       | Description                                   |
| ---------------------------- | --------------------------------------------- |
| `bun run dev`                | Run API + web dev servers                     |
| `bun run dev2`               | Run API + web-electric (ElectricSQL) servers  |
| `bun run dev3`               | Run API + web-powersync (PowerSync) servers   |
| `bun run dev:api`            | API only (`bun --hot`)                        |
| `bun run dev:web`            | Web only (vite)                               |
| `bun run dev:web-electric`   | web-electric only (vite)                      |
| `bun run dev:web-powersync`  | web-powersync only (vite)                     |
| `bun run build`              | Build all packages                            |
| `bun run db:up` / `:down`    | Start / stop Postgres, Electric and PowerSync |
| `bun run db:generate`        | Generate a migration from the schema          |
| `bun run db:migrate`         | Apply migrations                              |
| `bun run db:seed`            | Seed the initial admin user                   |
| `bun run db:studio`          | Open Drizzle Studio                           |
| `bun run lint` / `fmt` / `check` | Vite+ lint / format / full check          |

## API

| Method | Path                    | Auth  | Description                                   |
| ------ | ----------------------- | ----- | --------------------------------------------- |
| POST   | `/api/auth/login`       | –     | Log in, returns a JWT                         |
| GET    | `/api/auth/me`          | user  | Current user                                  |
| GET    | `/api/health`           | –     | Heartbeat (web-electric sync)                 |
| GET    | `/api/todos`            | user  | List own todos                                |
| POST   | `/api/todos`            | user  | Create a todo                                 |
| PATCH  | `/api/todos/:id`        | user  | Update own todo                               |
| DELETE | `/api/todos/:id`        | user  | Delete own todo                               |
| GET    | `/api/users`            | admin | List users                                    |
| POST   | `/api/users`            | admin | Create a user                                 |
| PATCH  | `/api/users/:id`        | admin | Update a user                                 |
| DELETE | `/api/users/:id`        | admin | Delete a user                                 |
| POST   | `/api/events`           | user  | Apply an offline-sync command (web-electric)  |
| POST   | `/api/data`             | user  | Upload a PowerSync CRUD batch (web-powersync) |
| GET    | `/api/powersync/token`  | user  | Mint a PowerSync token + endpoint             |

## Notes

- Three sync strategies share one backend: `web` uses **API query collections**
  (TanStack DB backed by the Hono REST API), `web-electric` uses **ElectricSQL for
  reads + a durable offline event queue for writes** (see
  [web-electric sync architecture](#web-electric-sync-architecture)), and
  `web-powersync` uses a **local SQLite database synced by PowerSync** (see
  [web-powersync sync architecture](#web-powersync-sync-architecture)). The
  `@app/db` package keeps schema and DTO types separate (`@app/db/types` has no
  runtime deps), which is what let both sync layers be added without
  restructuring.
- This is a POC: the JWT secret is a shared string, PIN is the only credential,
  the token lives in `localStorage`, Electric runs in insecure mode with
  unauthenticated reads, and the PowerSync streams are unscoped. Harden before
  any real use.

## Running `web-powersync` locally

The PowerSync frontend needs three things up: the app Postgres, the self-hosted
PowerSync service, and the API that mints its tokens.

1. **Env** — copy `.env.example` to `.env` and make sure it has:

   ```bash
   DATABASE_URL=postgres://postgres:postgres@localhost:5432/todoapp
   JWT_SECRET=dev-secret-change-me
   VITE_POWERSYNC_URL=http://localhost:8080   # service endpoint for the browser client
   ```

   Without `VITE_POWERSYNC_URL` the client never calls `db.connect()`: writes
   still reach `POST /api/data` through the manual queue flush, but **nothing
   streams back down** (see `initPowerSync()` in
   [`lib/powersync.ts`](packages/web-powersync/src/lib/powersync.ts)).

   If you change `JWT_SECRET`, update `PS_JWK_K` in `docker-compose.yml` to its
   base64url value or PowerSync will reject every client token:

   ```bash
   printf '%s' '<JWT_SECRET>' | base64 | tr '+/' '-_' | tr -d '='
   ```

2. **Start the services** — `bun run db:up` starts Postgres (`5432`), Electric
   (`3010`), the PowerSync storage Postgres, and the PowerSync service (`8080`).
   Config comes from [`powersync/config.yaml`](powersync/config.yaml) and
   [`powersync/sync-config.yaml`](powersync/sync-config.yaml), mounted read-only
   into the container.

   ```bash
   bun run db:up
   docker compose ps                 # all healthy?
   docker compose logs -f powersync  # replication + sync-stream startup
   ```

3. **Prepare the database** (first run, or after a schema change):

   ```bash
   bun run db:migrate
   bun run db:seed     # creates the peter / 12345 admin
   ```

4. **Run the app** — `bun run dev3` starts the API (`:3000`) and the
   `web-powersync` dev server (`:5175`); `bun run dev:web-powersync` runs only
   the frontend if the API is already up.

5. **Sign in** at http://localhost:5175 and check the browser console: you
   should see `[powersync] init http://localhost:8080` followed by a successful
   `GET /api/powersync/token`. The `SyncStatus` badge in the header shows the
   connection state.

### Notes and troubleshooting

- **Changed sync streams?** `powersync/sync-config.yaml` is mounted into the
  container, so restart the service to pick up edits:
  `docker compose restart powersync`.
- **401 / token rejected:** `JWT_SECRET` and `PS_JWK_K` are out of sync, or the
  token's `kid`/`audience` (`powersync`, set in `packages/api/src/auth.ts`) no
  longer match `client_auth` in `powersync/config.yaml`.
- **Stale local data:** the client database is a wa-sqlite file
  (`todos-powersync.sqlite`) in IndexedDB — clear the site's storage in devtools
  to start from an empty local DB.
- **Reset the service:** `docker compose down` and delete `./.data-powersync`
  (bucket storage only; the app database in `./.data` is untouched).
- **Admin CLI:** [`powersync/cli.yaml`](powersync/cli.yaml) points the PowerSync
  CLI at the local service and reads its key from `PS_ADMIN_TOKEN`.
