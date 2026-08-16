/**
 * POST /api/imgbb — server-side proxy for api.imgbb.com image uploads.
 *
 * The IMGBB API key lives ONLY in the Pages secret `IMGBB_KEY` (server-side).
 * Clients never see it, and the endpoint refuses requests from origins that
 * are not part of the gunx.pages.dev project — so nobody can reuse the key
 * from their own site.
 *
 * Protection layers:
 *   1. Origin allowlist  — only *.gunx.pages.dev (prod + preview) and
 *      http://localhost (dev) may upload. Requests with no Origin header
 *      (plain curl) are rejected unless X-GunX-Key matches env.GUNX_UPLOAD_KEY.
 *   2. Size cap          — images up to 10 MB (imgbb free limit is 32 MB).
 *   3. Type check        — image/* only.
 *   4. Rate limit        — per-IP token window (in-memory, per isolate).
 *
 * Response: { url, display_url, delete_url, thumb, width, height, size, time }
 * The imgbb key is never included in any response.
 */
const ALLOWED_ORIGIN_SUFFIXES = [
  "https://gunx.pages.dev", // apex (no leading dot!)
  ".gunx.pages.dev", // preview deployments: <hash>.gunx.pages.dev
  "http://localhost:8788",
  "http://localhost:8787",
];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 20; // uploads per IP per minute

const buckets = new Map(); // per-isolate limiter: ip -> { start, count }
function rateLimited(ip) {
  const now = Date.now();
  const bucket = buckets.get(ip);
  if (!bucket || now - bucket.start > RATE_WINDOW_MS) {
    buckets.set(ip, { start: now, count: 1 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_MAX;
}

function json(body, status = 200, origin = "*") {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-gunx-key",
    },
  });
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") return json({ ok: true });
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);

  const origin = request.headers.get("origin") || "";
  const allowlisted = ALLOWED_ORIGIN_SUFFIXES.some((s) => origin.endsWith(s));
  // No-Origin clients (curl, node, other sites) must present the optional
  // server-side upload key — NOT the imgbb key.
  const uploadKey = env.GUNX_UPLOAD_KEY;
  const hasKey = uploadKey && request.headers.get("x-gunx-key") === uploadKey;
  if (!allowlisted && !hasKey) {
    return json({ error: "origin not allowed" }, 403);
  }

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (rateLimited(ip)) return json({ error: "rate limited" }, 429);

  const imgbbKey = env.IMGBB_KEY;
  if (!imgbbKey) return json({ error: "imgbb key not configured" }, 500);

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "invalid multipart form" }, 400);
  }
  const file = form.get("image");
  if (!file || typeof file === "string") return json({ error: "image file required (field 'image')" }, 400);
  if (!(file.type || "").startsWith("image/")) return json({ error: "only image/* allowed" }, 415);
  if (file.size > MAX_IMAGE_BYTES) return json({ error: "image too large (max 10 MB)" }, 413);

  const imgbb = new FormData();
  imgbb.append("key", imgbbKey);
  imgbb.append("image", file, file.name || "upload.png");

  let res;
  try {
    res = await fetch("https://api.imgbb.com/1/upload", { method: "POST", body: imgbb });
  } catch {
    return json({ error: "imgbb unreachable" }, 502);
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok || !data || !data.data) {
    const msg =
      (data && data.error && (data.error.message || data.error.code)) ||
      `imgbb upload failed (${res.status})`;
    return json({ error: String(msg) }, 502);
  }

  const d = data.data;
  return json({
    url: d.url,
    display_url: d.display_url,
    delete_url: d.delete_url,
    thumb: d.thumb,
    width: d.width,
    height: d.height,
    size: d.size,
    time: d.time,
  });
}