/**
 * nostr_codec.js — GunX Phase 2: NIP-01 codec + Schnorr signing (pure, UMD).
 *
 * Minimal Nostr event layer with ZERO hard dependency on nostr-tools:
 *   - Canonical NIP-01 event serialization  [0,pubkey,created_at,kind,tags,content]
 *   - SHA-256 event id (NIP-01)
 *   - BIP-340 Schnorr signing / verification over secp256k1
 *     (Node: @noble/curves. Browser: inject your own signer via setSigner()
 *      — e.g. a NIP-07 extension or a bundled noble build.)
 *
 * API (all static):
 *   codec.randomSecKey()              -> 64-hex sec key
 *   codec.pubkeyOf(secKeyHex)         -> 64-hex pubkey
 *   codec.serializeEvent(evt)         -> canonical JSON string
 *   codec.hashEvent(evt)              -> 64-hex sha256 event id
 *   codec.makeEvent({kind,tags,content,secKeyHex,createdAt?}) -> signed event
 *   codec.verifyEvent(evt)            -> bool (checks id + sig against pubkey)
 *   codec.setSigner({sign,verify,pubkeyOf,randomSecKey}) -> inject browser impl
 *
 * (c) ABsUP / OpenCodeWEB. MIT License.
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    // @noble/curves v2+ is ESM-only: try CJS require, degrade gracefully —
    // a browser/NIP-07 signer can be injected via codec.setSigner().
    var nobleCurves = null, nobleHashes = null;
    try { nobleCurves = require("@noble/curves/secp256k1"); } catch (e) {}
    try { nobleHashes = require("@noble/hashes/sha2"); } catch (e) {}
    module.exports = factory(nobleCurves, nobleHashes);
  } else {
    root.GunXNostrCodec = factory(null, null);
  }
})(typeof self !== "undefined" ? self : globalThis, function (nobleCurves, nobleHashes) {
  "use strict";

  var u;
  var CURVE = (nobleCurves && nobleCurves.secp256k1) || null;
  var sha256 = (nobleHashes && nobleHashes.sha256) || null;

  /* ---- injected browser signer (NIP-07 / bundled noble) ---- */
  var injected = null;
  function setSigner(impl) {
    injected = impl || null;
  }

  function hasNative() {
    return !!(CURVE && sha256);
  }

  /* ---- hex helpers ---- */
  function toHex(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += ("0" + bytes[i].toString(16)).slice(-2);
    return s;
  }
  function fromHex(h) {
    var out = new Uint8Array(h.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  /* ---- randomness (crypto.getRandomValues / node crypto) ---- */
  function randomBytes(n) {
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      var a = new Uint8Array(n);
      crypto.getRandomValues(a);
      return a;
    }
    if (typeof require === "function") {
      var c = require("crypto");
      return c.randomBytes(n);
    }
    var b = new Uint8Array(n);
    for (var i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256);
    return b;
  }

  /* ---- key generation / derivation ---- */
  function randomSecKey() {
    if (injected && injected.randomSecKey) return injected.randomSecKey();
    if (CURVE) return toHex(CURVE.utils.randomSecretKey());
    return toHex(randomBytes(32));
  }

  function pubkeyOf(secKeyHex) {
    if (injected && injected.pubkeyOf) return injected.pubkeyOf(secKeyHex);
    if (!CURVE) throw new Error("NostrCodec: no secp256k1 implementation available");
    return toHex(CURVE.getPublicKey(fromHex(secKeyHex), true).subarray(1)); // 33B compressed -> drop 0x02/0x03 prefix
  }

  /* ---- NIP-01 canonical serialization ---- */
  function serializeEvent(evt) {
    return JSON.stringify([
      0,
      evt.pubkey,
      evt.created_at,
      evt.kind,
      evt.tags || [],
      evt.content,
    ]);
  }

  /* ---- event id ---- */
  function hashEvent(evt) {
    var ser = serializeEvent(evt);
    if (injected && injected.hashEvent) return injected.hashEvent(ser);
    if (sha256) return toHex(sha256(ser));
    throw new Error("NostrCodec: no sha256 implementation available");
  }

  /* ---- full event creation (signed) ---- */
  function makeEvent(opts) {
    var kind = opts.kind | 0;
    var tags = opts.tags || [];
    var content = String(opts.content === u ? "" : opts.content);
    var secKey = opts.secKeyHex;
    var pubkey = opts.pubkey || pubkeyOf(secKey);
    var createdAt = opts.createdAt === u ? Math.floor(Date.now() / 1000) : opts.createdAt | 0;

    var evt = { pubkey: pubkey, created_at: createdAt, kind: kind, tags: tags, content: content };
    var id = hashEvent(evt);
    evt.id = id;
    evt.sig = sign(id, secKey);
    return evt;
  }

  /* ---- BIP-340 schnorr sign ---- */
  function sign(idHex, secKeyHex) {
    if (injected && injected.sign) return injected.sign(idHex, secKeyHex);
    if (!CURVE) throw new Error("NostrCodec: no secp256k1 implementation available");
    return toHex(CURVE.schnorr.sign(fromHex(idHex), fromHex(secKeyHex)));
  }

  /* ---- verify (id matches + signature valid) ---- */
  function verifyEvent(evt) {
    var id = hashEvent(evt);
    if (id !== evt.id) return false;
    if (injected && injected.verify) return injected.verify(evt.id, evt.sig, evt.pubkey);
    if (!CURVE) return false;
    try {
      return CURVE.schnorr.verify(fromHex(evt.sig), fromHex(evt.id), fromHex(evt.pubkey));
    } catch (e) {
      return false;
    }
  }

  return {
    setSigner: setSigner,
    hasNative: hasNative,
    randomSecKey: randomSecKey,
    pubkeyOf: pubkeyOf,
    serializeEvent: serializeEvent,
    hashEvent: hashEvent,
    makeEvent: makeEvent,
    sign: sign,
    verifyEvent: verifyEvent,
  };
});