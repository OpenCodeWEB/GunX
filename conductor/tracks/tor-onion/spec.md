# Track: tor-onion — .onion TLD + Tor technology

## Problem
The `.onion` TLD currently accepts any free-form `target` string (e.g. `gateway`), which has nothing to do with Tor. User directive: **"`.onion` টরপ্রযুক্তি ব্যবহার করবে"** — the `.onion` TLD must be tied to real Tor technology.

## Solution (3 levels)
| Level | What | Feasibility |
|---|---|---|
| **A. Validation** | `.onion` mint `target` MUST be a syntactically valid Tor v3 onion address (56-char base32 + SHA3-256 checksum + version byte) — server-enforced in `DomainRegistryDO` | ✅ implement now |
| **B. Routing** | `.onion` records resolve to `http://<address>.onion/` — Tor Browser opens the real hidden service. Gateway (Phase C) renders an "open in Tor Browser" action. Cloudflare Workers cannot build Tor circuits (no TCP), so routing = browser-level via real `.onion` URL | ✅ via resolve + gateway UI |
| **C. Identity** | v3 addresses are derived from ed25519 keys → the target IS a self-authenticating identity. Record stores `onion: { v3: true, address }` | ✅ metadata |

## Tor v3 address format (RFC 7686 / Tor spec)
- 56 lowercase chars, alphabet `a-z2-7` (base32 without 0,1,8,9)
- payload = `pubkey(32B) || checksum(2B) || version(1B=0x03)` → base32 → 56 chars
- checksum = `SHA3-256(".onion checksum" || pubkey || version)[0:2]`
- SHA3-256 must run in pure JS (Cloudflare Workers Web Crypto has no SHA-3)

## Rules
- `.onion` mint with invalid target → **400** `invalid onion v3 address`
- PoW stays mandatory (requirePow), entitlement stays unlimited public
- Existing invalid onion records (test data: `gateway`/`gunx.pages.dev` targets) are grandfathered — resolve still works; only new mints are validated
- `.gunx` / `.absup` targets unchanged (free-form)

## Non-goals (this track)
- Tor circuit / Tor2web proxy on Workers (impossible — no TCP)
- ed25519 key generation (user brings their own v3 address from their Tor service)

## Acceptance criteria
1. `onion.js`: `validateV3Onion("…56 chars…")` true; bad length/alphabet/checksum → false; round-trip make→validate
2. DO: `.onion` claim with invalid target → 400; valid → 201
3. `.gunx` free-form targets unaffected
4. tests: test_tld.mjs new suite green (node --test)
5. live E2E uses a valid generated v3 address → 18+ PASS
6. UI: `.onion` target field shows Tor hint + client-side validation