/**
 * mock_nostr_relay.mjs — in-memory NIP-01 Nostr relay for GunX tests.
 *
 * Implements the minimal relay surface the bridge needs:
 *   - EVENT store with Kind 30000 LWW semantics (replaced by d tag)
 *   - EVENT ACK ["OK", id, ok, message] with Schnorr signature validation
 *   - REQ filter matching ({kinds, #t, since}) + replay of stored events
 *   - CLOSE subscription handling
 *
 * Run standalone: node mock_nostr_relay.mjs [port]   (default 8888)
 * Or import:      startMockRelay({port}) -> { server, store, port, stop() }
 *
 * (c) ABsUP / OpenCodeWEB. MIT License.
 */
import { WebSocketServer } from "ws";
import { secp256k1, schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

const toHex = (b) => Buffer.from(b).toString("hex");
const fromHex = (h) => new Uint8Array(Buffer.from(h, "hex"));

/* ---- NIP-01 validation (id + schnorr sig) ---- */
function serializeEvent(evt) {
  return JSON.stringify([0, evt.pubkey, evt.created_at, evt.kind, evt.tags || [], evt.content]);
}
function validEvent(evt) {
  try {
    const id = toHex(sha256(new TextEncoder().encode(serializeEvent(evt))));
    if (id !== evt.id) return false;
    return schnorr.verify(fromHex(evt.sig), fromHex(evt.id), fromHex(evt.pubkey));
  } catch (e) {
    return false;
  }
}

/* ---- filter matching (subset of NIP-01) ---- */
function matches(evt, f) {
  if (!f) return true;
  if (Array.isArray(f.kinds) && f.kinds.length && !f.kinds.includes(evt.kind)) return false;
  if (f.since !== undefined && evt.created_at < f.since) return false;
  if (f.until !== undefined && evt.created_at > f.until) return false;
  if (f["#t"]) {
    const tags = (evt.tags || []).filter((t) => t[0] === "t").map((t) => t[1]);
    if (!f["#t"].some((v) => tags.includes(v))) return false;
  }
  return true;
}

function dTagOf(evt) {
  const d = (evt.tags || []).find((t) => t[0] === "d");
  return d ? d[1] : null;
}

export function startMockRelay(opts = {}) {
  const port = opts.port || 8888;
  const store = new Map();        // kind30000: dTag -> event
  const allEvents = [];           // history (for replay)
  const subs = new Map();         // subId -> { ws, filter }
  const wss = new WebSocketServer({ port });

  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      if (!Array.isArray(msg)) return;

      switch (msg[0]) {
        case "EVENT": {
          const evt = msg[1];
          const ok = validEvent(evt);
          if (ok) {
            allEvents.push(evt);
            if (evt.kind === 30000 && dTagOf(evt)) store.set(dTagOf(evt), evt);
            // broadcast to matching subscriptions
            for (const [subId, sub] of subs) {
              if (matches(evt, sub.filter)) {
                try { sub.ws.send(JSON.stringify(["EVENT", subId, evt])); } catch (e) {}
              }
            }
          }
          ws.send(JSON.stringify(["OK", evt.id, ok, ok ? "" : "invalid: bad id or signature"]));
          break;
        }
        case "REQ": {
          const subId = msg[1];
          const filter = msg[2] || {};
          subs.set(subId, { ws, filter });
          // replay matching events: Kind 30000 from the LWW store (latest
          // per d tag only — replaceable semantics), everything else from
          // history. Dedup by id.
          const seen = new Set();
          for (const evt of store.values()) {
            if (matches(evt, filter) && !seen.has(evt.id)) {
              seen.add(evt.id);
              ws.send(JSON.stringify(["EVENT", subId, evt]));
            }
          }
          for (const evt of allEvents) {
            if (evt.kind === 30000) continue; // already covered by LWW store
            if (matches(evt, filter) && !seen.has(evt.id)) {
              seen.add(evt.id);
              ws.send(JSON.stringify(["EVENT", subId, evt]));
            }
          }
          ws.send(JSON.stringify(["EOSE", subId]));
          break;
        }
        case "CLOSE": {
          subs.delete(msg[1]);
          break;
        }
      }
    });
    ws.on("close", () => {
      for (const [subId, sub] of subs) if (sub.ws === ws) subs.delete(subId);
    });
  });

  return {
    port,
    store,
    allEvents,
    wss,
    stop: () =>
      new Promise((res) => {
        // force-close client sockets so wss.close() completes (Windows TCP
        // close handshakes can otherwise stall the callback forever)
        for (const client of wss.clients) {
          try { client.terminate(); } catch (e) {}
        }
        let done = false;
        const finish = () => { if (!done) { done = true; res(); } };
        wss.close(() => finish());
        setTimeout(finish, 2000); // safety net
      }),
  };
}

/* standalone runner */
if (process.argv[1] && process.argv[1].endsWith("mock_nostr_relay.mjs")) {
  const relay = startMockRelay({ port: parseInt(process.argv[2] || "8888", 10) });
  console.log(`mock nostr relay listening on ws://127.0.0.1:${relay.port}`);
  console.log("press Ctrl+C to stop");
}