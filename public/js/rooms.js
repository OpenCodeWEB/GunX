/**
 * rooms.js — GunX Phase 3: E2E-encrypted chat rooms.
 *
 * Two room kinds share one chat UI:
 *
 *   PUBLIC — the open demo room (gunx-playground/chat). Messages are sealed
 *            with the open-source demo key before they touch the relay, so
 *            the relay/DO storage only ever sees ciphertext. (The key is
 *            public by design — this is a demo room; see private below.)
 *
 *   PRIVATE — E2E rooms. A random room key is generated client-side and
 *            carried in the invite link hash:  #r=<roomId>&k=<roomKey>
 *            Only people holding the key can decrypt anything. Without it,
 *            messages render as a locked placeholder.
 *
 * The relay server NEVER sees a room key. Even the service owner cannot
 * decrypt private room data — the key lives only in the invite link and in
 * the browsers of the people who joined with it.
 */
(function () {
  "use strict";
  var u;
  var root = typeof self !== "undefined" ? self : globalThis;

  /** Open-source demo key for the PUBLIC playground room. */
  var PUBLIC_ROOM_KEY = "gunx-public-2026";
  var PUBLIC_ROOM_ID = "gunx-playground/chat";

  function hasHash() {
    return typeof location !== "undefined" && !!location.hash;
  }

  function b64decode(s) {
    try {
      return atob(String(s).replace(/-/g, "+").replace(/_/g, "/"));
    } catch (e) {
      return null;
    }
  }

  function b64encode(s) {
    return btoa(String(s)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  /** Parse the invite hash: #r=<roomId>&k=<roomKey> */
  function parseHash() {
    if (!hasHash()) return null;
    var h = location.hash.replace(/^#/, "");
    if (!h) return null;
    var r = null;
    var k = null;
    var parts = h.split("&");
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split("=");
      if (kv.length !== 2) continue;
      if (kv[0] === "r") r = decodeURIComponent(kv[1]);
      if (kv[0] === "k") k = decodeURIComponent(kv[1]);
    }
    if (!r || !k) return null;
    return { roomId: r, key: b64decode(k) };
  }

  function GunXRooms() {
    if (!(this instanceof GunXRooms)) return new GunXRooms();
    var invite = parseHash();
    if (invite) {
      this.roomId = invite.roomId;
      this.roomKey = invite.key;
      this.private = true;
      this.name = "private/" + invite.roomId;
    } else {
      this.roomId = PUBLIC_ROOM_ID;
      this.roomKey = PUBLIC_ROOM_KEY;
      this.private = false;
      this.name = "public";
    }
  }

  /** Create a brand-new private room; returns { roomId, key, url }. */
  GunXRooms.prototype.createPrivate = async function (sea) {
    var key = await sea.genRoomKey();
    var roomId = "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    var url = location.origin + location.pathname + "#r=" + encodeURIComponent(roomId) + "&k=" + encodeURIComponent(b64encode(key));
    return { roomId: roomId, key: key, url: url };
  };

  /** Copy the invite link to the clipboard (falls back to prompt). */
  GunXRooms.prototype.copyInvite = function (url) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(
        function () { return true; },
        function () {
          prompt("Copy this private room invite link — anyone with it can read the room:", url);
        }
      );
    } else {
      prompt("Copy this private room invite link — anyone with it can read the room:", url);
    }
  };

  /**
   * Seal + put a chat message into the current room.
   * Returns the put promise (message is only stored as ciphertext).
   */
  GunXRooms.prototype.send = function (gunx, text) {
    var self = this;
    var soul = self.private ? "room/" + self.roomId + "/" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
      : "chat/" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    var obj = { t: text, from: "local", ts: Date.now() };
    return gunx.sea.seal(obj, self.roomKey).then(function (sealed) {
      return gunx.put(soul, sealed);
    });
  };

  /**
   * Decrypt a received message node. Returns:
   *   { text, from, ts, locked:false }  — readable
   *   { locked:true }                   — ciphertext without the room key
   */
  GunXRooms.prototype.open = function (gunx, node) {
    var self = this;
    return gunx.sea.open(node, self.roomKey).then(function (msg) {
      if (!msg) return { locked: true };
      return {
        text: msg.t === u ? "" : String(msg.t),
        from: msg.from === u ? "?" : String(msg.from),
        ts: typeof msg.ts === "number" ? msg.ts : 0,
        locked: false,
      };
    });
  };

  root.GunXRooms = GunXRooms;
})(typeof self !== "undefined" ? self : globalThis);
