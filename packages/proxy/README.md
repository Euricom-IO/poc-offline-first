# `@app/proxy` — fault-injection dev proxy

A small Hono/Bun reverse proxy that sits between a frontend and the API so the
"network" can be made to misbehave on demand:

```
                    ┌──────────────────────────────┐
web-powersync :5175 │ writes  /api/*      → api :3000 → postgres
                    │ reads   /powersync/* → powersync :8080
                    └──────────────┬───────────────┘
                          proxy :3100 (data plane)
                                   ↑
                 control plane :3101 — POST /fault, /cut, /down, /up
```

Both legs of PowerSync go through it: the CRUD upload (`POST /api/data`) and the
download stream (`POST /powersync/sync/stream`, forwarded to the service with the
prefix stripped). Faults are scoped by path, so you can break one and leave the
other alone.

Two listeners on purpose. The **data plane** (`:3100`) forwards to the API and
is what faults apply to; the **control plane** (`:3101`) arms and disarms them
and stays up even when the data plane is stopped — which is what makes
`POST /down` usable: `:3100` then refuses connections outright and only `:3101`
can bring it back.

Everything is forwarded verbatim until a fault is armed. It exists to test what
PowerSync's local-first stack does when writes cannot reach the server: the app
keeps working against its local SQLite database, ops pile up in the CRUD queue,
and the queue drains once the proxy lets traffic through again.

> Not to be confused with `specs/proxy.md`, which plans an authenticated
> **Electric shape proxy inside the API**. This package is a dev/test tool and
> is never part of a deployment.

## Run it

```bash
bun run dev3        # api :3000 + proxy :3100 + web-powersync :5175
bun run dev:proxy   # the proxy on its own
```

`web-powersync`'s vite dev server already forwards `/api` to the proxy, so the
app goes through it with no further setup. To bypass it, set
`VITE_PROXY_URL=http://localhost:3000`.

## Dashboard

**<http://localhost:3101/ui>** — every action below as a button, plus a live
request log.

- **Presets** arm the interesting runs in one click: offline, break uploads
  only, slow 5s/30s, drop connection, hang, poison 400, flaky ×2, 401
  everything.
- **Arm a fault** is the same form spelled out: mode, status, delay, methods,
  path prefix, count. Picking a mode explains what it does to a client, and the
  **On arm** line under the form is the exact rule you are about to set —
  `POST /api/data → wait 10000ms, answer 500 without contacting the API (next 3
  request(s))` — updated as you type, with bad input reported there instead of
  after clicking.
- **Listener** takes the data plane down and brings it back, with an optional
  auto-restore in N seconds.
- **Requests** streams what the proxy saw — method, path, the fault applied, the
  status the client got, how long it took, and the request body, newest first.
  A request appears the moment it **arrives**, with a live counter while the
  proxy is still holding it, so a 30s stall or a hanging `timeout` is watchable
  rather than only visible once it is over.

Open it beside the app at `:5175` and you can watch PowerSync retry an upload
while you break and unbreak the network. It is one dependency-free HTML file
served from the control port, so it keeps working when the proxy is down and
needs nothing from the internet — which matters for a tool whose job is to
simulate having none. Edit `public/dashboard.html` and refresh; it is re-read
per request.

| Env                  | Default                 | Meaning                          |
| -------------------- | ----------------------- | -------------------------------- |
| `PROXY_PORT`         | `3100`                  | data plane — forwards to the API |
| `PROXY_CONTROL_PORT` | `3101`                  | control plane — always listening  |
| `PROXY_TARGET`       | `http://localhost:3000` | the API it forwards to           |
| `POWERSYNC_TARGET`   | `http://localhost:8080` | the PowerSync service, served under `/powersync/*` |

## Control plane

Drive it on **`:3101`** (`POST http://localhost:3101/fault`). The same routes
are also mounted on the data port under `/__proxy` (`:3100/__proxy/fault`) —
handy while it is up, never forwarded and never faulted, but gone once the data
plane is down.

