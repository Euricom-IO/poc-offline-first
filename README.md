# poc-offline-first

A Bun monorepo POC: a multi-user todo app with a Hono API, a Drizzle/Postgres
data layer, and **two React frontends that demonstrate two different sync
strategies** against the same backend:

- **`web`** — optimistic TanStack DB collections backed by the Hono REST API.
- **`web2`** — TanStack DB collections that **read** live from ElectricSQL's
  shape stream and **write** through a durable, offline-first event queue.

## Packages

```
packages/
  db     @app/db    Drizzle schema, migrations, seed, DB client (Postgres)
  api    @app/api   Hono HTTP API + JWT auth (depends on @app/db)
  web    @app/web    React SPA — REST-backed TanStack DB query collections
  web2   @app/web2   React SPA — ElectricSQL reads + offline event-sync writes
```

Bun workspaces only (no Turborepo). Root scripts fan out with `bun run --filter`.

## Stack

- **Runtime / package manager:** Bun
- **Web:** React 19, TanStack Router (file-based), TanStack DB (query collections),
  shadcn/ui, Tailwind CSS 4
- **API:** Hono, `hono/jwt` (HS256)
- **DB:** PostgreSQL via Docker, Drizzle ORM + drizzle-kit
- **Sync (web2):** ElectricSQL shape stream (`@electric-sql/client` +
  `@tanstack/electric-db-collection`) for reads; a Dexie/IndexedDB event queue
  for durable offline writes
- **Lint / format:** [Vite+](https://viteplus.dev/guide/) (`vp lint` / `vp fmt` / `vp check`)

## Getting started

```bash
bun install          # install all workspaces
cp .env.example .env # DATABASE_URL, JWT_SECRET, ports

bun run db:up        # start Postgres + ElectricSQL (docker compose)
bun run db:migrate   # apply migrations
bun run db:seed      # create the initial admin user

bun run dev          # API (:3000) + web  (:5173) — REST-backed frontend
bun run dev2         # API (:3000) + web2 (:5174) — ElectricSQL frontend
```

Open the frontend you started (http://localhost:5173 or http://localhost:5174)
and sign in. `db:up` brings up both Postgres and the Electric sync service
(host port `3010`) that `web2` reads from.

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

The bullets above describe the REST-backed `web` app. `web2` shares the same
login/auth but syncs differently — see below.

## web2 sync architecture

`web2` splits reads and writes onto two channels:

- **Reads** stream live from the ElectricSQL shape API. The
  [todos](packages/web2/src/collections/todos.ts) and
  [users](packages/web2/src/collections/users.ts) collections subscribe directly
  to Electric (host port `3010`); rows arrive as Postgres changes replicate. The
  users shape selects only non-sensitive columns so `pin_hash` never reaches the
  browser.
- **Writes** are captured as durable events. Every `insert`/`update`/`delete`
  is written to an IndexedDB queue ([`eventStore.ts`](packages/web2/src/lib/eventStore.ts))
  _before_ it is sent, so nothing is lost across reloads or offline. The
  [sync engine](packages/web2/src/lib/syncEngine.ts) drains the queue FIFO to
  `POST /api/events` with backoff + an `/api/health` heartbeat, dead-letters
  terminal (4xx) failures, and resolves each optimistic mutation with the
  Postgres `txid` so Electric can reconcile it. The
  [`SyncStatus`](packages/web2/src/components/SyncStatus.tsx) header badge shows
  online/offline state, the pending count, and retry/dismiss controls.

The server applies each command **idempotently**: `POST /api/events` records the
client-generated event id in a `processed_events` ledger inside the write
transaction, so a replayed command (committed but whose response was lost)
short-circuits and returns the original `txid` instead of re-applying.

> **Reconnect note:** Electric's client reconnects on an exponential backoff
> (up to 32s) and doesn't listen for the browser `online` event, so a client
> returning from offline could lag before it resumed streaming. `web2` supplies
> a custom `fetchClient` that releases held requests the moment `online` fires,
> plus a capped backoff (see [`lib/electric.ts`](packages/web2/src/lib/electric.ts)),
> so reads resync immediately on reconnect.

> **Security:** the POC runs Electric with `ELECTRIC_INSECURE=true` and the
> browser talks to it directly, so **reads are unauthenticated and unscoped** —
> any client can read every user's todos. Only `pin_hash` is withheld. For real
> use, proxy shape requests through the authenticated API and inject a
> server-controlled `where` clause per user.

## Scripts (run from the repo root)

| Script                | Description                              |
| --------------------- | ---------------------------------------- |
| `bun run dev`         | Run API + web dev servers                |
| `bun run dev2`        | Run API + web2 (ElectricSQL) dev servers |
| `bun run dev:api`     | API only (`bun --hot`)                   |
| `bun run dev:web`     | Web only (vite)                          |
| `bun run dev:web2`    | Web2 only (vite)                         |
| `bun run build`       | Build all packages                       |
| `bun run db:up` / `:down` | Start / stop Postgres                |
| `bun run db:generate` | Generate a migration from the schema     |
| `bun run db:migrate`  | Apply migrations                         |
| `bun run db:seed`     | Seed the initial admin user              |
| `bun run db:studio`   | Open Drizzle Studio                      |
| `bun run lint` / `fmt` / `check` | Vite+ lint / format / full check |

## API

| Method | Path                | Auth        | Description            |
| ------ | ------------------- | ----------- | ---------------------- |
| POST   | `/api/auth/login`   | –           | Log in, returns a JWT  |
| GET    | `/api/auth/me`      | user        | Current user           |
| GET    | `/api/health`       | –           | Heartbeat (web2 sync)  |
| GET    | `/api/todos`        | user        | List own todos         |
| POST   | `/api/todos`        | user        | Create a todo          |
| PATCH  | `/api/todos/:id`    | user        | Update own todo        |
| DELETE | `/api/todos/:id`    | user        | Delete own todo        |
| GET    | `/api/users`        | admin       | List users             |
| POST   | `/api/users`        | admin       | Create a user          |
| PATCH  | `/api/users/:id`    | admin       | Update a user          |
| DELETE | `/api/users/:id`    | admin       | Delete a user          |
| POST   | `/api/events`       | user        | Apply an offline-sync command (web2) |

## Notes

- Two sync strategies share one backend: `web` uses **API query collections**
  (TanStack DB backed by the Hono REST API), while `web2` uses **ElectricSQL for
  reads + a durable offline event queue for writes** (see
  [web2 sync architecture](#web2-sync-architecture)). The `@app/db` package keeps
  schema and DTO types separate (`@app/db/types` has no runtime deps), which is
  what let ElectricSQL be added without restructuring.
- This is a POC: the JWT secret is a shared string, PIN is the only credential,
  the token lives in `localStorage`, and Electric runs in insecure mode with
  unauthenticated reads. Harden before any real use.
