/**
 * /api/domain/* — .gunx registry REST API (Pages Functions → DomainRegistryDO).
 *
 *   POST /api/domain/claim    { name, ownerPub, target, ts, nonce, diff, hash, sig }
 *   POST /api/domain/touch    { name, ownerPub, ts, nonce, diff, hash, sig }
 *   GET  /api/domain/resolve?name=alice
 *   GET  /api/domain/list?owner=<pub>
 *   GET  /api/domain/stats
 *
 * Claims are verified cryptographically inside the Durable Object
 * (PoW + SEA signature), so this endpoint is safe to expose publicly.
 */
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      },
    });
  }

  const id = env.DOMAIN_REGISTRY.idFromName("default");
  const stub = env.DOMAIN_REGISTRY.get(id);

  const path = url.pathname.replace(/^\/api\/domain\/?/, "");
  const action = path.split("/")[0];

  const target = new URL(url.toString());
  if (action === "claim" || action === "touch") {
    target.pathname = "/" + action;
  } else if (action === "resolve" || action === "list" || action === "stats") {
    target.pathname = "/" + action;
  } else {
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  const proxy = new Request(target.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.method === "POST" ? await request.text() : undefined,
  });
  return stub.fetch(proxy);
}