/**
 * GunRelayDO — serverless GunDB relay peer for Cloudflare Workers + Durable Objects.
 *
 * Implements the GunDB wire protocol directly (no Node runtime required):
 *   - state-based LWW graph merge (gun `_.">"` semantics)
 *   - read/`get` responses, put acks, broadcast/relay between connected peers
 *   - persistent graph storage in Durable Object SQLite (hibernation WebSocket API)
 *
 * Adapted from ankushKun/gun (https://github.com/ankushKun/gun, MIT License):
 * "Cloudflare Workers Gun.js-compatible peer with persistent Durable Object storage".
 *
 * Hardening (public multi-tenant use):
 *   - 1 MB per-message frame cap (memory exhaustion protection)
 *   - token-bucket rate limiting per connection / per IP (in-DO memory)
 *   - batched stats persistence (one write per mergeGraph, not per node)
 *
 * Endpoints:
 *   GET  /gun                    -> 426 websocket-required (gun client probe)
 *   POST /gun                    -> gun wire messages over HTTP (fallback transport)
 *   GET  /gun  (Upgrade: ws)     -> WebSocket gun peer
 *   GET  /health                 -> health check
 *   GET  /api/stats              -> relay statistics
 */

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "geolocation=(), microphone=(), camera=()",
};

/** Hard ceiling per wire message (bytes) — public fairness cap. */
const MAX_MESSAGE_BYTES = 1024 * 1024; // 1 MB

/**
 * Retention policy — "99 days 9 hours 9 minutes 9 seconds".
 *
 * The relay NEVER deletes live data. Only *obsolete* data is ever pruned:
 * fields that were explicitly tombstoned (gun null-put / `unset`) and whose
 * write state is older than the retention window. Live chat, profiles, and
 * any non-null payload are retained forever, no matter how old they are.
 */
const PRUNE_TTL_MS = 99 * 86400000 + 9 * 3600000 + 9 * 60000 + 9000; // 8,586,549,000 ms
export { PRUNE_TTL_MS };
const PRUNE_INTERVAL_MS = 24 * 3600000; // sweep once a day via DO alarm

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      ...JSON_HEADERS,
      ...SECURITY_HEADERS,
      ...(init.headers || {}),
    },
  });
}

async function messageToText(raw) {
  if (typeof raw === "string") return raw;
  if (raw instanceof ArrayBuffer) return new TextDecoder().decode(raw);
  if (ArrayBuffer.isView(raw)) return new TextDecoder().decode(raw);
  if (raw && typeof raw.text === "function") return raw.text();
  return String(raw);
}

function safeSend(socket, message) {
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // closed sockets are removed by their close/error handlers
  }
}

function nodeKey(soul) {
  return `node:${soul}`;
}

function normalizeSoul(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value["="] === "string") {
    return value["="];
  }
  return null;
}

/** State-based LWW merge, identical semantics to gun's graph merge. */
function mergeNode(soul, existingNode, incomingNode) {
  const existingState = existingNode._?.[">"] || {};
  const incomingState = incomingNode._?.[">"] || {};
  const merged = {
    ...existingNode,
    _: { "#": soul, ">": { ...existingState } },
  };

  for (const [field, value] of Object.entries(incomingNode)) {
    if (field === "_") continue;
    const nextState = incomingState[field] ?? Date.now();
    const previousState = merged._[">"][field] ?? 0;
    if (nextState >= previousState) {
      merged[field] = value;
      merged._[">"][field] = nextState;
    }
  }
  return merged;
}

function nodesEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Materialize ancestor "lexicon" nodes for every put.
 *
 * gun clients send ONLY leaf nodes on the wire — the parent nodes with child
 * refs (`{ "#": soul }`) are materialized in the client's local graph but are
 * NOT included in the put batch. A relay must therefore synthesize the parent
 * chain itself, or `.map()` on a parent soul never sees children and fresh
 * clients can never discover them. This mirrors what gun's own node server
 * does when it stores graph data.
 *
 * Mutates `graph` in place, adding ancestor nodes with LWW state.
 */
