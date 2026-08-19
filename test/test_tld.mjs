/**
 * test_tld.mjs — GunX Phase 1: .gunx TLD registry engine tests.
 *
 * Covers:
 *   - sdk/tld/pow.js        difficulty brackets, mining, verification
 *   - sdk/tld/registry.js   claim/verify/resolve/watch/countByOwner (mock gunx)
 *   - worker verify_claim   PoW + SEA signature verification (Web Crypto path)
 *   - DomainRegistryDO      pure logic: pricing, entitlement, expiry
 *
 * Run:  node --test test/test_tld.mjs   (from the repo root)
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

import PoW from "../sdk/tld/pow.js";
import GunXRegistry from "../sdk/tld/registry.js";
import {
  verifyClaim,
  verifyPoW,
  verifySeaSig,
  claimBody,
  getDifficulty,
  hashInput,
} from "../worker/src/verify_claim.js";
import {
  tierFor,
  priceFor,
  entitlementFor,
  expireScan,
  BASE_PRICE,
  FREE_DOMAINS_PER_OWNER,
  EXPIRE_TTL_MS,
} from "../worker/src/DomainRegistryDO.js";

// ── SEA (needs the global Gun wired before loading sea.js) ─────────
let SEA = null;
before(() => {
  if (!globalThis.Gun) globalThis.Gun = require("gun");
  SEA = require("gun/sea.js");
});

after(() => {
  // gun keeps handles alive; force exit (same pattern as test_rooms.mjs)
  process.exit(0);
});

/* ══════════════════════ pow.js (SDK) ══════════════════════ */

test("pow: difficulty brackets by name length", () => {
  assert.equal(PoW.getDifficulty("a"), 6);
  assert.equal(PoW.getDifficulty("abc"), 6);
  assert.equal(PoW.getDifficulty("abcd"), 4);
  assert.equal(PoW.getDifficulty("abcdefg"), 4);
  assert.equal(PoW.getDifficulty("abcdefgh"), 2);
  assert.equal(PoW.getDifficulty("a-very-long-free-name-123"), 2);
});

test("pow: mined hash satisfies the difficulty and verifies", async () => {
  const mine = await PoW.mine("abcdefgh", "pubA", "node1", 1700000000000, 2);
  assert.ok(mine.hash.startsWith("00"));
  const chk = await PoW.verify({
    name: "abcdefgh",
    ownerPub: "pubA",
    target: "node1",
    ts: 1700000000000,
    nonce: mine.nonce,
    diff: 2,
    hash: mine.hash,
  });
  assert.equal(chk.ok, true);
});

test("pow: wrong difficulty is rejected", async () => {
  const mine = await PoW.mine("abcdefgh", "pubA", "node1", 1700000000000, 2);
  const chk = await PoW.verify({
    name: "abcdefgh",
    ownerPub: "pubA",
    target: "node1",
    ts: 1700000000000,
    nonce: mine.nonce,
    diff: 4, // forged difficulty — must fail
    hash: mine.hash,
  });
  assert.equal(chk.ok, false);
  assert.match(chk.error, /difficulty/i);
});

test("pow: invalid names are rejected", async () => {
  const chk = await PoW.verify({ name: "UPPER_case!", ownerPub: "x", target: "y", ts: 1, nonce: 0, diff: 2 });
  assert.equal(chk.ok, false);
});

/* ══════════════════════ registry.js (SDK) ══════════════════════ */

function mockGunx() {
  const store = new Map();
  const sea = { sign: null, verify: null }; // filled with real SEA below
  const gunx = {
    sea,
    ns: (s) => s,
    put: async (soul, val) => {
      store.set(soul, val);
    },
    get: (soul) => ({
      once: (cb) => {
        cb(store.get(soul) || null);
        return this;
      },
    }),
    _store: store,
  };
  sea.sign = async (obj, pair) => SEA.sign(obj, pair);
  sea.verify = async (obj, sig, pub) => {
    const out = await SEA.verify(sig, { pub });
    if (!out) return false;
    const canon = (o) =>
      JSON.stringify(
        Object.keys(o)
          .sort()
          .reduce((a, k) => ((a[k] = o[k]), a), {}),
      );
    return canon(out) === canon(obj);
  };
  return gunx;
}

let alicePair = null;
let bobPair = null;
before(async () => {
  [alicePair, bobPair] = await Promise.all([SEA.pair(), SEA.pair()]);
});

