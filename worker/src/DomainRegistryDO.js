/**
 * DomainRegistryDO — .gunx TLD registry Durable Object (Phase 1).
 *
 * The .gunx registry is censorship-proof by design: claim records live in the
 * GunDB graph (soul `tld/gunx/<name>`) and every reader re-verifies PoW + SEA
 * signatures. This DO is the *authoritative index* on top of that graph:
 *
 *   - entitlement accounting  — 3 free domains (8+ chars) per pubkey,
 *     premium (1-7 chars) requires payment, root admin mints unlimited
 *   - pricing                 — Price(N) = BASE × 2^(N−3), N = global mint count
 *   - liveness                — `touch` keeps a domain alive; 90 days of
 *     inactivity releases the name back to the registry (daily DO alarm)
 *   - stats                   — global counters for the registry dashboard
 *
 * Storage layout (Durable Object SQLite / KV keys):
 *   domain:<name>            → { name, ownerPub, target, ts, tier, price,
 *                                status, source, claimedAt, lastActiveAt }
 *   owner:<pub>:count        → number of live claims owned by this pubkey
 *   meta:domains             → total live claim count (N in the pricing)
 *   meta:stats               → { total, free, premium, pending, expired }
 */

import { verifyClaim, verifySeaSig, claimBody } from "./verify_claim.js";

export const BASE_PRICE = 1; // ABS units — Phase 4 wallet integration replaces this
export const FREE_DOMAINS_PER_OWNER = 3;
export const EXPIRE_TTL_MS = 90 * 86400000; // 90 days of inactivity → release
export const EXPIRE_INTERVAL_MS = 24 * 3600000; // daily sweep via DO alarm
export const MIN_NAME_LEN = 1;
export const MAX_NAME_LEN = 63;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

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
    if (last > 0 && last < cutoff) expired.push(rec.name);
  }
  return expired;
}

export class DomainRegistryObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.initialized = this.initialize();
    // simple in-memory token bucket per IP (defense against claim spam)
    this.buckets = new Map();
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

  async initialize() {
    const stats = await this.state.storage.get("meta:stats");
    this.stats = stats || { total: 0, free: 0, premium: 0, pending: 0, expired: 0 };
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
    for (const name of expired) {
      if (seen.has(name)) continue;
      seen.add(name);
      const rec = await this.state.storage.get(`domain:${name}`);
      if (!rec) continue;
      del.push(this.state.storage.delete(`domain:${name}`));
      ownerKeys.push(`owner:${rec.ownerPub}:count`);
    }
    await Promise.all(del);
    // decrement owner counters + global counters
    const puts = [];
    for (const k of ownerKeys) {
      const c = await this.state.storage.get(k);
      if (typeof c === "number" && c > 0) puts.push(this.state.storage.put(k, c - 1));
    }
    this.totalDomains = Math.max(0, this.totalDomains - expired.length);
    this.stats.total = this.totalDomains;
    this.stats.expired = (this.stats.expired || 0) + expired.length;
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
      if (url.pathname === "/resolve" && request.method === "GET") {
        return await this.handleResolve(url.searchParams.get("name"));
      }
      if (url.pathname === "/list" && request.method === "GET") {
        return await this.handleList(url.searchParams.get("owner"));
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

    // 1. cryptographic verification (PoW + SEA signature)
    const verified = await verifyClaim(body);
    if (!verified.ok) return json({ error: verified.error }, 400);

    // 2. liveness: reject claims stamped too far in the past/future
    const ts = Number(body.ts);
    const drift = Math.abs(Date.now() - ts);
    if (drift > 24 * 3600000) return json({ error: "claim timestamp out of window" }, 400);

    // 3. collision: already claimed by someone else?
    const existing = await this.state.storage.get(`domain:${name}`);
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
      isRoot: this.rootPubkeys().has(body.ownerPub),
    });

    const record = {
      name,
      ownerPub: body.ownerPub,
      target: String(body.target || ""),
      ts,
      tier: ent.tier,
      price: ent.price,
      status: ent.status,
      source: ent.source,
      claimedAt: Date.now(),
      lastActiveAt: Date.now(),
    };

    await Promise.all([
      this.state.storage.put(`domain:${name}`, record),
      this.state.storage.put(`owner:${body.ownerPub}:count`, ownerCount + 1),
      this.state.storage.put("meta:domains", this.totalDomains + 1),
    ]);

    this.totalDomains += 1;
    this.stats.total = this.totalDomains;
    this.stats[ent.tier] = (this.stats[ent.tier] || 0) + 1;
    this.stats[ent.status] = (this.stats[ent.status] || 0) + 1;
    await this.state.storage.put("meta:stats", this.stats);

    return json({ ok: true, record }, 201);
  }

  async handleTouch(body) {
    if (!body || typeof body !== "object") return json({ error: "body required" }, 400);
    const name = String(body.name || "").toLowerCase();
    if (!NAME_RE.test(name)) return json({ error: "invalid name" }, 400);
    if (!body.ownerPub || !body.sig) return json({ error: "ownerPub+sig required" }, 400);

    const record = await this.state.storage.get(`domain:${name}`);
    if (!record) return json({ error: "not claimed" }, 404);
    if (record.ownerPub !== body.ownerPub) {
      return json({ error: "not the owner" }, 403);
    }

    // owner-signed { name, ownerPub } proves liveness — SEA signature only.
    const verified = await verifySeaSig(claimBody(body), body.sig, body.ownerPub);
    if (!verified) return json({ error: "SEA signature invalid" }, 400);

    record.lastActiveAt = Date.now();
    await this.state.storage.put(`domain:${name}`, record);
    return json({ ok: true, record });
  }

  async handleResolve(name) {
    if (!name) return json({ error: "name required" }, 400);
    const record = await this.state.storage.get(`domain:${String(name).toLowerCase()}`);
    if (!record) return json({ error: "not found" }, 404);
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

  handleStats() {
    return json({
      ok: true,
      stats: { ...this.stats, totalDomains: this.totalDomains },
      policy: {
        freePerOwner: FREE_DOMAINS_PER_OWNER,
        basePrice: BASE_PRICE,
        pricing: "Price(N)=BASE*2^(N-3)",
        expireAfterMs: EXPIRE_TTL_MS,
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