function materializeParents(graph) {
  for (const [soul, node] of Object.entries(graph)) {
    if (!node || typeof node !== "object" || typeof soul !== "string") continue;
    const parts = soul.split("/");
    if (parts.length < 2) continue;

    let state = 0;
    const states = node._ && node._[">"] ? Object.values(node._[">"]) : [];
    for (const s of states) if (typeof s === "number" && s > state) state = s;
    if (!state) state = Date.now();

    for (let i = parts.length - 1; i >= 1; i--) {
      const parentSoul = parts.slice(0, i).join("/");
      const field = parts[i];
      const existing = graph[parentSoul];
      const parent =
        existing && typeof existing === "object"
          ? existing
          : { _: { "#": parentSoul, ">": {} } };
      parent._ = parent._ || { "#": parentSoul, ">": {} };
      parent._[">"] = parent._[">"] || {};
      const previousState = parent._[">"][field] || 0;
      if (state >= previousState) {
        parent[field] = { "#": parts.slice(0, i + 1).join("/") };
        parent._[">"][field] = state;
      }
      graph[parentSoul] = parent;
    }
  }
  return graph;
}

/**
 * Token-bucket rate limiter (in-memory, per DO instance).
 * Limits are per identity (IP or connection id); buckets reset lazily.
 */
class RateLimiter {
  constructor({ capacity = 60, refillPerSec = 10 } = {}) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.buckets = new Map();
    this.maxBuckets = 10000;
  }

  /** @returns {boolean} true if the message is allowed */
  allow(id, cost = 1) {
    if (!id) return true;
    const now = Date.now() / 1000;
    let bucket = this.buckets.get(id);
    if (!bucket) {
      if (this.buckets.size >= this.maxBuckets) {
        // crude eviction: drop the oldest half
        const oldest = [...this.buckets.keys()].slice(0, this.buckets.size / 2);
        for (const k of oldest) this.buckets.delete(k);
      }
      bucket = { tokens: this.capacity, last: now };
      this.buckets.set(id, bucket);
    }
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (now - bucket.last) * this.refillPerSec);
    bucket.last = now;
    if (bucket.tokens < cost) return false;
    bucket.tokens -= cost;
    return true;
  }
}

/**
 * Pure retention decision for a single stored node (unit-testable).
 *
 * Returns:
 *   { dead: [], action: null }          — nothing obsolete
 *   { dead: [...], action: "delete" }   — every field tombstoned → remove soul
 *   { dead: [...], action: "keep", next } — drop dead fields, keep live ones
 */
export function pruneNode(node, cutoff) {
  if (!node || typeof node !== "object") return { dead: [], action: null };
  const states = node._?.[">"] || {};
  const fields = Object.keys(node).filter((f) => f !== "_");
  const dead = fields.filter(
    (f) => node[f] === null && typeof states[f] === "number" && states[f] < cutoff,
  );
  if (!dead.length) return { dead: [], action: null };
  if (dead.length === fields.length) return { dead, action: "delete" };
  const next = { ...node };
  next._ = { "#": node._?.["#"], ">": { ...states } };
  for (const f of dead) {
    delete next[f];
    delete next._[">"][f];
  }
  return { dead, action: "keep", next };
}

