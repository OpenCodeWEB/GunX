/**
 * pow.js — .gunx Proof-of-Work (anti-squatting / anti-spam).
 *
 * Difficulty scales with domain value: shorter domains cost more work.
 *   - 1–3 chars : 6 leading zero nibbles (~16M hashes avg)
 *   - 4–7 chars : 4 leading zeros    (~65k hashes avg)
 *   - 8+  chars : 2 leading zeros    (~256 hashes avg)  — free-tier bracket
 *
 * Hash input (canonical):  `${domain}:${ownerPub}:${target}:${ts}:${nonce}`
 * The signed record includes `diff` + `hash` so verifiers can re-check both.
 *
 * Works in browsers (crypto.subtle) and Node (crypto.createHash).
 */
(function () {
  "use strict";
  var root = typeof self !== "undefined" ? self : globalThis;

  function hasNodeCrypto() {
    try {
      return typeof require === "function" && require("crypto");
    } catch (e) {
      return null;
    }
  }

  var nodeCrypto = hasNodeCrypto();

  /** Sync SHA-256 hex digest (Node only). */
  function sha256Sync(input) {
    if (!nodeCrypto) throw new Error("GunX PoW: sync sha256 needs Node crypto");
    return nodeCrypto.createHash("sha256").update(input, "utf8").digest("hex");
  }

  /** Async SHA-256 hex digest (Node or browser). */
  async function sha256(input) {
    if (nodeCrypto) return sha256Sync(input);
    if (typeof crypto !== "undefined" && crypto.subtle) {
      var buf = new TextEncoder().encode(input);
      var digest = await crypto.subtle.digest("SHA-256", buf);
      return Array.from(new Uint8Array(digest)).map(function (b) {
        return b.toString(16).padStart(2, "0");
      }).join("");
    }
    throw new Error("GunX PoW: no SHA-256 available");
  }

  /**
   * Difficulty for a domain name.
   * @param {string} domain lowercase, no dot suffix
   */
  function getDifficulty(domain) {
    var len = String(domain).length;
    if (len <= 3) return 6;
    if (len <= 7) return 4;
    return 2;
  }

  /** Canonical hash input — must match exactly on verify. */
  function hashInput(domain, ownerPub, target, ts, nonce) {
    return domain + ":" + ownerPub + ":" + target + ":" + ts + ":" + nonce;
  }

  /** Check whether a nonce satisfies the difficulty. */
  async function checkPoW(domain, ownerPub, target, ts, nonce, diff) {
    var hash = await sha256(hashInput(domain, ownerPub, target, ts, nonce));
    return { ok: hash.startsWith("0".repeat(diff)), hash: hash };
  }

  /**
   * Mine a PoW nonce for a domain claim.
   * Async-loop friendly: yields to the event loop every 4096 tries so the
   * browser tab stays responsive while mining.
   */
  async function minePoW(domain, ownerPub, target, ts, diff) {
    var prefix = "0".repeat(diff);
    var nonce = 0;
    while (true) {
      if (nonce % 4096 === 0) await new Promise(function (r) { setTimeout(r, 0); });
      var hash = await sha256(hashInput(domain, ownerPub, target, ts, nonce));
      if (hash.startsWith(prefix)) return { nonce: nonce, hash: hash, diff: diff };
      nonce++;
    }
  }

  /** Validate a full registry claim record. Returns { ok, error, hash? }. */
  async function verifyClaim(claim) {
    if (!claim || typeof claim !== "object") return { ok: false, error: "claim required" };
    var name = String(claim.name || "").toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) return { ok: false, error: "invalid name" };
    var diff = typeof claim.diff === "number" ? claim.diff : getDifficulty(name);
    if (diff !== getDifficulty(name)) return { ok: false, error: "difficulty mismatch" };
    var chk = await checkPoW(name, claim.ownerPub, claim.target, claim.ts, claim.nonce, diff);
    if (!chk.ok) return { ok: false, error: "proof-of-work not satisfied" };
    if (claim.hash && claim.hash !== chk.hash) return { ok: false, error: "hash mismatch" };
    return { ok: true, hash: chk.hash };
  }

  var PoW = {
    getDifficulty: getDifficulty,
    mine: minePoW,
    verify: verifyClaim,
    hashInput: hashInput,
    _sha256Sync: sha256Sync,
  };

  // UMD-ish export: module.exports for Node, root.GunXPoW for browsers.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = PoW;
  }
  root.GunXPoW = PoW;
})(typeof self !== "undefined" ? self : globalThis);
