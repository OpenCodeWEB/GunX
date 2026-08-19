/**
 * tld_ui.js — .gunx + .absup domain registry UI (Phase 2).
 *
 * Wires the playground to the DomainRegistryDO via /api/domain/*:
 *   - SEA identity (generate / load / save pair in localStorage)
 *   - claim a name  (.gunx: PoW mine → SEA sign; .absup: root-only mint)
 *   - resolve with web3.bio owner profile enrichment
 *   - list / stats / touch (keep-alive) / gift (signed transfer)
 *   - ABsUP owner card (web3.bio universal profile)
 */
(function () {
  "use strict";

  var API = "/api/domain";
  var W3B = "/api/w3b";
  var ABS_WALLET = "0x9016a472c308A4e87bed705D066636Adf625D1B0";

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

  function currentTld() {
    var sel = document.querySelector('input[name="tldSel"]:checked');
    return sel ? sel.value : "gunx";
  }

  /** fetch web3.bio universal profile through our proxy. */
  async function w3bProfile(identity) {
    try {
      var res = await fetch(W3B + "/profile/" + encodeURIComponent(identity));
      if (!res.ok) return null;
      var data = await res.json();
      return Array.isArray(data) && data.length ? data : null;
    } catch (e) { return null; }
  }

  function pickBest(profiles) {
    if (!profiles) return null;
    var order = ["ens", "farcaster", "basenames", "lens", "ethereum"];
    for (var i = 0; i < order.length; i++) {
      var hit = profiles.find(function (p) { return p.platform === order[i]; });
      if (hit) return hit;
    }
    return profiles[0];
  }

  function profileCardHTML(p, fallbackAddress) {
    if (!p) return "";
    var avatar = p.avatar ? '<img src="' + esc(p.avatar) + '" class="w-8 h-8 rounded-full object-cover border border-slate-700" alt="">' : '<div class="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-xs">?</div>';
    var name = esc(p.displayName || p.identity || fallbackAddress || "");
    var ident = esc(p.identity || "");
    var tw = p.links && p.links.twitter && p.links.twitter.link ? '<a href="' + esc(p.links.twitter.link) + '" target="_blank" rel="noopener" class="text-teal-400 hover:underline">x</a>' : "";
    var gh = p.links && p.links.github && p.links.github.link ? '<a href="' + esc(p.links.github.link) + '" target="_blank" rel="noopener" class="text-teal-400 hover:underline">gh</a>' : "";
    var web = p.links && p.links.website && p.links.website.link ? '<a href="' + esc(p.links.website.link) + '" target="_blank" rel="noopener" class="text-teal-400 hover:underline">web</a>' : "";
    return avatar + '<div class="min-w-0"><div class="font-semibold text-slate-200 truncate">' + name + '</div>' +
      '<div class="text-[10px] text-slate-500 truncate">' + ident + " · " + p.platform + "</div>" +
      '<div class="flex gap-2 text-[10px] mt-0.5">' + web + gh + tw + "</div></div>";
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

    // ── TLD selector ─────────────────────────────────────────────
    document.querySelectorAll('input[name="tldSel"]').forEach(function (radio) {
      radio.addEventListener("change", function () {
        var tld = currentTld();
        $("tldSuffix").textContent = "." + tld;
        var hint = $("tldSelHint");
        if (tld === "absup") {
          hint.textContent = "ABsUP-owned — only the root key can mint; everyone else can receive gifted names";
          hint.className = "text-[11px] text-teal-400";
          $("tldClaimBtn").className = "bg-gradient-to-r from-teal-500 to-cyan-600 text-slate-950 font-semibold px-4 py-2 rounded-lg text-sm hover:opacity-90";
        } else {
          hint.textContent = "";
          hint.className = "text-[11px] text-slate-500";
          $("tldClaimBtn").className = "bg-gradient-to-r from-amber-500 to-orange-600 text-slate-950 font-semibold px-4 py-2 rounded-lg text-sm hover:opacity-90";
        }
      });
    });

    // ── claim ────────────────────────────────────────────────────
    $("tldClaimBtn").addEventListener("click", async function () {
      var tld = currentTld();
      var name = $("tldNameInput").value.trim().toLowerCase();
      var target = $("tldTargetInput").value.trim() || "gunx.pages.dev";
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
        log("tldLog", "invalid name — letters, digits, dashes only (a-z0-9, start with alnum)", false);
        return;
      }
      if (!pair) { log("tldLog", "generate an identity first", false); return; }
      $("tldClaimBtn").disabled = true;
      try {
        var claim = { tld: tld, name: name, ownerPub: pair.pub, target: target, ts: Date.now() };
        if (tld === "absup") {
          claim.nonce = 0; claim.diff = 0; claim.hash = "";
          log("tldLog", "signing .absup mint (root-key only — will be rejected for non-root keys)…");
        } else {
          var diff = window.GunXPoW ? window.GunXPoW.getDifficulty(name) : (name.length <= 3 ? 6 : name.length <= 7 ? 4 : 2);
          log("tldLog", "mining PoW diff " + diff + (diff >= 4 ? " (short premium names need more work — this can take a moment)" : "") + "…");
          var mine = await window.GunXPoW.mine(name, pair.pub, target, claim.ts, diff);
          claim.nonce = mine.nonce; claim.diff = diff; claim.hash = mine.hash;
        }
        claim.sig = await SEA.sign(claim, { pub: pair.pub, priv: pair.priv });
        var res = await fetch(API + "/claim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(claim),
        });
        var data = await res.json();
        if (res.status === 201 && data.ok) {
          log("tldLog", "claimed " + name + "." + tld + " → " + data.record.tier + " [" + data.record.status + "]", true);
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

    // ── resolve + web3.bio enrichment ────────────────────────────
    $("tldResolveBtn").addEventListener("click", async function () {
      var name = $("tldResolveInput").value.trim().toLowerCase();
      if (!name) return;
      try {
        var res = await fetch(API + "/resolve?name=" + encodeURIComponent(name));
        var data = await res.json();
        var card = $("tldResolveCard");
        if (data.ok && data.record) {
          var r = data.record;
          var tld = r.tld || "gunx";
          card.classList.remove("hidden");
          card.innerHTML =
            '<div class="flex items-center justify-between gap-2 flex-wrap"><span class="text-teal-300 font-semibold">' + esc(name) + "." + tld + "</span>" +
            '<span class="text-slate-500">' + r.tier + " [" + r.status + "] · uses " + ((r.resolves || 0) + (r.touches || 0)) + "</span></div>" +
            '<div class="text-slate-400 truncate mt-1">target: ' + esc(r.target) + "</div>" +
            '<div class="text-slate-500 truncate">owner: <span class="mono">' + esc(r.ownerPub.slice(0, 20)) + "…</span> · 33% royalty → " + esc((r.beneficiary || "ABsUP").slice(0, 12)) + "…</div>" +
            '<div id="tldResolveProfile" class="flex items-center gap-2 mt-2"></div>';
          log("tldLog", name + "." + (r.tld || "gunx") + " → owner " + r.ownerPub.slice(0, 16) + "… · target " + r.target +
            " · " + r.tier + " [" + r.status + "] · last active " + new Date(r.lastActiveAt).toLocaleString(), true);
          // web3.bio profile of the owner (if the pubkey maps to an EVM wallet)
          var prof = await w3bProfile(r.ownerPub);
          var el = $("tldResolveProfile");
          if (prof) {
            var best = pickBest(prof);
            if (best) el.innerHTML = '<span class="text-[10px] text-slate-500">web3:</span> ' + profileCardHTML(best, r.ownerPub);
          } else {
            el.innerHTML = '<span class="text-[10px] text-slate-600">no web3.bio profile for this key</span>';
          }
        } else {
          card.classList.remove("hidden");
          card.innerHTML = '<span class="text-slate-500">' + esc(name) + " — not claimed yet, it is free!</span>";
          log("tldLog", name + ": not claimed yet — it is free!", false);
        }
      } catch (e) {
        log("tldLog", "resolve error: " + e.message, false);
      }
    });

    // ── ABsUP owner card (web3.bio) ──────────────────────────────
    (function loadOwnerCard() {
      var card = $("tldOwnerCard");
      if (!card) return;
      w3bProfile(ABS_WALLET).then(function (prof) {
        if (!prof || !prof.length) return;
        card.classList.remove("hidden");
        card.innerHTML = profileCardHTML(pickBest(prof), ABS_WALLET) +
          '<a href="https://web3.bio/' + ABS_WALLET + '" target="_blank" rel="noopener" class="ml-auto text-[10px] text-teal-400 hover:underline shrink-0">web3.bio ↗</a>';
      });
    })();

    // ── my domains + touch + gift ────────────────────────────────
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
            '<div><span class="text-teal-300 font-semibold">' + esc(r.name) + "." + esc(r.tld || "gunx") + "</span>" +
            '<span class="text-slate-500"> → ' + esc(r.target) + " · " + r.tier + " · " + r.status + "</span></div>" +
            '<div class="flex gap-1 shrink-0">' +
            '<button class="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300" data-touch="' + esc(r.name) + '" data-tld="' + esc(r.tld || "gunx") + '">touch</button>' +
            '<button class="px-2 py-1 rounded bg-teal-800/60 hover:bg-teal-700/60 text-teal-200" data-gift="' + esc(r.name) + '" data-tld="' + esc(r.tld || "gunx") + '">gift</button>' +
            "</div>";
          box.appendChild(row);
        });
        box.querySelectorAll("[data-touch]").forEach(function (btn) {
          btn.addEventListener("click", function () { touch(btn.getAttribute("data-touch"), btn.getAttribute("data-tld")); });
        });
        box.querySelectorAll("[data-gift]").forEach(function (btn) {
          btn.addEventListener("click", function () { gift(btn.getAttribute("data-gift"), btn.getAttribute("data-tld")); });
        });
      } catch (e) {
        box.innerHTML = '<p class="text-xs text-red-400">list error: ' + esc(e.message) + "</p>";
      }
    }

    async function touch(name, tld) {
      if (!pair) return;
      var body = { tld: tld || "gunx", name: name, ownerPub: pair.pub, ts: Date.now() };
      body.sig = await SEA.sign(body, { pub: pair.pub, priv: pair.priv });
      var res = await fetch(API + "/touch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      var data = await res.json();
      log("tldLog", data.ok ? "kept " + name + "." + (tld || "gunx") + " alive (90-day window reset)" : "touch failed: " + (data.error || res.status), !!data.ok);
      loadMine();
    }

    async function gift(name, tld) {
      if (!pair) return;
      var newOwner = prompt("Gift " + name + "." + (tld || "gunx") + " to (SEA pubkey):");
      if (!newOwner || !newOwner.trim()) return;
      newOwner = newOwner.trim();
      if (!confirm("Transfer ownership of " + name + "." + (tld || "gunx") + " to " + newOwner.slice(0, 16) + "… ? The gift is permanent and signed by your key.")) return;
      try {
        var giftRec = { name: name, tld: tld || "gunx", newOwnerPub: newOwner };
        giftRec.sig = await SEA.sign(giftRec, { pub: pair.pub, priv: pair.priv });
        var res = await fetch(API + "/transfer", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: name, tld: tld || "gunx", ownerPub: pair.pub, newOwnerPub: newOwner, sig: giftRec.sig }),
        });
        var data = await res.json();
        if (data.ok) {
          log("tldLog", "gifted " + name + "." + (tld || "gunx") + " → " + newOwner.slice(0, 16) + "…", true);
        } else {
          log("tldLog", "gift failed: " + (data.error || res.status), false);
        }
        loadMine();
      } catch (e) {
        log("tldLog", "gift error: " + e.message, false);
      }
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
        setText("tldStatPolicy", "3 free / key · Price(N)=1×2^(N−3) · expire 90d · royalty " + (p.royaltyBps || 0) + "bps → ABsUP · admins " + (p.rootAdmins || 0));
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