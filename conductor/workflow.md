# Workflow — DoMain / GunX

## Core Loop
1. **Context**: read/update `conductor/` docs — product vision is the source of truth
2. **Spec & Plan**: every feature = a Track (`conductor/tracks/<id>/spec.md` + `plan.md`); never implement before approved spec
3. **Implement**: TDD — write/extend tests first, then code, then run `node --test test/<file>.mjs`

## Test Commands (Windows — run individually, NOT `node --test test/`)
- Registry engine: `node --test test/test_tld.mjs`
- Live E2E (needs deployed worker + valid keys): `node test/e2e_live.cjs`

## Deploy
- Worker: `npx wrangler deploy` (workdir `worker/`) — hosts DO classes `GunPeerObject`, `DomainRegistryObject`
- Pages: `npx wrangler pages deploy public --project-name gunx --branch main` (repo root)
- **Pages limitations**: no `migrations` in Pages wrangler.toml; DO bindings need `script_name`; Pages bindings propagate slowly after deploy (1101 → OK later)
- After deploy, verify live: `test/e2e_live.cjs` + browser E2E on `main.gunx.pages.dev`

## Commit Convention
`feat: <scope> — <summary>` (matches repo history: `c1c0d6c`, `671c903`)
Commit + push only when the user asks or when a phase completes with tests green.

## Conductor Rules
- Loop protection: during interactive questioning (setup/planning) do NOT create background tasks/OpenCode todos that loop
- Ask clarifying questions when product intent is ambiguous — Gemini master chat (OpenCodeWEB) is the design-consultation channel the user designated