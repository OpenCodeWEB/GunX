# Plan: tld-tiers — `.onion` unlimited TLD

**Spec**: [spec.md](./spec.md) · **Approach**: TDD — tests first, then implementation, then deploy + live verify.

## Steps

### 1. Tests (test/test_tld.mjs — extend)
- `TLDS` includes `"onion"`; `TLD_RE` accepts it
- `entitlementFor({ name, tld: 'onion', ownerCount: 99 })` → `allowed: true`, `status: 'active'`, `source: 'public'`, no payment
- `.onion` verify: `verifyClaim(claim)` with valid PoW passes (default requirePow=true)
- DO fetch path: POST /claim with `tld: 'onion'` + mined PoW → 201; non-root user succeeds
- `/stats` policy `tlDs` includes onion
- Transfer `.onion`: signed gift verifies (already generic — assert works)

### 2. Implementation (worker/src/DomainRegistryDO.js)
- `TLDS = ["gunx", "absup", "onion"]`
- `TLD_RE = /^(gunx|absup|onion)$/`
- `entitlementFor`: branch on `tld` — if `tld === 'onion'` → `{ allowed: true, tier, price: 0, source: 'public', status: 'active' }` (unlimited, PoW already enforced by verifyClaim before entitlement)
- `handleClaim`: `.absup` root gate stays; `.onion` has no root gate (public)
- Verify PoW requirement: `.onion` uses default `requirePow: true` (like `.gunx`)

### 3. SDK + UI
- `public/js/tld_ui.js`: TLD selector add `onion` (label "OniOn — unlimited"); show unlimited note
- SDK `sdk/tld/registry.js`: nothing TLD-specific needed (name param); confirm no hardcoded TLD list — update if present

### 4. Deploy + Live verify
- `npx wrangler deploy` (worker dir) → Pages deploy
- Extend `test/e2e_live.cjs` with onion mint/resolve/transfer cases → run → expect green

## Verification
- `node --test test/test_tld.mjs` — all green (existing 11+ + new)
- Live E2E green on deployed worker/pages
- Commit: `feat: Phase A — .onion unlimited TLD (public mint, no count limit)`