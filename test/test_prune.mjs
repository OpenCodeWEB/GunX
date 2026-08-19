/**
 * test_prune.mjs — GunX Phase 3: retention policy tests.
 *
 * The relay NEVER deletes live data. Only obsolete (tombstoned) fields older
 * than the retention window are pruned. These tests pin that guarantee down.
 *
 * Run:  node --test test/test_prune.mjs   (from the repo root)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pruneNode, PRUNE_TTL_MS } from "../worker/src/GunRelayDO.js";

// 99d 9h 9m 9s
const EXPECTED_TTL = 99 * 86400000 + 9 * 3600000 + 9 * 60000 + 9000;
const OLD = 10 * 86400000; // way inside the window
const ANCIENT = 200 * 86400000; // far beyond it

test("retention window is exactly 99d 9h 9m 9s", () => {
  assert.equal(PRUNE_TTL_MS, EXPECTED_TTL);
  assert.equal(PRUNE_TTL_MS, 8586549000);
});

test("live data is NEVER pruned, no matter how old", () => {
  const node = {
    t: "still here",
    _: { "#": "chat/x", ">": { t: Date.now() - ANCIENT } },
  };
  const d = pruneNode(node, Date.now() - PRUNE_TTL_MS);
  assert.equal(d.action, null, "live field must survive forever");
});

test("fresh tombstone (inside window) is kept", () => {
  const node = {
    t: null,
    _: { "#": "chat/x", ">": { t: Date.now() - OLD } },
  };
  const d = pruneNode(node, Date.now() - PRUNE_TTL_MS);
  assert.equal(d.action, null, "tombstone younger than 99d+ must stay");
});

test("old tombstone is pruned", () => {
  const node = {
    t: null,
    _: { "#": "chat/x", ">": { t: Date.now() - ANCIENT } },
  };
  const d = pruneNode(node, Date.now() - PRUNE_TTL_MS);
  assert.equal(d.action, "delete", "fully tombstoned soul is obsolete");
});

test("mixed node: dead fields dropped, live fields kept", () => {
  const node = {
    title: "room",
    temp: null,
    _: { "#": "meta/room", ">": { title: Date.now() - ANCIENT, temp: Date.now() - ANCIENT } },
  };
  const d = pruneNode(node, Date.now() - PRUNE_TTL_MS);
  assert.equal(d.action, "keep");
  assert.deepEqual(d.dead, ["temp"]);
  assert.equal(d.next.title, "room", "live field must be preserved");
  assert.ok(!("temp" in d.next), "dead field must be removed");
  assert.ok(!("temp" in d.next._[">"]), "dead field state must be removed too");
  assert.ok("title" in d.next._[">"], "live field state must be kept");
});

test("null value without state timestamp is never touched", () => {
  const node = { t: null, _: { "#": "chat/x", ">": {} } };
  const d = pruneNode(node, Date.now() - PRUNE_TTL_MS);
  assert.equal(d.action, null, "unknown age must default to keep (safe side)");
});

test("mixed-version merge keeps future fields", () => {
  const node = {
    a: null,
    b: "live",
    _: { "#": "s/x", ">": { a: Date.now() - ANCIENT, b: Date.now() } },
  };
  const d = pruneNode(node, Date.now() - PRUNE_TTL_MS);
  assert.equal(d.action, "keep");
  assert.equal(d.next.b, "live");
  assert.ok(!("a" in d.next));
});