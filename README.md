# GunX — Serverless GunDB. No relay server needed.

**GunX is a free, always-on GunDB relay running entirely on Cloudflare Workers + Durable Objects (SQLite), plus a tiny client SDK that fixes GunDB's well-known browser re-ask gap.**

Connect any app — a chat, a multiplayer canvas, a P2P todo list — with realtime sync, offline-first storage, and SEA end-to-end encryption. No relay server to run, no backend to deploy, no cost to start.

- **Relay (live):** `wss://gunx.pages.dev/gun`
- **Playground:** <https://gunx.pages.dev>
- **Stats:** <https://gunx.pages.dev/api/stats>

---

## Why GunX?

GunDB's architecture is a mesh of peers: every node relays for everyone else. That's beautiful — but it means a "serverless" web app has nobody to relay through when all clients are browsers. GunX fills that role:

| Problem | GunX solution |
| --- | --- |
| No relay peer available | A free public relay on Cloudflare's edge, `wss://gunx.pages.dev/gun` |
| Browser clients never re-ask peers for data already in IndexedDB | SDK auto-refresh issues plain-soul GETs on an interval, so remote changes still arrive |
| Shared public relay → key collisions between projects | App namespacing: every soul is transparently stored as `<appKey>/<soul>` |
| Parents never materialized on the wire | The relay synthesizes ancestor "lexicon" nodes, so `.map()` works for every client |
| Abusive traffic on a shared resource | Token-bucket rate limiting + 1 MB frame caps |
| Encrypted data needs key management | SDK helpers persist SEA pairs and wrap user auth |

## Quickstart

### Browser (script tag)

```html
<script src="https://cdn.jsdelivr.net/npm/gun/gun.js"></script>
<script src="https://cdn.jsdelivr.net/npm/gun/sea.js"></script>
<script src="https://cdn.jsdelivr.net/gh/OpenCodeWEB/GunX@main/public/gunx.js"></script>
<script>
  const gunx = GunX({ appKey: 'my-app' });

  // realtime subscription (namespaced automatically)
  gunx.get('todos').map().on((value, key) => console.log('todo:', key, value));

  // write
  gunx.put('todos', { learn: 'GunX' });
</script>
```

### Node / npm

```js
const Gun = require('gun');
const GunX = require('./sdk/gunx.js'); // or your bundled copy

const gunx = GunX({ appKey: 'my-app' });
gunx.on('status', ({ status }) => console.log('relay:', status));
gunx.get('todos').once(console.log);
gunx.put('todos', { hello: 'world' });
```

### SDK API

| Method | Description |
| --- | --- |
| `GunX(options)` | `{ appKey, peers, refreshMs, storage }` — wraps a gun instance pointed at the relay |
| `gunx.get(soul)` | Namespaced read/subscribe chain (also tracks the soul for auto-refresh) |
| `gunx.put(soul, data, cb)` | Namespaced write with ack callback |
| `gunx.raw()` | The underlying gun instance (for `.user()`, `.map()`, SEA, …) |
| `gunx.refresh()` | Force plain-soul GETs to the relay for every tracked soul |
| `gunx.on('status', cb)` | `connecting` → `connected` / `disconnected` events |
| `gunx.sea.savePair / loadPair / asyncAuth` | SEA pair persistence + user auth helpers |
| `gunx.destroy()` | Stop timers and listeners |

## How the relay works

The Durable Object implements the GunDB wire protocol directly — no Node runtime involved:

- **State-based LWW graph merge** using gun `_.">"` semantics.
- **Parent materialization:** gun clients send only leaf nodes on the wire; the relay synthesizes the parent chain with child refs (`{ "#": soul }`), so fresh clients can discover and `.map()` all children.
- **Live broadcast:** puts are relayed to every other connected WebSocket in realtime.
- **Persistence:** the graph lives in Durable Object SQLite (durable, fast, free-tier friendly).
- **Fairness:** per-connection/IP token buckets and a hard 1 MB frame cap.

## Deploy your own

```bash
# 1. Worker (the relay DO)
cd worker
npm install
npm run deploy            # creates/updates the gunx-do Durable Object

# 2. Pages (the SDK + playground + /gun + /api/*)
cd ..
npx wrangler pages deploy public --project-name gunx
```

Point clients at your own URL:

```js
GunX({ appKey: 'my-app', peers: ['wss://your-worker.pages.dev/gun'] });
```

## Project layout

```
worker/src/GunRelayDO.js   — the Durable Object relay (hardened: rate limits, frame caps, batched stats)
functions/gun.js           — Pages function: WebSocket upgrade → DO
functions/api/stats.js     — /api/stats (live relay counters)
functions/api/health.js    — /api/health
functions/health.js        — /health alias
sdk/gunx.js                — the client SDK (UMD: browser + Node)
public/index.html          — playground + docs page
public/gunx.js             — SDK copy served at /gunx.js
test/                      — raw protocol tests + SDK integration test
```

## Tests

```bash
cd test && npm install
node sdk-test.js           # SDK integration test against the live relay
node raw-ws-test.js        # raw WebSocket hello/put/ack
node raw-get-shapes.js     # GET reply shapes (full node vs hash-check)
node verify-parent.js      # parent lexicon materialization
```

## Limits (shared public relay)

- 1 MB per message frame.
- Token-bucket rate limiting per connection and per IP.
- Free Cloudflare tier: 10 GB DO SQLite storage, worker CPU time limits — fine for hobby/P2P apps; self-host for heavy traffic.

## License

MIT — build anything you want on it. OpenCodeWEB / ABsUP.