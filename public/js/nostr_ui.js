/**
 * nostr_ui.js — GunX Phase 2: Nostr Mesh panel UI (browser).
 *
 * Module script: imports @noble/curves from CDN to power the NIP-01
 * signer (the codec itself is dependency-free UMD). Wire-up:
 *
 *   <script src="/js/nostr_codec.js"></script>
 *   <script src="/js/nostr_bridge.js"></script>
 *   <script type="module" src="/js/nostr_ui.js"></script>
 *
 * The UI exposes: relay URL input, connect/disconnect toggle, live
 * status pill (connected / reconnecting / disconnected), sent/received
 * counters, and a small activity log of verified incoming DAGs.
 *
 * (c) ABsUP / OpenCodeWEB. MIT License.
 */
import { secp256k1, schnorr } from "https://cdn.jsdelivr.net/npm/@noble/curves@2.3.0/secp256k1.js/+esm";
import { sha256 } from "https://cdn.jsdelivr.net/npm/@noble/hashes@2.3.0/sha2.js/+esm";

(function () {
  "use strict";

  if (!window.GunXNostrCodec || !window.GunXNostrBridge) {
    console.error("Nostr UI: load /js/nostr_codec.js and /js/nostr_bridge.js first");
    return;
  }

  /* Power the codec with noble (same path as the Node test suite). */
  var toHex = function (b) {
    var s = "";
    for (var i = 0; i < b.length; i++) s += ("0" + b[i].toString(16)).slice(-2);
    return s;
  };
  var fromHex = function (h) {
    var out = new Uint8Array(h.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return out;
  };
  window.GunXNostrCodec.setSigner({
    randomSecKey: function () { return toHex(secp256k1.utils.randomSecretKey()); },
    pubkeyOf: function (s) { return toHex(schnorr.getPublicKey(fromHex(s))); },
    hashEvent: function (ser) { return toHex(sha256(new TextEncoder().encode(ser))); },
    sign: function (idHex, secHex) { return toHex(schnorr.sign(fromHex(idHex), fromHex(secHex))); },
    verify: function (idHex, sigHex, pubHex) { return schnorr.verify(fromHex(sigHex), fromHex(idHex), fromHex(pubHex)); },
  });

  function initNostrUI(gunx) {
    if (initNostrUI._done) return;
    initNostrUI._done = true;
    gunx = gunx || window.gunx;
    if (!gunx) {
      console.error("Nostr UI: no gunx instance — call initNostrUI(gunx) or expose window.gunx");
      return;
    }
    var $ = function (id) { return document.getElementById(id); };
    var urlInput = $("nostrUrlInput");
    var toggle = $("nostrToggleBtn");
    var pill = $("nostrStatusPill");
    var statSent = $("nostrStatSent");
    var statRecv = $("nostrStatRecv");
    var statKey = $("nostrStatKey");
    var logBox = $("nostrLog");

    var connected = false;
    var lastConnectedRelay = null;

    function setPill(state, detail) {
      var dot =
        state === "connected" ? "text-emerald-400" :
        state === "reconnecting" ? "text-amber-400" :
        "text-slate-500";
      var label =
        state === "connected" ? "connected" :
        state === "reconnecting" ? "reconnecting" :
        "disconnected";
      pill.innerHTML = '<i class="fa-solid fa-circle ' + dot + '"></i> ' + label;
      if (detail) pill.title = detail;
    }

    function logLine(text, cls) {
      var div = document.createElement("div");
      div.className = "msg-in text-[11px] mono break-words " + (cls || "text-slate-400");
      div.textContent = text;
      logBox.appendChild(div);
      while (logBox.childNodes.length > 40) logBox.removeChild(logBox.firstChild);
      logBox.scrollTop = logBox.scrollHeight;
    }

    function renderStats() {
      var s = gunx.nostrStatus;
      statSent.textContent = "sent " + s.eventsSent;
      statRecv.textContent = "recv " + s.eventsReceived;
    }

    toggle.addEventListener("click", function () {
      if (connected) {
        gunx.destroyNostr();
        connected = false;
        lastConnectedRelay = null;
        toggle.innerHTML = '<i class="fa-solid fa-link mr-1"></i> Connect to relay';
        toggle.className = "w-full bg-violet-600 hover:bg-violet-500 text-white font-semibold px-4 py-2.5 rounded-lg text-sm";
        setPill("disconnected");
        renderStats();
        logLine("bridge disconnected");
        return;
      }
      var url = (urlInput.value || "").trim();
      if (!/^wss?:\/\//.test(url)) {
        logLine("invalid relay URL — expected wss://…", "text-red-400");
        return;
      }
      var bridge = gunx.connectNostrRelay(url, { heartbeatMs: 300000 });
      if (!bridge) {
        logLine("bridge unavailable — check console", "text-red-400");
        return;
      }
      connected = true;
      toggle.innerHTML = '<i class="fa-solid fa-unlink mr-1"></i> Disconnect';
      toggle.className = "w-full bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold px-4 py-2.5 rounded-lg text-sm border border-slate-700";
      logLine("connecting to " + url + " …");
    });

    gunx.onNostrStatus(function (s) {
      setPill(
        s.connected ? "connected" : "reconnecting",
        s.relayUrl + (s.lastError ? " — " + s.lastError : "")
      );
      /* keep the toggle in sync even when the bridge dies/tears down
         outside the UI (reconnect loop, destroyNostr() from code) */
      var wantConnected = s.connected;
      if (wantConnected !== connected) {
        connected = wantConnected;
        toggle.innerHTML = connected
          ? '<i class="fa-solid fa-unlink mr-1"></i> Disconnect'
          : '<i class="fa-solid fa-link mr-1"></i> Connect to relay';
        toggle.className = connected
          ? "w-full bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold px-4 py-2.5 rounded-lg text-sm border border-slate-700"
          : "w-full bg-violet-600 hover:bg-violet-500 text-white font-semibold px-4 py-2.5 rounded-lg text-sm";
      }
      renderStats();
      if (s.connected && s.relayUrl && s.relayUrl !== lastConnectedRelay) {
        lastConnectedRelay = s.relayUrl;
        logLine("relay connected: " + s.relayUrl);
        if (gunx._nostr) statKey.textContent = "key " + gunx._nostr.pubkey.slice(0, 10) + "…";
      }
    });

    gunx.onNostrDag(function (d) {
      var soul = d.soul || "?";
      var pub = d.pubkey ? d.pubkey.slice(0, 8) + "…" : "?";
      var t = new Date(d.created_at * 1000).toLocaleTimeString();
      logLine("DAG " + soul + " ← " + pub + " @ " + t, "text-violet-300");
      renderStats();
    });

    /* key fingerprint — this tab's ephemeral Nostr identity (appears once connected) */
    statKey.textContent = "key …";
    statKey.title = "This tab generates an ephemeral Nostr identity for signing — your gun data stays SEA-encrypted in the event content.";
  }

  window.initNostrUI = initNostrUI;

  /* Module scripts are deferred: the inline main script may have already
     run (and set window.gunx). Init whenever the DOM is ready. */
  if (document.readyState !== "loading") {
    initNostrUI(window.gunx);
  } else {
    document.addEventListener("DOMContentLoaded", function () {
      initNostrUI(window.gunx);
    });
  }
})();