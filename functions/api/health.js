/**
 * GET /api/health — liveness probe for the gunx relay.
 */
export async function onRequest(context) {
  const { env } = context;
  const id = env.GUN_PEER.idFromName("default");
  return env.GUN_PEER.get(id).fetch(new Request("https://gunx-do.internal/health"));
}
