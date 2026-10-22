// Colored part pictures (<part>_<color>.webp) from the ALPHA2_IMG KV namespace (key img/<name>), edge-cached; 404 lets the app fall back.
const OK = /^[A-Za-z0-9.-]{1,40}_\d{1,4}\.webp$/;
export async function onRequestGet({ request, params, env, waitUntil }) {
  const name = String(params.name || "");
  if (!OK.test(name) || !env.ALPHA2_IMG) return new Response("not found", { status: 404, headers: { "cache-control": "public, max-age=300", "x-robots-tag": "noindex" } });
  const cache = caches.default, key = new Request(new URL(request.url).origin + "/alpha2/img/" + name);
  const hit = await cache.match(key); if (hit) return hit;
  const o = await env.ALPHA2_IMG.get("img/" + name, { type: "arrayBuffer", cacheTtl: 86400 });
  if (!o) return new Response("not found", { status: 404, headers: { "cache-control": "public, max-age=300", "x-robots-tag": "noindex" } });
  const r = new Response(o, { headers: { "content-type": "image/webp", "cache-control": "public, max-age=31536000, immutable", "x-robots-tag": "noindex" } });
  waitUntil(cache.put(key, r.clone())); return r;
}
