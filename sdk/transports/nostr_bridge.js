/**
 * nostr_bridge.js — GunX Phase 2: Nostr Relay Bridge (NIP-01), UMD, zero-dep.
 *
 * Bridges the gun wire protocol through the public Nostr relay network:
 *
 *   OUTGOING (gun -> nostr):
 *     gun put message (flat-primitives JSON)  ->  Kind 30000 event
 *     #d  tag = gun soul key (e.g. "app_absup/chat/room1")
 *     #t  tags = ["gunx", appKey]  (global filtering + discovery)
 *     content = gun wire message payload JSON string
 *
 *   INCOMING (nostr -> gun):
 *     REQ {kinds:[30000], #t:["gunx",appKey], since} subscription;
 *     every event is Schnorr-verified (NIP-01) before the content is
 *     parsed and handed to the caller via on('dag', (soul, wireMsg)).
 *
 *   PEER DISCOVERY:
 *     Kind 20000 ephemeral heartbeat every heartbeatMs (default 5 min)
 *     tagged ["t","gunx_presence"] — visible to any gunx subscriber
 *     without any central directory.
 *
 * Uses the platform WebSocket in browsers and `ws` in Node (passed via
 * the UMD factory — the SDK loads this file lazily). All crypto lives in
 * sdk/utils/nostr_codec.js (injected signer API).
 *
 * Usage:
 *   const bridge = new NostrBridge({ relayUrl, codec, appKey, secKeyHex });
 *   bridge.on('dag', (soul, wireMsg) => { /* merge into gun graph *\/ });
 *   bridge.connect();
 *   bridge.publishDag('app_absup/chat/room1', { "#": "m1", ">": {...}, put: {...} });
 *   bridge.destroy();
 *
 * (c) ABsUP / OpenCodeWEB. MIT License.
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(function () {
      try { return require("ws"); } catch (e) { return null; }
    });
  } else {
    root.GunXNostrBridge = factory(function () {
      return root.WebSocket || null;
    });
  }
})(typeof self !== "undefined" ? self : globalThis, function (getWs) {
  "use strict";

  var u;

  function NostrBridge(opts) {
    if (!(this instanceof NostrBridge)) return new NostrBridge(opts);
    opts = opts || {};
    if (!opts.relayUrl) throw new Error("NostrBridge: relayUrl required");
    if (!opts.codec) throw new Error("NostrBridge: codec (sdk/utils/nostr_codec.js) required");

    this.relayUrl = opts.relayUrl;
    this.codec = opts.codec;
    this.appKey = (opts.appKey || "default").replace(/[\/\s]/g, "-");
    this.secKeyHex = opts.secKeyHex || this.codec.randomSecKey();
    this.pubkey = opts.pubkey || this.codec.pubkeyOf(this.secKeyHex);
    this.heartbeatMs = opts.heartbeatMs === u ? 300000 : opts.heartbeatMs;
    this.wsClass = opts.wsClass || getWs();
    this.presenceMeta = opts.presenceMeta || null;

    this._ws = null;
    this._subId = "gx_" + Math.random().toString(36).slice(2, 10);
    this._since = opts.since || 0;
    this._listeners = Object.create(null);
    this._ackCbs = Object.create(null);
    this._reconnectTimer = null;
    this._heartbeatTimer = null;
    this._reconnectDelay = 1000;
    this._destroyed = false;

    this.status = {
      connected: false,
      relayUrl: this.relayUrl,
      activeSubs: 0,
      eventsSent: 0,
      eventsReceived: 0,
      lastError: null,
    };
  }

  /* ---- events ---- */
  NostrBridge.prototype.on = function (name, cb) {
    (this._listeners[name] = this._listeners[name] || []).push(cb);
    return this;
  };
  NostrBridge.prototype._emit = function (name, arg) {
    var cbs = this._listeners[name];
    if (!cbs) return;
    for (var i = 0; i < cbs.length; i++) {
      try { cbs[i](arg); } catch (e) { /* listener errors must not kill the bridge */ }
    }
  };

  /* ---- connection ---- */
  NostrBridge.prototype.connect = function () {
    if (this._destroyed) return;
    var self = this;
    if (!this.wsClass) {
      this.status.lastError = "no WebSocket implementation";
      this._emit("error", { message: this.status.lastError });
      return;
    }
    try {
      this._ws = new this.wsClass(this.relayUrl);
    } catch (e) {
      this.status.lastError = e.message;
      this._emit("error", { message: e.message });
      this._scheduleReconnect();
      return;
    }

    if (this._ws.on) {
      // Node `ws`
      this._ws.on("open", function () { self._onOpen(); });
      this._ws.on("message", function (d) { self._onMessage(String(d)); });
      this._ws.on("close", function () { self._onClose(); });
      this._ws.on("error", function (e) { self._onError(e); });
    } else {
      // browser WebSocket
      this._ws.onopen = function () { self._onOpen(); };
      this._ws.onmessage = function (e) { self._onMessage(String(e.data)); };
      this._ws.onclose = function () { self._onClose(); };
      this._ws.onerror = function (e) { self._onError(e); };
    }
  };

  NostrBridge.prototype._onOpen = function () {
    this.status.connected = true;
    this.status.lastError = null;
    this._reconnectDelay = 1000;
    // subscribe: Kind 30000 events tagged gunx + appKey
    var req = ["REQ", this._subId, {
      kinds: [30000],
      "#t": ["gunx", this.appKey],
      since: this._since,
    }];
    this._send(req);
    this.status.activeSubs = 1;
    this._emit("status", this.status);
    this._startHeartbeat();
  };

  NostrBridge.prototype._onMessage = function (data) {
    var msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    if (!Array.isArray(msg)) return;
    if (msg[0] === "EVENT" && msg[1] === this._subId) {
      this._handleEvent(msg[2]);
    } else if (msg[0] === "OK") {
      var cb = this._ackCbs[msg[1]];
      if (cb) { delete this._ackCbs[msg[1]]; cb(msg[2], msg[3] || ""); }
    } else if (msg[0] === "EOSE") {
      this._emit("status", this.status);
    }
  };

  NostrBridge.prototype._handleEvent = function (evt) {
    if (!evt || typeof evt !== "object") return;
    if (!this.codec.verifyEvent(evt)) {
      this._emit("error", { message: "rejected unverifiable nostr event " + (evt.id || "?") });
      return;
    }
    var soul = null;
    var tags = evt.tags || [];
    for (var i = 0; i < tags.length; i++) {
      if (tags[i][0] === "d") { soul = tags[i][1]; break; }
    }
    var wireMsg;
    try { wireMsg = JSON.parse(evt.content); } catch (e) { return; }
    this.status.eventsReceived++;
    this._emit("dag", { soul: soul, wireMsg: wireMsg, pubkey: evt.pubkey, created_at: evt.created_at });
  };

  NostrBridge.prototype._onClose = function () {
    var wasConnected = this.status.connected;
    this.status.connected = false;
    this.status.activeSubs = 0;
    this._emit("status", this.status);
    if (wasConnected || this._reconnectDelay > 1000) this._scheduleReconnect();
  };

  NostrBridge.prototype._onError = function (e) {
    this.status.lastError = (e && e.message) || String(e);
    this._emit("error", { message: this.status.lastError });
  };

  NostrBridge.prototype._scheduleReconnect = function () {
    if (this._destroyed || this._reconnectTimer) return;
    var self = this;
    this._reconnectTimer = setTimeout(function () {
      self._reconnectTimer = null;
      if (self._destroyed) return;
      self._reconnectDelay = Math.min(self._reconnectDelay * 2, 30000);
      self.connect();
    }, this._reconnectDelay);
  };

  /* ---- publish ---- */
  NostrBridge.prototype._send = function (msg) {
    if (!this._ws) return false;
    var payload = JSON.stringify(msg);
    try {
      if (this._ws.readyState === 1 || this._ws.readyState === this.wsClass.OPEN) {
        this._ws.send(payload);
        return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  };

  /**
   * Publish a gun wire message for a soul as a Kind 30000 event.
   * @param soul     gun soul key, e.g. "app_absup/chat/room1"
   * @param wireMsg  flat-primitives gun message {"#":id,">":state,"put":{...}}
   * @param cb       (ok, message) ack from relay (optional)
   */
  NostrBridge.prototype.publishDag = function (soul, wireMsg, cb) {
    if (!soul || !wireMsg) return;
    var evt = this.codec.makeEvent({
      kind: 30000,
      tags: [["d", soul], ["t", "gunx"], ["t", this.appKey]],
      content: JSON.stringify(wireMsg),
      secKeyHex: this.secKeyHex,
      pubkey: this.pubkey,
    });
    if (cb) this._ackCbs[evt.id] = cb;
    this._send(["EVENT", evt]);
    this.status.eventsSent++;
  };

  /**
   * Kind 20000 ephemeral presence heartbeat — peer discovery without any
   * central directory. Relay usually broadcasts then drops it.
   */
  NostrBridge.prototype.publishPresence = function (meta, cb) {
    var evt = this.codec.makeEvent({
      kind: 20000,
      tags: [["t", "gunx_presence"], ["t", this.appKey]],
      content: JSON.stringify(meta || this.presenceMeta || { appKey: this.appKey }),
      secKeyHex: this.secKeyHex,
      pubkey: this.pubkey,
    });
    if (cb) this._ackCbs[evt.id] = cb;
    this._send(["EVENT", evt]);
    this.status.eventsSent++;
  };

  /* ---- heartbeat timer ---- */
  NostrBridge.prototype._startHeartbeat = function () {
    var self = this;
    if (this.heartbeatMs <= 0 || this._heartbeatTimer) return;
    this._heartbeatTimer = setInterval(function () {
      if (self._destroyed || !self.status.connected) return;
      self.publishPresence(null, function () {});
    }, this.heartbeatMs);
  };

  /* ---- teardown ---- */
  NostrBridge.prototype.destroy = function () {
    this._destroyed = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
    if (this._ws) {
      try {
        if (this._ws.on) this._ws.close(); else this._ws.close();
      } catch (e) {}
      this._ws = null;
    }
    this.status.connected = false;
    this.status.activeSubs = 0;
  };

  return NostrBridge;
});