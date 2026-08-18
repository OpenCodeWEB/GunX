/**
 * direct_ui.js — GunX "Direct Pair" panel: zero-server WebRTC pairing.
 *
 * Two flows (open this page on two devices, or two tabs):
 *   HOST: "Generate offer code"  → QR + code appears
 *         paste the JOINER's answer code → "Accept & connect"
 *   JOIN: paste the HOST's offer code → "Connect"
 *         the ANSWER code + QR appear → paste back into the host
 *
 * After the DataChannel opens both screens show the SAME 6-digit SAS
 * verification code ("384-912") — if they differ, someone tampered or a
 * code was mis-copied: disconnect.
 *
 * Messages + files flow over the direct channel only — zero relay, works
 * fully offline. (c) ABsUP / OpenCodeWEB. MIT.
 */
(function (root) {
  "use strict";

  var QR_LIB = (typeof root.qrcode === "function") || (typeof root.QRCode === "function"); // qrcode-generator | node-qrcode

  function initDirectUI(gunx, opts) {
    opts = opts || {};
    var $ = function (id) { return document.getElementById(id); };
    var els = {
      createBtn: $("directCreateBtn"),
      createBox: $("directCreateBox"),
      offerQr: $("directOfferQr"),
      offerCode: $("directOfferCode"),
      offerCopy: $("directOfferCopy"),
      offerStatus: $("directOfferStatus"),
      hostAnswerBox: $("directHostAnswerBox"),
      answerInput: $("directAnswerInput"),
      acceptBtn: $("directAcceptBtn"),
      hostSas: $("directHostSas"),
      joinBox: $("directJoinBox"),
      offerInput: $("directOfferInput"),
      connectBtn: $("directConnectBtn"),
      answerQr: $("directAnswerQr"),
      answerCode: $("directAnswerCode"),
      answerCopy: $("directAnswerCopy"),
      joinStatus: $("directJoinStatus"),
      joinSas: $("directJoinSas"),
      session: $("directSession"),
      sasBanner: $("directSas"),
      sasPeer: $("directSasPeer"),
      msgInput: $("directMsgInput"),
      msgSend: $("directMsgSend"),
      fileInput: $("directFileInput"),
      fileSend: $("directFileSend"),
      log: $("directLog"),
    };

    if (!gunx || !gunx.direct) {
      log("DirectRTC module not loaded — include /js/direct_rtc.js before /js/direct_ui.js", "text-red-400");
      return;
    }

    var peerId = null;
    var offer = null;   // { code, peerId, expireAt, cancel }
    var answer = null;  // { code, peerId, expireAt, cancel }

    function showQR(canvas, text) {
      if (!canvas) return;
      try {
        // qrcode-generator (local vendor lib): qrcode(typeNumber, level)
        if (typeof root.qrcode === "function") {
          var qr = root.qrcode(0, "M"); // 0 = auto size
          qr.addData(text);
          qr.make();
          var img = new Image();
          img.onload = function () {
            var ctx = canvas.getContext("2d");
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          };
          img.src = qr.createDataURL(4, 8); // cellSize px, margin px
          canvas.hidden = false;
          return;
        }
        // node-qrcode (CDN builds): QRCode.toCanvas(canvas, text, opts)
        if (typeof root.QRCode === "function" && root.QRCode.toCanvas) {
          root.QRCode.toCanvas(canvas, text, { width: 180, margin: 1, errorCorrectionLevel: "M" }, function (err) {
            if (err) console.warn("QR render failed:", err);
          });
          canvas.hidden = false;
          return;
        }
        console.warn("no QR library loaded");
      } catch (e) {
        console.warn("QR render failed:", e);
      }
    }

    function hideQR(canvas) {
      if (canvas) canvas.hidden = true;
    }

    function copyText(btn, text) {
      var done = function () {
        var old = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-check text-emerald-400"></i>';
        setTimeout(function () { btn.innerHTML = old; }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
      } else {
        fallbackCopy(text);
        done();
      }
    }

    function fallbackCopy(text) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch (e) { /* noop */ }
      document.body.removeChild(ta);
    }

    function log(text, cls) {
      if (!els.log) return;
      var div = document.createElement("div");
      div.className = "msg-in text-xs mono " + (cls || "text-slate-400");
      div.innerHTML = text;
      els.log.appendChild(div);
      els.log.scrollTop = els.log.scrollHeight;
    }

    function fmt(n) {
      return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);
    }

    function showSession(authCode) {
      els.session.hidden = false;
      els.sasBanner.textContent = authCode || "—";
      if (authCode) els.sasBanner.classList.add("glow");
      // SAS is computed identically on both peers — show the peer marker too
      els.sasPeer.textContent = peerId ? "peer " + peerId : "";
      els.log.innerHTML = "";
      log("channel open · SAS " + (authCode || "—") + " — verify both screens match", "text-teal-300");
      els.msgInput.focus();
    }

    /* ── peer lifecycle ─────────────────────────────────────────── */

    gunx.onDirectPeer(function (id, st) {
      if (st.status === "connected") {
        peerId = id;
        showSession(st.authCode);
      } else if (st.status === "disconnected") {
        log("peer disconnected", "text-amber-400");
        peerId = null;
        els.session.hidden = true;
      } else if (st.status === "expired") {
        log("pairing code expired — generate a new one", "text-amber-400");
        els.createBtn.disabled = false;
        els.offerStatus.textContent = "";
        hideQR(els.offerQr);
      }
    });

    /* ── HOST flow ──────────────────────────────────────────────── */

    els.createBtn.addEventListener("click", function () {
      els.createBtn.disabled = true;
      els.offerStatus.textContent = "generating…";
      gunx.createDirectCode({ timeoutMs: opts.timeoutMs || 60000 }).then(function (r) {
        offer = r;
        els.offerCode.value = r.code;
        els.createBox.hidden = false;
        els.offerStatus.textContent = "offer valid until " + new Date(r.expireAt).toLocaleTimeString() +
          " — share this code (or QR) with the other device";
        showQR(els.offerQr, r.code);
        els.hostAnswerBox.hidden = false;
        els.answerInput.focus();
      }).catch(function (err) {
        els.createBtn.disabled = false;
        els.offerStatus.textContent = err.message === "RTC_NOT_SUPPORTED"
          ? "WebRTC not supported in this browser"
          : "failed: " + err.message;
      });
    });

    els.offerCopy.addEventListener("click", function () {
      if (offer) copyText(els.offerCopy, offer.code);
    });

    els.acceptBtn.addEventListener("click", function () {
      var code = els.answerInput.value.trim();
      if (!code) return;
      els.acceptBtn.disabled = true;
      gunx.acceptDirectAnswer(code).then(function (res) {
        els.acceptBtn.disabled = false;
        els.offerStatus.textContent = "connected — verify SAS: " + res.authCode;
        els.hostAnswerBox.hidden = true;
      }).catch(function (err) {
        els.acceptBtn.disabled = false;
        els.offerStatus.textContent = "accept failed: " + err.message;
      });
    });

    /* ── JOIN flow ──────────────────────────────────────────────── */

    els.connectBtn.addEventListener("click", function () {
      var code = els.offerInput.value.trim();
      if (!code) return;
      els.connectBtn.disabled = true;
      els.joinStatus.textContent = "connecting…";
      gunx.connectDirect(code, { timeoutMs: opts.timeoutMs || 60000 }).then(function (r) {
        answer = r;
        els.answerCode.value = r.code;
        els.joinBox.hidden = false;
        els.joinStatus.textContent = "answer valid until " + new Date(r.expireAt).toLocaleTimeString() +
          " — send this back to the host (or show the QR)";
        showQR(els.answerQr, r.code);
        els.connectBtn.disabled = false;
      }).catch(function (err) {
        els.connectBtn.disabled = false;
        els.joinStatus.textContent = err.message === "RTC_NOT_SUPPORTED"
          ? "WebRTC not supported in this browser"
          : "failed: " + err.message;
      });
    });

    els.answerCopy.addEventListener("click", function () {
      if (answer) copyText(els.answerCopy, answer.code);
    });

    /* ── messaging over the direct channel ──────────────────────── */

    function sendMsg() {
      var t = els.msgInput.value.trim();
      if (!t || !peerId) return;
      if (gunx.directSend(peerId, { t: t, at: Date.now() })) {
        log('<span class="text-teal-300">→</span> ' + String(t).replace(/</g, "&lt;"), "text-slate-300");
        els.msgInput.value = "";
      } else {
        log("send failed — channel closed", "text-red-400");
      }
    }
    els.msgSend.addEventListener("click", sendMsg);
    els.msgInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") sendMsg();
    });

    gunx.onDirectMessage(function (id, msg) {
      if (msg && typeof msg.t === "string") {
        log('<span class="text-cyan-300">←</span> ' + String(msg.t).replace(/</g, "&lt;"), "text-slate-300");
      }
    });

    /* ── files over the direct channel ──────────────────────────── */

    els.fileSend.addEventListener("click", function () {
      els.fileInput.click();
    });
    els.fileInput.addEventListener("change", function () {
      var file = this.files[0];
      this.value = "";
      if (!file || !peerId) return;
      log("sending " + String(file.name).replace(/</g, "&lt;") + " (" + fmt(file.size) + "B)…", "text-teal-300");
      gunx.directShareFile(file, peerId, {
        onProgress: function (p) {
          if (p.done) log("sent " + String(p.name).replace(/</g, "&lt;") + " (" + fmt(p.sent) + "B)", "text-teal-300");
        },
      }).catch(function (err) {
        log("file send failed: " + err.message, "text-red-400");
      });
    });

    gunx.onDirectFile(function (f) {
      log("received " + String(f.name).replace(/</g, "&lt;") + " (" + fmt(f.size) + "B)", "text-cyan-300");
      var a = document.createElement("a");
      a.href = URL.createObjectURL(f.blob);
      a.download = f.name;
      a.className = "mt-1 inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-xs hover:border-teal-500/50 transition-colors";
      a.innerHTML = '<i class="fa-solid fa-download text-teal-400"></i> Save ' +
        String(f.name).replace(/</g, "&lt;") + ' <span class="text-slate-500 mono">(' + fmt(f.size) + "B)</span>";
      els.log.appendChild(a);
    });

    /* ── cleanup on unload ──────────────────────────────────────── */

    window.addEventListener("pagehide", function () {
      if (offer && offer.cancel) offer.cancel();
      if (answer && answer.cancel) answer.cancel();
      if (gunx.direct) gunx.direct.destroy();
    });
  }

  root.initDirectUI = initDirectUI;
})(typeof self !== "undefined" ? self : globalThis);