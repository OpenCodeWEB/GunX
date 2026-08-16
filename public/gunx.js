/**
 * gunx.js — GunX client SDK.
 *
 * Makes GunDB usable by ANYONE through the serverless gunx.pages.dev relay,
 * with zero relay-server setup. Wraps a gun instance and adds:
 *
 *   1. App namespacing  — every soul is transparently prefixed with your
 *      appKey (`appKey/soul`), so any number of public projects can share
 *      the gunx relay without key collisions.
 *   2. Auto-refresh     — gun browser clients never re-ask peers for souls
 *      already cached in IndexedDB (they only hash-check at peer "hi").
 *      GunX tracks the souls you subscribe to and periodically issues
 *      plain-soul GETs through the wire, so remote changes made while your
 *      tab was offline or unsubscribed still arrive.
 *   3. SEA helpers      — pair persistence (localStorage) and user auth
 *      convenience wrappers around gun/sea.
 *   4. Status events    — 'connecting' | 'connected' | 'disconnected'.
 *
 * Works in the browser (global `Gun`) and in Node (`require('gun')`).
 *
 * Usage:
 *   const gunx = GunX({ appKey: 'my-app' });
 *   gunx.get('todos').once(console.log);          // namespaced automatically
 *   gunx.on('status', ({ status }) => console.log(status));
 *   gunx.put('todos', { hello: 'world' });        // namespaced write
 *   gunx.destroy();
 *
 * (c) ABsUP / OpenCodeWEB. MIT License.
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    // Defer the gun require: loading the SDK must never throw, even if
    // gun is not installed yet (it is resolved at GunX() construction).
    module.exports = factory(function () {
      try {
        return require("gun");
      } catch (e) {
        throw new Error("GunX: gun not found — `npm install gun` (Node) or load gun.js first (browser).");
      }
    });
  } else if (root.Gun) {
    root.GunX = factory(function () {
      return root.Gun;
    });
  } else {
    console.error("GunX: Gun not found — load gun.js before gunx.js");
  }
})(typeof self !== "undefined" ? self : globalThis, function (getGun) {
  "use strict";

  var DEFAULT_PEERS = ["https://gunx.pages.dev/gun"];
  var DEFAULT_REFRESH_MS = 30000;
  var u;

  function randomId() {
    return (
      "gx" +
      Math.random().toString(36).slice(2, 10) +
      Date.now().toString(36)
    );
  }

  function hasLocalStorage() {
    try {
      return typeof localStorage !== "undefined" && !!localStorage;
    } catch (e) {
      return false;
    }
  }

  function isBrowser() {
    return typeof document !== "undefined";
  }

  function GunX(options) {
    if (!(this instanceof GunX)) return new GunX(options);
    options = options || {};
    if (typeof options !== "object") options = { appKey: String(options) };

    this.appKey = (options.appKey || "default").replace(/[\/\s]/g, "-");
    this.refreshMs = options.refreshMs === u ? DEFAULT_REFRESH_MS : options.refreshMs;
    this.trackedSouls = Object.create(null);
    this._listeners = Object.create(null);
    this._destroyed = false;

    var peers = options.peers || DEFAULT_PEERS;
    var gunOpts = {
      localStorage: options.storage === false ? false : true,
      radisk: options.storage === false ? false : true,
      peers: peers,
    };
    // Node-only quirks: axe/multicast interfere with remote peer connections.
    if (typeof module !== "undefined" && module.exports) {
      if (options.axe === u) gunOpts.axe = false;
      if (options.multicast === u) gunOpts.multicast = false;
    }

    this.gun = options.gun || getGun()(gunOpts);
    var root = (this.gun._ || {}).root || this.gun._;
    this._root = root;
    this._initStatus();
    if (this.refreshMs > 0) this._startRefresh();
  }

  /* ── Namespacing ─────────────────────────────────────────────────── */

  /** Map a public soul to its namespaced storage soul. */
  GunX.prototype.ns = function (soul) {
    return this.appKey + "/" + soul;
  };

  /**
   * Subscribe to a soul (namespaced automatically) and track it for
   * auto-refresh. Returns the underlying gun chain.
   */
  GunX.prototype.get = function (soul) {
    var ns = this.ns(soul);
    this.trackedSouls[ns] = 1;
    return this.gun.get(ns);
  };

  /**
   * Raw access to the underlying gun (for .put/.map/.user etc.).
   * Prefer gunx.get() when the soul belongs to your app namespace.
   */
  GunX.prototype.raw = function () {
    return this.gun;
  };

  /** Namespaced write helper: gunx.put('soul', data). */
  GunX.prototype.put = function (soul, data, cb) {
    var self = this;
    return this.get(soul).put(data, function (ack) {
      if (cb) cb(ack);
      // A round-tripped ack proves the relay connection is alive.
      if (ack && !ack.err) self._markConnected();
    });
  };

  /* ── Auto-refresh (IndexedDB re-ask fix) ─────────────────────────── */

  GunX.prototype._startRefresh = function () {
    var self = this;
    this._refreshTimer = setInterval(function () {
      if (isBrowser() && document.visibilityState === "hidden") return;
      self.refresh();
    }, this.refreshMs);
    if (isBrowser() && document.addEventListener) {
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "visible") self.refresh();
      });
    }
  };

  /**
   * Force plain-soul GETs to every connected peer for every tracked soul.
   * This is the wire-level request gun itself would send at peer "hi" —
   * replying with the full fresh node, which gun merges into the local
   * graph and re-emits to live `.on()` subscriptions.
   */
  GunX.prototype.refresh = function () {
    var root = this._root;
    if (!root || !root.opt || !root.opt.peers) return;
    var souls = Object.keys(this.trackedSouls);
    if (!souls.length) return;
    var peers = root.opt.peers;
    var ids = Object.keys(peers);
    if (!ids.length) return;
    for (var i = 0; i < souls.length; i++) {
      for (var j = 0; j < ids.length; j++) {
        var peer = peers[ids[j]];
        if (!peer || !peer.wire) continue;
        root.on("out", { "#": randomId(), get: { "#": souls[i] } });
      }
    }
  };

  /* ── Status events ───────────────────────────────────────────────── */

  GunX.prototype._initStatus = function () {
    var self = this;
    var root = this._root;
    if (!root || !root.on) return;
    this._status = "connecting";
    this._hi = root.on("hi", function (peer) {
      self._markConnected(peer && peer.url);
    });
    this._bye = root.on("bye", function (peer) {
      if (self._status !== "disconnected") self._emit("status", { status: "disconnected", peer: peer && peer.url });
      self._status = "disconnected";
    });
    // Node gun opens its peer wire LAZILY — only when the first message is
    // sent — and only then performs the hi handshake. Kick it with a benign
    // read so a connected status can be reported without user traffic.
    try {
      self.gun.get("__gunx__status").once(function () {});
    } catch (e) {
      /* noop */
    }
  };

  GunX.prototype._markConnected = function (peerUrl) {
    if (this._status !== "connected") this._emit("status", { status: "connected", peer: peerUrl });
    this._status = "connected";
  };

  GunX.prototype.on = function (event, cb) {
    (this._listeners[event] = this._listeners[event] || []).push(cb);
    if (event === "status" && this._status) {
      cb({ status: this._status, peer: this._lastPeer });
    }
    return this;
  };

  GunX.prototype._emit = function (event, data) {
    var cbs = this._listeners[event] || [];
    for (var i = 0; i < cbs.length; i++) {
      try {
        cbs[i](data);
      } catch (e) {
        console.error("GunX listener error", e);
      }
    }
  };

  /* ── SEA helpers ─────────────────────────────────────────────────── */

  GunX.prototype.sea = {
    /** Persist an SEA pair to localStorage (node no-op). */
    savePair: function (pair, key) {
      key = key || "gunx_pair";
      if (!hasLocalStorage()) return false;
      try {
        localStorage.setItem(key, JSON.stringify(pair));
        return true;
      } catch (e) {
        return false;
      }
    },
    /** Load a previously saved SEA pair (null if none). */
    loadPair: function (key) {
      key = key || "gunx_pair";
      if (!hasLocalStorage()) return null;
      try {
        var raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    },
    /** Create + auth a user (gun/sea must be loaded). */
    asyncAuth: function (gunx, alias, pass) {
      var user = gunx.raw().user();
      return new Promise(function (resolve, reject) {
        user.create(alias, pass, function (ack) {
          if (ack.err) return reject(ack.err);
          user.auth(alias, pass, function (ack2) {
            if (ack2.err) return reject(ack2.err);
            resolve(user);
          });
        });
      });
    },
  };

  /* ── Teardown ────────────────────────────────────────────────────── */

  GunX.prototype.destroy = function () {
    this._destroyed = true;
    if (this._refreshTimer) clearInterval(this._refreshTimer);
    try {
      if (this._hi && this._hi.off) this._hi.off();
      if (this._bye && this._bye.off) this._bye.off();
    } catch (e) {
      /* noop */
    }
  };

  GunX.defaultPeers = DEFAULT_PEERS;
  return GunX;
});
