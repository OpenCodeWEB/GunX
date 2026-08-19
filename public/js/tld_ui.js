/**
 * tld_ui.js — .gunx domain registry UI (Phase 1).
 *
 * Wires the playground to the DomainRegistryDO via /api/domain/*:
 *   - SEA identity (generate / load / save pair in localStorage)
 *   - claim a name  (PoW mine → SEA sign → POST /api/domain/claim)
 *   - resolve / list / stats / touch (keep-alive)
 */
(function () {
  "use strict";

  var API = "/api/domain";

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s).replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/&/g, "&amp;");
  }

  function setText(id, txt) {
    var el = $(id);
    if (el) el.textContent = txt;
  }

  function log(id, txt, ok) {
    var el = $(id);
    if (!el) return;
    var line = document.createElement("div");
    line.className = "text-xs mono " + (ok === false ? "text-red-400" : ok ? "text-teal-300" : "text-slate-400");
    line.textContent = txt;
    el.prepend(line);
    while (el.children.length > 40) el.removeChild(el.lastChild);
  }

  function initTldUI(gunx) {
    var pair = null;

    function refreshIdentity() {
      var pubEl = $("tldPub");
      if (!pair) {
        pubEl.innerHTML = '<span class="text-slate-500">no identity — generate one</span>';
        $("tldNewKeyBtn").classList.remove("hidden");
        $("tldClearKeyBtn").classList.add("hidden");
        $("tldClaimBtn").disabled = true;
        return;
      }
      pubEl.innerHTML = '<span class="text-teal-300 break-all">' + esc(pair.pub) + "</span>";
      $("tldNewKeyBtn").classList.add("hidden");
      $("tldClearKeyBtn").classList.remove("hidden");
      $("tldClaimBtn").disabled = false;
    }

    // ── identity ─────────────────────────────────────────────────
    $("tldNewKeyBtn").addEventListener("click", async function () {
      if (!confirm("Generate a new identity key? Your current one will be replaced (existing domains stay with the old key).")) return;
      pair = await SEA.pair();
      gunx.sea.savePair(pair, "gunx_tld_pair");
      refreshIdentity();
      log("tldLog", "identity generated — your pubkey is your .gunx owner id", true);
    });

    $("tldClearKeyBtn").addEventListener("click", function () {
      localStorage.removeItem("gunx_tld_pair");
      pair = null;
      refreshIdentity();
      log("tldLog", "local identity cleared");
    });

    // ── claim ────────────────────────────────────────────────────
    $("tldClaimBtn").addEventListener("click", async function () {
      var name = $("tldNameInput").value.trim().toLowerCase();
      var target = $("tldTargetInput").value.trim() || "gunx.pages.dev";
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
        log("tldLog", "invalid name — letters, digits, dashes only (a-z0-9, start with alnum)", false);
        return;
      }
      if (!pair) { log("tldLog", "generate an identity first", false); return; }
      var diff = window.GunXPoW ? window.GunXPoW.getDifficulty(name) : (name.length <= 3 ? 6 : name.length <= 7 ? 4 : 2);
      var warn = diff >= 4 ? " (short premium names need more work — this can take a moment)" : "";
      log("tldLog", "mining PoW diff " + diff + warn + "…");
      $("tldClaimBtn").disabled = true;
      try {
        var ts = Date.now();
        var mine = await window.GunXPoW.mine(name, pair.pub, target, ts, diff);
        var claim = {
          name: name,
          ownerPub: pair.pub,
          target: target,
          ts: ts,
          nonce: mine.nonce,
          diff: mine.diff,
          hash: mine.hash,
        };
        claim.sig = await SEA.sign(claim, { pub: pair.pub, priv: pair.priv });
        var res = await fetch(API + "/claim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(claim),
        });
        var data = await res.json();
        if (res.status === 201 && data.ok) {
          log("tldLog", "claimed " + name + ".gunx → " + data.record.tier + " [" + data.record.status + "]", true);
          loadStats();
          loadMine();
        } else {
          log("tldLog", "claim failed: " + (data.error || res.status), false);
        }
      } catch (e) {
        log("tldLog", "claim error: " + e.message, false);
      }
      $("tldClaimBtn").disabled = false;
    });

    function mineTs(mine, ts) { return ts; } // kept for callers that pass one

    // ── resolve ──────────────────────────────────────────────────
    $("tldResolveBtn").addEventListener("click", async function () {
      var name = $("tldResolveInput").value.trim().toLowerCase();
      if (!name) return;
      try {
        var res = await fetch(API + "/resolve?name=" + encodeURIComponent(name));
        var data = await res.json();
        if (data.ok && data.record) {
          var r = data.record;
          log("tldLog", name + ".gunx → owner " + r.ownerPub.slice(0, 16) + "… · target " + r.target +
            " · " + r.tier + " [" + r.status + "] · last active " + new Date(r.lastActiveAt).toLocaleString(), true);
        } else {
          log("tldLog", name + ".gunx: not claimed yet — it is free!", false);
        }
      } catch (e) {
        log("tldLog", "resolve error: " + e.message, false);
      }
    });

    // ── my domains + touch ───────────────────────────────────────
    $("tldRefreshBtn").addEventListener("click", loadMine);

    async function loadMine() {
      var box = $("tldMine");
      if (!pair) { box.innerHTML = '<p class="text-xs text-slate-500">generate an identity to see your domains</p>'; return; }
      try {
        var res = await fetch(API + "/list?owner=" + encodeURIComponent(pair.pub));
        var data = await res.json();
        var list = (data.ok && data.domains) || [];
        if (!list.length) {
          box.innerHTML = '<p class="text-xs text-slate-500">no domains claimed yet</p>';
          return;
        }
        box.innerHTML = "";
        list.forEach(function (r) {
          var row = document.createElement("div");
          row.className = "flex items-center justify-between gap-2 text-xs mono bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2";
          row.innerHTML =
            '<div><span class="text-teal-300 font-semibold">' + esc(r.name) + "</span>" +
            '<span class="text-slate-500"> → ' + esc(r.target) + " · " + r.tier + " · " + r.status + "</span></div>" +
            '<button class="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300" data-touch="' + esc(r.name) + '">touch</button>';
          box.appendChild(row);
        });
        box.querySelectorAll("[data-touch]").forEach(function (btn) {
          btn.addEventListener("click", function () { touch(btn.getAttribute("data-touch")); });
        });
      } catch (e) {
        box.innerHTML = '<p class="text-xs text-red-400">list error: ' + esc(e.message) + "</p>";
      }
    }

    async function touch(name) {
      if (!pair) return;
      var body = { name: name, ownerPub: pair.pub, target: "", ts: Date.now(), nonce: 0, diff: window.GunXPoW ? window.GunXPoW.getDifficulty(name) : 2, hash: "" };
      body.sig = await SEA.sign(body, { pub: pair.pub, priv: pair.priv });
      var res = await fetch(API + "/touch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      var data = await res.json();
      log("tldLog", data.ok ? "kept " + name + ".gunx alive (90-day window reset)" : "touch failed: " + (data.error || res.status), !!data.ok);
      loadMine();
    }

    // ── stats ────────────────────────────────────────────────────
    async function loadStats() {
      try {
        var res = await fetch(API + "/stats");
        var data = await res.json();
        if (!data.ok) return;
        var s = data.stats || {};
        var p = data.policy || {};
        setText("tldStatTotal", s.totalDomains + " domains");
        setText("tldStatFree", "free " + (s.free || 0) + " · premium " + (s.premium || 0));
        setText("tldStatPending", "pending " + (s.pending || 0) + " · expired " + (s.expired || 0));
        setText("tldStatPolicy", "3 free / key · Price(N)=1×2^(N−3) · expire 90d · admins " + (p.rootAdmins || 0));
      } catch (e) { /* stats are best-effort */ }
    }

    // init
    pair = gunx.sea.loadPair("gunx_tld_pair") || null;
    refreshIdentity();
    loadStats();
    loadMine();
    setInterval(loadStats, 15000);
  }

  window.initTldUI = initTldUI;
})();