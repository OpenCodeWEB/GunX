# Tech Stack — DoMain / GunX

## Runtime & Platform
- **Cloudflare Workers** — `gunx-do` worker hosts both Durable Objects (`GunPeerObject`, `DomainRegistryObject`)
- **Cloudflare Pages** — `gunx` project (public UI + Functions API proxy to DO via bindings, `script_name = "gunx-do"`)
- **Durable Objects SQLite** — registry storage (`domain:<tld>:<name>`, `owner:<pub>:count`, `meta:*`); DO alarms for expiry sweep
- **Pages Functions** — `functions/api/domain/[[path]].js` (REST proxy), `functions/api/w3b/[[path]].js` (web3.bio proxy), `functions/api/stats.js`
- **Cloudflare Pages** — `d2a` project (Phase C gateway, repo `github.com/OpenCodeWEB/DoMain`)

## Crypto & Signatures
- **Gun SEA v1** — ECDSA P-256 signatures; sig format `"SEA"+JSON.stringify({m,s})`; canonical (key-sorted) JSON comparison
- **Web Crypto** — verification path in worker (`verify_claim.js`)
- **PoW** — difficulty by name length: 1–3 chars = 6, 4–7 = 4, 8+ = 2; `hashInput = name:ownerPub:target:ts:nonce`; client mines via `sdk/tld/pow.js` (positional args)

## Payments (Phase B — planned)
- **Zora** — creator coin `$absup` on Base (`0x666437f3dd51cdab4a5ded38427bfa705049ee5a`); `@zoralabs/coins-sdk` `tradeCoin` with `recipient` param; Zora CLI `zora buy <address> --eth X`
- **Card** — provider TBD (Gemini consultation pending; options: Stripe/Cloudflare-based flow)
- **Base chain** — RPC for swap execution (backend signs; private key in Worker secret)

## Identity
- **web3.bio API** — `https://api.web3.bio/profile/<address>` (ENS/Farcaster/Lens/Base profiles)

## SDK & Tests
- `sdk/tld/` — `pow.js` (mine/verify), `registry.js` (GunX registry client, mock gunx)
- `node --test` — `test/test_tld.mjs` etc.; live E2E `test/e2e_live.cjs`; Windows: run test files individually (parallel runs clash on port 8888)