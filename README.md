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

## Migrating from Gun → GunX

GunX is a **drop-in replacement**: `gunx.get/put/map/on/once/set` behave like gun's, so a migration is mostly changing the factory call — and you gain namespacing, auto-refresh, and encryption helpers for free.

### API mapping

| Gun | GunX |
| --- | --- |
| `Gun(['https://gunx.pages.dev/gun'])` | `GunX({ appKey: 'my-app' })` — relay auto-configured |
| `gun.get('chat').map().on(cb)` | `gunx.get('chat').map().on(cb)` — same chain, namespaced |
| `gun.get('chat/xyz').put({...})` | `gunx.put('chat/xyz', {...})` — same ack callback |
| `gun.get(soul).once(cb)` | `gunx.get(soul).once(cb)` |
| `Gun.SEA.encrypt/decrypt(data, key)` | `gunx.sea.seal(obj, key)` / `gunx.sea.open(obj, key)` — object-level, `_e:1` marker |
| `Gun.SEA.pair()` + manual storage | `gunx.sea.savePair(pair)` / `loadPair()` / `asyncAuth(gunx, alias, pass)` |

### What you gain

1. **appKey namespacing** — your data is stored as `<appKey>/<soul>` on the shared relay; no manual prefixes, no collisions with other apps.
2. **Auto-refresh sync** — the SDK re-asks the relay for subscribed souls, fixing GunDB's IndexedDB re-ask gap.
3. **E2E room encryption** — `gunx.sea.seal/open` encrypt every field before data touches the relay; `genRoomKey()` makes private-room invite keys. Without the key (even the relay owner) can't read anything.
4. **Retention policy** — the relay prunes **only tombstoned (null-put) fields** older than 99d 9h 9m 9s. Live data is never deleted, ever.
5. **DirectRTC + Nostr bridge** — WebRTC P2P file transfer and NIP-01 Kind 30000 mesh are built in.

### Before / after — chat app

**Before (raw gun):**

```js
const gun = Gun(['https://gunx.pages.dev/gun']);
const key = 'my-shared-key';

async function send(text) {
  const ct = await Gun.SEA.encrypt(text, key);
  gun.get('chat').get('messages').set({ body: ct, ts: Date.now() });
}
gun.get('chat').get('messages').map().on(async (m) => {
  if (m?.body) console.log(await Gun.SEA.decrypt(m.body, key));
});
```

**After (GunX):**

```js
const gunx = GunX({ appKey: 'my-chat-app' });
const roomKey = 'my-shared-key'; // or: await gunx.sea.genRoomKey()

async function send(text) {
  // seal() takes an OBJECT — every field is encrypted, _e:1 marker added
  const sealed = await gunx.sea.seal({ t: text, from: 'me' }, roomKey);
  gunx.get('chat').get('messages').set({ payload: sealed, ts: Date.now() });
}
gunx.get('chat').get('messages').map().on(async (m) => {
  if (m?.payload) {
    const msg = await gunx.sea.open(m.payload, roomKey);
    if (msg) console.log(msg.t, '—', msg.from);
  }
});
```

### Gotchas

- **Namespacing is automatic** — if you previously stored data at a bare soul with raw gun, reading it back through GunX requires the same `appKey` (data lives under `<appKey>/<soul>`).
- **SEA must be loaded** — include `gun/sea.js` in the browser or `require('gun/sea.js')` (with `global.Gun` set) in Node, or `gunx.sea` helpers throw.
- **Retention is tombstone-only** — nothing of yours expires automatically. If you `unset`/null-put a field, it is pruned after 99d 9h 9m 9s; live values persist forever.
- **`seal/open` work on objects** — pass the whole payload object, not a string. `open` returns `null` when the key is wrong or missing (treat as "locked").

### When NOT to use GunX

