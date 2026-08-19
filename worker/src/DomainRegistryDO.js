/**
 * DomainRegistryDO — .gunx + .absup TLD registry Durable Object (Phase 2).
 *
 * Two-tier namespace:
 *   - `.gunx`  public TLD  — anyone can mint (PoW + SEA), free/premium tiers
 *   - `.absup` owner TLD   — ONLY the ABsUP root key (ROOT_PUBKEYS) can mint;
 *                            names can then be *gifted* (signed transfer) to
 *                            anyone. No PoW needed — root signature is enough.
 *
 * Every record carries the OpenCodeWEB royalty terms (33% → ABsUP), so any
 * future sale/transfer of value derived from this open-source stack splits
 * 33% to the beneficiary wallet.
 *
 * Usage ranking: every resolve/touch increments counters; /domains returns
 * the full registry sorted by usage/traffic for gunx.pages.dev/domain.
 *
 * Storage layout (Durable Object SQLite / KV keys):
 *   domain:<tld>:<name>     → record (see handleClaim for shape)
 *   owner:<pub>:count       → live claims owned by this pubkey
 *   meta:domains            → total live claim count (N in pricing)
 *   meta:stats              → { total, free, premium, pending, expired, byTld }
 */

import { verifyClaim, verifySeaSig, claimBody } from "./verify_claim.js";

export const BASE_PRICE = 1; // ABS units — Phase 4 wallet integration replaces this
export const FREE_DOMAINS_PER_OWNER = 3;
export const EXPIRE_TTL_MS = 90 * 86400000; // 90 days of inactivity → release
export const EXPIRE_INTERVAL_MS = 24 * 3600000; // daily sweep via DO alarm
export const MIN_NAME_LEN = 1;
export const MAX_NAME_LEN = 63;
export const ROYALTY_BPS = 3300; // 33% of derived value flows to ABsUP
export const BENEFICIARY = "0x9016a472c308A4e87bed705D066636Adf625D1B0";
export const LICENSE = "OpenCodeWEB";
export const TLDS = ["gunx", "absup"];

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TLD_RE = /^(gunx|absup)$/;

/** Domain tier by length — 1-7 chars are premium, 8+ are free-tier. */
export function tierFor(name) {
  return String(name).length <= 7 ? "premium" : "free";
}

/** Price(N) = BASE × 2^(N−3), floored at 1 for N ≤ 3. */
export function priceFor(totalDomains) {
  const n = Math.max(0, Math.floor(totalDomains || 0));
  const exp = Math.max(0, n - 3);
  return BASE_PRICE * Math.pow(2, exp);
}

/** OpenCodeWEB royalty terms attached to every claim record. */
export function royaltyFor() {
  return { royaltyBps: ROYALTY_BPS, beneficiary: BENEFICIARY, license: LICENSE };
}

/**
 * Entitlement decision for a claim (pure, unit-testable).
 *
 * @param {object} opts
 *   name         lower-case domain label
 *   ownerPub     claiming pubkey
 *   total        global live domain count (N in pricing)
 *   ownerCount   live domains already owned by this pubkey
 *   isRoot       pubkey present in ROOT_PUBKEYS → unlimited free mint
 * @returns {{allowed:boolean, tier:string, price:number, source:string,
 *            status:string, reason?:string}}
 */
export function entitlementFor({ name, ownerPub, total = 0, ownerCount = 0, isRoot = false }) {
  const tier = tierFor(name);
  if (isRoot) {
    return { allowed: true, tier, price: 0, source: "admin", status: "active" };
  }
  if (tier === "free") {
    const remaining = FREE_DOMAINS_PER_OWNER - ownerCount;
    if (remaining > 0) {
      return { allowed: true, tier, price: 0, source: "free", status: "active" };
    }
    return {
      allowed: true,
      tier,
      price: priceFor(total),
      source: "paid",
      status: "pending_payment",
    };
  }
  // premium (1-7 chars) always requires payment — until Phase 4 wallet flow.
  return {
    allowed: true,
    tier,
    price: priceFor(total),
    source: "paid",
    status: "pending_payment",
  };
}

