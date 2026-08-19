# DoMain / GunX — Conductor Index

**Project**: OpenCodeWEB DoMain — decentralized domain registry on Cloudflare (`.gunx` TLD) with hybrid web3 features.
**Conductor scope**: Context → Spec & Plan → Implement.

## Documents
- [Product Definition](./product.md)
- [Tech Stack](./tech-stack.md)
- [Workflow](./workflow.md)
- [Tracks Registry](./tracks.md)

## Current Status (2026-08-20)
- **Phase 1** ✅ `.gunx` TLD registry engine — DO + PoW/SEA verify + REST API + SDK + UI (commit `c1c0d6c`)
- **Phase 2** ✅ Dual-TLD: `.gunx` public + `.absup` owner-only (root key mint + signed gift), royalty 33% → ABsUP, usage ranking, web3.bio profile enrichment, leaderboard page, legacy-key migration (commit `671c903`)
- **Phase 3** 🔄 In progress — Gemini (OpenCodeWEB master chat) design review received; roadmap: A) `.onion` unlimited TLD, B) Zora `$absup` payment bridge, C) DoMain Gateway (d2a.pages.dev), D) global leaderboard/analytics