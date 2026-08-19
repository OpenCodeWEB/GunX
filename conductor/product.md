# Product Definition — DoMain (.GunX)

## Vision
An open-source, decentralized domain registry ("DoMain") on Cloudflare Workers/Pages where anyone can mint names under **three TLDs** with different rules, gift them, and point them at live subdomains of a public gateway. Payments flow through crypto/card and auto-convert to **$absup** (Zora creator coin) credited to the ABsUP wallet — 33% royalty to ABsUP on all derived value.

## TLD Tiers
| TLD | Access | Mint rule | Gift? | Limit |
|---|---|---|---|---|
| `.gunx` | Public | PoW + SEA signature; 1–7 chars premium (paid), 8+ free (3/owner) | Yes (signed transfer) | 3 free per pubkey |
| `.absup` | ABsUP only | Root key (ROOT_PUBKEYS) mint, no PoW | Yes (gift to anyone) | unlimited |
| `.onion` | Public | PoW + SEA signature; **no count limit** | Yes | unlimited |

## Business Rules
- **Pricing**: `Price(N) = 1 × 2^(N−3)` ABS units (N = global live domain count), floor 1
- **Expiry**: 90 days of inactivity → released (DO alarm sweep)
- **Royalty**: every record carries `royaltyBps: 3300` (33%) → beneficiary `0x9016a472c308A4e87bed705D066636Adf625D1B0`, license OpenCodeWEB
- **Usage ranking**: resolves + touches counters; `/domains?sort=usage` + leaderboard page at `gunx.pages.dev/domain.html`

## Payment Bridge (Phase B — planned)
- User pays via **crypto (Base chain) or card** → `POST /api/pay/create-checkout` → on webhook, backend executes Zora swap: buys **$absup** (`0x666437f3dd51cdab4a5ded38427bfa705049ee5a`) and sends to ABsUP wallet `0x9016a472c308A4e87bed705D066636Adf625D1B0` (via `@zoralabs/coins-sdk` `tradeCoin` with `recipient`, or Zora CLI)
- Minted premium domains start `pending_payment` until confirmed

## DoMain Gateway (Phase C — planned)
- `d2a.pages.dev` project (repo `github.com/OpenCodeWEB/DoMain`; Cloudflare Pages project `d2a`)
- Wildcard resolution: `NAME.TLD` → `NAME.TLD.D2A.Pages.Dev`
  - **Note (Gemini)**: `*.pages.dev` does NOT support dynamic subdomains → need custom domain (e.g. `d2a.app`) with wildcard CNAME + Pages Functions `functions/[[path]].js` parsing the Host header
- Gateway fetches `gunx.pages.dev/api/domain/*` (registry) + `api.web3.bio/profile/<owner_address>` (profile card) and renders a gateway page

## Identity / Profile
- `functions/api/w3b/[[path]].js` proxies web3.bio profile data (ENS `absup.org`, Farcaster `absup`, Lens `absup.lens`, Base `absup.base.eth`)

## Key Addresses
- Registry DO: Worker `gunx-do` (`https://gunx-do.xup.workers.dev`), class `DomainRegistryObject`; Pages binding `DOMAIN_REGISTRY` (script_name `gunx-do`)
- Pages: `gunx.pages.dev` (project `gunx`)
- ABsUP wallet: `0x9016a472c308A4e87bed705D066636Adf625D1B0`
- $absup coin: `0x666437f3dd51cdab4a5ded38427bfa705049ee5a` (Base, Zora creator coin)