# Plan — tor-onion

## Steps
1. **`worker/src/onion.js`** (new, pure JS, zero deps):
   - `sha3_256(bytes) -> Uint8Array(32)` — Keccak-f[1600], rate 136, pad 0x06 (SHA3 mode)
   - `validateV3Onion(address) -> boolean` — lowercase 56 chars /^[a-z2-7]{56}$/ + checksum check
   - `makeV3Onion(pubkey32) -> address` — build address from 32-byte ed25519 pubkey (for tests)
2. **`DomainRegistryDO.js`**: in `handleClaim`, when `tld === "onion"` → `validateV3Onion(target)` else 400; record gains `onion: { v3: true, address: target }`
3. **`test/test_tld.mjs`**: new suite — sha3 known-vector, validate (good/bad length/bad alphabet/bad checksum/case), DO mint invalid → 400, DO mint valid → 201 + onion metadata; update existing onion DO tests to use valid v3 addresses
4. **`test/e2e_live.cjs`**: onion section uses generated valid v3 target (deterministic: SHA-256 of name → 32 bytes → makeV3Onion)
5. **UI**: `public/js/tld_ui.js` + `index.html` — `.onion` selected → target placeholder "56-char v3 onion address (a-z2-7)" + live client validation; button disabled until valid
6. **Deploy**: `npx wrangler deploy` (worker), git push → production; verify: live E2E + browser

## Order
TDD: tests first (step 3 unit tests for onion.js written before/with step 1), then code, then deploy.