| Method   | Path       | Purpose                                                  |
| -------- | ---------- | -------------------------------------------------------- |
| `GET`    | `/ui`      | the dashboard                                             |
| `GET`    | `/`        | the dashboard for a browser; the JSON overview otherwise  |
| `GET`    | `/status`  | armed fault, data-plane state, counters                   |
| `GET`    | `/health`  | is the API behind the proxy reachable? (`?fresh` to re-probe) |
| `POST`   | `/fault`   | **arm a fault** (`dryRun: true` describes it without arming) |
| `DELETE` | `/fault`   | disarm                                                    |
| `POST`   | `/offline` | shorthand for `{ "mode": "offline" }`                     |
| `POST`   | `/online`  | shorthand for disarming                                   |
| `POST`   | `/cut`     | **break open streams** so an armed fault bites a connected client — `{ path? }` |
| `POST`   | `/down`    | **stop listening on `:3100`** — `{ "seconds": 20 }` to auto-restore |
| `POST`   | `/up`      | listen again                                              |
| `POST`   | `/reset`   | disarm, bring the data plane up, empty the log            |
| `GET`    | `/log`     | recent requests, newest first (`?limit=n`)                |
| `DELETE` | `/log`     | empty the log                                             |

### `POST /__proxy/fault`

```jsonc
{
  "mode": "offline",     // offline | error | delay | timeout | disconnect | off
  "status": 500,         // offline/error — any status you want to test
  "message": "…",        // offline/error — body is { error: message }
  "delaySeconds": 5,     // or delayMs; max 30s; applied in *every* mode
  "methods": ["POST"],   // default; "*" for every method
  "path": "/api/data",   // pathname prefix; default every path
  "count": 3             // fault the next 3 matching requests, then disarm
}
```

| Mode         | What the client sees                                                        |
| ------------ | --------------------------------------------------------------------------- |
| `offline`    | `500` (or `status`), and the API is never contacted — nothing is written     |
| `error`      | any status: `400` poisons a sync queue, `401` ends a session, `429`, `503`… |
| `delay`      | the normal answer, `delaySeconds` late (1–30s)                               |
| `timeout`    | nothing at all — the request hangs until the client gives up                 |
| `disconnect` | the connection drops mid-response: a socket error, not a status              |
| `off`        | pass-through (same as `DELETE /__proxy/fault`)                               |

Notes that matter when reading results:

- **Only `POST` is faulted by default.** Reads, and `GET /api/powersync/token`,
  keep working so a client can stay logged in while its writes fail. Pass
  `methods: "*"` to break everything.
- **`delay` composes with the other modes.** `{"mode":"offline","delaySeconds":10}`
  stalls for 10s and *then* fails.
- **`disconnect` through the vite dev server arrives as a 502**, because vite's
  proxy answers for the upstream socket it lost. Call the proxy directly
  (`:3100`) to see the raw connection failure.
- **`count` disarms itself**, which is how you reproduce a server that recovers
  on its own while a client is retrying.
- A `502` with `proxy: cannot reach …` in the body means the API is genuinely
  down — it is not an injected fault.
- **`dryRun` answers 200 either way.** `POST /fault {"mode":"delay","delaySeconds":45,"dryRun":true}`
  returns `{ valid: false, error: "delay must be at most 30000ms (30s)" }`; a
  valid rule comes back with the same `message` arming it would print. Arming
  for real still fails with 400.
- **Log entries are written on arrival.** `GET /log` marks one `pending: true`
  while the request is still in flight (`status: null`), then fills in `status`
  and `durationMs` when it is answered. A finished entry with `status: null` was
  one the client never got an answer for — dropped, or held until it gave up.
- **`/health` does not pester the API.** Every forwarded request already proves
  the API is up, so the answer comes from the last one (`source: "traffic"`);
  it only probes `GET /health` upstream when nothing has passed through for 5s,
  and the result is shared by every caller. That keeps the dashboard's status
  pill live without filling the API's request log. `?fresh` forces a probe.