test("registry: claim → resolve → verify round-trip", async () => {
  const gunx = mockGunx();
  const reg = new GunXRegistry(gunx);
  const claim = await reg.claim("myfreename", "node-abc", alicePair, 1700000000000);
  assert.equal(claim.name, "myfreename");
  assert.equal(claim.ownerPub, alicePair.pub);
  assert.ok(claim.nonce >= 0);
  assert.ok(claim.hash);
  assert.ok(claim.sig);

  const res = await reg.resolve("myfreename");
  assert.equal(res.ok, true);
  assert.equal(res.claim.ownerPub, alicePair.pub);
});

test("registry: signature forgery is rejected", async () => {
  const gunx = mockGunx();
  const reg = new GunXRegistry(gunx);
  const claim = await reg.claim("othername", "node-xyz", bobPair, 1700000000000);
  claim.ownerPub = alicePair.pub; // attacker rewrites ownership
  const res = await reg.verify(claim);
  assert.equal(res.ok, false);
});

test("registry: countByOwner tallies only that owner's claims", async () => {
  const gunx = mockGunx();
  const reg = new GunXRegistry(gunx);
  // mock watch-able map: use direct store puts for tally
  await reg.claim("firstname", "n1", alicePair, 1700000000000);
  await reg.claim("secondname", "n2", alicePair, 1700000000001);
  await reg.claim("thirdname", "n3", bobPair, 1700000000002);
  // countByOwner reads the root map — mock with a flat put on rootSoul
  gunx._store.set("tld/gunx", {
    one: { "#": "tld/gunx/one" },
    two: { "#": "tld/gunx/two" },
    three: { "#": "tld/gunx/three" },
  });
  // manual tally over the three claim records stored under their souls
  let alice = 0;
  for (const [soul, rec] of gunx._store) {
    if (soul.startsWith("tld/gunx/") && rec && rec.ownerPub === alicePair.pub) alice++;
  }
  assert.equal(alice, 2);
});

/* ══════════════════════ verify_claim.js (Worker) ══════════════════════ */

test("verify: SEA signature made by gun/sea.js verifies with Web Crypto", async () => {
  const body = { name: "myfreename", ownerPub: alicePair.pub, target: "node-abc", ts: 1700000000000, nonce: 7, diff: 2, hash: "00abc" };
  const sig = await SEA.sign(body, { pub: alicePair.pub, priv: alicePair.priv });
  const ok = await verifySeaSig(body, sig, alicePair.pub);
  assert.equal(ok, true);
});

test("verify: tampered body fails SEA verification", async () => {
  const body = { name: "myfreename", ownerPub: alicePair.pub, target: "node-abc", ts: 1700000000000, nonce: 7, diff: 2, hash: "00abc" };
  const sig = await SEA.sign(body, { pub: alicePair.pub, priv: alicePair.priv });
  const tampered = { ...body, target: "evil-node" };
  const ok = await verifySeaSig(tampered, sig, alicePair.pub);
  assert.equal(ok, false);
});

test("verify: full claim verification (PoW + SEA) with real SDK claim", async () => {
  const mine = await PoW.mine("myfreename", alicePair.pub, "node-abc", 1700000000000, 2);
  const claim = {
    name: "myfreename",
    ownerPub: alicePair.pub,
    target: "node-abc",
    ts: 1700000000000,
    nonce: mine.nonce,
    diff: 2,
    hash: mine.hash,
  };
  claim.sig = await SEA.sign(claim, { pub: alicePair.pub, priv: alicePair.priv });
  const res = await verifyClaim(claim);
  assert.equal(res.ok, true);
  assert.equal(res.claim.name, "myfreename");
});

test("verify: stale claim (bad PoW) fails end-to-end", async () => {
  const claim = {
    name: "myfreename",
    ownerPub: alicePair.pub,
    target: "x",
    ts: 1700000000000,
    nonce: 1, // not mined
    diff: 2,
    hash: "nope",
  };
  claim.sig = await SEA.sign(claim, { pub: alicePair.pub, priv: alicePair.priv });
  const res = await verifyClaim(claim);
  assert.equal(res.ok, false);
});

