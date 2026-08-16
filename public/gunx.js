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
    // File sharing (WebRTC, PairDrop-inspired) + imgbb image hosting config.
    this.rtcConfig = options.rtcConfig || { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
    this._imgbbKey = options.imgbbKey || null;
    this._imgbbProxy = options.imgbbProxy || null;
    this._autoAccept = !!options.autoAccept;
    this._fxId = null;
    this._sigSeq = 0;
    this._rtc = Object.create(null);
    this._peerSnap = Object.create(null);
    this._fileOfferCb = null;
    this._fileCb = null;
    this._progressCb = null;
    this.storage = { uploadImage: this.uploadImage.bind(this) };

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

  /* ── Presence (ephemeral online state) ─────────────────────────── */

  /** Stable-ish id for this client, used for presence + P2P signaling. */
  GunX.prototype.myId = function () {
    if (!this._fxId) this._fxId = randomId() + Date.now().toString(36).slice(-4);
    return this._fxId;
  };

  /** Namespaced internal soul: appKey/fx/<soul>. */
  GunX.prototype._fx = function (soul) {
    return this.gun.get(this.ns("fx/" + soul));
  };

  /**
   * Register this client as online. Heartbeat refreshes `ts` every ttl/2
   * (min 10s) so other clients can prune dead peers. Returns myId.
   */
  GunX.prototype.joinPresence = function (meta, ttl) {
    var self = this;
    var id = this.myId();
    this._presenceMeta = meta || {};
    this._presenceTtl = ttl || 60000;
    var beat = function () {
      if (self._destroyed) { clearInterval(self._presenceTimer); return; }
      self._fx("peers").get(id).put({ id: id, name: self._presenceMeta.name || "", on: true, ts: Date.now() });
    };
    beat();
    if (this._presenceTimer) clearInterval(this._presenceTimer);
    this._presenceTimer = setInterval(beat, Math.max(10000, this._presenceTtl / 2));
    return id;
  };

  /** Take this client offline. */
  GunX.prototype.leavePresence = function () {
    if (this._presenceTimer) { clearInterval(this._presenceTimer); this._presenceTimer = null; }
    if (!this._fxId) return this;
    this._fx("peers").get(this._fxId).put({ id: this._fxId, on: false, ts: Date.now() });
    return this;
  };

  /**
   * Watch online peers. cb(list) fires whenever the peer set changes.
   * Dead peers (on:false / missing / stale ts) are pruned.
   */
  GunX.prototype.onPeers = function (cb) {
    var self = this;
    this._fx("peers").map().on(function (data, key) {
      if (self._destroyed) return;
      var snap = self._peerSnap;
      if (!data || data.on === false) {
        if (snap[key]) { delete snap[key]; self._emitPeers(cb); }
        return;
      }
      if (key === self.myId()) return;
      var stale = data.ts && Date.now() - data.ts > (self._presenceTtl || 60000) * 2;
      if (stale) {
        if (snap[key]) { delete snap[key]; self._emitPeers(cb); }
        return;
      }
      var p = { id: key, name: data.name || "", ts: data.ts || 0 };
      var changed = !snap[key] || snap[key].name !== p.name || snap[key].ts !== p.ts;
      snap[key] = p;
      if (changed) {
        // New peer: attach the signaling listener for this direction.
        if (!self._sigListening) self._sigListening = Object.create(null);
        if (!self._sigListening[key]) {
          self._sigListening[key] = 1;
          self._sigListen(key);
        }
        self._emitPeers(cb);
      }
    });
    return this;
  };

  GunX.prototype._emitPeers = function (cb) {
    var list = [];
    for (var k in this._peerSnap) list.push(this._peerSnap[k]);
    if (cb) cb(list);
  };

  /** Current peer snapshot. */
  GunX.prototype.peers = function () {
    var list = [];
    for (var k in this._peerSnap) list.push(this._peerSnap[k]);
    return list;
  };

  /* ── P2P file sharing (WebRTC, PairDrop-inspired) ─────────────── */

  GunX.prototype._rtcGet = function (peerId) {
    if (!this._rtc[peerId]) this._rtc[peerId] = { peerId: peerId };
    return this._rtc[peerId];
  };

  /** Write one signaling message (offer / answer / ice) via gun souls. */
  GunX.prototype._sigWrite = function (to, payload) {
    var id = this.myId();
    var key = id.slice(0, 6) + "-" + (++this._sigSeq);
    this.gun.get(this.ns("fx/sig")).get(id).get(to).get(key).put(payload);
  };

  /** Listen for signaling messages from `from` (on the soul from→me). */
  GunX.prototype._sigListen = function (from) {
    var self = this;
    var id = this.myId();
    var dir = from + "/" + id;
    var seen = (this._sigSeen = this._sigSeen || Object.create(null));
    if (!seen[dir]) seen[dir] = Object.create(null);
    // Track so late joiners catch up via the auto-refresh get.
    this.trackedSouls[this.ns("fx/sig") + "/" + from + "/" + id] = 1;
    this.gun.get(this.ns("fx/sig")).get(from).get(id).map().on(function (data, key) {
      if (self._destroyed || !data) return;
      if (seen[dir][key]) return; // gun re-emits; dedupe
      seen[dir][key] = 1;
      self._onSignal(from, data);
    });
  };

  /** gun rejects DOM objects (RTCSessionDescription/RTCIceCandidate) as
   *  "Invalid data" AND converts any nested object value into a child
   *  soul reference — so signaling payloads must be completely flat:
   *  {sdpType, sdp} for descriptions, {iceCandidate, sdpMid,
   *  sdpMLineIndex, usernameFragment} for candidates. */
  GunX.prototype._sigPlain = function (sdp, ice) {
    if (sdp) return { sdpType: sdp.type, sdp: sdp.sdp };
    if (ice) return {
      iceCandidate: ice.candidate,
      sdpMid: ice.sdpMid,
      sdpMLineIndex: ice.sdpMLineIndex,
      usernameFragment: ice.usernameFragment,
    };
  };

  GunX.prototype._onSignal = function (from, data) {
    var self = this;
    var r = this._rtcGet(from);
    if (data.sdpType) {
      var sdp = { type: data.sdpType, sdp: data.sdp };
      if (sdp.type === "offer") {
        if (r.pc) return; // already negotiating
        r.role = "receiver";
        var accept = function () {
          r.accepted = true;
          r.pc = new RTCPeerConnection(self.rtcConfig);
          r.pc.onicecandidate = function (e) { if (e.candidate) self._sigWrite(from, self._sigPlain(null, e.candidate)); };
          r.pc.oniceconnectionstatechange = function () {
            if (r.pc && (r.pc.iceConnectionState === "failed" || r.pc.iceConnectionState === "closed")) self._rtcClean(from);
          };
          r.pc.ondatachannel = function (e) { self._onChannel(from, e.channel); };
          r.pc.setRemoteDescription(new RTCSessionDescription(sdp))
            .then(function () { return r.pc.createAnswer(); })
            .then(function (answer) { return r.pc.setLocalDescription(answer); })
            .then(function () { self._sigWrite(from, self._sigPlain(r.pc.localDescription)); })
            .catch(function (err) { self._fxError(from, err); });
        };
        if (this._autoAccept || !this._fileOfferCb) accept();
        else this._fileOfferCb({ from: from, accept: accept, reject: function () { self._rtcClean(from); } });
      } else if (sdp.type === "answer" && r.pc && !r.pc.remoteDescription) {
        r.pc.setRemoteDescription(new RTCSessionDescription(sdp)).catch(function (err) { self._fxError(from, err); });
      }
    } else if (data.iceCandidate && r.pc) {
      r.pc.addIceCandidate(new RTCIceCandidate({
        candidate: data.iceCandidate,
        sdpMid: data.sdpMid,
        sdpMLineIndex: data.sdpMLineIndex,
        usernameFragment: data.usernameFragment,
      })).catch(function () { /* trickle race, fine */ });
    }
  };

  /**
   * Receive side. cb({from, name, size, type, save}) fires when a file
   * transfer is established. Call save() to keep the file (auto-saved
   * when autoAccept is on or when no offer handler is registered).
   */
  GunX.prototype.onFileOffer = function (cb) {
    this._fileOfferCb = cb;
    return this;
  };

  /** Receive completed file. cb({blob, name, size, type, from}). */
  GunX.prototype.onFile = function (cb) {
    this._fileCb = cb;
    return this;
  };

  /** Progress events: {direction, to|from, name, sent|received, total}. */
  GunX.prototype.onTransferProgress = function (cb) {
    this._progressCb = cb;
    return this;
  };

  /** Shared channel plumbing for the receiver side. */
  GunX.prototype._onChannel = function (from, channel) {
    var self = this;
    var r = this._rtcGet(from);
    channel.binaryType = "arraybuffer";
    r.channel = channel;
    r.chunks = [];
    r.received = 0;
    channel.onmessage = function (e) {
      if (typeof e.data === "string") {
        var m;
        try { m = JSON.parse(e.data); } catch (err) { return; }
        if (m.type === "start") {
          r.meta = m;
          r.chunks = [];
          r.received = 0;
        } else if (m.type === "end") {
          self._fxComplete(from);
        }
      } else {
        r.received += e.data.byteLength;
        r.chunks.push(e.data);
        if (self._progressCb) {
          self._progressCb({ direction: "in", from: from, name: r.meta && r.meta.name, received: r.received, total: (r.meta && r.meta.size) || 0 });
        }
      }
    };
    channel.onclose = function () { self._rtcClean(from); };
  };

  GunX.prototype._fxComplete = function (from) {
    var r = this._rtc[from];
    if (!r || !r.meta) return;
    var blob = new Blob(r.chunks || [], { type: r.meta.type || "application/octet-stream" });
    var file = { blob: blob, name: r.meta.name, size: r.meta.size, type: blob.type, from: from };
    // Persist a lightweight metadata node for chat-style apps.
    var transferId = randomId();
    this.gun.get(this.ns("fx/files")).get(transferId).put({
      name: file.name, size: file.size, type: file.type, from: from, to: this.myId(), ts: Date.now(),
    });
    if (this._fileCb) this._fileCb(file);
    this._rtcClean(from);
  };

  GunX.prototype._fxError = function (peerId, err) {
    this._rtcClean(peerId);
    if (this._fileCb) this._fileCb({ error: err, from: peerId });
  };

  GunX.prototype._rtcClean = function (peerId) {
    var r = this._rtc[peerId];
    if (!r) return;
    if (r.timeout) { clearTimeout(r.timeout); r.timeout = null; }
    try { if (r.channel) r.channel.close(); } catch (e) { /* noop */ }
    try { if (r.pc) r.pc.close(); } catch (e) { /* noop */ }
    delete this._rtc[peerId];
  };

  /**
   * Send a file to one peer (opts.to) or to every currently-known peer
   * (default). Chunked 64KB over an ordered RTC data channel; signaling
   * flows through gun souls, so no relay ever sees file bytes.
   */
  GunX.prototype.shareFile = function (file, opts, cb) {
    var self = this;
    opts = opts || {};
    var targets = opts.to ? [opts.to] : [];
    if (!targets.length) targets = this.peers().map(function (p) { return p.id; });
    if (!targets.length) {
      if (cb) cb(new Error("no peers available"));
      return this;
    }
    targets.forEach(function (to) { self._sendFileTo(file, to, cb); });
    return this;
  };

  GunX.prototype._sendFileTo = function (file, to, cb) {
    var self = this;
    // Ensure we can hear this peer's answer + ICE even if it was never
    // discovered via presence (explicit opts.to).
    if (!this._sigListening) this._sigListening = Object.create(null);
    if (!this._sigListening[to]) {
      this._sigListening[to] = 1;
      this._sigListen(to);
    }
    var r = this._rtcGet(to);
    r.role = "sender";
    r.file = file;
    r.sent = 0;
    var pc = (r.pc = new RTCPeerConnection(this.rtcConfig));
    pc.onicecandidate = function (e) { if (e.candidate) self._sigWrite(to, self._sigPlain(null, e.candidate)); };
    pc.oniceconnectionstatechange = function () {
      if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "closed") {
        if (cb) cb(new Error("ice " + pc.iceConnectionState));
        self._rtcClean(to);
      }
    };
    // Give the peer 45s to answer; otherwise abort the transfer.
    r.timeout = setTimeout(function () {
      if (r.channel && r.channel.readyState !== "open") {
        if (cb) cb(new Error("peer did not answer"));
        self._rtcClean(to);
      }
    }, 45000);
    var ch = pc.createDataChannel("gunx-file", { ordered: true });
    ch.binaryType = "arraybuffer";
    r.channel = ch;
    ch.onopen = function () {
      if (r.timeout) { clearTimeout(r.timeout); r.timeout = null; }
      ch.send(JSON.stringify({ type: "start", name: file.name, size: file.size, type: file.type || "application/octet-stream" }));
      var offset = 0, chunkSize = 64000;
      var reader = new FileReader();
      var readNext = function () { reader.readAsArrayBuffer(file.slice(offset, Math.min(offset + chunkSize, file.size))); };
      reader.onload = function (e) {
        if (self._destroyed || ch.readyState !== "open") return;
        var buf = e.target.result;
        ch.send(buf);
        r.sent += buf.byteLength;
        if (self._progressCb) {
          self._progressCb({ direction: "out", to: to, name: file.name, sent: r.sent, total: file.size });
        }
        offset += buf.byteLength;
        if (offset < file.size) readNext();
        else { ch.send(JSON.stringify({ type: "end" })); if (cb) cb(null, { name: file.name, size: file.size, to: to }); }
      };
      reader.onerror = function () { if (cb) cb(new Error("file read failed")); };
      readNext();
    };
    ch.onerror = function () { if (cb) cb(new Error("channel error")); };
    pc.createOffer()
      .then(function (offer) { return pc.setLocalDescription(offer); })
      .then(function () { self._sigWrite(to, self._sigPlain(pc.localDescription)); })
      .catch(function (err) { if (cb) cb(err); self._rtcClean(to); });
  };

  /* ── Image hosting via imgbb ──────────────────────────────────── */

  /**
   * Upload an image (File/Blob/dataURL/URL) to imgbb. Requires an imgbb
   * API key (opts.key, or the GunX({imgbbKey}) option) OR a self-hosted
   * proxy (opts.proxy or GunX({imgbbProxy})) that injects the key.
   * Resolves with the imgbb data block {url, thumb, display_url, ...}.
   */
  GunX.prototype.uploadImage = function (image, opts) {
    opts = opts || {};
    var self = this;
    return new Promise(function (resolve, reject) {
      var proxy = opts.proxy || self._imgbbProxy;
      var key = opts.key || self._imgbbKey;
      var post = function (value) {
        var body;
        if (proxy) {
          // Server-side proxy: multipart file upload. The key stays on the
          // server (Pages secret) — clients never see it.
          var fd = new FormData();
          if (typeof value === "string" && value.indexOf("data:") === 0) {
            var m = /^data:([^;,]+)?(;[^,]*)?,(.*)$/s.exec(value);
            var bin = atob(m[3]);
            var bytes = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            fd.append("image", new Blob([bytes], { type: (m && m[1]) || "image/png" }), "upload.png");
          } else {
            fd.append("image", value, (value && value.name) || "upload.png");
          }
          body = fd;
        } else {
          // Direct imgbb API — only for SDK users who hold their own key.
          if (!key) return reject(new Error("no imgbb key or proxy configured"));
          var fd = new FormData();
          fd.append("key", key);
          if (typeof value === "string" && value.indexOf("data:") === 0) fd.append("image", value.split(",")[1]);
          else fd.append("image", value, (value && value.name) || "upload.png");
          body = fd;
        }
        fetch(proxy || "https://api.imgbb.com/1/upload", { method: "POST", body: body })
          .then(function (r) { return r.json(); })
          .then(function (json) {
            if (!json) return reject(new Error("empty upload response"));
            if (json.error) return reject(new Error((json.error && (json.error.message || json.error)) || "imgbb upload failed"));
            // Direct API wraps data in {data:{...}}; our proxy returns the flat block.
            resolve(json.data || json);
          })
          .catch(reject);
      };
      if (typeof image === "string") post(image);
      else if (image instanceof Blob) post(image);
      else {
        var reader = new FileReader();
        reader.onload = function (e) { post(String(e.target.result)); };
        reader.onerror = function () { reject(new Error("image read failed")); };
        reader.readAsDataURL(image);
      }
    });
  };

  /* ── Teardown ────────────────────────────────────────────────────── */

  GunX.prototype.destroy = function () {
    this._destroyed = true;
    this.leavePresence();
    for (var k in this._rtc) this._rtcClean(k);
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
