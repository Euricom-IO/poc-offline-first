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
