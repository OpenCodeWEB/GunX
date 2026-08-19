# Track: tld-tiers — Phase A: `.onion` unlimited TLD + tiered rules hardening

**Status**: in_progress · **Created**: 2026-08-20 · **Source**: Gemini design review (OpenCodeWEB master chat) + user vision

## Problem
`.onion` TLD doesn't exist. User vision: ".OniOn unlimited — কোনো limit নেই". Gemini review Phase A: `.onion` minted with normal PoW, **no count limit**; tiered rules live in `DomainRegistryDO.js`; add `POST /api/domain/transfer-gift` verification (already exists as `/transfer`).

## Current State (already shipped in Phase 2, commit `671c903`)
- `.gunx` public: PoW + SEA; 1–7 chars premium→`pending_payment`, 8+ free (3/owner)
- `.absup` owner-only: root key mint (no PoW), gift via signed transfer `/transfer`
- Royalty 33% → ABsUP on every record; usage ranking; `/domains?sort=usage`; web3.bio proxy; legacy-key migration

## Requirements
1. **`.onion` TLD** registered in `TLDS`, `TLD_RE`; public mint allowed (any pubkey), PoW required (like `.gunx`), **no free-domain count limit** (unlimited) and **no premium/payment gating** — every `.onion` mint is active immediately
2. Stats: `byTld.onion` counter works; leaderboard/usage ranking includes `.onion`
3. Gift/transfer works for `.onion` same as other TLDs (owner-signed transfer)
4. Resolve/touch/list/domains endpoints accept `tld=onion`
5. SDK + UI updated: mint form TLD selector includes `.onion` with unlimited note; PoW diff rules unchanged (8+ = 2, etc.)
6. Tests: pure logic (`tierFor`/`entitlementFor` for onion), verify-claim path, DO fetch path (mint onion with PoW, transfer onion), stats byTld
7. Deploy worker + Pages; live E2E: mint `.onion` name, resolve, gift-transfer, stats show 3 TLDs

## Acceptance Criteria
- [ ] `entitlementFor({name:'x', tld:'onion', ...})` → allowed, no free-limit logic, status `active`, source `public`
- [ ] `.onion` mint without PoW fails; with valid PoW succeeds
- [ ] Non-root user can mint `.onion` (unlike `.absup`)
- [ ] `/stats` shows `byTld: {gunx, absup, onion}` and policy lists 3 TLDs
- [ ] transfer of `.onion` works end-to-end (live)
- [ ] Live E2E 7/7 + new onion cases green
- [ ] UI: TLD selector shows OniOn + unlimited label

## Out of Scope
- Payment gating for `.onion` (Phase B)
- Custom TLD registry admin UI
- Analytics DO (Phase D)