- Heavy relational joins or analytics queries — a document/relational DB fits better than a P2P graph mesh.
- Raw single-string encryption with no `_e:1` structure — use `gunx.sea.encryptText/decryptText` instead of `seal`.
- You need your own relay topology/control plane — GunX targets the hosted `gunx.pages.dev` relay (self-hosting the DO is possible but experimental).

## SDK API

| Method | Description |
| --- | --- |
| `GunX(options)` | `{ appKey, peers, refreshMs, storage }` — wraps a gun instance pointed at the relay |
| `gunx.get(soul)` | Namespaced read/subscribe chain (also tracks the soul for auto-refresh) |
| `gunx.put(soul, data, cb)` | Namespaced write with ack callback |
| `gunx.raw()` | The underlying gun instance (for `.user()`, `.map()`, SEA, …) |
| `gunx.refresh()` | Force plain-soul GETs to the relay for every tracked soul |
| `gunx.on('status', cb)` | `connecting` → `connected` / `disconnected` events |
| `gunx.sea.savePair / loadPair / asyncAuth` | SEA pair persistence + user auth helpers |
| `gunx.sea.seal(obj, key)` / `sea.open(obj, key)` | E2E encrypt every field of a payload (`_e:1` marker) / decrypt back; `open` → `null` without the key |
| `gunx.sea.genRoomKey()` | Random 32-byte URL-safe room key for private invite links |
| `gunx.sea.encryptText / decryptText` | Raw string-level SEA encryption helpers |
| `gunx.joinPresence(meta, ttl)` | Register as online (heartbeat); returns myId |
| `gunx.onPeers(cb)` | Watch live peers; `cb(list)` on changes |
| `gunx.shareFile(file, opts, cb)` | P2P WebRTC transfer to one peer (`opts.to`) or all online peers. Any size — adaptive 64KB–256KB chunks, no relay storage |
| `gunx.onFile(cb)` | `cb({blob, name, size, type, from})` when a transfer completes |
| `gunx.onFileOffer(cb)` | Intercept incoming transfers (accept/reject) — auto-accept when unset |
| `gunx.onTransferProgress(cb)` | `{direction, to|from, name, sent|received, total, ts}` per transfer |
| `gunx.uploadImage(image, opts)` | imgbb upload — `opts.proxy` (server-side, key stays secret) or `opts.key` (direct API) |
| `gunx.destroy()` | Stop timers and listeners |

## .gunx TLD registry (Phase 1)

Zero-ICANN domains: names are owned by SEA keys, not registrars. Claim records live in the registry Durable Object and are verifiable by anyone (PoW + ECDSA signature).

**Policy**
- `1–3` chars → PoW diff 6 · `4–7` → diff 4 · `8+` → diff 2
- `8+` chars: 3 free per pubkey; 4th+ = `Price(N) = 1 × 2^(N−3)` ABS (payment in Phase 4)
- `1–7` chars: premium → `pending_payment`
- Root admins (`ROOT_PUBKEYS` worker var) mint unlimited `active`
- Inactive names expire after 90 days (daily DO alarm sweep)

**API** (public, cryptographically safe — claims are verified inside the DO)

```
POST /api/domain/claim    { name, ownerPub, target, ts, nonce, diff, hash, sig }
POST /api/domain/touch    { name, ownerPub, sig }            // SEA-only liveness
GET  /api/domain/resolve?name=<n>
GET  /api/domain/list?owner=<pub>
GET  /api/domain/stats
```

