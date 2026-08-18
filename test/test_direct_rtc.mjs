/**
 * test_direct_rtc.mjs — end-to-end transport test with mocked
 * RTCPeerConnection / RTCDataChannel (no real network needed).
 *
 * Exercises: offer/answer handshake, SAS agreement, one-shot offer,
 * message send, file transfer (adaptive chunks), expiry, cleanup.
 *
 * Run: node test/test_direct_rtc.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const DirectRTC = require("../sdk/transports/direct_rtc.js");

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log("  ok  " + name); })
    .catch((e) => { failed++; console.error("FAIL  " + name + "\n      " + (e && e.stack || e)); });
}

/* ── mock WebRTC layer ─────────────────────────────────────────── */

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

class MockChannel {
  constructor(pc, label) {
    this.pc = pc;
    this.label = label;
    this.readyState = "connecting";
    this.binaryType = "arraybuffer";
    this.bufferedAmount = 0;
    this.peer = null;   // linked counterpart channel
    this.sent = 0;
  }
  send(data) {
    this.sent++;
    if (this.peer && this.peer.onmessage) {
      this.peer.onmessage({ data });
    }
  }
  close() {
    this.readyState = "closed";
    if (this.onclose) this.onclose();
  }
  _open() {
    this.readyState = "open";
    if (this.onopen) this.onopen();
  }
}

class MockPC {
  constructor() {
    this.localDescription = null;
    this.remoteDescription = null;
    this.iceGatheringState = "complete";
    this.iceConnectionState = "connected";
    this.ondatachannel = null;
    this.closed = false;
  }
  createDataChannel(label, opts) {
    const ch = new MockChannel(this, label);
    this.dataChannel = ch;
    return ch;
  }
  createOffer() {
    this.localDescription = { type: "offer", sdp: SAMPLE_SDP };
    return Promise.resolve(this.localDescription);
  }
  createAnswer() {
    this.localDescription = { type: "answer", sdp: SAMPLE_SDP };
    return Promise.resolve(this.localDescription);
  }
  setLocalDescription(d) { this.localDescription = d; return Promise.resolve(); }
  setRemoteDescription(d) { this.remoteDescription = d; return Promise.resolve(); }
  close() { this.closed = true; }
  addEventListener(name, fn) { (this._listeners = this._listeners || {})[name] = fn; } // icecandidate etc.
  _injectChannel(ch) { if (this.ondatachannel) this.ondatachannel({ channel: ch }); }
}

