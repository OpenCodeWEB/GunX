/**
 * GET /api/w3b/{identity} — web3.bio universal profile proxy.
 *
 * Proxies api.web3.bio so the browser never hits CORS/rate-limit walls:
 *   /api/w3b/profile/0x9016...      → universal profile
 *   /api/w3b/ns/absup.org           → name-service resolution
 *   /api/w3b/domain/absup.org       → WHOIS-style domain query
 *
 * Response is cached 60s (Cache API) to protect the free API from
 * playground traffic spikes.
 */

const UPSTREAM = "https://api.web3.bio";

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/w3b\/?/, "");
  if (!path) {
    return json({ error: "usage: /api/w3b/profile|ns|domain/<identity>" }, 400);
  }

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  try {
    const upstream = new Request(UPSTREAM + "/" + path, {
      headers: { accept: "application/json", "user-agent": "GunX-DoMain/2" },
    });
    const res = await fetch(upstream);
    const body = await res.text();
    if (!res.ok) {
      // upstream 4xx = identity has no web3.bio profile — pass through as 404
      if (res.status >= 400 && res.status < 500) {
        return json({ error: "no web3.bio profile for this identity" }, 404);
      }
      return json({ error: "web3.bio upstream " + res.status, detail: body.slice(0, 200) }, 502);
    }
    const out = new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=60",
      },
    });
    await cache.put(cacheKey, out.clone());
    return out;
  } catch (e) {
    return json({ error: "web3.bio unreachable: " + String(e?.message || e) }, 502);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" },
  });
}