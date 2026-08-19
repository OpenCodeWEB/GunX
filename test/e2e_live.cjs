// Live E2E against the deployed .gunx + .absup registry API (main.gunx.pages.dev).
const Gun = require("gun");
globalThis.Gun = Gun;
const SEA = require("gun/sea.js");
const PoW = require("../sdk/tld/pow.js");
const powMine = PoW.mine;
const getDifficulty = PoW.getDifficulty;

const API = "https://main.gunx.pages.dev/api/domain";
const results = [];
function check(label, cond, extra) {
  results.push({ label, ok: !!cond, extra });
  console.log((cond ? "PASS" : "FAIL") + "  " + label + (extra ? "  " + JSON.stringify(extra) : ""));
}

(async () => {
  const pair = await SEA.pair();
  const ownerPub = pair.pub;
  console.log("identity:", ownerPub.slice(0, 20) + "...");

  // 1. CLAIM a fresh 8+ char name (free tier, .gunx)
  const name = "e2e" + Math.random().toString(36).slice(2, 8);
  const target = "test-target-" + Date.now().toString(36);
  const ts = Date.now();
  const diff = getDifficulty(name);
  const mine = await powMine(name, ownerPub, target, ts, diff);
  const claim = { tld: "gunx", name, ownerPub, target, ts, nonce: mine.nonce, diff, hash: mine.hash };
  claim.sig = await SEA.sign(claim, { pub: pair.pub, priv: pair.priv });

  let res = await fetch(API + "/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(claim),
  });
  let json = await res.json();
  check("claim accepted (201)", res.status === 201, json.ok ? json.record : json.error);
  const record = json.record;

  // 2. RESOLVE
  res = await fetch(API + "/resolve?name=" + encodeURIComponent(name));
  json = await res.json();
  check("resolve returns target + tld", res.status === 200 && json.record && json.record.target === target && json.record.tld === "gunx", json.record && { target: json.record.target, tld: json.record.tld });

  // 3. LIST
  res = await fetch(API + "/list?owner=" + encodeURIComponent(ownerPub));
  json = await res.json();
  check("list contains claim", res.status === 200 && json.domains && json.domains.some(d => d.name === name), json.domains && json.domains.map(d => d.name));

  // 4. COLLISION — same name, different key must be rejected
  const evil = await SEA.pair();
  const ts2 = Date.now();
  const diff2 = getDifficulty(name);
  const mine2 = await powMine(name, evil.pub, target, ts2, diff2);
  const claim2 = { tld: "gunx", name, ownerPub: evil.pub, target, ts: ts2, nonce: mine2.nonce, diff: diff2, hash: mine2.hash };
  claim2.sig = await SEA.sign(claim2, { pub: evil.pub, priv: evil.priv });
  res = await fetch(API + "/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(claim2),
  });
  json = await res.json();
  check("double claim rejected (409)", res.status === 409, json);

  // 5. .ABSUP mint with a non-root key must be rejected (root-only TLD)
  const absName = "e2e" + Math.random().toString(36).slice(2, 6);
  const absClaim = { tld: "absup", name: absName, ownerPub, target: "absup.pages.dev", ts: Date.now(), nonce: 0, diff: 0, hash: "" };
  absClaim.sig = await SEA.sign(absClaim, { pub: pair.pub, priv: pair.priv });
  res = await fetch(API + "/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(absClaim),
  });
  json = await res.json();
  check("non-root .absup mint rejected (403)", res.status === 403, json);

  // 6. TOUCH — owner-signed { name, ownerPub, tld } only (no PoW)
  const touchBody = { name, ownerPub, tld: "gunx" };
  touchBody.sig = await SEA.sign(touchBody, { pub: pair.pub, priv: pair.priv });
  res = await fetch(API + "/touch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(touchBody),
  });
  json = await res.json();
  check("touch accepted (owner-signed)", res.status === 200 && json.ok, json);

  // 7. TOUCH forged — wrong key must fail
  res = await fetch(API + "/touch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, ownerPub, tld: "gunx", sig: (await SEA.sign({ name, ownerPub, tld: "gunx" }, { pub: evil.pub, priv: evil.priv })) }),
  });
  json = await res.json();
  check("forged touch rejected", res.status === 400 || res.status === 403, json);

  // 8. GIFT — signed transfer owner -> newOwner, then resolve shows new owner
  const newOwner = await SEA.pair();
  const giftRec = { name, tld: "gunx", newOwnerPub: newOwner.pub };
  giftRec.sig = await SEA.sign(giftRec, { pub: pair.pub, priv: pair.priv });
  res = await fetch(API + "/transfer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, tld: "gunx", ownerPub, newOwnerPub: newOwner.pub, sig: giftRec.sig }),
  });
  json = await res.json();
  check("gift accepted", res.status === 200 && json.ok, json);
  res = await fetch(API + "/resolve?name=" + encodeURIComponent(name));
  json = await res.json();
  check("resolve shows new owner after gift", json.record && json.record.ownerPub === newOwner.pub, json.record && { owner: json.record.ownerPub.slice(0, 8) });

  // 9. FORGED GIFT — non-owner cannot transfer
  const forgedGift = { name, tld: "gunx", newOwnerPub: evil.pub };
  forgedGift.sig = await SEA.sign(forgedGift, { pub: evil.pub, priv: evil.priv });
  res = await fetch(API + "/transfer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, tld: "gunx", ownerPub, newOwnerPub: evil.pub, sig: forgedGift.sig }),
  });
  json = await res.json();
  check("forged gift rejected", res.status === 400 || res.status === 403, json);

  // 10. RANKING — /domains?sort=usage returns the claimed name with usage counters
  res = await fetch(API + "/domains?sort=usage");
  json = await res.json();
  const found = json.domains && json.domains.find(d => d.name === name && (d.tld || "gunx") === "gunx");
  check("domains ranking contains claim with uses", json.ok && !!found && typeof found.resolves === "number", found && { uses: found.resolves + found.touches });

  // 11. STATS reflects domains + byTld
  res = await fetch(API + "/stats");
  json = await res.json();
  check("stats total >= 1 + byTld", res.status === 200 && json.stats && json.stats.total >= 1 && json.stats.byTld && typeof json.stats.byTld.gunx === "number", json.stats);

  const failed = results.filter(r => !r.ok);
  console.log("\n" + (failed.length === 0 ? "ALL LIVE E2E PASS (" + results.length + ")" : failed.length + " FAILED") + " — owner=" + ownerPub);
  console.log("claimed:", name + ".gunx ->", target, "| gifted to", newOwner.pub.slice(0, 10) + "...");
  process.exit(failed.length === 0 ? 0 : 1);
})().catch(e => { console.error("E2E error:", e); process.exit(1); });