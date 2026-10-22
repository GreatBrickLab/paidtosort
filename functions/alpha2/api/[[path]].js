// Paid to Sort alpha 2 API. D1 binding DB (users, sessions, lots), secret SECRET. Every query is scoped to the signed-in user.
import { checkPw, readCookie, setCookie, CLEAR } from "../../../lib/alpha2/auth.js";
import PRICES from "../../../lib/alpha2/prices.js";
import { inventoryXml, lotsFromCards, validPart } from "../../../lib/alpha2/invfile.js";
const HDR = { "content-type": "application/json", "x-robots-tag": "noindex, nofollow", "cache-control": "no-store" };
const J = (o, s = 200, h = {}) => new Response(JSON.stringify(o), { status: s, headers: { ...HDR, ...h } }), E = (m, s = 400, x = {}) => J({ error: m, ...x }, s);
const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const LOCK_AFTER = 5, LOCK_MIN = 15, WHY = { expired: "Your sign-in expired. Please sign in again.", signed_out: "You were signed out. Please sign in again." };
const LIMIT = { cards: 80, crop: 60000, image: 3e6, name: 60 };
let WEIGHTS = null;   // part -> grams (static file, read once per isolate) for the export's weight column
const weights = async (env, url) => WEIGHTS || (WEIGHTS = await env.ASSETS.fetch(new URL("/alpha2/data/weights.json", url)).then(r => r.json()).then(w => { for (const k in w) w[k] *= EST_LOW; return w; }).catch(() => ({})));
const EST_LOW = 0.85;   // deliberately low estimate; real pay comes from a scale weight
let CNAME = null;   // color id -> name, from the same palette file the app uses
const colorNames = async (env, url) => CNAME || (CNAME = await env.ASSETS.fetch(new URL("/alpha2/data/palette.json", url)).then(r => r.json()).then(p => Object.fromEntries(p.map(c => [c.id, c.name]))).catch(() => ({})));
const lotOut = l => ({ id: l.id, part: l.part, name: l.name, color: l.color, qty: l.qty, confidence: l.confidence, alts: JSON.parse(l.alts || "[]"), color_guesses: JSON.parse(l.guesses || "[]"), crop: l.crop, status: l.status, checked_at: l.checked_at });
const csvCell = v => { let s = String(v ?? ""); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const ctime = t => t ? new Date(t.replace(" ", "T") + "Z").toLocaleString("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) + " CT" : "";

export async function onRequest({ request: req, env, params }) {
  const url = new URL(req.url), path = (params.path || []).join("/"), M = req.method, DB = env.ALPHA2_DB, secret = env.ALPHA2_SECRET;
  if (!secret) return E("server not configured", 500);
  let body = {}; if (M === "POST") { if (+(req.headers.get("content-length") || 0) > 4e6) return E("too big", 413); body = await req.json().catch(() => ({})); }
  const one = (q, ...a) => DB.prepare(q).bind(...a).first(), all = async (q, ...a) => (await DB.prepare(q).bind(...a).all()).results, run = (q, ...a) => DB.prepare(q).bind(...a).run();

  if (path === "login" && M === "POST") {
    const un = String(body.username || "").trim().toLowerCase(), u = await one("select * from users where username = ?", un);
    if (u?.locked_until && Date.parse(u.locked_until + "Z") > Date.now()) return E(`Too many wrong passwords. Try again in ${LOCK_MIN} minutes.`, 429, { reason: "locked" });
    if (!u || !(await checkPw(String(body.password || ""), u.pw_hash))) {
      if (u) { const n = u.failed + 1, lock = n >= LOCK_AFTER; await run("update users set failed = ?, locked_until = ? where id = ?", lock ? 0 : n, lock ? new Date(Date.now() + LOCK_MIN * 6e4).toISOString().replace("T", " ").slice(0, 19) : null, u.id);
        if (lock) return E(`Too many wrong passwords. Try again in ${LOCK_MIN} minutes.`, 429, { reason: "locked" }); }
      return E("Wrong username or password.", 401); }
    if (u.failed || u.locked_until) await run("update users set failed = 0, locked_until = null where id = ?", u.id);
    return J({ ok: true }, 200, { "set-cookie": await setCookie(secret, u) });
  }
  if (path === "logout") { const c = await readCookie(req, secret); if (c.uid && body.everywhere) await run("update users set token_ver = token_ver + 1 where id = ?", c.uid); return J({ ok: true }, 200, { "set-cookie": CLEAR }); }

  const ck = await readCookie(req, secret); if (!ck.uid) return E(WHY[ck.why] || "Please sign in.", 401, { reason: ck.why });
  const me = await one("select id, username, display, token_ver from users where id = ?", ck.uid);
  if (!me) return E("Please sign in.", 401, { reason: "none" }, CLEAR);
  if (me.token_ver !== ck.ver) return new Response(JSON.stringify({ error: WHY.signed_out, reason: "signed_out" }), { status: 401, headers: { ...HDR, "set-cookie": CLEAR } });
  const mySess = id => one("select * from sessions where id = ? and user_id = ?", String(id), me.id);
  let m;

  if (path === "me") return J({ user: { username: me.username, display: me.display || me.username } });

  // ---- identify: one photo crop -> top 5 matches (proxy; the browser never talks to the recognition service)
  if (path === "identify" && M === "POST") {
    const b64 = String(body.image || "").replace(/^data:image\/\w+;base64,/, ""); if (!b64 || b64.length > LIMIT.image) return E("bad image");
    if (env.IDENTIFY_MOCK) return J({ items: mockIdentify(b64) });
    const fd = new FormData(); fd.append("query_image", new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], { type: "image/jpeg" }), "crop.jpg");
    const r = await fetch("https://api.brickognize.com/predict/", { method: "POST", body: fd, headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (!r) return E("identification timed out", 504); if (!r.ok) return E("identification error " + r.status, 502);
    const js = await r.json(); return J({ items: (js.items || []).slice(0, 5).map(it => ({ id: String(it.id), name: it.name, score: +it.score || 0, type: it.type || "part" })) });
  }
  // ---- reference picture of a part (the "our match" tile); cached at the edge for a week
  if ((m = path.match(/^ref\/([A-Za-z0-9._-]{1,40})$/)) && M === "GET") {
    if (env.IDENTIFY_MOCK) return new Response(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" rx="12" fill="#eef3f2"/><text x="80" y="86" font-size="20" text-anchor="middle" fill="#0E4A4F" font-family="sans-serif">${m[1].replace(/[^\w.-]/g, "")}</text></svg>`, { headers: { "content-type": "image/svg+xml", "cache-control": "max-age=3600" } });
    const src = `https://storage.googleapis.com/brickognize-static/thumbnails/v4.0/part/${encodeURIComponent(m[1])}/0.webp`;
    const r = await fetch(src, { cf: { cacheTtl: 604800, cacheEverything: true } }).catch(() => null);
    if (!r || !r.ok) return new Response("", { status: 404 });
    return new Response(r.body, { headers: { "content-type": r.headers.get("content-type") || "image/webp", "cache-control": "public, max-age=604800" } });
  }

  // ---- sessions
  if (path === "sessions" && M === "GET") return J({ sessions: await all(`select s.*, (select count(*) from lots where session_id = s.id and status = 'ok') lots, (select coalesce(sum(qty), 0) from lots where session_id = s.id and status = 'ok') pcs,
      (select count(*) from lots where session_id = s.id and status = 'check') checking from sessions s where user_id = ? order by started desc limit 50`, me.id) });
  if (path === "sessions" && M === "POST") {
    const d = new Date(), id = "S-" + d.toISOString().slice(2, 10).replace(/-/g, "") + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();
    await run("insert into sessions(id, user_id, name, started, status) values(?, ?, ?, ?, 'open')", id, me.id, String(body.name || "").trim().slice(0, LIMIT.name) || null, now());
    return J({ ok: true, id });
  }
  if ((m = path.match(/^session\/([\w-]+)$/))) {
    const s = await mySess(m[1]); if (!s) return E("not found", 404);
    if (M === "GET") { const ls = (await all("select * from lots where session_id = ? order by id", s.id)).map(lotOut); return J({ s, check: ls.filter(l => l.status === "check"), lots: ls.filter(l => l.status === "ok") }); }
    const a = body.action;
    if (a === "rename") { await run("update sessions set name = ? where id = ?", String(body.name || "").trim().slice(0, LIMIT.name) || null, s.id); return J({ ok: true }); }
    if (a === "weigh") { const g = body.weighed_g === null || body.weighed_g === "" ? null : Math.max(0, +body.weighed_g || 0); await run("update sessions set weighed_g = ? where id = ?", g, s.id); return J({ ok: true, weighed_g: g }); }
    if (a === "finish") { const n = await one("select count(*) n from lots where session_id = ? and status = 'check'", s.id);
      if (n.n && !body.force) return E(`${n.n} card${n.n === 1 ? " is" : "s are"} still waiting to be checked.`, 409, { waiting: n.n });
      if (n.n) await run("delete from lots where session_id = ? and status = 'check'", s.id);
      await run("update sessions set status = 'done', ended = ?, weighed_g = coalesce(?, weighed_g) where id = ?", now(), body.weighed_g == null || body.weighed_g === "" ? null : Math.max(0, +body.weighed_g), s.id); return J({ ok: true }); }
    if (a === "reopen") { await run("update sessions set status = 'open', ended = null where id = ?", s.id); return J({ ok: true }); }
    if (a === "delete") { await DB.batch([DB.prepare("delete from lots where session_id = ?").bind(s.id), DB.prepare("delete from sessions where id = ?").bind(s.id)]); return J({ ok: true }); }
    return E("unknown action");
  }
  // new cards from one photo (unrecognised crops never reach here; "?" rows are skipped anyway)
  if ((m = path.match(/^session\/([\w-]+)\/cards$/)) && M === "POST") {
    const s = await mySess(m[1]); if (!s || s.status !== "open") return E("session not open");
    const cards = (Array.isArray(body.cards) ? body.cards : []).slice(0, LIMIT.cards), ids = [], t = now();
    for (const c of cards) {
      if (!validPart(c.part)) { ids.push(null); continue; }
      const crop = typeof c.crop === "string" && c.crop.startsWith("data:image/") && c.crop.length < LIMIT.crop ? c.crop : null;
      const r = await DB.prepare("insert into lots(session_id, part, name, color, qty, confidence, alts, guesses, crop, status, created) values(?,?,?,?,?,?,?,?,?, 'check', ?) returning id")
        .bind(s.id, String(c.part), String(c.name || "").slice(0, 120), +c.color || 0, Math.max(1, Math.min(999, +c.qty || 1)), +c.confidence || 0,
          JSON.stringify((c.alts || []).slice(0, 4).map(a => ({ id: String(a.id).slice(0, 40), name: String(a.name || "").slice(0, 120), score: +a.score || 0 }))),
          JSON.stringify((c.color_guesses || []).slice(0, 5).map(Number).filter(Number.isFinite)), crop, t).first();
      ids.push(r.id); }
    return J({ ok: true, ids, added: ids.filter(Boolean).length });
  }
  // one card / lot: confirm (merges into the lot with the same part + color), edit qty / color / part, drop / delete
  if ((m = path.match(/^lot\/(\d+)$/)) && M === "POST") {
    const l = await one("select l.* from lots l join sessions s on s.id = l.session_id where l.id = ? and s.user_id = ?", +m[1], me.id); if (!l) return E("not found", 404);
    const s = await mySess(l.session_id); if (s.status !== "open") return E("This session is finished. Reopen it to make changes.", 409);
    const a = body.action;
    if (a === "edit") { const qty = body.qty != null ? Math.max(1, Math.min(9999, +body.qty | 0)) : l.qty, color = body.color != null ? +body.color | 0 : l.color;
      const part = body.part != null ? String(body.part) : l.part; if (!validPart(part)) return E("bad part number");
      const name = body.part != null ? String(body.name || "").slice(0, 120) : l.name;
      if (l.status === "ok") { const tw = await one("select id, qty from lots where session_id = ? and status = 'ok' and part = ? and color = ? and id <> ?", l.session_id, part, color, l.id);
        if (tw) { await DB.batch([DB.prepare("update lots set qty = qty + ? where id = ?").bind(qty, tw.id), DB.prepare("delete from lots where id = ?").bind(l.id)]); return J({ ok: true, merged_into: tw.id, id: tw.id, part, name, color, qty: tw.qty + qty }); } }
      await run("update lots set qty = ?, color = ?, part = ?, name = ? where id = ?", qty, color, part, name, l.id); return J({ ok: true, id: l.id, part, name, color, qty }); }
    if (a === "confirm") { if (l.status !== "check") return E("already confirmed", 409); const qty = body.qty != null ? Math.max(1, +body.qty | 0) : l.qty;
      const tw = await one("select id from lots where session_id = ? and status = 'ok' and part = ? and color = ?", l.session_id, l.part, l.color);
      if (tw) { await DB.batch([DB.prepare("update lots set qty = qty + ?, checked_at = ?, crop = coalesce(crop, ?) where id = ?").bind(qty, now(), l.crop, tw.id), DB.prepare("delete from lots where id = ?").bind(l.id)]); return J({ ok: true, lot: tw.id, merged: true }); }
      await run("update lots set status = 'ok', qty = ?, checked_at = ? where id = ?", qty, now(), l.id); return J({ ok: true, lot: l.id, merged: false }); }
    if (a === "delete") { await run("delete from lots where id = ?", l.id); return J({ ok: true }); }
    return E("unknown action");
  }
  // ---- export: the verified lot list as a spreadsheet (CSV) or an inventory file (.bsx), weights estimated from the parts catalog
  if ((m = path.match(/^session\/([\w-]+)\/export\.(csv|bsx)$/)) && M === "GET") {
    const s = await mySess(m[1]); if (!s) return E("not found", 404);
    const ls = await all("select part, name, color, qty from lots where session_id = ? and status = 'ok' order by part, color", s.id), cn = await colorNames(env, req.url);
    const fn = `${s.id}${s.name ? "-" + s.name.replace(/[^\w-]+/g, "_").slice(0, 30) : ""}`;
    if (m[2] === "bsx") return new Response(inventoryXml(lotsFromCards(ls), { colorName: id => cn[id] || "" }), { headers: { "content-type": "application/xml; charset=utf-8", "content-disposition": `attachment; filename="${fn}.bsx"`, "x-robots-tag": "noindex" } });
    const W = await weights(env, req.url), G_OZ = 28.349523125; let tot = 0, known = 0;
    let val = 0;
    const rows = [["part", "name", "color id", "color", "qty", "est. low weight each (oz)", "est. low weight (oz)", "used avg each ($)", "used avg total ($)", "few sales"]];
    for (const l of ls) { const g = W[l.part], pr = PRICES[`${l.part}|${l.color}`]; if (g) { tot += g * l.qty; known++; } if (pr) val += pr[0] * l.qty;
      rows.push([l.part, l.name, l.color, cn[l.color] || "", l.qty, g ? (g / G_OZ).toFixed(3) : "", g ? (g * l.qty / G_OZ).toFixed(2) : "", pr ? pr[0].toFixed(3) : "", pr ? (pr[0] * l.qty).toFixed(2) : "", pr && pr[1] ? "yes" : ""]); }
    rows.push([], ["session", s.id], ["name", s.name || ""], ["started", ctime(s.started)], ["finished", ctime(s.ended)], ["lots", ls.length], ["pieces", ls.reduce((a, l) => a + l.qty, 0)],
      ["estimated (low) weight (lb, catalog x 0.85)", (tot / G_OZ / 16).toFixed(3)], ["lots without a catalog weight", ls.length - known], ["used avg total ($)", val.toFixed(2)], ["weighed - real (lb)", s.weighed_g ? (s.weighed_g / G_OZ / 16).toFixed(3) : ""]);
    return new Response("\ufeff" + rows.map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n", { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${fn}.csv"`, "x-robots-tag": "noindex" } });
  }
  return E("not found", 404);
}
// test mode (IDENTIFY_MOCK): a stable answer per crop, so tests never call the recognition service
function mockIdentify(b64) { let h = 0; for (let i = 0; i < b64.length; i += 97) h = (h * 31 + b64.charCodeAt(i)) >>> 0;
  const P = [["3001", "Brick 2 x 4"], ["3023", "Plate 1 x 2"], ["3024", "Plate 1 x 1"], ["3710", "Plate 1 x 4"], ["3069b", "Tile 1 x 2 with Groove"], ["3004", "Brick 1 x 2"]];
  if (h % 9 === 0) return [];   // some crops are not recognised
  const a = P[h % P.length], b = P[(h >> 3) % P.length], sc = 0.55 + (h % 40) / 100;
  return [{ id: a[0], name: a[1], score: sc, type: "part" }, ...(b[0] !== a[0] ? [{ id: b[0], name: b[1], score: sc - 0.15, type: "part" }] : [])]; }