### The download stream

PowerSync's own default transport is a **WebSocket** (RSocket over
`ws://…/sync/stream`), which this proxy does not bridge — a WS upgrade gets a
`501` explaining that. So `web-powersync` connects with PowerSync's **HTTP
streaming** mode instead: one long-lived `POST /sync/stream` whose response body
is newline-delimited JSON. That is an ordinary HTTP request, so every fault
applies to it. (`VITE_POWERSYNC_TRANSPORT=websocket` switches back to the
default; then point `POWERSYNC_URL` straight at `:8080`.)

One thing behaves differently from a normal request: **a fault applies to
requests as they arrive**, and the download stream arrived minutes ago. Arming
one while a client is connected changes nothing until that connection breaks —
so break it:

```bash
curl -X POST localhost:3101/fault -H 'content-type: application/json' \
  -d '{"mode":"error","status":500,"methods":"*","path":"/powersync"}'
curl -X POST localhost:3101/cut -H 'content-type: application/json' \
  -d '{"path":"/powersync"}'          # the stream dies; the client reconnects into the 500
curl -X POST localhost:3101/online    # and recovers on the next attempt
```

The dashboard's **Download → PowerSync** presets do both in one click, and the
**Open streams** card shows what is currently connected with a Cut button.
`GET /status` lists open streams; the request log marks a stream with a live
`↓ 47.1s · 497 B` counter until it closes.

### `disconnect` vs `down`

`disconnect` kills one request's connection; the proxy keeps listening and the
next request is served. `POST /down` stops the listener, so there is nothing to
connect to at all:

```bash
curl -X POST localhost:3101/down            # :3100 now refuses connections
curl localhost:3100/api/health              # curl: (7) Failed to connect
curl localhost:3101/status                  # still answers — different port
curl -X POST localhost:3101/up              # back
curl -X POST localhost:3101/down -H 'content-type: application/json' -d '{"seconds":20}'
```

`down` also cuts connections that are already open, so a request being held by a
`timeout` fault dies with it. A `bun --hot` reload does **not** bring a stopped
data plane back — that would undo the thing you are testing; call `/up`.

Note what the **browser** sees: with `web-powersync` going through vite's dev
proxy, vite catches the refused connection and answers `502` itself (it logs
`http proxy error … ECONNREFUSED`). The upload still fails and PowerSync still
holds its CRUD queue, but it is an HTTP error rather than a `TypeError`. Only a
client talking to `:3100` directly — the `.http` files, curl — sees the raw
connection failure.

## Sync fault checklist

A pass over the whole `web-powersync` path — both directions, every fault mode,
and what each one should look like in the app. Everything below was run against
this proxy; the expected results are what it actually did, not what it ought to
do in theory.

Setup: `bun run dev3`, log in at <http://localhost:5175> (`peter` / `12345`),
and open the dashboard at <http://localhost:3101/ui> next to it. Ground truth
for "did the server really get it" is the API, read directly so the proxy is not
in the way:

```bash
TOKEN=$(curl -s -X POST localhost:3000/api/auth/login \
  -H 'content-type: application/json' -d '{"name":"peter","pin":"12345"}' \
  | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
curl -s localhost:3000/api/todos -H "authorization: Bearer $TOKEN"
```

Run `curl -X POST localhost:3101/reset` between scenarios: it disarms, brings
the data plane back and clears the log. The badge vocabulary the app uses is
`Synced` · `Syncing n` · `Retrying n` · `Reconnecting` · `Not syncing · <age>
stale` · `Offline`.

### 1. Baseline — nothing armed

Add a todo. `POST /api/data → 200` in the log, followed by
`GET /powersync/write-checkpoint2.json`; the row is in Postgres; badge stays
`Synced`. If this fails, nothing below means anything.

### 2. Writes broken, reads untouched