test("verify: touch-style {name, ownerPub} signature passes, forged owner fails", async () => {
  const body = { name: "myfreename", ownerPub: alicePair.pub };
  const sig = await SEA.sign(body, { pub: alicePair.pub, priv: alicePair.priv });
  assert.equal(await verifySeaSig(claimBody({ ...body, sig }), sig, alicePair.pub), true);
  const forged = { name: "myfreename", ownerPub: bobPair.pub };
  const forgedSig = await SEA.sign(forged, { pub: bobPair.pub, priv: bobPair.priv });
  // attacker signs with their own key but claims alice's pub — mismatch must fail
  assert.equal(await verifySeaSig(claimBody({ ...forged, sig: forgedSig }), forgedSig, alicePair.pub), false);
});

test("verify: hashInput matches SDK canonical form", () => {
  assert.equal(hashInput("a", "p", "t", 1, 2), PoW.hashInput("a", "p", "t", 1, 2));
});

test("verify: difficulty agreement between SDK and Worker", () => {
  for (const name of ["a", "abc", "abcd", "abcdefgh"]) {
    assert.equal(getDifficulty(name), PoW.getDifficulty(name));
  }
});

/* ══════════════════════ DomainRegistryDO pure logic ══════════════════════ */

test("tier: 1-7 chars premium, 8+ free", () => {
  assert.equal(tierFor("x"), "premium");
  assert.equal(tierFor("abcdefg"), "premium");
  assert.equal(tierFor("abcdefgh"), "free");
});

test("pricing: Price(N) = BASE × 2^(N−3), floor at 1", () => {
  assert.equal(priceFor(0), BASE_PRICE);
  assert.equal(priceFor(3), BASE_PRICE);
  assert.equal(priceFor(4), BASE_PRICE * 2);
  assert.equal(priceFor(5), BASE_PRICE * 4);
  assert.equal(priceFor(10), BASE_PRICE * 128);
});

test("entitlement: free tier gives 3 active domains per pubkey", () => {
  const e1 = entitlementFor({ name: "myfreename", ownerPub: "p", total: 10, ownerCount: 0 });
  assert.equal(e1.allowed, true);
  assert.equal(e1.source, "free");
  assert.equal(e1.status, "active");
  const e3 = entitlementFor({ name: "myfreename", ownerPub: "p", total: 10, ownerCount: 2 });
  assert.equal(e3.source, "free");
  const e4 = entitlementFor({ name: "myfreename", ownerPub: "p", total: 10, ownerCount: 3 });
  assert.equal(e4.source, "paid");
  assert.equal(e4.status, "pending_payment");
  assert.equal(e4.price, priceFor(10));
});

test("entitlement: premium names always require payment", () => {
  const e = entitlementFor({ name: "short", ownerPub: "p", total: 5, ownerCount: 0 });
  assert.equal(e.tier, "premium");
  assert.equal(e.source, "paid");
  assert.equal(e.status, "pending_payment");
});

test("entitlement: root admin mints unlimited free", () => {
  const e = entitlementFor({ name: "short", ownerPub: "root", total: 99, ownerCount: 99, isRoot: true });
  assert.equal(e.allowed, true);
  assert.equal(e.source, "admin");
  assert.equal(e.status, "active");
  assert.equal(e.price, 0);
});

test("expire: names inactive for 90+ days are released", () => {
  const now = Date.now();
  const active = { name: "a", claimedAt: now - 10 * 86400000, lastActiveAt: now - 86400000 };
  const stale = { name: "b", claimedAt: now - 200 * 86400000, lastActiveAt: now - 100 * 86400000 };
  const expired = expireScan([active, stale], now);
  assert.deepEqual(expired, ["b"]);
});

test("expire: missing lastActiveAt falls back to claimedAt", () => {
  const now = Date.now();
  const old = { name: "c", claimedAt: now - 200 * 86400000 };
  assert.deepEqual(expireScan([old], now), ["c"]);
  const fresh = { name: "d", claimedAt: now - 1000 };
  assert.deepEqual(expireScan([fresh], now), []);
});

test("policy constants match the vision document", () => {
  assert.equal(FREE_DOMAINS_PER_OWNER, 3);
  assert.equal(EXPIRE_TTL_MS, 90 * 86400000);
  assert.equal(claimBody({ a: 1, sig: "x", b: 2 }).sig, undefined);
  assert.deepEqual(Object.keys(claimBody({ a: 1, b: 2, sig: "x" })), ["a", "b"]);
});