Try it live: the playground at `gunx.pages.dev/#tld` — generate a key, mint a name, resolve it.

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
worker/src/GunRelayDO.js       — the Durable Object relay (hardened: rate limits, frame caps, batched stats)
worker/src/DomainRegistryDO.js — .gunx registry Durable Object (tiers, pricing, 90d expiry)
worker/src/verify_claim.js     — server-side PoW + SEA (ECDSA P-256) verification
worker/wrangler.toml           — worker config (GUN_PEER + DOMAIN_REGISTRY bindings, ROOT_PUBKEYS)
wrangler.toml                  — Pages config (binds Pages Functions to the registry DO)
functions/gun.js               — Pages function: WebSocket upgrade → DO
functions/api/stats.js         — /api/stats (live relay counters)
functions/api/imgbb.js         — /api/imgbb (server-side imgbb proxy; key = Pages secret)
functions/api/health.js        — /api/health
functions/api/domain/[[path]].js — /api/domain/* REST proxy → registry DO
functions/health.js            — /health alias
sdk/gunx.js                    — the client SDK (UMD: browser + Node)
sdk/tld/pow.js                 — PoW mining/verification (browser + Node)
sdk/tld/registry.js            — client registry (claim/touch/resolve helpers)
public/index.html              — playground + docs page
public/gunx.js             — SDK copy served at /gunx.js
test/                      — raw protocol tests + SDK integration test
```

## Image hosting + P2P files (playground features)

### `/api/imgbb` — server-side image upload proxy

The playground's 🖼️ button uploads images to imgbb.com through a Cloudflare
Pages Function. **The API key never reaches the browser** — it lives only as a
Pages secret, so nobody can steal it and abuse your imgbb account from their
own site.

```bash
# one-time setup: store the key as a production secret
npx wrangler pages secret put IMGBB_KEY --project-name gunx
```

The function enforces:

- **Origin allowlist** — only your pages.dev domain (and `localhost` for dev)
  may call it; anything else gets `403`. Add your own domains in
  `functions/api/imgbb.js`.
- **Per-IP rate limit** (20 uploads/min) and a **10 MB image cap**.
- Only `image/*` files are accepted; the key is never included in responses.

### P2P files — Snapdrop/PairDrop-style, no relay storage

The 📎 button streams files **peer-to-peer over WebRTC data channels**:
signaling (offer/answer/ICE) travels through gun souls, but file bytes never
touch the relay. No size limits — chunks start at 64KB for instant first-byte
latency and adapt up to 256KB (the browser-safe SCTP ceiling) under clear
throughput, with `bufferedAmount` backpressure for huge files. Receivers get a
Save link backed by an in-memory Blob (`URL.createObjectURL`).

## Tests

```bash
cd test && npm install
node sdk-test.js           # SDK integration test against the live relay
node raw-ws-test.js        # raw WebSocket hello/put/ack
node raw-get-shapes.js     # GET reply shapes (full node vs hash-check)
node verify-parent.js      # parent lexicon materialization
node --test test_tld.mjs   # .gunx registry unit tests (PoW + SEA + policy)
node e2e_live.cjs          # live end-to-end against the deployed registry API
```

## Limits (shared public relay)

- 1 MB per message frame.
- Token-bucket rate limiting per connection and per IP.
- Free Cloudflare tier: 10 GB DO SQLite storage, worker CPU time limits — fine for hobby/P2P apps; self-host for heavy traffic.

## Web3 identity

GunX is built by **ABsUP / OpenCodeWEB** — verified web3 identity at [web3.bio/ABsUP](https://web3.bio/ABsUP):

| Identity | Handle |
|---|---|
| Wallet (Ethereum) | `0x9016...d1b0` |
| ENS | [absup.org](https://web3.bio/absup.org) |
| Basenames | `absup.base.eth` |
| Farcaster | [@absup](https://farcaster.xyz/absup) (verified) |
| Lens | [absup.lens](https://web3.bio/absup.lens) (verified) |
| X / Twitter | [@absupx](https://x.com/absupx) (verified) |
| GitHub | [absups](https://github.com/absups) |
| Telegram / Discord | @absups |
| Website | [absup.org/c](https://absup.org/c) |

Phase 4 will bind `.gunx` ownership to this wallet via EIP-712 signatures (Trust Wallet).

## License

MIT — build anything you want on it. OpenCodeWEB / ABsUP.