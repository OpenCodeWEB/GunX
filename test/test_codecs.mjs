/**
 * test_codecs.mjs — pure codec / framing unit tests for the DirectRTC
 * transport (sdk/transports/direct_rtc.js). No WebRTC needed.
 *
 * Run: node test/test_codecs.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const DirectRTC = require("../sdk/transports/direct_rtc.js");
const C = DirectRTC.codecs;

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log("  ok  " + name); })
    .catch((e) => { failed++; console.error("FAIL  " + name + "\n      " + (e && e.message)); });
}

/* ── SDP stripping ─────────────────────────────────────────────── */

const SAMPLE_SDP = [
  "v=0",
  "o=- 1234567890 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "a=extmap-allow-mixed",
  "a=msid-semantic: WMS",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "c=IN IP4 0.0.0.0",
  "a=ice-ufrag:abcd",
  "a=ice-pwd:efghijklmnopqrstuv",
  "a=ice-options:trickle",
  "a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99",
  "a=setup:actpass",
  "a=mid:0",
  "a=sctp-port:5000",
  "a=max-message-size:262144",
  "a=candidate:1 1 UDP 2122260223 192.168.1.5 54321 typ host",
  "a=end-of-candidates",
  "",
].join("\r\n");

await t("stripSdp keeps wire-relevant lines", () => {
  const out = C.stripSdp(SAMPLE_SDP);
  for (const keep of ["v=0", "a=ice-ufrag:abcd", "a=ice-pwd:", "a=fingerprint:", "a=candidate:", "a=setup:", "m=application", "a=sctp-port:", "a=extmap-allow-mixed", "a=ice-options:trickle", "a=msid-semantic: WMS"]) {
    assert.ok(out.includes(keep), "expected to keep: " + keep);
  }
  for (const drop of ["a=end-of-candidates"]) {
    assert.ok(!out.includes(drop), "expected to drop: " + drop);
  }
  assert.ok(!out.includes("\r\n\r\n"), "no blank-line runs");
});

await t("stripSdp is deterministic & idempotent", () => {
  const a = C.stripSdp(SAMPLE_SDP);
  const b = C.stripSdp(SAMPLE_SDP);
  const c = C.stripSdp(a);
  assert.equal(a, b);
  assert.equal(a, c);
});

/* ── compact code roundtrip ────────────────────────────────────── */

await t("encodeCompact -> decodeCompact roundtrip", async () => {
  const payload = { v: 1, id: "pab12c", t: "o", n: "nonce123", s: C.stripSdp(SAMPLE_SDP), h: "1a2b3c" };
  const code = await C.encodeCompact(payload);
  assert.ok(code.startsWith("GUNX1:"), "GUNX1: prefix");
  const back = await C.decodeCompact(code);
  assert.deepEqual(back, payload);
});

await t("compact codes are meaningfully compressed & bounded", async () => {
  const payload = { v: 1, id: "pab12c", t: "o", n: "nonce123", s: C.stripSdp(SAMPLE_SDP), h: "1a2b3c" };
  const rawJson = JSON.stringify(payload);
  const code = await C.encodeCompact(payload);
  assert.ok(code.length < rawJson.length, "compressed: " + code.length + " < " + rawJson.length);
  assert.ok(code.length < 2000, "sane upper bound for any real SDP");
});

await t("decodeCompact rejects garbage", async () => {
  await assert.rejects(C.decodeCompact(null), /INVALID_OFFER_CODE/);
  await assert.rejects(C.decodeCompact("nonsense"), /INVALID_OFFER_CODE/);
  await assert.rejects(C.decodeCompact("GUNX1:!!!!"), /INVALID_OFFER_CODE|URI malformed|unexpected/);
});

await t("decodeCompact rejects wrong version", async () => {
  const code = await C.encodeCompact({ v: 2, id: "x", t: "o", n: "n", s: "sdp", h: "h" });
  await assert.rejects(C.decodeCompact(code), /INVALID_OFFER_CODE/);
});

await t("decodeCompact rejects non-JSON payload", async () => {
  const raw = require("zlib").deflateRawSync("hello");
  const code = "GUNX1:" + Buffer.from(raw).toString("base64url");
  await assert.rejects(C.decodeCompact(code), /INVALID_OFFER_CODE/);
});

/* ── SAS codes ─────────────────────────────────────────────────── */

await t("sasCode format & determinism", () => {
  const a = C.sasCode("nonce1", "a1", "b1", "h1", "h2");
  const b = C.sasCode("nonce1", "a1", "b1", "h1", "h2");
  assert.equal(a, b, "deterministic");
  assert.match(a, /^\d{3}-\d{3}$/, "formatted 384-912");
});

await t("sasCode differs on tamper (MITM detection)", () => {
  const base = C.sasCode("nonce1", "a1", "b1", "h1", "h2");
  const tampered = C.sasCode("nonce1", "a1", "b1", "h1", "h3"); // sdp hash differs
  const wrongNonce = C.sasCode("nonce2", "a1", "b1", "h1", "h2");
  assert.notEqual(base, tampered);
  assert.notEqual(base, wrongNonce);
});

/* ── frames ────────────────────────────────────────────────────── */

await t("encodeFrame/decodeFrame roundtrip (empty, small, 300B)", () => {
  for (const len of [0, 1, 300]) {
    const payload = new Uint8Array(len).map((_, i) => (i * 7) & 0xff);
    const frame = C.encodeFrame(0x04, payload);
    assert.equal(frame.byteLength, 5 + len);
    const back = C.decodeFrame(frame);
    assert.equal(back.type, 0x04);
    assert.deepEqual(Array.from(back.payload), Array.from(payload));
  }
});

await t("decodeFrame handles real-world ArrayBuffer input", () => {
  const frame = C.encodeFrame(0x01, new Uint8Array([1, 2, 3]));
  // WebRTC delivers e.data as ArrayBuffer when binaryType='arraybuffer'
  const ab = frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength);
  const back = C.decodeFrame(ab);
  assert.equal(back.type, 0x01);
  assert.deepEqual(Array.from(back.payload), [1, 2, 3]);
});

await t("decodeFrame rejects short/garbage frames", () => {
  assert.equal(C.decodeFrame(null), null);
  assert.equal(C.decodeFrame(new Uint8Array(4)), null);
  const f = C.decodeFrame(C.encodeFrame(0x01, new Uint8Array([1, 2, 3])));
  assert.deepEqual(Array.from(f.payload), [1, 2, 3]);
});

/* ── base64url ─────────────────────────────────────────────────── */

await t("b64url roundtrip (binary-safe, no padding)", () => {
  const bytes = new Uint8Array(256).map((_, i) => i);
  const s = C.b64urlFromBytes(bytes);
  assert.ok(!s.includes("="), "no padding");
  assert.ok(!s.includes("+") && !s.includes("/"), "url-safe alphabet");
  const back = C.bytesFromB64url(s);
  assert.deepEqual(Array.from(back), Array.from(bytes));
});

/* ── deflate/inflate ───────────────────────────────────────────── */

await t("deflateRaw/inflateRaw roundtrip (CompressionStream or zlib)", async () => {
  const text = JSON.stringify({ v: 1, id: "pab12c", t: "o", n: "nonce123", s: C.stripSdp(SAMPLE_SDP), h: "1a2b3c" });
  const bytes = await C.deflateRawBytes(text);
  assert.ok(bytes.byteLength < text.length, "actually compressed");
  const back = await C.inflateRawBytes(bytes);
  assert.equal(back, text);
});

/* ── summary ───────────────────────────────────────────────────── */

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);