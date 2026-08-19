/**
 * test_rooms.mjs — GunX Phase 3: E2E room-key encryption tests.
 *
 * Verifies that room payloads are sealed into ciphertext before they ever
 * reach the relay, and that only the room key holder can open them.
 *
 * Run:  node test/test_rooms.mjs   (from the repo root)
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
globalThis.Gun = (await import("gun")).default;
const SEA = (await import("gun/sea.js")).default;
import GunX from "../sdk/gunx.js";

// gun's server bundle keeps handles alive; force a clean exit after all tests.
after(() => process.exit(0));

// Browser-like minimum: rooms.js's helpers need btoa/atob.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const btoa = (s) => Buffer.from(s, "binary").toString("base64");
const atob = (s) => Buffer.from(s, "base64").toString("binary");

function makeGunx(appKey) {
  const gun = Gun({ localStorage: false, radisk: false, axe: false, multicast: false, peers: [] });
  return GunX({ appKey, storage: false, refreshMs: 0, gun });
}

test("seal produces ciphertext that never contains plaintext", async () => {
  const gunx = makeGunx("t-rooms");
  const roomKey = "test-room-key-123";
  const payload = { t: "top secret message", from: "alice", ts: Date.now() };
  const sealed = await gunx.sea.seal(payload, roomKey);
  assert.equal(sealed._e, 1, "sealed payload carries the _e marker");
  assert.ok(!JSON.stringify(sealed).includes("top secret"), "plaintext must not leak into the sealed payload");
  assert.ok(!JSON.stringify(sealed).includes("alice"), "sender must not leak either");
  gunx.destroy();
});

test("open decrypts a payload the key holder wrote", async () => {
  const gunx = makeGunx("t-rooms");
  const roomKey = "shared-room-key";
  const payload = { t: "hello world", from: "bob", ts: 1234 };
  const sealed = await gunx.sea.seal(payload, roomKey);
  const opened = await gunx.sea.open(sealed, roomKey);
  assert.deepEqual(opened, payload, "round-trip must restore the original payload");
  gunx.destroy();
});

test("open returns null without the key (relay/server cannot read)", async () => {
  const gunx = makeGunx("t-rooms");
  const sealed = await gunx.sea.seal({ t: "forbidden", from: "x", ts: 1 }, "k1");
  const opened = await gunx.sea.open(sealed, null);
  assert.equal(opened, null, "missing key must yield locked");
  const wrong = await gunx.sea.open(sealed, "k2");
  assert.equal(wrong, null, "wrong key must yield locked");
  gunx.destroy();
});

test("open passes legacy plaintext through untouched", async () => {
  const gunx = makeGunx("t-rooms");
  const legacy = { t: "old plain message", from: "local" };
  const opened = await gunx.sea.open(legacy, "any-key");
  assert.equal(opened.t, "old plain message", "legacy messages stay readable");
  gunx.destroy();
});

test("genRoomKey produces a unique URL-safe key", async () => {
  const gunx = makeGunx("t-rooms");
  const a = await gunx.sea.genRoomKey();
  const b = await gunx.sea.genRoomKey();
  assert.ok(a && a.length >= 20, "key must be non-trivial");
  assert.notEqual(a, b, "keys must be unique");
  assert.ok(!/[+/=]/.test(a), "key must be URL-safe (no + / =)");
  gunx.destroy();
});

test("sealed + opened across two independent clients", async () => {
  const a = makeGunx("t-rooms-2");
  const b = makeGunx("t-rooms-2");
  const roomKey = await a.sea.genRoomKey();
  const sealed = await a.sea.seal({ t: "mesh sync", from: "alice", ts: Date.now() }, roomKey);
  const opened = await b.sea.open(sealed, roomKey);
  assert.equal(opened.t, "mesh sync", "second client with key must decrypt");
  const locked = await b.sea.open(sealed, "attacker-key");
  assert.equal(locked, null, "second client without key must not decrypt");
  a.destroy();
  b.destroy();
});