```bash
curl -X POST localhost:3101/fault -H 'content-type: application/json' \
  -d '{"mode":"offline","path":"/api/data","methods":["POST"]}'
```

Add two todos. Both appear instantly (they are local writes), badge goes
`Syncing 2`, and `POST /api/data → 500` repeats every ~5s. Nothing reaches
Postgres. `GET /api/powersync/token` keeps returning 200 — that is deliberate,
and why only `POST` is faulted by default: the client must stay logged in while
its writes fail.

**Also insert a row from outside the app** (`POST localhost:3000/api/todos`, as
above) while this is armed. It does *not* appear, even though the download
stream is connected and healthy: **PowerSync will not apply a checkpoint while
the CRUD queue is non-empty**, since server state could overwrite local writes
that have not been uploaded. So a broken upload path stops downloads too — the
client goes fully stale, which is not true of the `web-electric` path, where the
two channels are independent.

Recover with `POST /online`: the queue drains in order, the held-back row
arrives, badge returns to `Synced`.

### 3. Reads broken, writes untouched

```bash
curl -X POST localhost:3101/fault -H 'content-type: application/json' \
  -d '{"mode":"offline","path":"/powersync","methods":["POST","GET"]}'
curl -X POST localhost:3101/cut -H 'content-type: application/json' \
  -d '{"path":"/powersync"}'
```

The `/cut` is the whole point — without it the established stream keeps running
and the fault never bites. After it, `POST /powersync/sync/stream → 500` repeats.

Writes still work: add a todo and it lands in Postgres normally. Rows inserted
from outside do **not** arrive. The badge shows `Reconnecting` for the first 10s,
then `Not syncing · <age> stale`, with the upstream error in its tooltip.

That escalation is the fix for a real bug: the badge used to read `Synced`
throughout, because it only watched the upload queue — the client was silently
stale with a green light. Re-check it here whenever `SyncStatus.tsx` changes.

`POST /online` reconnects within a few seconds and the missed rows land.

### 4. Poison message — the head-of-line block

```bash
curl -X POST localhost:3101/fault -H 'content-type: application/json' \
  -d '{"mode":"error","status":400,"path":"/api/data","methods":["POST"]}'
```

Add a todo, then a second one. Badge goes `Retrying 1` then `Retrying 2` (the
amber variant, meaning the upload is erroring rather than merely in flight), and
`POST /api/data → 400` repeats forever. Neither row reaches Postgres: the second
is stuck behind the first.

This is the documented gap — `/api/data` collapses every failure into a flat
`400` and the client just throws and retries, so **there is no dead-lettering on
this path** and a genuinely invalid op blocks the queue permanently. Contrast
`web-electric`, which dead-letters 4xx. Clearing the fault drains both in order,
which confirms the ops were never dropped, only blocked.

### 5. Slow and hanging

```bash
curl -X POST localhost:3101/fault -H 'content-type: application/json' \
  -d '{"mode":"delay","delaySeconds":5,"path":"/api/data"}'   # writes land, late
curl -X POST localhost:3101/fault -H 'content-type: application/json' \
  -d '{"mode":"timeout","path":"/api/data"}'                  # never answered
```

Under `timeout` the request hangs until the client gives up, and the control
plane stays usable throughout — `/__proxy/*` is registered before the catch-all
and is never faulted, so a fault is always clearable even while a request hangs.

### 6. `disconnect` — one dropped socket

```bash
curl -X POST localhost:3101/fault -H 'content-type: application/json' \
  -d '{"mode":"disconnect","path":"/api/health","methods":["POST","GET"]}'
curl localhost:3100/api/health    # curl: (56) Recv failure: Connection reset by peer
curl localhost:5175/api/health    # 502 — vite answers for the socket it lost
```