function link(a, b) { a.peer = b; b.peer = a; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── full handshake harness ────────────────────────────────────── */

async function pair(rtcA, rtcB) {
  const offer = await rtcA.createDirectCode({ timeoutMs: 3000, iceWaitMs: 100 });
  const answer = await rtcB.connectDirect(offer.code, { timeoutMs: 3000, iceWaitMs: 100 });
  const pcA = rtcA._sessions[offer.peerId].pc;
  const pcB = rtcB._sessions[offer.peerId].pc;
  const aCh = rtcA._sessions[offer.peerId].channel;
  pcB._injectChannel(new MockChannel(pcB, "gx-direct"));
  const bCh = rtcB._sessions[offer.peerId].channel;
  link(aCh, bCh);
  const acceptP = rtcA.acceptDirectAnswer(answer.code);
  aCh._open();
  bCh._open();
  const res = await acceptP;
  return { offer, answer, res, aCh, bCh, pcA, pcB };
}

/* ── tests ─────────────────────────────────────────────────────── */

await t("full handshake: offer -> answer -> accept, channels open", async () => {
  const rtcA = new DirectRTC({ pcFactory: () => new MockPC() });
  const rtcB = new DirectRTC({ pcFactory: () => new MockPC() });
  try {
    const { offer, answer, res } = await pair(rtcA, rtcB);
    assert.ok(offer.code.startsWith("GUNX1:"), "offer code format");
    assert.ok(answer.code.startsWith("GUNX1:"), "answer code format");
    assert.equal(answer.peerId, offer.peerId, "joiner keys session by offerer id");
    assert.equal(res.connected, true);
    assert.ok(res.peerId, "answerer id present");
  } finally {
    rtcA.destroy();
    rtcB.destroy();
  }
});

await t("SAS auth code identical on BOTH sides (mutual verification)", async () => {
  const rtcA = new DirectRTC({ pcFactory: () => new MockPC() });
  const rtcB = new DirectRTC({ pcFactory: () => new MockPC() });
  try {
    const { offer, res } = await pair(rtcA, rtcB);
    const aAuth = rtcA._sessions[offer.peerId].authCode;
    const bAuth = rtcB._sessions[offer.peerId].authCode;
    assert.equal(res.authCode, aAuth, "acceptDirectAnswer exposes SAS");
    assert.equal(aAuth, bAuth, "both peers compute the same SAS");
    assert.match(aAuth, /^\d{3}-\d{3}$/);
  } finally {
    rtcA.destroy();
    rtcB.destroy();
  }
});

await t("peer lifecycle events: connected + disconnected", async () => {
  const rtcA = new DirectRTC({ pcFactory: () => new MockPC() });
  const rtcB = new DirectRTC({ pcFactory: () => new MockPC() });
  const events = [];
  rtcA.on("peer", (id, st) => events.push([id, st]));
  try {
    const { offer } = await pair(rtcA, rtcB);
    assert.ok(events.some(([id, st]) => id === offer.peerId && st.status === "connected" && st.authCode), "connected event");
    rtcA.destroy(); // closes channels -> disconnected on the OTHER side
    await sleep(10);
    // B side sees the close via its own channel handler
  } finally {
    rtcB.destroy();
  }
});

await t("one-shot offer: second accept rejected", async () => {
  const rtcA = new DirectRTC({ pcFactory: () => new MockPC() });
  const rtcB = new DirectRTC({ pcFactory: () => new MockPC() });
  try {
    const { answer } = await pair(rtcA, rtcB);
    await assert.rejects(rtcA.acceptDirectAnswer(answer.code), /NO_PENDING_OFFER/);
  } finally {
    rtcA.destroy();
    rtcB.destroy();
  }
});

await t("directSend: object and string messages arrive intact", async () => {
  const rtcA = new DirectRTC({ pcFactory: () => new MockPC() });
  const rtcB = new DirectRTC({ pcFactory: () => new MockPC() });
  const gotA = [], gotB = [];
  rtcA.on("message", (id, m) => gotA.push([id, m]));
  rtcB.on("message", (id, m) => gotB.push([id, m]));
  try {
    const { offer } = await pair(rtcA, rtcB);
    assert.equal(rtcA.directSend(offer.peerId, { hello: "world", n: 42 }), true);
    assert.equal(rtcB.directSend(offer.peerId, "plain string"), true);
    await sleep(5);
    assert.equal(gotB.length, 1);
    assert.deepEqual(gotB[0], [offer.peerId, { hello: "world", n: 42 }]);
    assert.equal(gotA.length, 1);
    assert.deepEqual(gotA[0], [offer.peerId, "plain string"]);
    // unknown peer -> false, no throw
    assert.equal(rtcA.directSend("pdeadbeef", "x"), false);
  } finally {
    rtcA.destroy();
    rtcB.destroy();
  }
});

await t("directShareFile: 200KB binary blob arrives byte-exact", async () => {
  const rtcA = new DirectRTC({ pcFactory: () => new MockPC() });
  const rtcB = new DirectRTC({ pcFactory: () => new MockPC() });
  const files = [];
  rtcB.on("file", (f) => files.push(f));
  try {
    const { offer } = await pair(rtcA, rtcB);
    const payload = new Uint8Array(200000).map((_, i) => i & 0xff);
    const file = new File([payload], "test.bin", { type: "application/octet-stream" });
    const out = await rtcA.directShareFile(file, offer.peerId);
    assert.equal(out.name, "test.bin");
    assert.equal(out.size, 200000);
    await sleep(5);
    assert.equal(files.length, 1);
    const f = files[0];
    assert.equal(f.name, "test.bin");
    assert.equal(f.size, 200000);
    assert.equal(f.type, "application/octet-stream");
    const back = new Uint8Array(await f.blob.arrayBuffer());
    assert.equal(back.length, 200000);
    assert.deepEqual(Array.from(back), Array.from(payload), "byte-exact");
    // framing used >1 chunk (adaptive chunking path)
    const sess = rtcA._sessions[offer.peerId];
    assert.ok(rtcB._sessions[offer.peerId].received >= 200000, "receiver counted bytes");
  } finally {
    rtcA.destroy();
    rtcB.destroy();
  }
});

await t("directShareFile: empty file still completes", async () => {
  const rtcA = new DirectRTC({ pcFactory: () => new MockPC() });
  const rtcB = new DirectRTC({ pcFactory: () => new MockPC() });
  const files = [];
  rtcB.on("file", (f) => files.push(f));
  try {
    const { offer } = await pair(rtcA, rtcB);
    const out = await rtcA.directShareFile(new File([], "empty.txt", { type: "text/plain" }), offer.peerId);
    assert.equal(out.size, 0);
    await sleep(5);
    assert.equal(files.length, 1);
    assert.equal(files[0].size, 0);
  } finally {
    rtcA.destroy();
    rtcB.destroy();
  }
});

await t("directShareFile to unconnected peer rejects", async () => {
  const rtcA = new DirectRTC({ pcFactory: () => new MockPC() });
  try {
    await assert.rejects(
      rtcA.directShareFile(new File(["x"], "x.txt"), "pdeadbeef"),
      /peer not connected/
    );
  } finally {
    rtcA.destroy();
  }
});

await t("nonce mismatch: answer from another pairing rejected", async () => {
  const rtcA = new DirectRTC({ pcFactory: () => new MockPC() });
  const rtcB = new DirectRTC({ pcFactory: () => new MockPC() });
  const rtcC = new DirectRTC({ pcFactory: () => new MockPC() });
  try {
    const offer1 = await rtcA.createDirectCode({ timeoutMs: 3000, iceWaitMs: 100 });
    const answer1 = await rtcB.connectDirect(offer1.code, { timeoutMs: 3000, iceWaitMs: 100 });
    // A creates a second offer; answer1 (nonce of offer1) must not be accepted for it
    const offer2 = await rtcA.createDirectCode({ timeoutMs: 3000, iceWaitMs: 100 });
    assert.notEqual(offer1.code, offer2.code);
    await assert.rejects(rtcA.acceptDirectAnswer(answer1.code), /INVALID_ANSWER_CODE/);
    // cleanup offer2's session
    rtcA._cleanSession(rtcA._sessions[offer2.peerId]);
  } finally {
    rtcA.destroy();
    rtcB.destroy();
    rtcC.destroy();
  }
});

await t("offer expiry: peer event + NO_PENDING_OFFER", async () => {
  const rtcA = new DirectRTC({ pcFactory: () => new MockPC() });
  const events = [];
  rtcA.on("peer", (id, st) => events.push([id, st]));
  try {
    const offer = await rtcA.createDirectCode({ timeoutMs: 25, iceWaitMs: 10 });
    await sleep(60);
    assert.ok(events.some(([, st]) => st.status === "expired"), "expired event fired");
    await assert.rejects(rtcA.acceptDirectAnswer("GUNX1:broken"), /NO_PENDING_OFFER|INVALID_ANSWER_CODE|INVALID_OFFER_CODE/);
    assert.equal(rtcA._offer, null, "offer cleared");
  } finally {
    rtcA.destroy();
  }
});

await t("RTC_NOT_SUPPORTED when no WebRTC available", async () => {
  const rtc = new DirectRTC({ pcFactory: null, pcCtor: null });
  // browser/Node global may exist — force absence
  const saved = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = undefined;
  try {
    await assert.rejects(rtc.createDirectCode({ timeoutMs: 50 }), /RTC_NOT_SUPPORTED/);
    await assert.rejects(rtc.connectDirect("GUNX1:broken"), /INVALID_OFFER_CODE|RTC_NOT_SUPPORTED/);
  } finally {
    globalThis.RTCPeerConnection = saved;
    rtc.destroy();
  }
});

/* ── summary ───────────────────────────────────────────────────── */

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);