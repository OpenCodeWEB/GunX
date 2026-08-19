// Live E2E against the deployed .gunx registry API (main.gunx.pages.dev).
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

  // 1. CLAIM a fresh 8+ char name (free tier)
  const name = "e2e" + Math.random().toString(36).slice(2, 8);
  const target = "test-target-" + Date.now().toString(36);
  const ts = Date.now();
  const diff = getDifficulty(name);
  const mine = await powMine(name, ownerPub, target, ts, diff);
  const claim = { name, ownerPub, target, ts, nonce: mine.nonce, diff, hash: mine.hash };
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
  check("resolve returns target", res.status === 200 && json.record && json.record.target === target, json.record && { target: json.record.target, owner: json.record.ownerPub.slice(0, 8) });

  // 3. LIST
  res = await fetch(API + "/list?owner=" + encodeURIComponent(ownerPub));
  json = await res.json();
  check("list contains claim", res.status === 200 && json.domains && json.domains.some(d => d.name === name), json.domains && json.domains.map(d => d.name));

  // 4. COLLISION — same name, different key must be rejected
  const evil = await SEA.pair();
  const ts2 = Date.now();
  const diff2 = getDifficulty(name);
  const mine2 = await powMine(name, evil.pub, target, ts2, diff2);
  const claim2 = { name, ownerPub: evil.pub, target, ts: ts2, nonce: mine2.nonce, diff: diff2, hash: mine2.hash };
  claim2.sig = await SEA.sign(claim2, { pub: evil.pub, priv: evil.priv });
  res = await fetch(API + "/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(claim2),
  });
  json = await res.json();
  check("double claim rejected (409)", res.status === 409, json);

  // 5. TOUCH — owner-signed { name, ownerPub } only (no PoW)
  const touchBody = { name, ownerPub };
  touchBody.sig = await SEA.sign(touchBody, { pub: pair.pub, priv: pair.priv });
  res = await fetch(API + "/touch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(touchBody),
  });
  json = await res.json();
  check("touch accepted (owner-signed)", res.status === 200 && json.ok, json);

  // 6. TOUCH forged — wrong key must fail
  touchBody.sig = await SEA.sign({ name, ownerPub: evil.pub }, { pub: evil.pub, priv: evil.priv });
  res = await fetch(API + "/touch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, ownerPub, sig: touchBody.sig }),
  });
  json = await res.json();
  check("forged touch rejected", res.status === 400 || res.status === 403, json);

  // 7. STATS reflects 1 domain
  res = await fetch(API + "/stats");
  json = await res.json();
  check("stats total >= 1", res.status === 200 && json.stats && json.stats.total >= 1, json.stats);

  const failed = results.filter(r => !r.ok);
  console.log("\n" + (failed.length === 0 ? "ALL LIVE E2E PASS (" + results.length + ")" : failed.length + " FAILED") + " — owner=" + ownerPub);
  console.log("claimed:", name + ".gunx ->", target);
  process.exit(failed.length === 0 ? 0 : 1);
})().catch(e => { console.error("E2E error:", e); process.exit(1); });