Both are correct; they are different vantage points. See
[`disconnect` vs `down`](#disconnect-vs-down).

### 7. `down` — no listener at all

```bash
curl -X POST localhost:3101/down
curl localhost:3100/api/health    # curl: (7) Failed to connect
curl localhost:5175/api/health    # 502
curl localhost:3101/status        # still answers
```

Write a todo while down: it stays local, and the badge shows
`Not syncing · <age> stale · 1 pending` — **not** `Offline`, because
`navigator.onLine` is still `true`. An unreachable server is not a browser
offline event, and the badge has to say so itself; it previously showed a
reassuring `Syncing 1` here. `POST /up` restores, and the queue drains.

### 8. Two clients — does it actually round-trip?

Everything above verifies one client against the server. This is the one that
checks a write reaches *another* client, and it needs a second browser with its
own storage.

**Two tabs of the same browser do not work.** Same origin and same profile means
the same IndexedDB, so both tabs share one wa-sqlite database and one CRUD
queue — a row "appearing" in the second tab proves only shared local storage,
not sync. Confirmed the hard way: with uploads broken, a row written in tab 1
was already present in tab 2's local DB, and tab 2's badge showed the same
`1 pending`. (Its list did not re-render, but that is a reactivity detail, not
isolation.) Use a second **profile**: a private window, a separate browser, or a
second Playwright MCP server started with `--isolated`.

Read each client's own database directly rather than trusting the rendered list:

```js
await db.getAll("SELECT title, completed FROM todos WHERE title LIKE 'ISO%'")
await db.getUploadQueueStats()   // whose queue is this row sitting in?
```

1. Log both in. Both should reach `Synced` with the same row count — B syncing
   down from scratch is itself a download-path test.
2. Break uploads (`{"mode":"offline","path":"/api/data"}`) and write in A.
   **B's local DB must not contain it and B's `pendingUploads` must be 0.** This
   is the assertion that fails with two tabs, so it is the one that proves the
   clients are really separate.
3. Clear the fault. The row should land in B's local DB *and* render without a
   reload.
4. Write in B and confirm it appears in A — the reverse direction is a different
   code path on the way back down.
5. Toggle a todo's completion in A and confirm B's checkbox follows; updates go
   through the schema validation that inserts skip (see the two-zod-schema note
   in CLAUDE.md).

The dashboard shows the two clients apart: `write-checkpoint2.json?client_id=…`
carries a different id per client, and there is one open `/powersync/sync/stream`
each. If both requests share a `client_id`, they are the same client and this
scenario is not testing what it looks like.

Note the proxy's fault state is **global** — rules scope by path, method and
count, never by client, so both clients always see the same armed fault. You can
break sync for everyone, not for one client.

### 9. Genuinely offline

Toggle the browser's own offline mode (DevTools → Network → Offline) rather than
using the proxy. This is the one case `navigator.onLine` does see, and the badge
should read `Offline · n pending`. Worth doing last, as a control: it proves the
states above are reporting a *server* problem rather than a network one.

## `.http` files

[`http/`](http) drives all of this from the editor. Written for the VS Code
[REST Client](https://marketplace.visualstudio.com/items?itemName=humao.rest-client)
extension (JetBrains' HTTP client runs them too) — click "Send Request" above a
block.

| File                                                   | Contents                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| [`proxy-control.http`](http/proxy-control.http)         | every control endpoint and every mode, plus validation cases |
| [`api-through-proxy.http`](http/api-through-proxy.http) | the API as the app calls it: login, `/api/data` batches, REST |
| [`offline-scenarios.http`](http/offline-scenarios.http) | numbered runs: arm → write → observe → recover               |

Send the login block first in any file that needs a token; the rest reuse it.

## Scope

Both PowerSync legs are covered: uploads (`/api/data`) and the download stream
(`/powersync/*`). What is not covered is PowerSync's WebSocket transport — the
proxy speaks HTTP only, and bridging RSocket frames would mean piping two
sockets together. If you need to test the default transport under failure, the
listener-level `POST /down` still works on it (nothing to connect to), but
per-request faults do not.
