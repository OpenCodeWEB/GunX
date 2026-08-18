/**
 * test_nostr_sdk.mjs — Phase 2 Step 3: GunX SDK + Nostr bridge integration.
 *
 * Two GunX clients with NO shared gun relay (peers: []) converge purely
 * through a Nostr relay bridge: A.put() -> Kind 30000 -> relay -> B ingest.
 *
 * Run: node test_nostr_sdk.mjs
 */
import { createRequire } from "node:module";
import { WebSocket } from "ws";
import { secp256k1, schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { startMockRelay } from "./mocks/mock_nostr_relay.mjs";

const require = createRequire(import.meta.url);
const codec = require("../sdk/utils/nostr_codec.js");
codec.setSigner({
  randomSecKey: () => Buffer.from(secp256k1.utils.randomSecretKey()).toString("hex"),
  pubkeyOf: (s) => Buffer.from(schnorr.getPublicKey(Buffer.from(s, "hex"))).toString("hex"),
  hashEvent: (ser) => Buffer.from(sha256(new TextEncoder().encode(ser))).toString("hex"),
  sign: (idHex, secHex) => Buffer.from(schnorr.sign(Buffer.from(idHex, "hex"), Buffer.from(secHex, "hex"))).toString("hex"),
  verify: (idHex, sigHex, pubHex) => schnorr.verify(Buffer.from(sigHex, "hex"), Buffer.from(idHex, "hex"), Buffer.from(pubHex, "hex")),
});

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log("  PASS  " + name); }
  else { failed++; console.error("  FAIL  " + name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function waitFor(fn, ms = 5000, step = 50) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      const v = fn();
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error("timeout waiting for condition"));
      setTimeout(poll, step);
    })();
  });
}

console.log("== nostr sdk integration tests ==");

const relay = startMockRelay({ port: 0 });
await new Promise((r) => relay.wss.on("listening", r));
const url = `ws://127.0.0.1:${relay.wss.address().port}`;
console.log("  mock nostr relay on " + url);

const APP = "sdk-nostr-" + Date.now().toString(36);
const Gun = require("gun");
const GunX = require("../sdk/gunx.js");

/* isolated gun instances — no shared relay, Nostr is the only mesh */
const a = GunX({ appKey: APP, storage: false, peers: [], refreshMs: 0 });
const b = GunX({ appKey: APP, storage: false, peers: [], refreshMs: 0 });

/* ---- 1. both connect to the Nostr bridge ---- */
const statusA = [];
const statusB = [];
a.onNostrStatus((s) => statusA.push(s));
b.onNostrStatus((s) => statusB.push(s));
a.connectNostrRelay(url);
b.connectNostrRelay(url);
await waitFor(() => a.nostrStatus.connected && b.nostrStatus.connected);
ok(a.nostrStatus.connected && b.nostrStatus.connected, "both clients bridge-connected");
ok(statusA.length >= 1 && statusB.length >= 1, "onNostrStatus fired on both");

/* ---- 2. A.put() mirrors to Nostr; B ingests into its gun graph ---- */
const soul = "room";
const value = { msg: "hello over nostr", n: Math.floor(Math.random() * 1e6) };
const bRead = new Promise((resolve) => {
  const t = setTimeout(() => resolve({ timeout: true }), 8000);
  b.get(soul).once((data) => {
    if (data && data.n === value.n) { clearTimeout(t); resolve(data); }
  });
});
a.put(soul, value);
const got = await bRead;
ok(!!got && got.msg === value.msg, "B converges via Nostr mesh (no gun relay)");

/* ---- 3. reverse direction: B writes, A reads ---- */
const value2 = { msg: "reply over nostr", n: Math.floor(Math.random() * 1e6) };
const aRead = new Promise((resolve) => {
  const t = setTimeout(() => resolve({ timeout: true }), 8000);
  a.get(soul).once((data) => {
    if (data && data.n === value2.n) { clearTimeout(t); resolve(data); }
  });
});
b.put(soul, value2);
const got2 = await aRead;
ok(!!got2 && got2.msg === value2.msg, "A converges in the reverse direction");

/* ---- 4. replaceable LWW: fresh state wins after resubscribe ---- */
const value3 = { msg: "final state", n: Math.floor(Math.random() * 1e6) };
a.put(soul, value3);
await sleep(400);
const late = GunX({ appKey: APP, storage: false, peers: [], refreshMs: 0 });
const lateRead = new Promise((resolve) => {
  const t = setTimeout(() => resolve({ timeout: true }), 8000);
  late.get(soul).once((data) => { clearTimeout(t); resolve(data); });
});
late.connectNostrRelay(url);
await waitFor(() => late.nostrStatus.connected);
const gotLate = await lateRead;
ok(!!gotLate && gotLate.n === value3.n, "late joiner gets only the final LWW state");

/* ---- 5. mirror only flat payloads (nested objects skipped) ---- */
const sentBefore = a.nostrStatus.eventsSent;
a.put("nested", { outer: { inner: 1 } });
await sleep(300);
ok(a.nostrStatus.eventsSent === sentBefore, "nested object writes are not mirrored");

/* ---- 6. destroyNostr tears the bridge down ---- */
a.destroyNostr();
ok(!a.nostrStatus.connected, "destroyNostr() disconnects the bridge");

a.destroy(); b.destroy(); late.destroy();
await relay.stop();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);