/**
 * test_nostr_bridge.mjs — Phase 2 Step 2: Nostr Relay Bridge integration.
 *
 * Spins up the in-memory mock relay, then exercises two bridge clients
 * (Peer A writes, Peer B receives) + LWW + presence + tamper rejection.
 * Run: node test_nostr_bridge.mjs
 */
import { createRequire } from "node:module";
import { WebSocket } from "ws";
import { secp256k1, schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { startMockRelay } from "./mocks/mock_nostr_relay.mjs";

const require = createRequire(import.meta.url);
const codec = require("../sdk/utils/nostr_codec.js");
const NostrBridge = require("../sdk/transports/nostr_bridge.js");

const toHex = (b) => Buffer.from(b).toString("hex");
const fromHex = (h) => new Uint8Array(Buffer.from(h, "hex"));
codec.setSigner({
  randomSecKey: () => toHex(secp256k1.utils.randomSecretKey()),
  pubkeyOf: (s) => toHex(schnorr.getPublicKey(fromHex(s))),
  hashEvent: (ser) => toHex(sha256(new TextEncoder().encode(ser))),
  sign: (idHex, secHex) => toHex(schnorr.sign(fromHex(idHex), fromHex(secHex))),
  verify: (idHex, sigHex, pubHex) => schnorr.verify(fromHex(sigHex), fromHex(idHex), fromHex(pubHex)),
});

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log("  PASS  " + name); }
  else { failed++; console.error("  FAIL  " + name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function waitFor(fn, ms = 3000, step = 50) {
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

console.log("== nostr_bridge tests ==");

const relay = startMockRelay({ port: 0 });
await new Promise((r) => relay.wss.on("listening", r));
const url = `ws://127.0.0.1:${relay.wss.address().port}`;
console.log("  mock relay on " + url);

const APP = "app_absup";
const secA = codec.randomSecKey();

/* ---- 1. connect + REQ subscription ---- */
const a = new NostrBridge({ relayUrl: url, codec, appKey: APP, secKeyHex: secA, heartbeatMs: 0 });
const b = new NostrBridge({ relayUrl: url, codec, appKey: APP, heartbeatMs: 0 });
const bDag = [];
b.on("dag", (d) => bDag.push(d));
a.connect(); b.connect();
await waitFor(() => a.status.connected && b.status.connected);
ok(a.status.connected && b.status.connected, "both peers connect to relay");
ok(a.status.activeSubs === 1 && b.status.activeSubs === 1, "REQ subscription active on both");

/* ---- 2. Peer A -> relay -> Peer B (gun DAG over Nostr) ---- */
const soul1 = `${APP}/chat/room1`;
const wire1 = { "#": "m1", ">": { [soul1]: { msg: 1724025600 } }, put: { [soul1]: { msg: "Hello via Nostr" } } };
a.publishDag(soul1, wire1);
const got = await waitFor(() => bDag.find((d) => d.wireMsg["#"] === "m1"));
ok(!!got, "Peer B received the gun wire message");
ok(got.soul === soul1, "d tag carries the gun soul key");
ok(got.wireMsg.put[soul1].msg === "Hello via Nostr", "content roundtrips intact");
ok(b.status.eventsReceived >= 1, "received counter increments");

/* ---- 3. Kind 30000 LWW: same soul newer state replaces ---- */
const wire2 = { "#": "m2", ">": { [soul1]: { msg: 1724025700 } }, put: { [soul1]: { msg: "v2 via Nostr" } } };
a.publishDag(soul1, wire2);
await waitFor(() => bDag.some((d) => d.wireMsg["#"] === "m2"));
ok(relay.store.get(soul1) && relay.store.get(soul1).content.includes("v2 via Nostr"),
  "mock relay LWW store holds latest state for the soul");

/* ---- 4. late joiner gets only the latest state (LWW replay) ---- */
const c = new NostrBridge({ relayUrl: url, codec, appKey: APP, heartbeatMs: 0 });
const cDag = [];
c.on("dag", (d) => cDag.push(d));
c.connect();
await waitFor(() => c.status.connected);
await sleep(300);
const cMsgs = cDag.filter((d) => d.soul === soul1);
ok(cMsgs.length === 1 && cMsgs[0].wireMsg["#"] === "m2",
  "late joiner receives exactly the latest LWW state (no stale m1)");

/* ---- 5. presence heartbeat (Kind 20000) reaches relay history ---- */
const before = relay.allEvents.length;
a.publishPresence({ appKey: APP, via: "test" });
await waitFor(() => relay.allEvents.length > before);
const pres = relay.allEvents.filter((e) => e.kind === 20000);
ok(pres.length >= 1, "kind 20000 presence event stored/broadcast by relay");

/* ---- 6. relay rejects events with invalid signatures ---- */
const raw = new WebSocket(url);
await new Promise((r) => raw.on("open", r));
const forged = codec.makeEvent({
  kind: 30000,
  tags: [["d", `${APP}/forged`], ["t", "gunx"], ["t", APP]],
  content: "{}",
  secKeyHex: secA,
});
forged.sig = "0".repeat(128);
const ack = new Promise((r) => {
  raw.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m[0] === "OK" && m[1] === forged.id) r(m);
  });
  raw.send(JSON.stringify(["EVENT", forged]));
});
const ackMsg = await ack;
ok(ackMsg[2] === false, "relay rejects forged signature (OK false)");
ok(!relay.allEvents.some((e) => e.id === forged.id), "forged event not stored");
raw.close();

/* ---- 7. destroy cleans up ---- */
a.destroy(); b.destroy(); c.destroy();
ok(!a.status.connected && !b.status.connected && !c.status.connected, "destroy() disconnects all");

await relay.stop();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);