/**
 * Expiry scan (pure, unit-testable): returns names whose last activity is
 * older than EXPIRE_TTL_MS. Does NOT mutate anything — the DO applies it.
 */
export function expireScan(records, now = Date.now()) {
  const cutoff = now - EXPIRE_TTL_MS;
  const expired = [];
  for (const rec of records) {
    if (!rec || typeof rec !== "object") continue;
    const last = typeof rec.lastActiveAt === "number" ? rec.lastActiveAt : rec.claimedAt || 0;
    if (last > 0 && last < cutoff) expired.push(rec);
  }
  return expired;
}

/** Sort full registry by usage/traffic (resolves+touches), tie → name. */
export function rankDomains(records) {
  return records
    .filter((r) => r && typeof r === "object")
    .sort((a, b) => {
      const ua = (a.resolves || 0) + (a.touches || 0);
      const ub = (b.resolves || 0) + (b.touches || 0);
      if (ub !== ua) return ub - ua;
      return String(a.name).localeCompare(String(b.name));
    });
}

export class DomainRegistryObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.initialized = this.initialize();
    // simple in-memory token bucket per IP (defense against claim spam)
    this.buckets = new Map();
    // resolve pulse: throttle resolve-counter increments per IP (30s)
    this.resolvePulse = new Map();
  }

  rootPubkeys() {
    const raw = this.env?.ROOT_PUBKEYS || "";
    return new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  rateLimit(id, capacity = 30, windowMs = 60000) {
    if (!id) return true;
    const now = Date.now();
    const b = this.buckets.get(id);
    if (!b || now - b.resetAt > windowMs) {
      this.buckets.set(id, { count: 1, resetAt: now + windowMs });
      return true;
    }
    b.count += 1;
    if (this.buckets.size > 5000) this.buckets.clear();
    return b.count <= capacity;
  }

  pulse(id, windowMs = 30000) {
    const now = Date.now();
    const at = this.resolvePulse.get(id);
    if (!at || now - at > windowMs) {
      this.resolvePulse.set(id, now);
      if (this.resolvePulse.size > 10000) this.resolvePulse.clear();
      return true;
    }
    return false;
  }

  async initialize() {
    await this.migrateLegacyKeys();
    const stats = await this.state.storage.get("meta:stats");
    this.stats = stats || { total: 0, free: 0, premium: 0, pending: 0, expired: 0, byTld: {} };
    const total = await this.state.storage.get("meta:domains");
    this.totalDomains = typeof total === "number" ? total : 0;
    await this.scheduleExpire();
  }

  scheduleExpire() {
    return this.state.storage.setAlarm(Date.now() + EXPIRE_INTERVAL_MS);
  }

  async alarm() {
    await this.initialized;
    await this.runExpire();
    await this.scheduleExpire();
  }

  keyFor(tld, name) {
    return `domain:${tld}:${name}`;
  }

  /**
   * Phase 1 records were stored under `domain:<name>` (no TLD).
   * Phase 2 namespaces by TLD (`domain:<tld>:<name>`). One-time migration:
   * re-key legacy .gunx records (they carry no tld field) and drop the old
   * keys so prefix scans don't double-count. Runs on first fetch.
   */
  async migrateLegacyKeys() {
    if (this._migrated) return;
    this._migrated = true;
    const page = await this.state.storage.list({ prefix: "domain:", limit: 1000 });
    const puts = [];
    const dels = [];
    for (const [key, rec] of page.entries()) {
      if (key.startsWith("domain:gunx:") || key.startsWith("domain:absup:")) continue;
      const name = key.slice("domain:".length);
      if (!name || !rec || typeof rec !== "object") continue;
      if (rec.tld && rec.tld !== "gunx") continue; // foreign format — leave it
      const newKey = this.keyFor("gunx", name);
      const existing = await this.state.storage.get(newKey);
      if (!existing) {
        rec.tld = "gunx";
        puts.push(this.state.storage.put(newKey, rec));
      }
      dels.push(this.state.storage.delete(key));
    }
    await Promise.all(puts);
    await Promise.all(dels);
  }

  bumpStats(tier, status, tld, delta = 1) {
    this.stats.total = Math.max(0, (this.stats.total || 0) + delta);
    this.stats[tier] = Math.max(0, (this.stats[tier] || 0) + delta);
    this.stats[status] = Math.max(0, (this.stats[status] || 0) + delta);
    if (tld) {
      this.stats.byTld = this.stats.byTld || {};
      this.stats.byTld[tld] = Math.max(0, (this.stats.byTld[tld] || 0) + delta);
    }
  }

  /** Daily sweep: release names inactive for 90+ days. */
  async runExpire() {
    const now = Date.now();
    const keys = [];
    let cursor;
    do {
      const page = await this.state.storage.list({ prefix: "domain:", cursor });
      for (const [key, rec] of page.entries()) keys.push([key, rec]);
      cursor = page?.list_complete === false ? page?.cursor : undefined;
    } while (cursor);

    const expired = expireScan(keys.map(([, r]) => r), now);
    if (!expired.length) return;
    const seen = new Set();
    const del = [];
    const ownerKeys = [];
    for (const rec of expired) {
      const id = rec.tld + ":" + rec.name;
      if (seen.has(id)) continue;
      seen.add(id);
      const current = await this.state.storage.get(this.keyFor(rec.tld, rec.name));
      if (!current) continue;
      del.push(this.state.storage.delete(this.keyFor(rec.tld, rec.name)));
      ownerKeys.push(`owner:${rec.ownerPub}:count`);
      this.bumpStats(rec.tier, "expired", rec.tld, -1);
    }
    await Promise.all(del);
    // decrement owner counters
    const puts = [];
    for (const k of ownerKeys) {
      const c = await this.state.storage.get(k);
      if (typeof c === "number" && c > 0) puts.push(this.state.storage.put(k, c - 1));
    }
    this.totalDomains = Math.max(0, this.totalDomains - seen.size);
    puts.push(
      this.state.storage.put("meta:domains", this.totalDomains),
      this.state.storage.put("meta:stats", this.stats),
    );
    await Promise.all(puts);
  }

  async fetch(request) {
    await this.initialized;
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: JSON_HEADERS });
    }
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    try {
      if (url.pathname === "/claim" && request.method === "POST") {
        if (!this.rateLimit(ip, 15, 60000)) return json({ error: "rate limited" }, 429);
        return await this.handleClaim(await request.json());
      }
      if (url.pathname === "/touch" && request.method === "POST") {
        if (!this.rateLimit(ip, 30, 60000)) return json({ error: "rate limited" }, 429);
        return await this.handleTouch(await request.json());
      }
      if (url.pathname === "/transfer" && request.method === "POST") {
        if (!this.rateLimit(ip, 15, 60000)) return json({ error: "rate limited" }, 429);
        return await this.handleTransfer(await request.json());
      }
      if (url.pathname === "/resolve" && request.method === "GET") {
        return await this.handleResolve(url.searchParams.get("name"), url.searchParams.get("tld"));
      }
      if (url.pathname === "/list" && request.method === "GET") {
        return await this.handleList(url.searchParams.get("owner"));
      }
      if (url.pathname === "/domains" && request.method === "GET") {
        return await this.handleDomains(url.searchParams.get("sort"));
      }
      if (url.pathname === "/stats" && request.method === "GET") {
        return this.handleStats();
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e?.message || e) }, 400);
    }
  }

  /* ── handlers ───────────────────────────────────────────────────── */

  async handleClaim(body) {
    if (!body || typeof body !== "object") return json({ error: "body required" }, 400);
    const tld = String(body.tld || "gunx").toLowerCase();
    if (!TLD_RE.test(tld)) return json({ error: "invalid tld (gunx|absup)" }, 400);
    const name = String(body.name || "").toLowerCase();
    if (!NAME_RE.test(name) || name.length < MIN_NAME_LEN || name.length > MAX_NAME_LEN) {
      return json({ error: "invalid name" }, 400);
    }
    if (!body.ownerPub || typeof body.ownerPub !== "string") {
      return json({ error: "ownerPub required" }, 400);
    }
    if (!body.sig || typeof body.sig !== "string") {
      return json({ error: "sig required" }, 400);
    }

    const isRoot = this.rootPubkeys().has(body.ownerPub);

    // .absup is owner-only: only the ABsUP root key can mint.
    if (tld === "absup" && !isRoot) {
      return json({ error: ".absup is ABsUP-owned — minted by the root key or gifted" }, 403);
    }

    // 1. cryptographic verification (PoW + SEA). .absup root mints are
    //    signature-secured — the root key IS the gate, so PoW is skipped.
    const verified = await verifyClaim(body, { requirePow: tld !== "absup" });
    if (!verified.ok) return json({ error: verified.error }, 400);

    // 2. liveness: reject claims stamped too far in the past/future
    const ts = Number(body.ts);
    const drift = Math.abs(Date.now() - ts);
    if (drift > 24 * 3600000) return json({ error: "claim timestamp out of window" }, 400);

    // 3. collision: already claimed by someone else?
    const existing = await this.state.storage.get(this.keyFor(tld, name));
    if (existing) {
      return json(
        {
          error: "name already claimed",
          ownerPub: existing.ownerPub,
          claimedAt: existing.claimedAt,
        },
        409,
      );
    }

    // 4. entitlement (free tier / premium payment / root admin)
    const ownerCount = (await this.state.storage.get(`owner:${body.ownerPub}:count`)) || 0;
    const ent = entitlementFor({
      name,
      ownerPub: body.ownerPub,
      total: this.totalDomains,
      ownerCount,
      isRoot,
    });

    const record = {
      name,
      tld,
      ownerPub: body.ownerPub,
      target: String(body.target || ""),
      ts,
      tier: ent.tier,
      price: ent.price,
      status: ent.status,
      source: ent.source,
      ...royaltyFor(),
      resolves: 0,
      touches: 0,
      claimedAt: Date.now(),
      lastActiveAt: Date.now(),
    };

    await Promise.all([
      this.state.storage.put(this.keyFor(tld, name), record),
      this.state.storage.put(`owner:${body.ownerPub}:count`, ownerCount + 1),
      this.state.storage.put("meta:domains", this.totalDomains + 1),
    ]);

    this.totalDomains += 1;
    this.bumpStats(ent.tier, ent.status, tld, 1);
    await this.state.storage.put("meta:stats", this.stats);

    return json({ ok: true, record }, 201);
  }

  async handleTouch(body) {
    if (!body || typeof body !== "object") return json({ error: "body required" }, 400);
    const tld = String(body.tld || "gunx").toLowerCase();
    if (!TLD_RE.test(tld)) return json({ error: "invalid tld" }, 400);
    const name = String(body.name || "").toLowerCase();
    if (!NAME_RE.test(name)) return json({ error: "invalid name" }, 400);
    if (!body.ownerPub || !body.sig) return json({ error: "ownerPub+sig required" }, 400);

    const record = await this.state.storage.get(this.keyFor(tld, name));
    if (!record) return json({ error: "not claimed" }, 404);
    if (record.ownerPub !== body.ownerPub) {
      return json({ error: "not the owner" }, 403);
    }

    // owner-signed { name, tld, ownerPub } proves liveness — SEA signature only.
    const verified = await verifySeaSig(claimBody(body), body.sig, body.ownerPub);
    if (!verified) return json({ error: "SEA signature invalid" }, 400);

    record.lastActiveAt = Date.now();
    record.touches = (record.touches || 0) + 1;
    await this.state.storage.put(this.keyFor(tld, name), record);
    return json({ ok: true, record });
  }

  /** Gift / transfer: current owner signs { name, tld, newOwnerPub }. */
  async handleTransfer(body) {
    if (!body || typeof body !== "object") return json({ error: "body required" }, 400);
    const tld = String(body.tld || "gunx").toLowerCase();
    if (!TLD_RE.test(tld)) return json({ error: "invalid tld" }, 400);
    const name = String(body.name || "").toLowerCase();
    if (!NAME_RE.test(name)) return json({ error: "invalid name" }, 400);
    if (!body.ownerPub || !body.newOwnerPub || !body.sig) {
      return json({ error: "ownerPub+newOwnerPub+sig required" }, 400);
    }
    if (body.ownerPub === body.newOwnerPub) {
      return json({ error: "already owned by that key" }, 400);
    }

    const key = this.keyFor(tld, name);
    const record = await this.state.storage.get(key);
    if (!record) return json({ error: "not claimed" }, 404);
    if (record.ownerPub !== body.ownerPub) {
      return json({ error: "not the owner" }, 403);
    }

    // owner signature covers { name, tld, newOwnerPub }
    const gift = { name, tld, newOwnerPub: body.newOwnerPub };
    const verified = await verifySeaSig(gift, body.sig, body.ownerPub);
    if (!verified) return json({ error: "SEA signature invalid" }, 400);

    const oldCount = (await this.state.storage.get(`owner:${body.ownerPub}:count`)) || 0;
    const newCount = (await this.state.storage.get(`owner:${body.newOwnerPub}:count`)) || 0;

    record.ownerPub = body.newOwnerPub;
    record.transferredAt = Date.now();
    record.transfers = (record.transfers || 0) + 1;

    await Promise.all([
      this.state.storage.put(key, record),
      this.state.storage.put(`owner:${body.ownerPub}:count`, Math.max(0, oldCount - 1)),
      this.state.storage.put(`owner:${body.newOwnerPub}:count`, newCount + 1),
    ]);

    return json({ ok: true, record });
  }

  async handleResolve(name, tld) {
    if (!name) return json({ error: "name required" }, 400);
    const tt = String(tld || "gunx").toLowerCase();
    if (!TLD_RE.test(tt)) return json({ error: "invalid tld" }, 400);
    const record = await this.state.storage.get(this.keyFor(tt, String(name).toLowerCase()));
    if (!record) return json({ error: "not found" }, 404);
    // usage counter — throttled per IP so a single client can't inflate ranks
    if (this.pulse("res:" + tt + ":" + name)) {
      record.resolves = (record.resolves || 0) + 1;
      await this.state.storage.put(this.keyFor(tt, String(name).toLowerCase()), record);
    }
    return json({ ok: true, record });
  }

  async handleList(owner) {
    if (!owner) return json({ error: "owner required" }, 400);
    const records = [];
    let cursor;
    do {
      const page = await this.state.storage.list({ prefix: "domain:", cursor });
      for (const [, rec] of page.entries()) {
        if (rec.ownerPub === owner) records.push(rec);
      }
      cursor = page?.list_complete === false ? page?.cursor : undefined;
    } while (cursor);
    return json({ ok: true, domains: records });
  }

  async handleDomains(sort) {
    const records = [];
    let cursor;
    do {
      const page = await this.state.storage.list({ prefix: "domain:", cursor });
      for (const [, rec] of page.entries()) records.push(rec);
      cursor = page?.list_complete === false ? page?.cursor : undefined;
    } while (cursor);
    if (sort === "usage" || sort === "traffic") {
      return json({ ok: true, domains: rankDomains(records), sort: "usage" });
    }
    return json({
      ok: true,
      domains: records.sort((a, b) => String(a.name).localeCompare(String(b.name))),
      sort: "name",
    });
  }

  handleStats() {
    return json({
      ok: true,
      stats: { ...this.stats, totalDomains: this.totalDomains },
      policy: {
        freePerOwner: FREE_DOMAINS_PER_OWNER,
        basePrice: BASE_PRICE,
        pricing: "Price(N)=BASE*2^(N-3)",
        expireAfterMs: EXPIRE_TTL_MS,
        royaltyBps: ROYALTY_BPS,
        beneficiary: BENEFICIARY,
        license: LICENSE,
        tlDs: TLDS,
        rootAdmins: this.rootPubkeys().size,
      },
    });
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: JSON_HEADERS });
    }
    const id = env.DOMAIN_REGISTRY.idFromName("default");
    const stub = env.DOMAIN_REGISTRY.get(id);
    return stub.fetch(request);
  },
};