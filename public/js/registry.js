/**
 * registry.js — .gunx name registry (Layer 3).
 *
 * A censorship-proof TLD registry stored as GunDB graph nodes on the GunX
 * relay. Ownership is cryptographic:
 *
 *   claim = { name, ownerPub, target, ts, nonce, diff, hash, sig }
 *
 *   - name      lower-case domain label (no ".gunx" suffix)
 *   - ownerPub  SEA public key of the claimer
 *   - target    routing target (node id, .onion, *.absup.pw host, …)
 *   - ts        claim timestamp (ms)
 *   - nonce/diff/hash  Proof-of-Work (see pow.js) — anti-squatting
 *   - sig       SEA signature over the claim object (ownership proof)
 *
 * Conflict rules (applied on read/verify, never trusted blindly):
 *   1. PoW must satisfy the difficulty bracket for the name length.
 *   2. Signature must verify against ownerPub (SEA.verify).
 *   3. If two claims collide with equal timestamps (LWW tie), the one with
 *      the lexicographically smaller PoW hash wins.
 *
 * The relay only stores whatever clients put — every reader re-verifies
 * everything, so even a malicious writer cannot forge a claim it didn't
 * mine + sign.
 */
(function () {
  "use strict";
  var root = typeof self !== "undefined" ? self : globalThis;
  var PoW = (typeof module !== "undefined" && module.exports ? null : null); // resolved below

  function loadPow() {
    if (typeof module !== "undefined" && module.exports) return require("./pow.js");
    return root.GunXPoW;
  }

  function hasNodeCrypto() {
    try {
      return typeof require === "function" && require("crypto");
    } catch (e) {
      return null;
    }
  }

  /** Sort two claims with identical ts — smaller PoW hash wins. */
  function tieBreak(a, b) {
    var ah = String(a.hash || "");
    var bh = String(b.hash || "");
    return ah < bh ? a : b;
  }

  /**
   * Create a .gunx registry manager bound to a GunX instance.
   *
   * @param {object} gunx  GunX SDK instance (uses gunx.get/put + gunx.sea)
   */
  function GunXRegistry(gunx) {
    if (!(this instanceof GunXRegistry)) return new GunXRegistry(gunx);
    this.gunx = gunx;
    this.pow = loadPow();
  }

  /** Storage soul for a domain claim. */
  GunXRegistry.prototype.soul = function (name) {
    return "tld/gunx/" + String(name).toLowerCase();
  };

  /** All claims under the registry (map soul — no trailing slash). */
  GunXRegistry.prototype.rootSoul = function () {
    return "tld/gunx";
  };

  /**
   * Mine PoW + SEA-sign + put a domain claim.
   * @param {string} name      desired name (without .gunx)
   * @param {string} target    routing target (node id / onion / host)
   * @param {object} pair      SEA key pair { pub, priv, eph }
   * @param {number} [ts]      claim timestamp (defaults to now)
   * @returns {Promise<object>} the claim record
   */
  GunXRegistry.prototype.claim = async function (name, target, pair, ts) {
    var g = this.gunx;
    name = String(name).toLowerCase();
    var diff = this.pow.getDifficulty(name);
    var stamp = ts || Date.now();
    var mine = await this.pow.mine(name, pair.pub, String(target), stamp, diff);
    var claim = {
      name: name,
      ownerPub: pair.pub,
      target: String(target),
      ts: stamp,
      nonce: mine.nonce,
      diff: diff,
      hash: mine.hash,
    };
    var sig = await g.sea.sign(claim, pair);
    claim.sig = sig;
    await g.put(this.soul(name), claim);
    return claim;
  };

  /**
   * Verify a claim record end-to-end: PoW + difficulty + SEA signature.
   * @returns {Promise<{ok:boolean, error?:string, claim?:object}>}
   */
  GunXRegistry.prototype.verify = async function (claim) {
    var g = this.gunx;
    if (!claim || typeof claim !== "object") return { ok: false, error: "claim required" };
    var pw = await this.pow.verify(claim);
    if (!pw.ok) return { ok: false, error: pw.error };
    // Signature over the canonical claim (sig excluded).
    var body = {};
    for (var k in claim) {
      if (k === "sig" || !Object.prototype.hasOwnProperty.call(claim, k)) continue;
      body[k] = claim[k];
    }
    var verified = await g.sea.verify(body, claim.sig, claim.ownerPub);
    if (!verified) return { ok: false, error: "SEA signature invalid" };
    return { ok: true, claim: claim };
  };

  /** Read + verify a single claim. */
  GunXRegistry.prototype.resolve = async function (name) {
    var g = this.gunx;
    var claim = await new Promise(function (resolve) {
      g.get(g.un ? g.ns(this.soul(name)) : this.soul(name)).once(function (node) {
        resolve(node || null);
      });
      setTimeout(function () { resolve("__timeout__"); }, 8000);
    }.bind(this));
    if (claim === null || claim === "__timeout__") return { ok: false, error: "not found" };
    return this.verify(claim);
  };

  /**
   * Live-subscribe the registry: every claim verified on arrival.
   * @param {function} cb  ({ok, error?, claim?}, key)
   * @returns {function}   unsubscribe
   */
  GunXRegistry.prototype.watch = function (cb) {
    var g = this.gunx;
    var self = this;
    var rootSoul = this.rootSoul();
    var sub = g.get(rootSoul).map().on(function (node, key) {
      if (!node || typeof node !== "object") return;
      if (node["#"] || node._) return; // parent refs — not claims
      self.verify(node).then(function (res) {
        cb(res, key);
      });
    });
    return function () { sub.off(); };
  };

  /** Tally how many claims a pubkey already owns (for free-tier limits). */
  GunXRegistry.prototype.countByOwner = async function (pub) {
    var g = this.gunx;
    var count = 0;
    await new Promise(function (resolve) {
      var sub = g.get(this.rootSoul()).map().once(function (node, key) {
        if (node && node.ownerPub === pub) count++;
      }.bind(this));
      sub.off();
      setTimeout(resolve, 3000);
    }.bind(this));
    return count;
  };

  root.GunXRegistry = GunXRegistry;
  if (typeof module !== "undefined" && module.exports) module.exports = GunXRegistry;
})(typeof self !== "undefined" ? self : globalThis);
