/**
 * test_nostr_codec.mjs — Phase 2 Step 1: NIP-01 codec + Schnorr sign/verify.
 *
 * Pure-logic tests, no network. Run: node test_nostr_codec.mjs
 *
 * @noble/curves is ESM-only, so the codec's injected-signer API is used
 * (the same path browser builds / NIP-07 extensions use).
 */
import { createRequire } from "node:module";
import { secp256k1, schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

const require = createRequire(import.meta.url);
const codec = require("../sdk/utils/nostr_codec.js");

const toHex = (b) => Buffer.from(b).toString("hex");
const fromHex = (h) => new Uint8Array(Buffer.from(h, "hex"));

/* inject the noble-backed signer (Node test path) */
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

console.log("== nostr_codec tests ==");

/* 1. key generation & derivation */
const sec = codec.randomSecKey();
ok(/^[0-9a-f]{64}$/.test(sec), "randomSecKey() -> 64-hex");
const pub = codec.pubkeyOf(sec);
ok(/^[0-9a-f]{64}$/.test(pub), "pubkeyOf() -> 64-hex x-only pubkey");
ok(pub !== sec, "pubkey differs from seckey");

/* 2. deterministic derivation for a known key */
const KNOWN_SEC = "0000000000000000000000000000000000000000000000000000000000000001";
const KNOWN_PUB = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
ok(codec.pubkeyOf(KNOWN_SEC) === KNOWN_PUB, "pubkeyOf(0x01) == G x-coord (BIP340 known vector)");

/* 3. makeEvent -> verifyEvent roundtrip */
const evt = codec.makeEvent({
  kind: 30000,
  tags: [["d", "app/chat/room1"], ["t", "gunx"], ["t", "app_absup"]],
  content: JSON.stringify({ "#": "m123", ">": { "app/chat/room1": { msg: 1724025600 } }, put: { msg: "Hello via Nostr" } }),
  secKeyHex: sec,
});
ok(typeof evt.id === "string" && evt.id.length === 64, "event has 64-hex id");
ok(typeof evt.sig === "string" && evt.sig.length === 128, "event has 128-hex schnorr sig");
ok(evt.pubkey === pub, "event pubkey matches derived pubkey");
ok(evt.kind === 30000 && evt.tags.length === 3, "kind/tags preserved");
ok(codec.verifyEvent(evt), "verifyEvent(signed event) == true");

/* 4. canonical serialization is deterministic */
const evtA = codec.makeEvent({
  kind: 30000,
  tags: [["d", "app/chat/room1"], ["t", "gunx"], ["t", "app_absup"]],
  content: "same",
  secKeyHex: sec,
  createdAt: 1724025600,
});
const evtB = codec.makeEvent({
  kind: 30000,
  tags: [["d", "app/chat/room1"], ["t", "gunx"], ["t", "app_absup"]],
  content: "same",
  secKeyHex: sec,
  createdAt: 1724025600,
});
ok(evtA.id === evtB.id, "identical events -> identical ids (canonical)");
ok(codec.verifyEvent(evtB), "second identical event still verifies (BIP340 aux-rand sigs may differ)");
const evtC = codec.makeEvent({ kind: 30000, tags: [["d", "x"]], content: "other", secKeyHex: sec, createdAt: 1724025600 });
ok(evtA.id !== evtC.id, "different content -> different id");

/* 5. tamper detection */
const bad1 = { ...evt, content: evt.content + "x" };
ok(codec.verifyEvent(bad1) === false, "tampered content rejected");
const bad2 = { ...evt, sig: "0".repeat(128) };
ok(codec.verifyEvent(bad2) === false, "tampered sig rejected");
const bad3 = { ...evt, kind: 1 };
ok(codec.verifyEvent(bad3) === false, "tampered kind rejected (id mismatch)");

/* 6. empty content + no tags still valid */
const minimal = codec.makeEvent({ kind: 20000, tags: [["t", "gunx_presence"]], content: "", secKeyHex: sec });
ok(codec.verifyEvent(minimal), "minimal event verifies");

/* 7. cross-client compatibility: standard nostr event shape accepted */
ok(["id", "pubkey", "created_at", "kind", "tags", "content", "sig"].every((k) => k in evt),
  "event has all NIP-01 fields");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);