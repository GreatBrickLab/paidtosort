// Paid to Sort ALPHA API (unlisted). Data in D1 (binding PTSDB) via the per-host gatekeeper in lib/store_d1.js;
// Each request reads only the rows it needs (indexed by host + session / bag / card); KV (PTSA) holds training images and the pre-D1 backup.
import { inventoryXml, lotsFromCards, validateImport, validPart, IMPORT_LIMITS } from "../../../lib/invfile.js";
import { hostStore, sharedStore, findLogin, migrateFromKV, trainStore, ensureIndexes } from "../../../lib/store_d1.js";
const HDR = { "content-type": "application/json", "x-robots-tag": "noindex, nofollow", "cache-control": "no-store" };
const J = (o, s = 200, h = {}) => new Response(JSON.stringify(o), { status: s, headers: { ...HDR, ...h } });
const E = (m, s = 400) => J({ error: m }, s);
const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
const rnd = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const enc = new TextEncoder();
const QR_TTL = 7 * 864e5, PREP_TTL = 90 * 864e5, LABEL_TTL = 100 * 365 * 864e5;   // pre-labeled bags are permanent   // batch-prep sheets are printed ahead of time

async function pbkdf2(pw, saltHex, it) {
  const k = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: it }, k, 256));
}
async function hashPw(pw) { const s = rnd(16), it = 20000; return `pbkdf2_sha256$${it}$${s}$${await pbkdf2(pw, s, it)}`; }
async function checkPw(pw, h) { const [, it, s, d] = h.split("$"); return (await pbkdf2(pw, s, +it)) === d; }
async function hmac(secret, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
async function readCookie(req, secret, kv) { // value: "<host>:<user>:<ver>.<exp>.<sig>" (older "<host>:<user>" = ver 0); kv: signed-out tokens
  const m = (req.headers.get("cookie") || "").match(/ptsa=([^;]+)/);
  if (!m || !m[1]) return { why: "none" };
  const [who, exp, sig] = decodeURIComponent(m[1]).split(".");
  if (!sig || (await hmac(secret, who + "." + exp)) !== sig) return { why: "invalid" };
  if (+exp < Date.now()) return { why: "expired" };
  if (kv && (await kv.get("out:" + sig))) return { why: "signed_out" };
  const [hid, uid, ver] = who.split(":").map(Number);
  return Number.isInteger(hid) && Number.isInteger(uid) ? { hid, uid, ver: ver || 0 } : { why: "invalid" };
}
const SIGNIN_DAYS = 14, LOCK_AFTER = 5, LOCK_MIN = 15;
async function signinCookie(secret, u) { const exp = Date.now() + SIGNIN_DAYS * 864e5, v = `${u.host_id}:${u.id}:${+u.token_ver || 0}.${exp}`;
  return { "set-cookie": `ptsa=${encodeURIComponent(v + "." + (await hmac(secret, v)))}; Path=/alpha; HttpOnly; Secure; SameSite=Lax; Max-Age=${SIGNIN_DAYS * 86400}` }; }
const CLEAR = { "set-cookie": "ptsa=; Path=/alpha; Max-Age=0; HttpOnly; Secure; SameSite=Lax" };
const WHY = { expired: "Your sign-in expired. Please sign in again.", signed_out: "You were signed out. Please sign in again.", disabled: "This account is turned off. Ask your host." };
let PALETTE = null, MIGRATED = false, SECRET = null;
const BAGS_MIGRATED = new Set();
const colorName = id => ((PALETTE || {})[id] || [String(id)])[0];
const cardIn = c => (c ? { ...c, alts: JSON.parse(c.alts || "[]"), color_guesses: JSON.parse(c.color_guesses || "[]"), crop: c.image_id ? `/alpha/api/crop/${c.image_id}` : null } : null);
const CARD_COLS = ["id", "session_id", "part", "name", "color", "qty", "confidence", "alts", "color_guesses", "image_id", "status", "bag_code"];
const cardRow = c => Object.fromEntries(CARD_COLS.filter(k => k in c).map(k => [k, c[k]]));
const sessHours = s => Math.max(0, ((s.ended ? Date.parse(s.ended + "Z") : Date.now()) - Date.parse(s.started + "Z")) / 36e5);
const payAmt = (s, host) => host.pay_mode === "hr" ? sessHours(s) * host.rate_hr : s.weight_lb ? s.weight_lb * host.rate_lb : 0;   // $ for one session (0 while the sorted weight is not entered)
const csvCell = v => { const t = v === null || v === undefined ? "" : String(v); return /[",\n\r]/.test(t) || /^[=+\-@]/.test(t) ? `"${(/^[=+\-@]/.test(t) ? "'" : "") + t.replace(/"/g, '""')}"` : t; };
function pay(s, host) {
  if (host.pay_mode === "hr") { const h = ((s.ended ? Date.parse(s.ended + "Z") : Date.now()) - Date.parse(s.started + "Z")) / 36e5; return `$${(h * host.rate_hr).toFixed(2)} (${h.toFixed(2)} h × $${host.rate_hr.toFixed(2)})`; }
  return s.weight_lb ? `$${(s.weight_lb * host.rate_lb).toFixed(2)} (${s.weight_lb} lb × $${host.rate_lb.toFixed(2)})` : "sorted weight not entered";
}
// A bag (one PTS- QR) holds many lots. Lots are the confirmed cards whose bag_code is the bag's code; removed lots get status "removed".
// ---- open-bag meter: running weight (g), bag volume (cm3), pieces and parts value from the shared parts data.
// Bag volume uses loose bulk density (a 4x6 in bag holds ~250-300 cm3 / ~100-120 g of loose parts -> ~0.4 g/cm3, host setting loose_density):
//   weight known -> weight_g / loose_density; no weight -> bounding-box volume_cm3 x 0.6 packing fraction (approximate); neither -> 0 (approximate).
// Bag-full uses only weight and volume (never prices): full when weight >= bag_max_g OR volume >= bag_max_cm3, whichever comes first.
const PACKING = 0.6;
async function meterOf(sh, lots, host, caps) { caps = caps || { max_g: +host.bag_max_g || 0, max_cm3: +host.bag_max_cm3 || 0, share: 0, size: null };
  const { metrics, prices } = await sh.partData(lots.map(l => l.part)), dens = +host.loose_density > 0 ? +host.loose_density : 0.4;
  let g = 0, v = 0, cm3 = 0, pcs = 0, nW = 0, nP = 0, nD = 0;
  for (const l of lots) { const q = +l.qty || 0, mt = metrics.get(l.part), pr = prices.get(l.part + "|" + l.color); pcs += q;
    if (mt && mt.has_weight && mt.weight_g > 0) { g += q * mt.weight_g; cm3 += q * mt.weight_g / dens; }
    else { nW++; if (mt && mt.has_dims && mt.volume_cm3 > 0) cm3 += q * mt.volume_cm3 * PACKING; else nD++; }
    if (pr && pr.price_used_avg > 0) v += q * pr.price_used_avg; else nP++; }
  const share = +caps.share || 0;   // the sorter's own pay share (users.pay_share), 0 = parts value only
  const byW = caps.max_g > 0 && g >= caps.max_g, byV = caps.max_cm3 > 0 && cm3 >= caps.max_cm3, full = lots.length > 0 && (byW || byV);
  return { lots: lots.length, pcs, weight_g: Math.round(g * 10) / 10, volume_cm3: Math.round(cm3), value: Math.round(v * 100) / 100, share,
    earnings: share > 0 ? Math.round(v * share * 100) / 100 : null, no_weight: nW, no_price: nP, no_size: nD, approx: nW + nP > 0, full,
    full_by: full ? (byW && byV ? "weight and volume" : byW ? "weight" : "volume") : null,
    max_g: +caps.max_g || 0, max_cm3: +caps.max_cm3 || 0, bag_size: caps.size }; }
const lotOut = c => ({ id: c.id, part: c.part, name: c.name, color: c.color, color_name: colorName(c.color), qty: c.qty, color_guesses: c.color_guesses || [], crop: c.crop || null });

// Per-request data access: every read is an indexed query for just the rows the endpoint needs (all through the hostStore gatekeeper).
function repo(hs) {
  const R = {
    bag: code => hs.get("bags", { code: String(code || "").trim().toUpperCase() }),
    qr: code => hs.get("qrcodes", { code }),
    lotsByCode: async codes => { const m = new Map(codes.map(c => [c, []])); if (!codes.length) return m;
      for (const c of await hs.list("cards", { bag_code: [...new Set(codes)], status: "confirmed" }, "id")) m.get(c.bag_code)?.push(cardIn(c)); return m; },
    lots: async b => (await R.lotsByCode([b.code])).get(b.code),
    // many bags -> API shape, with 3 batched queries (lots, QR codes, boxes) instead of one per bag
    bagsOut: async (bags, withQr = false) => { if (!bags.length) return [];
      const codes = bags.map(b => b.code), lots = await R.lotsByCode(codes);
      const qrs = new Map((await hs.list("qrcodes", { code: [...new Set(codes)] })).map(q => [q.code, q]));
      const bids = [...new Set(bags.map(b => b.box_id).filter(x => x !== null && x !== undefined))];
      const boxes = new Map((bids.length ? await hs.list("boxes", { id: bids }) : []).map(x => [x.id, x]));
      const out = bags.map(b => { const q = qrs.get(b.code); const o = { ...b, color_name: colorName(b.color), box_code: boxes.get(b.box_id)?.barcode || null, lots: (lots.get(b.code) || []).map(lotOut), open: q?.status === "open" };
        if (withQr) o.qr = q; return o; });
      for (const o of out) if (o.box_id !== null && o.box_id !== undefined) o.n = await R.bagN(o);   // number within its box, same as the seal toast and batch summary
      return out; },
    openLots: async sid => (await hs.list("cards", { session_id: sid, status: "confirmed", bag_code: null }, "id")).map(cardIn),
    bagN: async b => b.box_n ?? ((await hs.list("bags", { box_id: b.box_id, status: { ne: "void" } }, "id")).findIndex(x => x.code === b.code) + 1 || null),
    bagOut: async b => (await R.bagsOut([b]))[0],
    retired: b => b.trace === "retired" || (!/^BG\d+$/.test(b.code) && b.status === "labelled" && !b.session_id && !b.box_n && !(+b.qty)),
    labelCode: k => `BG${String(hs.hostId ?? "").padStart(2, "0")}${String(k).padStart(6, "0")}`,
    // the bag the sorter is filling now: scanned into the session's box, not sealed
    curBag: async s => s.box_id ? (await hs.list("bags", { session_id: s.id, box_id: s.box_id, status: "labelled" }, "id desc")).find(b => b.box_n && !b.sealed_at) || null : null,
    seal: async (s, bag, ol) => { const t = now();
      await hs.batch([hs.updateStmt("cards", { id: ol.map(c => c.id) }, { bag_code: bag.code }), hs.updateStmt("bags", { id: bag.id }, { status: "bagged", sealed_at: t }),
        hs.updateStmt("qrcodes", { code: bag.code }, { status: "used" })]);
      Object.assign(bag, { status: "bagged", sealed_at: t }); await R.syncBag(bag); await hs.staleTotals(); const bo = await R.bagOut(bag);
      return { ...bo, n: bag.box_n }; },
    release: async bag => { await hs.batch([hs.updateStmt("bags", { id: bag.id }, { box_id: null, box_n: null, session_id: null, user_id: null, location: "" }),
      hs.updateStmt("qrcodes", { code: bag.code }, { session_id: null, user_id: null, status: "issued" })]); },
    // keep the bag row's summary columns (first lot + total qty) in step with its lots
    syncBag: async b => { const ls = await R.lots(b), f = ls[0] || {}, q = ls.reduce((a, c) => a + c.qty, 0), nm = ls.length > 1 ? `${ls.length} lots` : (f.name || "");
      if (b.part !== (f.part || "") || b.color !== (f.color ?? 0) || b.qty !== q || b.name !== nm) { Object.assign(b, { part: f.part || "", color: f.color ?? 0, qty: q, name: nm }); await hs.update("bags", { id: b.id }, { part: b.part, color: b.color, qty: b.qty, name: b.name }); } },
    newQr: async (s, status = "issued") => { let code; do { code = "PTS-" + rnd(4).toUpperCase(); } while (await R.qr(code));
      await hs.put("qrcodes", { code, session_id: s.id, user_id: s.user_id, created: now(), expires: Date.now() + QR_TTL, status }); return code; },
    newBag: async s => { const code = await R.newQr(s, "open");
      const bag = { id: await hs.nextId("bag"), code, host_id: s.host_id, session_id: s.id, user_id: s.user_id, part: "", name: "", color: 0, qty: 0,
        box_id: null, location: "", status: "labelled", promoted_at: null, picked_at: null, created: now() }; await hs.put("bags", bag); await hs.staleTotals(); return bag; },
    closeOpen: async (sid, exceptCode) => {   // close every open QR of a session (except one); returns the bags that were closed
      const qs = (await hs.list("qrcodes", { session_id: sid, status: "open" })).filter(q => q.code !== exceptCode); if (!qs.length) return [];
      await hs.update("qrcodes", { code: qs.map(q => q.code), status: "open" }, { status: "issued" });
      return hs.list("bags", { code: qs.map(q => q.code), session_id: sid }, "id"); },
    // issued QR codes past their expiry -> expired, and their still-unbagged bags -> void (indexed: only expired rows are read)
    expire: async () => { const qs = await hs.list("qrcodes", { status: "issued", expires: { lt: Date.now() } }); if (!qs.length) return 0;
      const codes = qs.map(q => q.code);
      for (let i = 0; i < codes.length; i += 80) { const cs = codes.slice(i, i + 80);
        await hs.update("qrcodes", { code: cs, status: "issued" }, { status: "expired" }); await hs.update("bags", { code: cs, status: "labelled" }, { status: "void" }); }
      await hs.staleTotals(); return qs.length; },
  };
  return R;
}
// one-time per host: older bags (one lot each, created before multi-lot bags) get their lot as a card, so every existing QR keeps working as a bag code
async function migrateBags(hs, sh) { const key = "bags_migrated:" + hs.hostId; if (BAGS_MIGRATED.has(key)) return;
  if (!(await sh.meta(key))) {
    const bags = (await hs.list("bags", { status: { ne: "void" } })).filter(b => b.part), has = new Set((await hs.list("cards", { bag_code: bags.map(b => b.code) })).map(c => c.bag_code));
    const todo = bags.filter(b => !has.has(b.code)), ids = todo.length ? await hs.nextIds("card", todo.length) : [];
    await hs.batch(todo.map((b, i) => hs.putStmt("cards", { id: ids[i], image_id: null, session_id: b.session_id, part: b.part, name: b.name || "", color: b.color, qty: b.qty || 1,
      confidence: 1, alts: [], color_guesses: [], status: "confirmed", bag_code: b.code })));
    if (todo.length) await hs.staleTotals(); await sh.setMeta(key, new Date().toISOString());
  }
  BAGS_MIGRATED.add(key); }

// optional request metering (header x-pts-meter: 1): D1 rows read / written by this request, summed from each statement's meta
function meter(d1) { const m = { q: 0, rows_read: 0, rows_written: 0 };
  const add = mt => { m.q++; if (mt) { m.rows_read += mt.rows_read || 0; m.rows_written += mt.rows_written || 0; } };
  const wrap = st => ({ _st: st, bind: (...a) => wrap(st.bind(...a)),
    all: async () => { const r = await st.all(); add(r.meta); return r; },
    first: async col => { const r = await st.all(); add(r.meta); const row = r.results[0] ?? null; return col && row ? row[col] : row; },
    run: async () => { const r = await st.run(); add(r.meta); return r; } });
  return { m, prepare: sql => wrap(d1.prepare(sql)), batch: async ss => { const rs = await d1.batch(ss.map(s => s._st)); rs.forEach(r => add(r.meta)); return rs; } };
}

function bsxXml(items) {
  const e = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  let o = '<?xml version="1.0" encoding="UTF-8"?>\n<BrickStoreXML>\n <Inventory Currency="USD">\n';
  items.forEach((it, i) => { o += (i ? "<Item>\n" : "  <Item>\n") + `   <ItemID>${e(it.part)}</ItemID>\n   <ItemTypeID>P</ItemTypeID>\n   <ColorID>${+it.color}</ColorID>\n   <ItemTypeName>Part</ItemTypeName>\n   <Status>I</Status>\n   <Qty>${+it.qty}</Qty>\n   <Price>0.000</Price>\n   <Condition>U</Condition>\n  </Item>\n`; });
  return o + " </Inventory>\n</BrickStoreXML>\n";
}

// rebuild the sample labels from a whitelist: nothing about host, user, session, pay or names can get through
const ST = ["confirmed", "corrected", "dropped", "missed", "unreviewed"];
const num = v => (Number.isFinite(+v) ? Math.round(+v * 10) / 10 : 0);
const box4 = b => (Array.isArray(b) && b.length === 4 ? b.map(num) : null);
const partId = p => (typeof p === "string" && /^[A-Za-z0-9.\-]{1,40}$/.test(p) ? p : null);
const colId = c => (c === null || c === undefined || c === "" ? null : Number.isInteger(+c) ? +c : null);
function cleanLabels(l, id) {
  const fr = l.frame || {}, im = l.image || {};
  if (!(+fr.w > 0 && +fr.h > 0 && +im.w > 0 && +im.h > 0)) return null;
  const boxes = (Array.isArray(l.boxes) ? l.boxes : []).slice(0, 400).map(b => ({ box: box4(b.box), box_img: box4(b.box_img), status: ST.includes(b.status) ? b.status : "unreviewed",
    pred: b.pred ? { part: partId(b.pred.part), color: colId(b.pred.color), score: num(b.pred.score * 1000) / 1000 } : null, part: partId(b.part), color: colId(b.color) })).filter(b => b.box && b.box_img);
  return { v: 1, sample_id: id, created: new Date().toISOString(), app_version: String(l.app_version || "").slice(0, 20).replace(/[^\w.-]/g, ""),
    detector_version: String(l.detector_version || "").slice(0, 20).replace(/[^\w.-]/g, ""), frame: { w: num(fr.w), h: num(fr.h) }, crop: box4(l.crop) || [0, 0, num(fr.w), num(fr.h)],
    scale: num((+l.scale || 1) * 1e4) / 1e4, image: { w: num(im.w), h: num(im.h) }, boxes };
}

export async function onRequest(ctx) {
  const { request: req, env, params } = ctx;
  if (!env.PTSDB) return E("storage not bound", 500);
  const path = (params.path || []).join("/");
  const url = new URL(req.url);
  const M = req.method;
  const body = M === "POST" ? await req.json().catch(() => ({})) : {};
  const MET = req.headers.get("x-pts-meter") === "1" ? meter(env.PTSDB) : null;
  const D1 = MET || env.PTSDB, sh = sharedStore(D1);
  const J2 = (o, s = 200, h = {}) => J(o, s, MET ? { ...h, "x-pts-rows-read": String(MET.m.rows_read), "x-pts-rows-written": String(MET.m.rows_written), "x-pts-queries": String(MET.m.q) } : h);
  const E2 = (m, s = 400, x = {}, h = {}) => J2({ error: m, ...x }, s, h);
  if (!MIGRATED) { await migrateFromKV({ ...env, PTSDB: D1 }); await ensureIndexes(D1); MIGRATED = true; }
  if (!SECRET) SECRET = await sh.meta("secret");
  const secret = SECRET;
  if (!secret) return E2("not seeded", 500);

  if (path === "login" && M === "POST") {
    const un = String(body.username || "").trim().toLowerCase();
    const u = await findLogin(D1, un);
    if (u && u.locked_until && Date.parse(u.locked_until + "Z") > Date.now()) return E2(`Too many wrong passwords. Try again in ${LOCK_MIN} minutes, or ask your host to reset your password.`, 429, { reason: "locked" });
    if (!u || !(await checkPw(String(body.password || ""), u.pw_hash))) {
      if (u) { const n = (+u.failed_logins || 0) + 1, lock = n >= LOCK_AFTER; const uh = hostStore(D1, u.host_id);
        await uh.update("users", { id: u.id }, { failed_logins: lock ? 0 : n, locked_until: lock ? new Date(Date.now() + LOCK_MIN * 6e4).toISOString().replace("T", " ").slice(0, 19) : u.locked_until || null });
        if (lock) { await uh.put("audit", { id: await uh.nextId("audit"), at: now(), user_id: u.id, username: un, action: "sign-in locked", target: un, detail: `${LOCK_AFTER} wrong passwords; locked ${LOCK_MIN} min` }); return E2(`Too many wrong passwords. Try again in ${LOCK_MIN} minutes, or ask your host to reset your password.`, 429, { reason: "locked" }); } }
      return E2("Wrong username or password.", 401); }
    if (u.status === "disabled") return E2(WHY.disabled, 403, { reason: "disabled" });
    if (+u.failed_logins || u.locked_until) await hostStore(D1, u.host_id).update("users", { id: u.id }, { failed_logins: 0, locked_until: null });
    return J2({ ok: true }, 200, await signinCookie(secret, u));
  }

  // training-data export for the offline dataset script (EXPORT_KEY header; no cookie)
  if (path.startsWith("train/export") || path.startsWith("train/img/")) {
    if (!env.EXPORT_KEY || req.headers.get("x-export-key") !== env.EXPORT_KEY) return E2("forbidden", 403);
    const ts = trainStore(D1, env.PTSA);
    if (path === "train/export") return J2({ samples: await ts.list(url.searchParams.get("after") || "") });
    const v = await ts.image(path.slice(10)); if (!v) return E2("nf", 404);
    return new Response(Uint8Array.from(atob(v), c => c.charCodeAt(0)), { headers: { "content-type": "image/jpeg", "x-robots-tag": "noindex" } });
  }
  if (path === "logout") {   // end this token server-side (KV entry until it would have expired), then clear the cookie
    const m = (req.headers.get("cookie") || "").match(/ptsa=([^;]+)/), [, exp, sig] = m ? decodeURIComponent(m[1]).split(".") : [];
    if (sig && env.PTSA && +exp > Date.now() && (await readCookie(req, secret)).uid) await env.PTSA.put("out:" + sig, "1", { expirationTtl: Math.max(60, Math.ceil((+exp - Date.now()) / 1000)) });
    return J2({ ok: true }, 200, { "set-cookie": "ptsa=; Path=/alpha; Max-Age=0; HttpOnly; Secure; SameSite=Lax" }); }

  const ck = await readCookie(req, secret, env.PTSA);
  if (!ck.uid) return E2(WHY[ck.why] || "login required", 401, { reason: ck.why });
  // only the logged-in user's host, through the gatekeeper; each endpoint below reads just the rows it needs
  const hs = hostStore(D1, ck.hid), R = repo(hs);
  const user = await hs.get("users", { id: ck.uid });
  // bag caps come from the box's bag size (host list bag_sizes; first size if the box has none; host bag_max_* if the host has no sizes);
  // pay share is the session sorter's own users.pay_share
  const SZ = {}; const capsOf = async s => { const k = (s?.box_id ?? "-") + ":" + (s?.user_id ?? "-"); if (SZ[k]) return SZ[k];
    const box = s?.box_id ? await hs.get("boxes", { id: s.box_id }) : null, sizes = await hs.list("bag_sizes", {}, "id");
    const z = (box?.bag_size_id && sizes.find(x => x.id === box.bag_size_id)) || sizes[0] || null, su = s && s.user_id !== user.id ? await hs.get("users", { id: s.user_id }) : user;
    return SZ[k] = { max_g: z ? +z.max_g : +host.bag_max_g || 0, max_cm3: z ? +z.max_cm3 : +host.bag_max_cm3 || 0, size: z ? z.name : null, share: +su?.pay_share || 0 }; };
  if (!user) return E2("login required", 401);
  if ((+user.token_ver || 0) !== ck.ver) return E2(WHY.signed_out, 401, { reason: "signed_out" }, CLEAR);
  if (user.status === "disabled") return E2(WHY.disabled, 401, { reason: "disabled" });
  const host = await hs.get("hosts", {});
  if (!host) return E2("login required", 401);
  if (!PALETTE) PALETTE = Object.fromEntries((await sh.colors()).map(c => [c.id, [c.name]]));
  const admin = user.role === "admin", prep = !admin && +user.prep_only === 1;   // prep helper: a sorter who may also do batch prep, box/bag labels and bag lookup
  const audit = async (action, target, detail) => { try { await hs.put("audit", { id: await hs.nextId("audit"), at: now(), user_id: user.id, username: user.username, action, target: target == null ? null : String(target).slice(0, 80), detail: detail == null ? null : String(detail).slice(0, 300) }); } catch (e) { console.warn("audit", e); } };
  const mine = s => s && s.host_id === host.id && (admin || s.user_id === user.id);
  const sess = id => hs.get("sessions", { id: String(id) });
  let m;
  // these never touch bags/QR codes: skip the per-request housekeeping
  const light = path === "identify" || path === "train/sample" || path === "train/cards" || /^crop\//.test(path) || path === "mold-exceptions" || path === "parts/info";
  if (!light) { await migrateBags(hs, sh); await R.expire(); }

  // ---- own account: change password (signs out other phones), log out everywhere
  if (path === "account/password" && M === "POST") {
    const cur = String(body.current || ""), nw = String(body.password || "");
    if (!(await checkPw(cur, user.pw_hash))) return E2("Your current password is not right.", 400);
    if (nw.length < 8) return E2("New password: 8 or more characters.");
    if (nw === cur) return E2("Pick a new password that is different from the current one.");
    user.pw_hash = await hashPw(nw); user.pw_changed = now(); user.token_ver = (+user.token_ver || 0) + 1;
    await hs.update("users", { id: user.id }, { pw_hash: user.pw_hash, pw_changed: user.pw_changed, token_ver: user.token_ver, failed_logins: 0, locked_until: null });
    await audit("password changed", user.username, "by the user; other phones signed out");
    return J2({ ok: true, msg: "Password changed. Other phones were signed out." }, 200, await signinCookie(secret, { ...user, host_id: host.id }));
  }
  if (path === "account/logout-all" && M === "POST") {
    await hs.update("users", { id: user.id }, { token_ver: (+user.token_ver || 0) + 1 }); await audit("logged out everywhere", user.username);
    return J2({ ok: true }, 200, CLEAR);
  }
  // ---- own pay totals by week (Mon-Sun) and month, Central time; only the signed-in user's own sessions
  if (path === "me/pay") {
    const ss = await hs.list("sessions", { user_id: user.id }, "started desc", 500);
    const ct = t => new Date(new Date(Date.parse(t + "Z")).toLocaleString("en-US", { timeZone: "America/Chicago" }));
    const wk = d => { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x.toISOString().slice(0, 10); };
    const W = new Map(), Mo = new Map();
    for (const s of ss) { if (!s.started) continue; const d = ct(s.started), a = payAmt(s, host), lb = +s.weight_lb || 0, h = sessHours(s);
      for (const [map, k] of [[W, wk(d)], [Mo, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`]]) { const o = map.get(k) || { k, sessions: 0, pay: 0, lb: 0, hours: 0, missing_weight: 0 };
        o.sessions++; o.pay += a; o.lb += lb; o.hours += h; if (host.pay_mode !== "hr" && !s.weight_lb) o.missing_weight++; map.set(k, o); } }
    const r2 = o => ({ ...o, pay: Math.round(o.pay * 100) / 100, lb: Math.round(o.lb * 100) / 100, hours: Math.round(o.hours * 100) / 100 });
    return J2({ pay_mode: host.pay_mode, rate: host.pay_mode === "hr" ? host.rate_hr : host.rate_lb, weeks: [...W.values()].slice(0, 12).map(r2), months: [...Mo.values()].slice(0, 12).map(r2) });
  }
  if (path === "me") {
    const ss = await hs.list("sessions", { user_id: user.id }, "started desc", 10);
    const per = new Map((await hs.group("bags", "session_id", { session_id: ss.map(s => s.id), status: { ne: "void" } }, "qty")).map(r => [r.k, r]));
    const out = { user: { id: user.id, username: user.username, display: user.display, role: user.role, prep: prep, pw_changed: user.pw_changed || null }, host,
      sessions: ss.map(s => ({ ...s, nb: per.get(s.id)?.n || 0, pcs: per.get(s.id)?.s || 0 })) };
    if (url.searchParams.get("stats") === "1") out.stats = await hs.totals();   // repository totals: home screen only
    return J2(out);
  }
  if (path === "session/start" && M === "POST") {
    const d = new Date(), id = `S-${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}-${rnd(2).toUpperCase()}`;
    await hs.put("sessions", { id, user_id: user.id, started: now(), ended: null, weight_lb: null, status: "open" });
    return J2({ id });
  }
  if ((m = path.match(/^session\/([\w-]+)$/))) {
    const s = await sess(m[1]); if (!mine(s)) return E2("not found", 404);
    const owner = s.user_id === user.id ? user : await hs.get("users", { id: s.user_id });
    const cards = (await hs.list("cards", { session_id: s.id, status: "pending" }, "id")).map(cardIn).map(c => ({ ...c, color_name: colorName(c.color) }));
    const bags = await R.bagsOut(await hs.list("bags", { session_id: s.id, status: { ne: "void" } }, "id desc"));
    const openLots = (await R.openLots(s.id)).map(lotOut), box = s.box_id ? await hs.get("boxes", { id: s.box_id }) : null;
    const sealed = bags.filter(b => b.lots.length), per = [];
    // one bag number everywhere (summary, sealed list, toasts): its number in the box, else (older bags without a box) its order in this session
    [...sealed].sort((a, b) => a.id - b.id).forEach((b, i) => { if (b.n === null || b.n === undefined) b.n = i + 1; });
    for (const b of sealed) per.push({ code: b.code, n: b.n ?? null, box_code: b.box_code, ...(await meterOf(sh, b.lots, host, await capsOf(s))) });
    const tot = { bags: per.length, pcs: per.reduce((a, b) => a + b.pcs, 0), weight_g: Math.round(per.reduce((a, b) => a + b.weight_g, 0) * 10) / 10, value: Math.round(per.reduce((a, b) => a + b.value, 0) * 100) / 100,
      approx: per.some(b => b.approx), batch_weight_g: box?.batch_weight_g ?? null, share: +(await capsOf(s)).share || 0 };
    tot.earnings = tot.share > 0 ? Math.round(tot.value * tot.share * 100) / 100 : null;
    const cb = s.status === "open" ? await R.curBag(s) : null;
    return J2({ s, pay: pay(s, host), owner: owner?.username, cards, bags, box, cur_bag: cb ? { code: cb.code, n: cb.box_n } : null, open_lots: openLots, meter: await meterOf(sh, openLots, host, await capsOf(s)), summary: { ...tot, per_bag: per } });
  }
  if ((m = path.match(/^session\/([\w-]+)\/end$/)) && M === "POST") {
    const s = await sess(m[1]); if (!mine(s)) return E2("not found", 404);
    const ol = await R.openLots(s.id), cur = s.status === "open" ? await R.curBag(s) : null;
    if (ol.length && cur) await R.seal(s, cur, ol);   // ending the session seals the bag being filled
    else if (ol.length && !body.force) return E2("Parts are waiting with no bag: scan a bag to put them in first", 409);
    else if (cur) await R.release(cur);   // scanned but never filled: back to the supply
    await hs.put("sessions", { ...s, status: "closed", ended: now(), weight_lb: body.weight_lb ? +body.weight_lb : null }); return J2({ ok: true });
  }
  if (path === "identify" && M === "POST") {
    const b64 = String(body.image || "").replace(/^data:image\/\w+;base64,/, "");
    if (!b64 || b64.length > 3e6) return E2("bad image");
    const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const fd = new FormData(); fd.append("query_image", new Blob([bin], { type: "image/jpeg" }), "crop.jpg");
    const r = await fetch("https://api.brickognize.com/predict/", { method: "POST", body: fd, headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (!r) return E2("identification timed out", 504);
    if (!r.ok) return E2("identification engine error " + r.status, 502);
    const js = await r.json();
    return J2({ items: (js.items || []).slice(0, 5).map(it => ({ id: it.id, name: it.name, score: +it.score || 0, type: it.type || "part" })) });
  }
  if ((m = path.match(/^session\/([\w-]+)\/cards$/)) && M === "POST") {
    const s = await sess(m[1]); if (!mine(s) || s.status !== "open") return E2("session not open");
    const pend = (await hs.list("cards", { session_id: s.id, status: "pending" }, "id")).map(cardIn);
    const inp = (body.cards || []).slice(0, 80), fresh = [], touched = new Set(); let added = 0; const ids = [];   // ids[i] = card that input line i landed in (training labels link boxes to cards)
    const nNew = inp.filter(c => c.part && c.part !== "?").length, newIds = nNew ? await hs.nextIds("card", nNew) : [];
    for (const c of inp) {
      if (!c.part || c.part === "?") { ids.push(null); continue; }   // unidentified crops are never saved as cards
      const ex = pend.find(x => x.part === c.part && x.color === +c.color);
      if (ex) { ex.qty += +c.qty || 1; touched.add(ex); ids.push(ex.id); continue; }
      const id = newIds.shift();
      let image_id = null;
      if (c.crop && c.crop.length < 400000) {
        const b64 = c.crop.replace(/^data:image\/\w+;base64,/, "");
        image_id = await sh.addImage(String(c.part), +c.color || 0, b64); await sh.addIdentification(image_id, String(c.part), +c.confidence || 0);
      }
      const card = { id, image_id, session_id: s.id, part: String(c.part).slice(0, 40), name: String(c.name || "").slice(0, 120), color: +c.color || 0, qty: +c.qty || 1,
        confidence: +c.confidence || 0, alts: (c.alts || []).slice(0, 4), color_guesses: (c.color_guesses || []).slice(0, 6).map(Number).filter(Number.isFinite), status: "pending", bag_code: null };
      pend.push(card); fresh.push(card); added++; ids.push(id);
    }
    await hs.batch([...fresh, ...[...touched].filter(c => !fresh.includes(c))].map(c => hs.putStmt("cards", cardRow(c))));
    return J2({ ok: true, added, ids });
  }
  if ((m = path.match(/^crop\/(\d+)$/))) {
    const v = (await sh.image(m[1]))?.jpeg_b64; if (!v) return E2("nf", 404);
    return new Response(Uint8Array.from(atob(v), c => c.charCodeAt(0)), { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=86400", "x-robots-tag": "noindex" } });
  }
  if ((m = path.match(/^card\/(\d+)$/)) && M === "POST") {
    const c = cardIn(await hs.get("cards", { id: +m[1] })); const s = c && await sess(c.session_id);
    if (!mine(s)) return E2("not found", 404);
    if (c.status !== "pending") return E2(`this lot is already ${c.status}`, 409);
    if (body.action === "drop") { c.status = "dropped"; await hs.put("cards", cardRow(c)); return J2({ ok: true }); }
    if (body.part && body.part !== c.part) { const np = String(body.part).trim().slice(0, 40); if (!validPart(np)) return E2("bad part number"); c.part = np; c.name = String(body.name || ""); }
    if (body.color !== undefined && body.color !== "") c.color = +body.color;
    if (body.qty) c.qty = Math.max(1, +body.qty);
    if (body.action === "confirm" && !validPart(c.part)) return E2("this card has no part number", 400);
    if (body.action === "confirm") {
      // confirmed lots collect in the session's open bag (bag_code null) until a bag label is scanned to seal them
      if (!s.box_id) return E2("Scan the box master QR first", 409);
      c.status = "confirmed"; c.bag_code = null; await hs.put("cards", cardRow(c));
      if (c.image_id) await sh.confirmIdentification(c.image_id, c.part, c.color);
      const ol = await R.openLots(s.id);
      return J2({ ok: true, lot: lotOut(c), open_lots: ol.map(lotOut), meter: await meterOf(sh, ol, host, await capsOf(s)), part: c.part, color: c.color, color_name: colorName(c.color), qty: c.qty, name: c.name });
    }
    await hs.put("cards", cardRow(c));
    return J2({ ok: true, part: c.part, name: c.name, color: c.color, color_name: colorName(c.color), qty: c.qty });
  }
  // ---- training data
  if (path === "train/cards") {   // final state of the cards a photo produced (only this host's cards)
    const want = (url.searchParams.get("ids") || "").split(",").map(Number).filter(Boolean).slice(0, 200);
    const cs = want.length ? await hs.list("cards", { id: want }) : [];
    const ok = new Set((cs.length ? await hs.list("sessions", { id: [...new Set(cs.map(c => c.session_id))] }) : []).filter(mine).map(s => s.id));
    const byId = new Map(cs.map(c => [c.id, c]));
    return J2({ cards: want.map(id => byId.get(id)).filter(c => c && ok.has(c.session_id)).map(c => ({ id: c.id, status: c.status, part: c.part, color: c.color })) });
  }
  if (path === "train/sample" && M === "POST") {
    const id = String(body.id || ""); if (!/^[0-9a-f]{32}$/.test(id)) return E2("bad sample id");
    const b64 = String(body.image || "").replace(/^data:image\/jpeg;base64,/, ""); if (!b64 || b64.length > 1.6e6 || !b64.startsWith("/9j/")) return E2("bad image");
    const L = cleanLabels(body.labels || {}, id); if (!L) return E2("bad labels");
    const added = await trainStore(D1, env.PTSA).add(id, L, b64, host.id);
    return J2({ ok: true, added });
  }
  if (path === "host/train" || path === "host/train/delete") {
    if (!admin) return E2("host admins only", 403);
    const ts = trainStore(D1, env.PTSA);
    if (path === "host/train/delete" && M === "POST") { const n = Array.isArray(body.ids) ? await ts.deleteIds(host.id, body.ids) : await ts.deleteHost(host.id); await audit("training photos deleted", `${n}`); return J2({ ok: true, deleted: n, ...(await ts.stats(host.id)) }); }
    return J2(await ts.stats(host.id));
  }
  if ((m = path.match(/^bag\/([\w-]+)$/)) && M === "GET") {
    const b = await R.bag(m[1]); if (!b || b.status === "void") return E2(`${m[1]}: unknown or expired bag QR`, 404);
    return J2({ bag: await R.bagOut(b) });
  }
  if ((m = path.match(/^bag\/([\w-]+)\/reopen$/)) && M === "POST") {   // make an earlier (still unbagged) bag of an open session the open bag again
    const b = await R.bag(m[1]); const s = b && await sess(b.session_id);
    if (!b || !mine(s) || s.status !== "open") return E2("not found or session closed", 404);
    const q = await R.qr(b.code);
    if (b.status !== "labelled" || !q || !["open", "issued"].includes(q.status)) return E2("this bag is already bagged, boxed or expired", 409);
    const closed = await R.closeOpen(s.id, b.code);
    await hs.update("qrcodes", { code: b.code }, { status: "open", expires: Date.now() + QR_TTL });
    return J2({ ok: true, bag: await R.bagOut(b), closed: await R.bagsOut(closed) });
  }
  // sorter: scan the box master QR at the start (links the batch's box to this session), then a bag QR from that box's sheet seals the open bag into it
  if ((m = path.match(/^session\/([\w-]+)\/scan$/)) && M === "POST") {
    const s = await sess(m[1]); if (!mine(s) || s.status !== "open") return E2("session not open");
    const code = String(body.code || "").trim().toUpperCase();
    if (/^BX\d+$/.test(code)) { const box = await hs.get("boxes", { barcode: code }); if (!box) return E2(`${code}: not a known box QR`, 404);
      if (s.box_id && s.box_id !== box.id) return E2("this session already works on another box", 409);
      if (box.sorter_id && box.sorter_id !== s.user_id) return E2("this box is prepared for another sorter", 409);
      const other = (await hs.list("sessions", { box_id: box.id })).find(x => x.id !== s.id);
      if (other) return E2(other.status === "open" ? `Box ${code} is open in session ${other.id}.` : "this box is already used by another sorting session", 409, other.status === "open" ? { in_use: other.id } : undefined);
      if (box.closed_at) return E2(`${code} was closed as full: reopen it or scan a new box`, 409, { closed_box: { id: box.id, barcode: box.barcode, bags: (await hs.list("bags", { box_id: box.id, status: { ne: "void" } })).length } });
      const bs = await hs.list("bags", { box_id: box.id, status: { ne: "void" } }, "id");
      const busy = bs.find(b => b.session_id && b.session_id !== s.id && !b.sealed_at && b.status === "labelled");
      if (busy) return E2(`Box ${code} is open in session ${busy.session_id}.`, 409, { in_use: busy.session_id });   // sealed bags of an earlier session are fine (reopened box)
      s.box_id = box.id; await hs.update("sessions", { id: s.id }, { box_id: box.id });
      return J2({ ok: true, box, sealed: null }); }
    const bag = await R.bag(code);
    // old pre-printed per-box bag QRs (batch-prep sheets) are retired: only GBL labeled bags (BG...) are handed out now
    if (bag && R.retired(bag)) return E2("This QR is from an old per-box bag sheet and is no longer used. Set the bag aside and scan a GBL labeled bag.", 409, { retired: true });
    if (!bag || bag.status === "void") return E2(`${code}: not a known box or bag QR`, 404);
    if (!s.box_id) return E2("Scan the box master QR first", 409);
    const box = await hs.get("boxes", { id: s.box_id }), cur = await R.curBag(s);
    if (cur && cur.code === bag.code) return E2(`This is already the open bag: Bag ${cur.box_n}`, 409);
    // pre-labeled supply: a free label has no box yet (or, for older sheets, belongs to this box unused); anything else is used and must not be reused
    const used = bag.trace || bag.sealed_at || bag.status !== "labelled" || (bag.session_id && bag.session_id !== s.id) || (bag.box_id && bag.box_id !== s.box_id) || bag.box_n || (await R.lots(bag)).length;
    if (used) { const bx = bag.box_id ? await hs.get("boxes", { id: bag.box_id }) : null;
      return E2(`Bag label ${bag.code} is already used${bx ? ` (box ${bx.barcode}${bag.box_n ? `, Bag ${bag.box_n}` : ""})` : ""}. Set it aside and scan a fresh bag.`, 409, { used: true }); }
    const ol = await R.openLots(s.id); let sealed = null;
    if (cur) { if (!ol.length) return E2(`Bag ${cur.box_n} is still empty: confirm some parts into it first`, 409); sealed = await R.seal(s, cur, ol); sealed.meter = await meterOf(sh, sealed.lots, host, await capsOf(s)); }
    // no bag yet but confirmed parts waiting: they simply belong to this first bag
    const n = ((await hs.list("bags", { box_id: box.id, status: { ne: "void" } })).reduce((a, b) => Math.max(a, b.box_n || 0), 0)) + 1;
    Object.assign(bag, { box_id: box.id, box_n: n, session_id: s.id, user_id: s.user_id, location: box.shelf || "" });
    await hs.batch([hs.updateStmt("bags", { id: bag.id }, { box_id: box.id, box_n: n, session_id: s.id, user_id: s.user_id, location: bag.location }),
      hs.updateStmt("qrcodes", { code: bag.code }, { session_id: s.id, user_id: s.user_id, status: "open" })]); await hs.staleTotals();
    return J2({ ok: true, bag: { code: bag.code, n, box_code: box.barcode }, sealed });
  }
  // "Box full": seal the current bag (if it has parts), close the box; the sorter scans a new box and numbering restarts at 1
  if ((m = path.match(/^session\/([\w-]+)\/box-full$/)) && M === "POST") {
    const s = await sess(m[1]); if (!mine(s) || s.status !== "open") return E2("session not open");
    if (!s.box_id) return E2("No box is open", 409);
    const box = await hs.get("boxes", { id: s.box_id }), cur = await R.curBag(s), ol = await R.openLots(s.id); let sealed = null;
    if (ol.length && !cur) return E2("Parts are waiting with no bag: scan a bag to put them in first", 409);
    if (cur) sealed = ol.length ? await R.seal(s, cur, ol) : (await R.release(cur), null);
    if (sealed) sealed.meter = await meterOf(sh, sealed.lots, host, await capsOf(s));
    await hs.batch([hs.updateStmt("boxes", { id: box.id }, { closed_at: now() }), hs.updateStmt("sessions", { id: s.id }, { box_id: null })]);
    return J2({ ok: true, closed: { code: box.barcode, shelf: box.shelf || "", bags: (await hs.list("bags", { box_id: box.id, status: { ne: "void" } })).filter(b => b.sealed_at || b.status === "bagged").length }, sealed });
  }
  if ((m = path.match(/^bag\/([\w-]+)\/close$/)) && M === "POST") {
    const b = await R.bag(m[1]); if (!b || !mine(await sess(b.session_id))) return E2("not found", 404);
    await hs.update("qrcodes", { code: b.code, status: "open" }, { status: "issued" }); return J2({ ok: true, bag: await R.bagOut(b) });
  }
  if ((m = path.match(/^lot\/(\d+)$/)) && M === "POST") {   // a lot inside a bag: edit color/qty/part, remove from bag, or undo the removal
    const c = cardIn(await hs.get("cards", { id: +m[1] })); const s = c && await sess(c.session_id);
    const b = s && c.bag_code ? await R.bag(c.bag_code) : null;   // no bag_code: the lot is in the session's open bag
    if (!s || (c.bag_code && !b) || s.host_id !== host.id || !(admin || s.user_id === user.id || b?.user_id === user.id)) return E2("not found", 404);
    if (body.action === "remove") c.status = "removed";
    else if (body.action === "restore") c.status = "confirmed";
    else { if (c.status !== "confirmed") return E2("this part was removed from the bag", 409);
      if (body.part && body.part !== c.part) { const np = String(body.part).trim().slice(0, 40); if (!validPart(np)) return E2("bad part number"); c.part = np; c.name = String(body.name || ""); }
      if (body.color !== undefined && body.color !== "") c.color = +body.color;
      if (body.qty) c.qty = Math.max(1, +body.qty); }
    await hs.put("cards", cardRow(c));
    if (!b) { const ol = await R.openLots(s.id); return J2({ ok: true, id: c.id, status: c.status, part: c.part, name: c.name, color: c.color, color_name: colorName(c.color), qty: c.qty, open_lots: ol.map(lotOut), meter: await meterOf(sh, ol, host, await capsOf(s)) }); }
    await R.syncBag(b); await hs.staleTotals();
    return J2({ ok: true, id: c.id, status: c.status, part: c.part, name: c.name, color: c.color, color_name: colorName(c.color), qty: c.qty, bag: await R.bagOut(b) });
  }
  if ((m = path.match(/^bag\/([\w-]+)\/bagged$/)) && M === "POST") {
    const b = await R.bag(m[1]); if (!b || b.status === "void") return E2("unknown or expired QR", 404);
    await hs.update("qrcodes", { code: b.code }, { status: "used" }); if (b.status === "labelled") await hs.update("bags", { id: b.id }, { status: "bagged" }); return J2({ ok: true });
  }
  if (path === "boxes") {
    if (M === "POST") return E2("boxes are created in Batch prep (host/batch)", 404);
    const bx = await hs.list("boxes", {}, "id desc");
    const per = new Map((await hs.group("bags", "box_id", { box_id: bx.map(x => x.id), status: { ne: "void" } }, "qty")).map(r => [r.k, r]));
    return J2({ boxes: bx.map(x => ({ ...x, nb: per.get(x.id)?.n || 0, pcs: per.get(x.id)?.s || 0 })) });
  }
  if ((m = path.match(/^box\/(\d+)$/))) {
    const box = await hs.get("boxes", { id: +m[1] }); if (!box) return E2("not found", 404);
    let msg = null;
    if (M === "POST") {
      if (body.action === "shelf") { box.shelf = String(body.shelf || "").trim().toUpperCase().slice(0, 24); await hs.put("boxes", box); await hs.update("bags", { box_id: box.id }, { location: box.shelf }); msg = "Shelf address saved."; }
      if (body.action === "add") return E2("bags are added to boxes in Batch prep", 400);
      if (body.action === "reopen") { if (!box.closed_at) return E2("this box is not closed", 409); box.closed_at = null; await hs.update("boxes", { id: box.id }, { closed_at: null }); msg = `Box ${box.barcode} reopened: bag numbers continue.`; await audit("box reopened", box.barcode); }   // anyone on the host (sorter or admin)
      if (body.action === "remove") { const b = await R.bag(body.code); if (b && b.box_id === box.id) await hs.update("bags", { id: b.id }, { box_id: null }); }
    }
    return J2({ box, msg, bags: await R.bagsOut(await hs.list("bags", { box_id: box.id, status: { ne: "void" } }, "id")),
      loose: await R.bagsOut(await hs.list("bags", { box_id: null, status: ["labelled", "bagged"] }, "id desc", 50)) });
  }
  if (path === "mold-exceptions") return J2({ parts: await sh.moldExceptions() });
  if (path === "host/mold-exceptions" && M === "POST") {
    if (!admin) return E2("host admins only", 403);
    const part = String(body.part || "").trim();
    if (!/^[A-Za-z0-9.\-]{1,40}$/.test(part)) return E2("That doesn't look like a part number.");
    if (body.action === "remove") await sh.removeMoldException(part);
    else await sh.addMoldException(part, String(body.note || "").slice(0, 120), `${user.username} (${host.site_name})`);
    return J2({ ok: true, parts: await sh.moldExceptions() });
  }
  // ---- inventory file (.bsx) export: one Item per part/color lot of the confirmed cards (void bags left out)
  const invFile = async (cards, fname) => {
    const voids = new Set((await hs.list("bags", { status: "void" })).map(b => b.code));
    const xml = inventoryXml(lotsFromCards(cards.filter(c => !c.bag_code || !voids.has(c.bag_code))), { colorName: id => (PALETTE[id] || [""])[0] });
    return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8", "content-disposition": `attachment; filename="${fname}"`, "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } }); };
  if ((m = path.match(/^export\/session\/([\w-]+)$/)) && M === "GET") {
    if (!admin) return E2("host admins only", 403);   // inventory files are a host-admin export, not a sorter download
    const s = await sess(m[1]); if (!mine(s)) return E2("not found", 404);
    return invFile(await hs.list("cards", { session_id: s.id, status: "confirmed" }, "id"), `${s.id}.bsx`); }
  if (path === "host/export" && M === "GET") {   // all of this host's sessions, or ?sessions=S-1,S-2
    if (!admin) return E2("host admins only", 403);
    const ids = (url.searchParams.get("sessions") || "").split(",").map(x => x.trim()).filter(x => /^[\w-]{1,40}$/.test(x)).slice(0, 200);
    const cards = await hs.list("cards", ids.length ? { session_id: ids, status: "confirmed" } : { status: "confirmed" }, "id");
    return invFile(cards, `${ids.length === 1 ? ids[0] : "host-" + host.id + "-" + now().slice(0, 10)}.bsx`); }
  // ---- shared parts data (names + the colors each part comes in), used by the verify card's color list
  if (path === "parts/info" && M === "GET") {
    const ps = [...new Set((url.searchParams.get("p") || "").split(",").map(x => x.trim()).filter(validPart))].slice(0, 10);
    const rows = ps.length ? (await D1.prepare(`select part, name, colors from parts where part in (${ps.map(() => "?").join(",")})`).bind(...ps).all()).results : [];
    return J2({ parts: Object.fromEntries(rows.map(r => [r.part, { name: r.name || "", colors: JSON.parse(r.colors || "[]") }])) }, 200, { "cache-control": "private, max-age=300" }); }
  if (path === "host/parts/import" && M === "POST") {   // host admins only; writes ONLY shared tables (parts, colors), never host data
    if (!admin) return E2("host admins only", 403);
    if (+(req.headers.get("content-length") || 0) > IMPORT_LIMITS.bodyBytes) return E2("request too large", 413);
    const v = validateImport(body); if (v.error) return E2(v.error);
    const ids = v.parts.map(p => p.part), have = new Map();
    for (let i = 0; i < ids.length; i += 90) { const c = ids.slice(i, i + 90);
      for (const r of (await D1.prepare(`select part, name, colors from parts where part in (${c.map(() => "?").join(",")})`).bind(...c).all()).results) have.set(r.part, r); }
    const st = []; let added = 0, updated = 0, same = 0;
    for (const p of v.parts) { const o = have.get(p.part);
      const old = o ? JSON.parse(o.colors || "[]") : [], cols = [...old, ...p.colors.filter(c => !old.includes(c))], name = (o && o.name) || p.name;
      if (o && cols.length === old.length && name === (o.name || "")) { same++; continue; }
      o ? updated++ : added++;
      st.push(D1.prepare("insert into parts(part, name, colors) values(?,?,?) on conflict(part) do update set name = excluded.name, colors = excluded.colors").bind(p.part, name, JSON.stringify(cols))); }
    let colorsAdded = 0;
    for (const [id, name] of v.colors) if (!PALETTE[id]) { st.push(D1.prepare("insert or ignore into colors(id, name) values(?,?)").bind(id, name)); PALETTE[id] = [name]; colorsAdded++; }
    for (let i = 0; i < st.length; i += 50) await D1.batch(st.slice(i, i + 50));
    await audit("parts file imported", `${added} added, ${updated} updated`); return J2({ ok: true, added, updated, unchanged: same, colors_added: colorsAdded, errors: v.errors, n_errors: v.n_errors }); }
  if (path.startsWith("host")) {
    const prepOK = prep && (/^host\/(batch|bag-labels|bag-sizes)$/.test(path) || /^host\/(sheet|bag)\//.test(path)) && !(path === "host/bag-sizes" && M === "POST");
    if (!admin && !prepOK) return E2("host admins only", 403);
    if (path === "host") { const us = await hs.list("users", {}, "id"), ns = new Map((await hs.group("sessions", "user_id")).map(r => [r.k, r.n]));
      const ss = await hs.list("sessions", {}, "started desc", 30), un = new Map(us.map(u => [u.id, u.username]));
      return J2({ host, users: us.map(u => ({ username: u.username, display: u.display, role: u.role, prep: +u.prep_only === 1, status: u.status || "active", locked: !!(u.locked_until && Date.parse(u.locked_until + "Z") > Date.now()), me: u.id === user.id, ns: ns.get(u.id) || 0, pay_share: +u.pay_share || 0 })), bag_sizes: await hs.list("bag_sizes", {}, "id"), sessions: ss.map(s => ({ ...s, username: un.get(s.user_id), pay: pay(s, host) })) }); }
    // delete whole sessions (cards, bags, QR codes, crops) and boxes, e.g. data made by automated test runs.
    // {sessions: [...], boxes: [...], dry: true} returns the rows (with crops when backup: true) without deleting anything.
    if (path === "host/purge" && M === "POST") {
      const sids = [...new Set((body.sessions || []).map(String))].slice(0, 500), bxids = [...new Set((body.boxes || []).map(Number).filter(Number.isInteger))].slice(0, 200);
      const chunk = async (t, k, v) => { const o = []; for (let i = 0; i < v.length; i += 80) o.push(...await hs.list(t, { [k]: v.slice(i, i + 80) })); return o; };
      const ss = await chunk("sessions", "id", sids), ok = ss.map(s => s.id);
      const cards = await chunk("cards", "session_id", ok), bags = await chunk("bags", "session_id", ok);
      const qrs = [...await chunk("qrcodes", "session_id", ok), ...(await chunk("qrcodes", "code", bags.map(b => b.code))).filter(q => !ok.includes(q.session_id))];
      const strays = (await chunk("cards", "bag_code", bags.map(b => b.code))).filter(c => !ok.includes(c.session_id));   // lots of other sessions inside these bags (kept, unlinked)
      const boxes = await chunk("boxes", "id", bxids), inBox = (await chunk("bags", "box_id", boxes.map(x => x.id))).filter(b => !ok.includes(b.session_id));   // kept bags in purged boxes -> unboxed
      const imgIds = [...new Set(cards.map(c => c.image_id).filter(x => x !== null && x !== undefined))];
      const rows = { sessions: ss, cards, bags, qrcodes: qrs, boxes, kept_bags_unboxed: inBox.map(b => b.code), kept_cards_unlinked: strays.map(c => c.id), image_ids: imgIds };
      if (body.dry) return J2({ dry: true, counts: Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.length])), ...(body.backup ? { rows, images: await sh.images(imgIds) } : {}) });
      const st = [];
      for (let i = 0; i < ok.length; i += 80) { const c = ok.slice(i, i + 80); st.push(hs.delStmt("cards", { session_id: c }), hs.delStmt("bags", { session_id: c }), hs.delStmt("qrcodes", { session_id: c }), hs.delStmt("sessions", { id: c })); }
      const qc = qrs.map(q => q.code); for (let i = 0; i < qc.length; i += 80) st.push(hs.delStmt("qrcodes", { code: qc.slice(i, i + 80) }));
      for (const c of strays) st.push(hs.updateStmt("cards", { id: c.id }, { bag_code: null }));
      for (const b of inBox) st.push(hs.updateStmt("bags", { id: b.id }, { box_id: null }));
      for (let i = 0; i < boxes.length; i += 80) st.push(hs.delStmt("boxes", { id: boxes.slice(i, i + 80).map(x => x.id) }));
      st.push(...sh.deleteImagesStmts(imgIds));
      await hs.batch(st); if (ok.length || boxes.length) await hs.staleTotals(); await audit("purged", `${ok.length} sessions, ${boxes.length} boxes`, ok.slice(0, 10).join(" "));
      return J2({ ok: true, deleted: Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.length])) });
    }
    // people: role, password reset, off/on, end sign-ins (kill switch), remove (only without sessions)
    if (path === "host/user" && M === "POST") {
      const u = await hs.get("users", { username: String(body.username || "").trim().toLowerCase() }); if (!u) return E2("no such user", 404);
      const self = u.id === user.id, a = String(body.action || ""), bump = () => (+u.token_ver || 0) + 1;
      if (a === "role") { const r = body.role === "admin" ? "admin" : "sorter", pf = body.role === "prep" ? 1 : 0;
        if (self && r !== "admin") return E2("You can't remove your own admin role. Ask another admin.", 409);
        await hs.update("users", { id: u.id }, { role: r, prep_only: pf }); const lbl = r === "admin" ? "admin" : pf ? "prep helper" : "sorter";
        await audit("role set", u.username, lbl); return J2({ ok: true, msg: `${u.username} is now ${lbl === "admin" ? "an admin" : `a ${lbl}`}.` }); }
      if (a === "reset") { const pw = String(body.password || ""); if (pw.length < 8) return E2("Temporary password: 8 or more characters.");
        await hs.update("users", { id: u.id }, { pw_hash: await hashPw(pw), pw_changed: now(), token_ver: bump(), failed_logins: 0, locked_until: null });
        await audit("password reset", u.username, "temporary password set by admin; signed out everywhere"); return J2({ ok: true, msg: `New password set for ${u.username}. Tell them in person; they can change it under Account.` }); }
      if (a === "disable" || a === "enable") { if (self) return E2("You can't turn off your own account.", 409);
        await hs.update("users", a === "disable" ? { id: u.id } : { id: u.id }, a === "disable" ? { status: "disabled", token_ver: bump() } : { status: "active", failed_logins: 0, locked_until: null });
        await audit(a === "disable" ? "account turned off" : "account turned on", u.username, a === "disable" ? "signed out everywhere" : null);
        return J2({ ok: true, msg: a === "disable" ? `${u.username} is turned off and signed out everywhere.` : `${u.username} can sign in again.` }); }
      if (a === "kill") { await hs.update("users", { id: u.id }, { token_ver: bump() }); await audit("signed out everywhere", u.username, "by admin");
        return J2({ ok: true, msg: `${u.username} is signed out on every phone.` }); }
      if (a === "remove") { if (self) return E2("You can't remove yourself.", 409);
        const n = (await hs.list("sessions", { user_id: u.id }, "", 1)).length; if (n) return E2(`${u.username} has sorting sessions, so the account is kept for pay records. Turn it off instead.`, 409);
        await hs.del("users", { id: u.id }); await audit("user removed", u.username); return J2({ ok: true, msg: `${u.username} removed.` }); }
      return E2("unknown action");
    }
    if (path === "host/audit" && M === "GET") return J2({ entries: await hs.list("audit", {}, "id desc", 300) });
    // sessions and pay as CSV (host admins only; times in Central time)
    if (path === "host/pay.csv" && M === "GET") {
      const ss = await hs.list("sessions", {}, "started desc", 5000), us = new Map((await hs.list("users", {}, "id")).map(u => [u.id, u]));
      const per = new Map(); for (let i = 0; i < ss.length; i += 80) for (const r of await hs.group("bags", "session_id", { session_id: ss.slice(i, i + 80).map(s => s.id), status: { ne: "void" } }, "qty")) per.set(r.k, r);
      const ct = t => t ? new Date(Date.parse(t + "Z")).toLocaleString("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).replace(",", "") : "";
      const rows = [["session", "sorter", "started (CT)", "ended (CT)", "status", "bags", "pieces", "sorted weight (lb)", "hours", "pay basis", "pay ($)"]];
      for (const s of ss) rows.push([s.id, us.get(s.user_id)?.username || "", ct(s.started), ct(s.ended), s.status, per.get(s.id)?.n || 0, per.get(s.id)?.s || 0, s.weight_lb ?? "", sessHours(s).toFixed(2),
        host.pay_mode === "hr" ? `$${host.rate_hr.toFixed(2)}/h` : `$${host.rate_lb.toFixed(2)}/lb`, host.pay_mode !== "hr" && !s.weight_lb ? "" : payAmt(s, host).toFixed(2)]);
      await audit("pay CSV downloaded", `${ss.length} sessions`);
      return new Response(rows.map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n", { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="paidtosort-sessions-pay.csv"`, "x-robots-tag": "noindex, nofollow", "cache-control": "no-store" } });
    }
    if (path === "host/settings" && M === "POST") {
      Object.assign(host, { site_name: String(body.site_name || host.site_name).slice(0, 80), pay_mode: body.pay_mode === "hr" ? "hr" : "lb", rate_lb: +body.rate_lb || 1.35, rate_hr: +body.rate_hr || 10, low_threshold: Math.max(1, +body.low_threshold || 3),
        payout_share: Math.min(1, Math.max(0, +body.payout_share || 0)), bag_max_g: Math.max(0, +(body.bag_max_g ?? host.bag_max_g ?? 110) || 0), bag_max_cm3: Math.max(0, +(body.bag_max_cm3 ?? host.bag_max_cm3) || 0),
        loose_density: Math.min(2, Math.max(0.05, +body.loose_density || host.loose_density || 0.4)) });
      if (body.contact_note !== undefined) host.contact_note = String(body.contact_note || "").trim().slice(0, 300);
      await hs.put("hosts", host); await audit("settings saved", host.site_name, `pay ${host.pay_mode === "hr" ? `$${host.rate_hr}/h` : `$${host.rate_lb}/lb`}, default share ${host.payout_share}`); return J2({ ok: true, msg: "Settings saved." });
    }
    if (path === "host/sorter" && M === "POST") {
      const un = String(body.username || "").trim().toLowerCase();
      if (!/^[a-z0-9_.-]{3,32}$/.test(un) || String(body.password || "").length < 8) return E2("Username 3-32 letters/numbers; password 8+ characters.");
      if (await findLogin(D1, un)) return E2("That username is taken.");
      // the id sequence can lag behind users created outside it (seeded / imported): never reuse an id, that would overwrite an existing person
      let uid = await hs.nextId("user"); const top = Math.max(0, ...(await hs.list("users", {}, "id")).map(x => +x.id || 0));
      if (uid <= top) { uid = top + 1; await D1.prepare("update host_seq set v = ? where host_id = ? and name = 'user'").bind(uid, host.id).run(); }
      await hs.put("users", { id: uid, username: un, pw_hash: await hashPw(body.password), role: "sorter", display: String(body.display || un).slice(0, 60), created: now(), pay_share: Math.min(1, Math.max(0, +host.payout_share || 0)) });
      await audit("sorter added", un); return J2({ ok: true, msg: `Sorter ${un} added.` });
    }
    // per-sorter pay: share of the parts value shown to that sorter as estimated earnings (0 = show the parts value only)
    if (path === "host/sorter/pay" && M === "POST") { const u = await hs.get("users", { username: String(body.username || "").trim().toLowerCase() }); if (!u) return E2("no such user", 404);
      const was = +u.pay_share || 0; u.pay_share = Math.min(1, Math.max(0, +body.pay_share || 0)); await hs.put("users", u); await audit("pay share set", u.username, `${Math.round(was * 100)}% -> ${Math.round(u.pay_share * 100)}%`); return J2({ ok: true, username: u.username, pay_share: u.pay_share }); }
    // bag sizes (host list): add / edit / remove. A size in use by a box can be edited but not removed.
    if (path === "host/bag-sizes" && M === "GET") return J2({ sizes: await hs.list("bag_sizes", {}, "id") });
    if (path === "host/bag-sizes" && M === "POST") { const sizes = await hs.list("bag_sizes", {}, "id"), name = String(body.name || "").trim().slice(0, 40);
      const g = Math.max(0, +body.max_g || 0), v = Math.max(0, +body.max_cm3 || 0);
      if (body.action === "remove") { const z = sizes.find(x => x.id === +body.id); if (!z) return E2("not found", 404);
        if ((await hs.list("boxes", { bag_size_id: z.id }, "id", 1)).length) return E2("this bag size is used by a box; edit it instead", 409);
        await hs.batch([hs.delStmt("bag_sizes", { id: z.id })]); return J2({ ok: true, sizes: await hs.list("bag_sizes", {}, "id") }); }
      if (!name || !(g > 0 || v > 0)) return E2("Give the bag size a name and a weight (oz) or volume (cu in) limit.");
      if (body.action === "edit") { const z = sizes.find(x => x.id === +body.id); if (!z) return E2("not found", 404); Object.assign(z, { name, max_g: g, max_cm3: v }); await hs.put("bag_sizes", z); }
      else await hs.put("bag_sizes", { id: Math.max(0, ...sizes.map(x => x.id)) + 1, name, max_g: g, max_cm3: v });
      return J2({ ok: true, sizes: await hs.list("bag_sizes", {}, "id") }); }
    // ---- batch prep (admin, before the sorter leaves): N boxes, each = 1 master QR (box barcode) + M bag QRs (bag 1..M), printed as one sheet
    // pre-labeled bag supply: admins print a sheet of permanent bag QRs (no box); the sorter's scan gives each its number in a box
    if (path === "host/bag-labels" && M === "POST") {
      const n = Math.min(200, Math.max(1, Math.floor(+body.count) || 0)); if (!(+body.count >= 1)) return E2("how many bag labels?");
      const seq = await hs.nextIds("baglabel", n), ids = await hs.nextIds("bag", n), st = [], codes = [];
      for (let k = 0; k < n; k++) { const code = R.labelCode(seq[k]); if (await R.qr(code)) return E2("label number clash; try again", 409); codes.push(code);
        st.push(hs.putStmt("qrcodes", { code, session_id: null, user_id: null, created: now(), expires: Date.now() + LABEL_TTL, status: "issued" }),
          hs.putStmt("bags", { id: ids[k], code, host_id: host.id, session_id: null, user_id: null, part: "", name: "", color: 0, qty: 0, box_id: null, location: "", status: "labelled", promoted_at: null, picked_at: null, created: now() })); }
      for (let i = 0; i < st.length; i += 80) await hs.batch(st.slice(i, i + 80)); await hs.staleTotals();
      await audit("bag labels made", `${codes[0]} to ${codes[codes.length - 1]}`, `${n} labels`); return J2({ ok: true, from: seq[0], to: seq[n - 1], labels: codes });
    }
    if (path === "host/bag-labels" && M === "GET") {   // reprint a range (?from=1&to=40) or list the free supply
      const f = Math.floor(+url.searchParams.get("from")), t = Math.floor(+url.searchParams.get("to"));
      if (f >= 1 && t >= f) { const codes = []; for (let k = f; k <= Math.min(t, f + 199); k++) codes.push(R.labelCode(k));
        const have = new Map((await hs.list("bags", { code: codes })).map(b => [b.code, b])); return J2({ from: f, to: t, labels: codes.filter(c => have.has(c)) }); }
      const free = (await hs.list("bags", { box_id: null, session_id: null, status: "labelled", code: { prefix: R.labelCode(0).slice(0, 4) } }, "id")).filter(b => !b.trace);
      return J2({ free: free.length, labels: free.slice(0, 200).map(b => b.code) });
    }
    // admin bag lookup: any bag QR -> its box, number, sorter, dates and contents; mark it missing / moved (or clear that)
    if ((m = path.match(/^host\/bag\/([\w-]+)$/))) {
      const b = await R.bag(m[1]); if (!b) return E2(`${m[1].toUpperCase()}: not a bag QR of this host`, 404);
      if (M === "POST") { const a = body.action;
        if (!["missing", "moved", "clear"].includes(a)) return E2("action: missing, moved or clear");
        const note = String(body.note || "").trim().slice(0, 120); if (a === "moved" && !note) return E2("where is it now? add a note");
        Object.assign(b, a === "clear" ? { trace: null, trace_note: null, trace_at: null } : { trace: a, trace_note: note || null, trace_at: now() });
        await hs.update("bags", { id: b.id }, { trace: b.trace, trace_note: b.trace_note, trace_at: b.trace_at }); await audit(a === "clear" ? "bag mark cleared" : `bag marked ${a}`, b.code, note || null); }
      const bo = await R.bagOut(b), box = b.box_id ? await hs.get("boxes", { id: b.box_id }) : null, who = b.user_id ? await hs.get("users", { id: b.user_id }) : null;
      return J2({ bag: { ...bo, sorter: who?.username || null, box: box ? { id: box.id, barcode: box.barcode, shelf: box.shelf || "", closed_at: box.closed_at || null } : null,
        state: b.trace || (b.sealed_at || b.status === "bagged" ? "sealed" : b.box_n ? "filling" : "unused") }, msg: M === "POST" ? "Saved." : null });
    }
    if (path === "host/batch" && M === "POST") {
      const nb = Math.min(20, Math.max(1, +body.boxes || 1)), nq = 0, shelf = String(body.shelf || "").trim().toUpperCase().slice(0, 24), made = [];
      const wg = body.weight_g === undefined || body.weight_g === "" || body.weight_g === null ? null : +body.weight_g; if (wg !== null && !(wg > 0 && wg < 1e6)) return E2("batch weight looks wrong");
      let sizeId = null; if (body.bag_size_id) { const z = await hs.get("bag_sizes", { id: +body.bag_size_id }); if (!z) return E2("no such bag size"); sizeId = z.id; }
      let sorterId = null; if (body.sorter) { const su = await hs.get("users", { username: String(body.sorter).trim().toLowerCase() }); if (!su) return E2("no such sorter on this host"); sorterId = su.id; }
      let n = (await hs.count("boxes")).n + 1;
      for (let k = 0; k < nb; k++) { let bc; do { bc = `BX${String(host.id).padStart(2, "0")}${String(n++).padStart(5, "0")}`; } while (await hs.get("boxes", { barcode: bc }));
        const id = await hs.nextId("box"); await hs.put("boxes", { id, barcode: bc, shelf, created: now(), batch_weight_g: wg, sorter_id: sorterId, bag_size_id: sizeId });
        const ids = await hs.nextIds("bag", nq), st = [];
        for (let q = 0; q < nq; q++) { let code; do { code = "PTS-" + rnd(4).toUpperCase(); } while (await R.qr(code));
          st.push(hs.putStmt("qrcodes", { code, session_id: null, user_id: null, created: now(), expires: Date.now() + PREP_TTL, status: "issued" }),
            hs.putStmt("bags", { id: ids[q], code, host_id: host.id, session_id: null, user_id: null, part: "", name: "", color: 0, qty: 0, box_id: id, location: shelf, status: "labelled", promoted_at: null, picked_at: null, created: now() })); }
        await hs.batch(st); made.push(id); }
      await hs.staleTotals(); await audit("boxes created", `${made.length} box${made.length === 1 ? "" : "es"}`, shelf || null); return J2({ ok: true, boxes: made });
    }
    if (path === "host/batch") {
      const un = new Map((await hs.list("users", {})).map(u => [u.id, u.username]));
      const bx = (await hs.list("boxes", {}, "id desc", 60)).map(x => ({ ...x, sorter: un.get(x.sorter_id) || null })), bags = bx.length ? await hs.list("bags", { box_id: bx.map(x => x.id), status: { ne: "void" } }, "id") : [];
      return J2({ boxes: bx.map(x => { const bs = bags.filter(b => b.box_id === x.id); return { ...x, nbags: bs.length, session_id: bs.find(b => b.session_id)?.session_id || null }; }), sorters: [...un.values()], bag_sizes: await hs.list("bag_sizes", {}, "id") });
    }
    if ((m = path.match(/^host\/sheet\/(\d+)$/))) {
      const box = await hs.get("boxes", { id: +m[1] }); if (!box) return E2("not found", 404);
      const bags = await hs.list("bags", { box_id: box.id, status: { ne: "void" } }, "id");
      return J2({ box, bags: bags.map((b, i) => ({ code: b.code, n: i + 1, session_id: b.session_id || null })) });
    }
  }
  if (path === "putaway" && M === "POST") {
    const b = await R.bag(body.code), shelf = String(body.shelf || "").trim().toUpperCase();
    if (!b || b.status === "void") return E2(`${body.code}: unknown or expired bag QR`, 404);
    const box = await hs.get("boxes", { barcode: shelf }); let loc;
    if (box) { b.box_id = box.id; b.location = box.shelf; loc = `box ${box.barcode} @ ${box.shelf || "(no shelf)"}`; }
    else { if (!/^[A-Z0-9][A-Z0-9 ._\/-]{0,23}$/.test(shelf)) return E2("shelf address looks wrong"); b.location = shelf; loc = shelf; }
    if (b.status === "labelled") b.status = "bagged";
    await hs.update("bags", { id: b.id }, { box_id: b.box_id, location: b.location, status: b.status }); await hs.update("qrcodes", { code: b.code }, { status: "used" });
    const bo = await R.bagOut(b), ls = bo.lots;
    return J2({ ok: true, bag: bo, msg: `${b.code} (${ls.length === 1 ? `${ls[0].qty}× ${ls[0].part} ${colorName(ls[0].color)}` : `${ls.length} lots, ${b.qty} pcs`}) → ${loc}` });
  }
  return E2("not found", 404);
}
