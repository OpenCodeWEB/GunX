/**
 * direct_rtc.js — GunX Phase 1: Direct WebRTC P2P (manual/QR air-gapped pairing).
 *
 * Zero-server peer connectivity: two devices exchange a compact offer code
 * (copy-paste or QR), then an answer code, and the RTCPeerConnection +
 * DataChannel are established with no relay, no gun soul, no signaling
 * server of any kind — works fully offline / air-gapped.
 *
 * Design (Gemini-consulted):
 *   - Two-way handshake: OFFER_CODE -> ANSWER_CODE -> accept -> DTLS -> DataChannel
 *   - Compact payload:  {v, id, t, n, s, h}  ->  "GUNX1:" + base64url(deflateRaw(json))
 *     (s = stripped SDP, h = SDP djb2 hash, n = pairing nonce)
 *   - Multiplexed framing over one ordered DataChannel:
 *       0x01 MSG  (directSend JSON)
 *       0x02 META (file announce)
 *       0x04 CHUNK(binary file chunk)
 *       0x05 END  (file complete)
 *   - 6-digit SAS verification code (djb2 over nonce + ids + sdp hashes)
 *     shown on BOTH screens after connect — catches MITM/copy-paste errors.
 *   - Codes expire (default 60s); offers are one-shot (single answer).
 *
 * UMD: browser (global DirectRTC) + Node (module.exports). No dependencies
 * beyond platform WebRTC / CompressionStream (zlib fallback in Node).
 *
 * (c) ABsUP / OpenCodeWEB. MIT License.
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.DirectRTC = factory();
  }
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  var u;

  /* ── small helpers ─────────────────────────────────────────────── */

  function randomId() {
    return (
      "p" +
      Math.random().toString(36).slice(2, 8) +
      Date.now().toString(36).slice(-4)
    );
  }

  /** djb2 — deterministic string hash (fingerprints, code sanity). */
  function djb2(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
    return h >>> 0;
  }

  function pad3(n) {
    return n < 10 ? "00" + n : n < 100 ? "0" + n : "" + n;
  }

  /**
   * 6-digit SAS verification code "384-912". Computed identically on both
   * peers from shared inputs: pairing nonce + both temp ids + both SDP
   * hashes. A MITM (or a mis-copied code) produces different codes on the
   * two screens, so the humans instantly detect it.
   */
  function sasCode(nonce, aId, bId, aSdpHash, bSdpHash) {
    var n = djb2(nonce + "|" + aId + "|" + bId + "|" + aSdpHash + "|" + bSdpHash) % 1000000;
    return pad3(Math.floor(n / 1000)) + "-" + pad3(n % 1000);
  }

  /* ── SDP compaction ────────────────────────────────────────────── */

  /**
   * Drop wire-irrelevant lines from an SDP. For a data-channel-only SDP the
   * connectivity-relevant lines are: v= o= s= t= a=group a=extmap-allow-mixed
   * a=msid-semantic a=ice-ufrag a=ice-pwd a=ice-options a=fingerprint
   * a=setup a=mid a=sctp-port a=max-message-size a=candidate m= c=.
   * Media-only boilerplate is safe to strip — but NOT extmap-allow-mixed /
   * msid-semantic / ice-options: Chrome fails to parse a datachannel SDP
   * without them (verified against real Chromium SDP).
   */
  function stripSdp(sdp) {
    return sdp
      .split(/\r?\n/)
      .filter(function (line) {
        if (!line) return false;
        if (/^a=(rtcp|rtcp-mux|rtpmap|fmtp|ssrc|extmap:|end-of-candidates|ice-lite)/i.test(line)) return false;
        return true;
      })
      .join("\r\n");
  }

  function deflateRawBytes(str) {
    return new Promise(function (resolve, reject) {
      if (typeof CompressionStream !== "undefined") {
        try {
          var cs = new CompressionStream("deflate-raw");
          var stream = new Blob([str]).stream().pipeThrough(cs);
          new Response(stream)
            .arrayBuffer()
            .then(function (buf) { resolve(new Uint8Array(buf)); })
            .catch(reject);
          return;
        } catch (e) { /* fall through to zlib */ }
      }
      try {
        var zlib = require("zlib");
        resolve(zlib.deflateRawSync(str));
      } catch (e) {
        reject(e);
      }
    });
  }

  function inflateRawBytes(bytes) {
    return new Promise(function (resolve, reject) {
      if (typeof DecompressionStream !== "undefined") {
        try {
          var ds = new DecompressionStream("deflate-raw");
          var stream = new Blob([bytes]).stream().pipeThrough(ds);
          new Response(stream)
            .text()
            .then(resolve)
            .catch(reject);
          return;
        } catch (e) { /* fall through to zlib */ }
      }
      try {
        var zlib = require("zlib");
        resolve(zlib.inflateRawSync(Buffer.from(bytes)).toString("utf8"));
      } catch (e) {
        reject(e);
      }
    });
  }

  function b64urlFromBytes(bytes) {
    if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64url");
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function bytesFromB64url(s) {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(s, "base64"));
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /**
   * Encode a pairing payload into a compact transfer code.
   * Returns Promise<string> like "GUNX1:eJydV1tz...".
   */
  function encodeCompact(payload) {
    var json = JSON.stringify(payload);
    return deflateRawBytes(json).then(function (bytes) {
      return "GUNX1:" + b64urlFromBytes(bytes);
    });
  }

  /** Decode a transfer code. Returns Promise<payload>. Throws on format errors. */
  function decodeCompact(code) {
    if (typeof code !== "string") return Promise.reject(new Error("INVALID_OFFER_CODE"));
    if (code.slice(0, 6) !== "GUNX1:") return Promise.reject(new Error("INVALID_OFFER_CODE"));
    return inflateRawBytes(bytesFromB64url(code.slice(6))).then(function (text) {
      var payload;
      try {
        payload = JSON.parse(text);
      } catch (e) {
        throw new Error("INVALID_OFFER_CODE");
      }
      if (!payload || payload.v !== 1) throw new Error("INVALID_OFFER_CODE");
      return payload;
    }, function () {
      // corrupt base64 / bad deflate stream = not a real code
      throw new Error("INVALID_OFFER_CODE");
    });
  }

  /* ── frame types (single multiplexed DataChannel) ─────────────── */

  var T = { MSG: 0x01, META: 0x02, CHUNK: 0x04, END: 0x05 };

  /** Frame = [type(1) | len(4, LE) | payload]. One frame per channel message. */
  function encodeFrame(type, payloadBytes) {
    var len = payloadBytes.length;
    var frame = new Uint8Array(5 + len);
    frame[0] = type;
    frame[1] = len & 0xff;
    frame[2] = (len >> 8) & 0xff;
    frame[3] = (len >> 16) & 0xff;
    frame[4] = (len >> 24) & 0xff;
    frame.set(payloadBytes, 5);
    return frame;
  }

  function decodeFrame(frame) {
    if (!frame) return null;
    // e.data arrives as ArrayBuffer (binaryType='arraybuffer') in real
    // WebRTC; mock channels may pass views. Normalize both.
    var view = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
    if (view.byteLength < 5) return null;
    var type = view[0];
    var len = view[1] | (view[2] << 8) | (view[3] << 16) | (view[4] << 24);
    return { type: type, payload: view.slice(5, 5 + len) };
  }

  function textFromBytes(bytes) {
    return new TextDecoder().decode(bytes);
  }

  function bytesFromText(str) {
    return new TextEncoder().encode(str);
  }

  function toArrayBuffer(buf) {
    if (buf instanceof ArrayBuffer) return buf;
    if (ArrayBuffer.isView(buf)) return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return buf;
  }

  /* ── DirectRTC ─────────────────────────────────────────────────── */

  var DEFAULT_TIMEOUT = 60000;
  var DEFAULT_ICE_WAIT = 8000;
  var HANDSHAKE_TIMEOUT = 30000;

  function DirectRTC(options) {
    options = options || {};
    this.rtcConfig = options.rtcConfig || { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
    this._sessions = Object.create(null); // tempId -> session
    this._offer = null;                   // pending host offer
    this._listeners = Object.create(null);
    this._destroyed = false;
    // test injection points (kept off the public API)
    this._pcFactory = options.pcFactory || null;
    this._pcCtor = options.pcCtor || null;
  }

  DirectRTC.codecs = {
    stripSdp: stripSdp,
    encodeCompact: encodeCompact,
    decodeCompact: decodeCompact,
    encodeFrame: encodeFrame,
    decodeFrame: decodeFrame,
    sasCode: sasCode,
    djb2: djb2,
    b64urlFromBytes: b64urlFromBytes,
    bytesFromB64url: bytesFromB64url,
    deflateRawBytes: deflateRawBytes,
    inflateRawBytes: inflateRawBytes,
  };

  DirectRTC.prototype._makePc = function () {
    var pc;
    if (this._pcFactory) {
      pc = this._pcFactory();
    } else {
      var Ctor = this._pcCtor || (typeof RTCPeerConnection !== "undefined" ? RTCPeerConnection : null);
      if (!Ctor) throw new Error("RTC_NOT_SUPPORTED");
      pc = new Ctor(this.rtcConfig);
    }
    // Buffer ICE candidates so the pairing code is self-contained even when
    // gathering is still in flight when we snapshot localDescription.
    // Only HOST candidates are kept: Chrome's SDP parser rejects remote
    // offers carrying a srflx candidate whose raddr/rport are zeroed, and it
    // also rejects a c= line updated to the public (srflx) address. Host
    // candidates suffice for the QR-pairing use case (same LAN / same host).
    pc._gx_candidates = [];
    pc.addEventListener("icecandidate", function (e) {
      if (e && e.candidate && /^candidate:.*\styp\shost(\s|$)/i.test(e.candidate.candidate)) {
        pc._gx_candidates.push("a=candidate:" + e.candidate.candidate);
      }
    });
    return pc;
  };

  DirectRTC.prototype._emit = function (name, args) {
    var cbs = this._listeners[name];
    if (!cbs) return;
    for (var i = 0; i < cbs.length; i++) {
      try {
        cbs[i].apply(null, args);
      } catch (e) { /* listener errors must not break the transport */ }
    }
  };

  DirectRTC.prototype.on = function (name, cb) {
    if (!this._listeners[name]) this._listeners[name] = [];
    this._listeners[name].push(cb);
    return this;
  };

  /** Wait until ICE gathering finishes (bounded) so the code is self-contained. */
  function waitIceComplete(pc, timeoutMs) {
    return new Promise(function (resolve) {
      if (!pc || pc.iceGatheringState === "complete") return resolve();
      var done = false;
      var finish = function () { if (!done) { done = true; clearTimeout(timer); resolve(); } };
      var timer = setTimeout(finish, timeoutMs || DEFAULT_ICE_WAIT);
      if (pc.addEventListener) pc.addEventListener("icegatheringstatechange", finish);
    });
  }

  /**
   * Snapshot the final local SDP for the wire. Chrome only guarantees
   * a=candidate lines inside pc.localDescription.sdp once gathering has
   * fully finished — and it refuses to parse a datachannel SDP that has
   * NO candidate lines at all ("Failed to parse SessionDescription").
   * ICE candidates can still be trickling in right after the gathering
   * state flips to "complete", so poll briefly; then fall back to the
   * buffered candidates if the snapshot still has none.
   */
  function finalizeSdp(pc, timeoutMs) {
    return waitIceComplete(pc, timeoutMs).then(function () {
      var snapshot = function () {
        var sdp = pc.localDescription ? pc.localDescription.sdp : "";
        var lines = sdp.split(/\r?\n/).filter(Boolean);
        // Normalize what Chrome mutates once a srflx candidate lands:
        //   - c= line may be rewritten to the public address -> 0.0.0.0
        //   - m=application port may be rewritten to the candidate port -> 9
        //   - drop non-host candidates (they break remote parsing here)
        lines = lines.map(function (l) {
          if (/^c=IN IP4\s/.test(l)) return "c=IN IP4 0.0.0.0";
          if (/^m=application\s+\d+\s+/.test(l)) return "m=application 9 UDP/DTLS/SCTP webrtc-datachannel";
          return l;
        }).filter(function (l) {
          return !/^a=candidate:.*\styp\s(?:srflx|prflx|relay)(\s|$)/i.test(l);
        });
        var hasCand = lines.some(function (l) { return /^a=candidate:/i.test(l); });
        var buffered = pc._gx_candidates || [];
        if (!hasCand && buffered.length) lines = lines.concat(buffered, ["a=end-of-candidates"]);
        return stripSdp(lines.join("\r\n"));
      };
      var first = snapshot();
      if (/a=candidate:/i.test(first)) return first;
      return new Promise(function (resolve) {
        var tries = 0;
        (function poll() {
          var s = snapshot();
          if (/a=candidate:/i.test(s) || ++tries > 14) return resolve(s);
          setTimeout(poll, 150);
        })();
      });
    });
  }

  function waitOpen(channel, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (!channel) return reject(new Error("HANDSHAKE_TIMEOUT"));
      if (channel.readyState === "open") return resolve();
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error("HANDSHAKE_TIMEOUT"));
      }, timeoutMs || HANDSHAKE_TIMEOUT);
      // Chain, never clobber: _prepareChannel's own onopen (SAS emit) must fire too.
      var prev = channel.onopen;
      channel.onopen = function () {
        if (prev) { try { prev(); } catch (e) { /* ignore */ } }
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
    });
  }

  DirectRTC.prototype._session = function (tempId) {
    if (!this._sessions[tempId]) this._sessions[tempId] = { tempId: tempId, chunks: null, received: 0, meta: null, files: Object.create(null) };
    return this._sessions[tempId];
  };

  /** Wire a DataChannel into the multiplexed protocol. */
  DirectRTC.prototype._prepareChannel = function (session, channel) {
    var self = this;
    session.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.onmessage = function (e) {
      var data = e.data;
      if (typeof data === "string") {
        // text frames are legacy-tolerant: treat as JSON message
        try { self._emit("message", [session.tempId, JSON.parse(data)]); } catch (err) { /* ignore */ }
        return;
      }
      var frame = decodeFrame(toArrayBuffer(data));
      if (!frame) return;
      if (frame.type === T.MSG) {
        var msg;
        try { msg = JSON.parse(textFromBytes(frame.payload)); } catch (err) { return; }
        self._emit("message", [session.tempId, msg]);
      } else if (frame.type === T.META) {
        var meta;
        try { meta = JSON.parse(textFromBytes(frame.payload)); } catch (err) { return; }
        session.meta = meta;
        session.received = 0;
        if (session.files[meta.id]) session.files[meta.id].chunks = [];
        else session.files[meta.id] = { chunks: [] };
      } else if (frame.type === T.CHUNK) {
        // payload layout: fileId(4 LE) + bytes
        var fid = (frame.payload[0] | (frame.payload[1] << 8) | (frame.payload[2] << 16) | (frame.payload[3] << 24)) >>> 0;
        var file = session.files[fid];
        if (!file) { session.files[fid] = { chunks: [] }; file = session.files[fid]; }
        file.chunks.push(frame.payload.slice(4));
        session.received += frame.payload.byteLength - 4;
        if (self._listeners["progress"]) {
          self._emit("progress", [{ direction: "in", from: session.tempId, name: session.meta && session.meta.name, received: session.received, total: (session.meta && session.meta.size) || 0 }]);
        }
      } else if (frame.type === T.END) {
        var fid2 = (frame.payload[0] | (frame.payload[1] << 8) | (frame.payload[2] << 16) | (frame.payload[3] << 24)) >>> 0;
        var f = session.files[fid2];
        if (f && session.meta) {
          var blob = new Blob(f.chunks, { type: session.meta.mime || "application/octet-stream" });
          self._emit("file", [{ from: session.tempId, blob: blob, name: session.meta.name, size: session.meta.size, type: blob.type }]);
          delete session.files[fid2];
        }
      }
    };
    channel.onclose = function () {
      self._emit("peer", [session.tempId, { status: "disconnected" }]);
      self._cleanSession(session);
    };
    if (channel.readyState === "open") self._onOpen(session);
    else channel.onopen = function () { self._onOpen(session); };
  };

  DirectRTC.prototype._recomputeAuth = function (session) {
    if (!session.offerHash || !session.answerHash) return false;
    session.authCode = sasCode(session.nonce, session.offerId, session.answerId, session.offerHash, session.answerHash);
    return true;
  };

  DirectRTC.prototype._emitConnected = function (session) {
    if (session.connectedEmitted) return;
    session.connectedEmitted = true;
    this._emit("peer", [session.tempId, { status: "connected", authCode: session.authCode }]);
  };

  DirectRTC.prototype._onOpen = function (session) {
    if (session.opened) return;
    session.opened = true;
    // Compute the mutual SAS from shared inputs (both sides agree). If the
    // counterpart hashes are not all in yet (e.g. the channel opened before
    // the async answer decode finished), the accept flow emits later.
    if (this._recomputeAuth(session)) this._emitConnected(session);
    // host: expire the one-shot offer once the channel is live
    if (this._offer === session) {
      this._offer = null;
      if (session.timer) { clearTimeout(session.timer); session.timer = null; }
    }
  };

  DirectRTC.prototype._cleanSession = function (session) {
    if (!session || session.cleaning) return; // recursion guard: close() fires onclose synchronously in mocks
    session.cleaning = true;
    if (session.timer) { clearTimeout(session.timer); session.timer = null; }
    try { if (session.channel) session.channel.close(); } catch (e) { /* noop */ }
    try { if (session.pc) session.pc.close(); } catch (e) { /* noop */ }
    if (this._sessions[session.tempId] === session) delete this._sessions[session.tempId];
  };

  /**
   * Host side — start a pairing. Returns a promise of
   * { code, peerId, expireAt, cancel }. `code` is the compact OFFER_CODE
   * (share it via copy-paste or QR). One-shot: a single answer is accepted.
   */
  DirectRTC.prototype.createDirectCode = function (options) {
    var self = this;
    options = options || {};
    var timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT;
    return new Promise(function (resolve, reject) {
      var pc, channel;
      try {
        pc = self._makePc();
      } catch (e) {
        return reject(new Error("RTC_NOT_SUPPORTED"));
      }
      var tempId = randomId();
      var nonce = Math.random().toString(36).slice(2, 12);
      channel = pc.createDataChannel("gx-direct", { ordered: true });
      var session = self._session(tempId);
      session.pc = pc;
      session.nonce = nonce;
      session.offerId = tempId;
      session.role = "host";
      session.expireAt = Date.now() + timeoutMs;
      session.timer = setTimeout(function () {
        if (self._offer === session) self._offer = null;
        self._emit("peer", [tempId, { status: "expired" }]);
        self._cleanSession(session);
      }, timeoutMs);
      self._offer = session;
      self._prepareChannel(session, channel);

      pc.oniceconnectionstatechange = function () {
        if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "closed") {
          self._emit("peer", [tempId, { status: "disconnected" }]);
          self._cleanSession(session);
        }
      };

      pc.createOffer()
        .then(function (offer) { return pc.setLocalDescription(offer); })
        .then(function () { return finalizeSdp(pc, options.iceWaitMs); })
        .then(function (sdp) {
          var payload = {
            v: 1,
            id: tempId,
            t: "o",
            n: nonce,
            s: sdp,
            h: djb2(sdp).toString(16),
          };
          session.offerHash = payload.h; // needed for the mutual SAS
          return encodeCompact(payload);
        })
        .then(function (code) {
          resolve({
            code: code,
            peerId: tempId,
            expireAt: session.expireAt || Date.now() + timeoutMs,
            cancel: function () {
              if (self._offer === session) self._offer = null;
              self._cleanSession(session);
            },
          });
        })
        .catch(function (err) {
          self._cleanSession(session);
          reject(err);
        });
    });
  };

  /**
   * Joiner side — consume an OFFER_CODE, produce an ANSWER_CODE.
   * Returns a promise of { code, peerId, expireAt, cancel }.
   */
  DirectRTC.prototype.connectDirect = function (offerCode, options) {
    var self = this;
    options = options || {};
    var timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT;
    return new Promise(function (resolve, reject) {
      decodeCompact(offerCode).then(function (payload) {
        if (payload.t !== "o") throw new Error("INVALID_OFFER_CODE");
        var pc;
        try {
          pc = self._makePc();
        } catch (e) {
          throw new Error("RTC_NOT_SUPPORTED");
        }
        var tempId = randomId();
        var session = self._session(payload.id); // keyed by the OFFERER's id
        session.pc = pc;
        session.nonce = payload.n;
        session.offerId = payload.id;
        session.offerHash = payload.h || djb2(payload.s).toString(16);
        session.answerId = tempId;
        session.role = "joiner";
        session.timer = setTimeout(function () {
          self._emit("peer", [payload.id, { status: "expired" }]);
          self._cleanSession(session);
        }, timeoutMs);
        pc.ondatachannel = function (e) { self._prepareChannel(session, e.channel); };
        pc.oniceconnectionstatechange = function () {
          if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "closed") {
            self._emit("peer", [payload.id, { status: "disconnected" }]);
            self._cleanSession(session);
          }
        };
        return pc.setRemoteDescription({ type: "offer", sdp: payload.s })
          .then(function () { return pc.createAnswer(); })
          .then(function (answer) { return pc.setLocalDescription(answer); })
          .then(function () { return finalizeSdp(pc, options.iceWaitMs); })
          .then(function (sdp) {
            var answerPayload = {
              v: 1,
              id: tempId,
              t: "a",
              n: payload.n,
              s: sdp,
              h: djb2(sdp).toString(16),
            };
            session.answerHash = answerPayload.h;
            return encodeCompact(answerPayload);
          })
          .then(function (code) {
            resolve({
              code: code,
              peerId: payload.id,
              expireAt: session.expireAt || Date.now() + timeoutMs,
              cancel: function () { self._cleanSession(session); },
            });
          })
          .catch(function (err) {
            self._cleanSession(session);
            reject(err);
          });
      }, reject).catch(reject);
    });
  };

  /**
   * Host side — consume the ANSWER_CODE to complete the handshake.
   * Resolves { connected: true, peerId, authCode } once the DataChannel opens.
   */
  DirectRTC.prototype.acceptDirectAnswer = function (answerCode) {
    var self = this;
    return new Promise(function (resolve, reject) {
      // Bind the pending offer SYNCHRONOUSLY: by the time the async code
      // decode finishes, a fast ICE may already have opened the channel
      // (which clears _offer as the one-shot guard).
      var session = self._offer;
      if (!session) return reject(new Error("NO_PENDING_OFFER"));
      decodeCompact(answerCode).then(function (payload) {
        if (payload.t !== "a") throw new Error("INVALID_ANSWER_CODE");
        if (session.nonce !== payload.n) throw new Error("INVALID_ANSWER_CODE");
        session.answerId = payload.id;
        session.answerHash = payload.h || djb2(payload.s).toString(16);
        if (session.expireAt && Date.now() > session.expireAt) throw new Error("OFFER_EXPIRED");
        return session.pc
          .setRemoteDescription({ type: "answer", sdp: payload.s })
          .then(function () { return waitOpen(session.channel, HANDSHAKE_TIMEOUT); })
          .then(function () {
            self._recomputeAuth(session); // covers the fast-open / slow-decode edge
            self._emitConnected(session);
            resolve({ connected: true, peerId: payload.id, authCode: session.authCode });
          })
          .catch(function (err) {
            self._emit("peer", [session.tempId, { status: "disconnected" }]);
            self._cleanSession(session);
            reject(err);
          });
      }, reject).catch(reject);
    });
  };

  /** Send a JSON message to a direct peer. data: string | object. Returns boolean. */
  DirectRTC.prototype.directSend = function (peerId, data) {
    var session = this._sessions[peerId];
    if (!session || !session.channel || session.channel.readyState !== "open") return false;
    // Always JSON-encode (strings too): the receiver parses every MSG frame.
    try {
      session.channel.send(encodeFrame(T.MSG, bytesFromText(JSON.stringify(data))));
      return true;
    } catch (e) {
      return false;
    }
  };

  /** Alias: send() for the on-message listener naming symmetry. */
  DirectRTC.prototype.send = DirectRTC.prototype.directSend;

  /**
   * Send a file over the direct channel. Adaptive 64KB–256KB chunks with
   * bufferedAmount backpressure (same strategy as the gun relay path).
   * Returns Promise<{name, size, to}>.
   */
  DirectRTC.prototype.directShareFile = function (file, peerId, opts) {
    var self = this;
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      var session = self._sessions[peerId];
      if (!session || !session.channel || session.channel.readyState !== "open") {
        return reject(new Error("peer not connected"));
      }
      var ch = session.channel;
      var fileId = (Math.random() * 0xffffffff) >>> 0;
      var fid = new Uint8Array(4);
      fid[0] = fileId & 0xff; fid[1] = (fileId >> 8) & 0xff; fid[2] = (fileId >> 16) & 0xff; fid[3] = (fileId >> 24) & 0xff;
      var meta = JSON.stringify({ id: fileId, name: file.name, size: file.size, mime: file.type || "application/octet-stream" });
      ch.send(encodeFrame(T.META, bytesFromText(meta)));
      var CHUNK_MIN = 64000, CHUNK_MAX = 262144;
      var offset = 0, chunkSize = CHUNK_MIN, quietRuns = 0, lastT = 0, sent = 0;
      var fileBuf = null;
      var readNext = function () {
        if (fileBuf) {
          sendChunk(fileBuf.slice(offset, Math.min(offset + chunkSize, fileBuf.byteLength)));
          return;
        }
        // Blob/File both expose arrayBuffer(); Node 18+ Blob as well.
        file.arrayBuffer().then(function (buf) {
          fileBuf = buf;
          sendChunk(buf.slice(offset, Math.min(offset + chunkSize, buf.byteLength)));
        }).catch(function () { reject(new Error("file read failed")); });
      };
      var sendChunk = function (buf) {
        if (self._destroyed || ch.readyState !== "open") { reject(new Error("channel closed")); return; }
        var part = new Uint8Array(4 + buf.byteLength);
        part.set(fid, 0);
        part.set(new Uint8Array(buf), 4);
        ch.send(encodeFrame(T.CHUNK, part));
        sent += buf.byteLength;
        var buffered = ch.bufferedAmount;
        if (buffered < 262144) {
          if (++quietRuns >= 8 && chunkSize < CHUNK_MAX) { chunkSize = Math.min(CHUNK_MAX, chunkSize * 2); quietRuns = 0; }
        } else if (buffered > 2097152) {
          chunkSize = Math.max(CHUNK_MIN, Math.floor(chunkSize / 2));
          quietRuns = 0;
        }
        offset += buf.byteLength;
        var done = offset >= fileBuf.byteLength;
        var now = Date.now();
        if (opts.onProgress && (done || now - lastT > 50)) {
          lastT = now;
          opts.onProgress({ direction: "out", to: peerId, name: file.name, sent: sent, total: fileBuf.byteLength, ts: now, done: done });
        }
        if (offset < fileBuf.byteLength) readNext();
        else {
          ch.send(encodeFrame(T.END, fid));
          resolve({ name: file.name, size: fileBuf.byteLength, to: peerId });
        }
      };
      readNext();
    });
  };

  /** Tear down every session and listener. */
  DirectRTC.prototype.destroy = function () {
    this._destroyed = true;
    if (this._offer) this._offer = null;
    for (var k in this._sessions) this._cleanSession(this._sessions[k]);
    this._listeners = Object.create(null);
  };

  return DirectRTC;
});