export class GunPeerObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.startTime = Date.now();
    // per-connection limiter (WS) + per-IP limiter (HTTP)
    this.connLimiter = new RateLimiter({ capacity: 120, refillPerSec: 20 });
    this.ipLimiter = new RateLimiter({ capacity: 300, refillPerSec: 30 });
    this.initialized = this.initialize();
  }

  async initialize() {
    const stats = await this.state.storage.get("stats");
    if (stats) {
      this.stats = {
        startTime: stats.startTime || this.startTime,
        messagesProcessed: stats.messagesProcessed || 0,
        bytesTransferred: stats.bytesTransferred || 0,
        graphNodes: stats.graphNodes || 0,
      };
    } else {
      this.stats = {
        startTime: this.startTime,
        messagesProcessed: 0,
        bytesTransferred: 0,
        graphNodes: 0,
      };
      await this.persistStats();
    }
    // Recover node count if the counter was lost (cold-start O(n) list, one time)
    if (!this.stats.graphNodes) {
      let count = 0;
      let cursor;
      do {
        const page = await this.state.storage.list({ prefix: "node:", cursor });
        const entries = page instanceof Map ? [...page.keys()] : page?.keys || [];
        count += entries.length;
        cursor = page?.list_complete === false ? page?.cursor : undefined;
      } while (cursor);
      if (count > 0) {
        this.stats.graphNodes = count;
        await this.persistStats();
      }
    }
    // Retention sweep: schedule the first prune one day out (DO alarm).
    await this.schedulePrune();
  }

  /** Next retention sweep exactly PRUNE_INTERVAL_MS from now. */
  schedulePrune() {
    return this.state.storage.setAlarm(Date.now() + PRUNE_INTERVAL_MS);
  }

  /**
   * Daily retention sweep (DO alarm handler).
   *
   * Deletes ONLY obsolete data: fields that carry a `null` value (gun
   * tombstone / unset) whose last-write state is older than PRUNE_TTL_MS.
   * Live non-null data is never touched, ever. A node whose every field has
   * been pruned is removed entirely and the graph-node counter updated.
   */
  async prune() {
    const cutoff = Date.now() - PRUNE_TTL_MS;
    const puts = [];
    const dels = [];
    let removed = 0;

    let cursor;
    do {
      const page = await this.state.storage.list({ prefix: "node:", cursor });
      for (const [key, node] of page.entries()) {
        const decision = pruneNode(node, cutoff);
        if (decision.action === "delete") {
          dels.push(this.state.storage.delete(key));
          removed += 1;
        } else if (decision.action === "keep") {
          puts.push(this.state.storage.put(key, decision.next));
        }
      }
      cursor = page?.list_complete === false ? page?.cursor : undefined;
    } while (cursor);

    if (dels.length || puts.length) {
      await Promise.all([...dels, ...puts]);
      if (removed) {
        this.stats.graphNodes = Math.max(0, this.stats.graphNodes - removed);
        await this.persistStats();
      }
    }
  }

  /** DO alarm handler — triggers the daily retention sweep. */
  async alarm() {
    await this.initialized;
    await this.prune();
    await this.schedulePrune();
  }

  async fetch(request) {
    await this.initialized;
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: JSON_HEADERS });
    }

    if (url.pathname === "/health") {
      return json({
        status: "healthy",
        peer: "gunx-do",
        timestamp: Date.now(),
        connections: this.state.getWebSockets().length,
        graphNodes: this.stats.graphNodes,
      });
    }

    if (url.pathname === "/api/stats" && request.method === "GET") {
      return json({
        status: "online",
        uptimeMs: Date.now() - this.stats.startTime,
        connections: this.state.getWebSockets().length,
        messagesProcessed: this.stats.messagesProcessed,
        bytesTransferred: this.stats.bytesTransferred,
        graphNodes: this.stats.graphNodes,
        storageBackend: this.state.storage?.sql ? "durable-object-sqlite" : "durable-object-kv",
      });
    }

    if (url.pathname === "/gun") {
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        return this.handleWebSocket(request);
      }
      if (request.method === "POST") {
        return this.handleHttpMessage(request);
      }
      return json(
        { status: "websocket required", peer: "/gun" },
        { status: 426, headers: { upgrade: "websocket" } },
      );
    }

    return new Response("not found", { status: 404, headers: SECURITY_HEADERS });
  }

  /* ── WebSocket (hibernation API) ─────────────────────────────────── */

  handleWebSocket(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    server.serializeAttachment({ id: crypto.randomUUID(), ip });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    await this.initialized;
    const text = await messageToText(message);
    if (text.length > MAX_MESSAGE_BYTES) {
      safeSend(ws, { err: "message too large" });
      return;
    }
    const meta = ws.deserializeAttachment?.() || {};
    if (!this.connLimiter.allow(meta.id || "ws")) {
      safeSend(ws, { err: "rate limited" });
      return;
    }
    try {
      await this.handleRawMessage(text, ws);
    } catch {
      safeSend(ws, { err: "message processing failed" });
    }
  }

  async webSocketClose(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  async webSocketError(ws) {
    try {
      ws.close(1011, "WebSocket error");
    } catch {
      // already closed
    }
  }

  /* ── Message handling ────────────────────────────────────────────── */

  async handleHttpMessage(request) {
    const text = await request.text();
    if (text.length > MAX_MESSAGE_BYTES) {
      return json({ err: "message too large" }, { status: 413 });
    }
    if (!this.ipLimiter.allow(request.headers.get("cf-connecting-ip") || "http")) {
      return json({ err: "rate limited" }, { status: 429 });
    }

    this.stats.messagesProcessed += 1;
    this.stats.bytesTransferred += text.length;

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return json({ err: "invalid json" }, { status: 400 });
    }

    const replies = await this.processPayload(payload);
    return json(replies.length === 1 ? replies[0] : replies);
  }

  async handleRawMessage(text, sender) {
    this.stats.messagesProcessed += 1;
    this.stats.bytesTransferred += text.length;

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      safeSend(sender, { err: "invalid json" });
      return;
    }

    const replies = await this.processPayload(payload, sender);
    for (const reply of replies) {
      safeSend(sender, reply);
    }
  }

  async processPayload(payload, sender) {
    const messages = Array.isArray(payload) ? payload : [payload];
    const replies = [];

    for (const message of messages) {
      if (!message || typeof message !== "object") continue;

      if (message.put && typeof message.put === "object") {
        materializeParents(message.put);
        await this.mergeGraph(message.put);
        replies.push({ "@": message["#"], ok: 1 });
        this.relayPut(message.put, sender);
      }

      if (message.get && typeof message.get === "object") {
        replies.push(await this.readGraph(message));
      }
    }

    return replies;
  }

  /* ── Graph merge / storage ───────────────────────────────────────── */

  async mergeGraph(graph) {
    const puts = [];
    let added = 0;

    for (const [soul, incomingNode] of Object.entries(graph)) {
      if (!incomingNode || typeof incomingNode !== "object") continue;

      const key = nodeKey(soul);
      const stored = await this.state.storage.get(key);
      const existingNode = stored || { _: { "#": soul, ">": {} } };
      const merged = mergeNode(soul, existingNode, incomingNode);

      if (stored && nodesEqual(stored, merged)) continue;

      puts.push(this.state.storage.put(key, merged));
      if (!stored) added += 1;
    }

    // Batch: fire all writes concurrently, persist the node-count delta once.
    if (puts.length) {
      await Promise.all(puts);
      if (added) {
        this.stats.graphNodes += added;
        await this.persistStats();
      }
    }
  }

  async readGraph(message) {
    const requestId = message["#"];
    const get = message.get || {};
    const soul = normalizeSoul(get["#"]);
    const field = typeof get["."] === "string" ? get["."] : null;

    if (!soul) {
      return { "@": requestId, put: null, err: "soul required" };
    }

    const node = await this.state.storage.get(nodeKey(soul));
    if (!node) {
      return { "@": requestId, put: null };
    }

    if (field) {
      if (!(field in node)) {
        return { "@": requestId, put: null };
      }
      return {
        "@": requestId,
        put: {
          [soul]: {
            _: { "#": soul, ">": { [field]: node._?.[">"]?.[field] ?? Date.now() } },
            [field]: node[field],
          },
        },
      };
    }

    return { "@": requestId, put: { [soul]: node } };
  }

  /* ── Relay ───────────────────────────────────────────────────────── */

  relayPut(graph, sender) {
    const message = { "#": crypto.randomUUID(), put: graph };
    for (const socket of this.state.getWebSockets()) {
      if (socket !== sender) {
        safeSend(socket, message);
      }
    }
  }

  persistStats() {
    return this.state.storage.put("stats", this.stats);
  }
}

/* ── Worker entry point (direct access at gunx-do.<account>.workers.dev) ── */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: JSON_HEADERS });
    }
    const id = env.GUN_PEER.idFromName("default");
    const stub = env.GUN_PEER.get(id);
    return stub.fetch(request);
  },
};
