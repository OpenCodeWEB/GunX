/**
 * gunx.pages.dev/gun — forwards the gun wire protocol to the gunx-do
 * Durable Object (WebSocket upgrade, HTTP POST, and 426 probe).
 *
 * WebSocket upgrades must be re-constructed as a fresh Request before
 * forwarding to the DO (same pattern as cloudflare's multiplayer-globe
 * template) — passing the original Request object through a DO/service
 * binding breaks the upgrade handshake.
 */
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const upgrade = request.headers.get("Upgrade");
  if (upgrade && upgrade.toLowerCase() === "websocket") {
    const doRequest = new Request(url.toString(), {
      method: "GET",
      headers: request.headers,
    });
    return env.GUN_PEER.get(env.GUN_PEER.idFromName("default")).fetch(doRequest);
  }

  const id = env.GUN_PEER.idFromName("default");
  const stub = env.GUN_PEER.get(id);
  return stub.fetch(request);
}
