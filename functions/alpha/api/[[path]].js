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
const QR_TTL = 7 * 864e5, PREP_TTL = 90 * 864e5;   // batch-prep sheets are printed ahead of time

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
async function readCookie(req, secret) { // value: "<host>:<user>.<exp>.<sig>"
  const m = (req.headers.get("cookie") || "").match(/ptsa=([^;]+)/);
  if (!m) return null;
  const [who, exp, sig] = decodeURIComponent(m[1]).split(".");
  if (!sig || +exp < Date.now() || (await hmac(secret, who + "." + exp)) !== sig) return null;
  const [hid, uid] = who.split(":").map(Number);
  return Number.isInteger(hid) && Number.isInteger(uid) ? { hid, uid } : null;
}
let PALETTE = null, MIGRATED = false, SECRET = null;
const BAGS_MIGRATED = new Set();
const colorName = id => ((PALETTE || {})[id] || [String(id)])[0];
const cardIn = c => (c ? { ...c, alts: JSON.parse(c.alts || "[]"), color_guesses: JSON.parse(c.color_guesses || "[]"), crop: c.image_id ? `/alpha/api/crop/${c.image_id}` : null } : null);
const CARD_COLS = ["id", "session_id", "part", "name", "color", "qty", "confidence", "alts", "color_guesses", "image_id", "status", "bag_code"];
const cardRow = c => Object.fromEntries(CARD_COLS.filter(k => k in c).map(k => [k, c[k]]));
function pay(s, host) {
  if (host.pay_mode === "hr") { const h = ((s.ended ? Date.parse(s.ended + "Z") : Date.now()) - Date.parse(s.started + "Z")) / 36e5; return `$${(h * host.rate_hr).toFixed(2)} (${h.toFixed(2)} h × $${host.rate_hr.toFixed(2)})`; }
  return s.weight_lb ? `$${(s.weight_lb * host.rate_lb).toFixed(2)} (${s.weight_lb} lb × $${host.rate_lb.toFixed(2)})` : "weight not entered";
}
// A bag (one PTS- QR) holds many lots. Lots are the confirmed cards whose bag_code is the bag's code; removed lots get status "removed".
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
      return bags.map(b => { const q = qrs.get(b.code); const o = { ...b, color_name: colorName(b.color), box_code: boxes.get(b.box_id)?.barcode || null, lots: (lots.get(b.code) || []).map(lotOut), open: q?.status === "open" };
        if (withQr) o.qr = q; return o; }); },
    bagOut: async b => (await R.bagsOut([b]))[0],
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
  const E2 = (m, s = 400) => J2({ error: m }, s);
  if (!MIGRATED) { await migrateFromKV({ ...env, PTSDB: D1 }); await ensureIndexes(D1); MIGRATED = true; }
  if (!SECRET) SECRET = await sh.meta("secret");
  const secret = SECRET;
  if (!secret) return E2("not seeded", 500);

  if (path === "login" && M === "POST") {
    const un = String(body.username || "").trim().toLowerCase();
    const u = await findLogin(D1, un);
    if (!u || !(await checkPw(String(body.password || ""), u.pw_hash))) return E2("Wrong username or password.", 401);
    const exp = Date.now() + 14 * 864e5, v = `${u.host_id}:${u.id}.${exp}`;
    return J2({ ok: true }, 200, { "set-cookie": `ptsa=${encodeURIComponent(v + "." + (await hmac(secret, v)))}; Path=/alpha; HttpOnly; Secure; SameSite=Lax; Max-Age=1209600` });
  }
  // training-data export for the offline dataset script (EXPORT_KEY header; no cookie)
  if (path.startsWith("train/export") || path.startsWith("train/img/")) {
    if (!env.EXPORT_KEY || req.headers.get("x-export-key") !== env.EXPORT_KEY) return E2("forbidden", 403);
    const ts = trainStore(D1, env.PTSA);
    if (path === "train/export") return J2({ samples: await ts.list(url.searchParams.get("after") || "") });
    const v = await ts.image(path.slice(10)); if (!v) return E2("nf", 404);
    return new Response(Uint8Array.from(atob(v), c => c.charCodeAt(0)), { headers: { "content-type": "image/jpeg", "x-robots-tag": "noindex" } });
  }
  if (path === "logout") return J2({ ok: true }, 200, { "set-cookie": "ptsa=; Path=/alpha; Max-Age=0; HttpOnly; Secure; SameSite=Lax" });

  const ck = await readCookie(req, secret);
  if (!ck) return E2("login required", 401);
  // only the logged-in user's host, through the gatekeeper; each endpoint below reads just the rows it needs
  const hs = hostStore(D1, ck.hid), R = repo(hs);
  const user = await hs.get("users", { id: ck.uid });
  if (!user) return E2("login required", 401);
  const host = await hs.get("hosts", {});
  if (!host) return E2("login required", 401);
  if (!PALETTE) PALETTE = Object.fromEntries((await sh.colors()).map(c => [c.id, [c.name]]));
  const admin = user.role === "admin";
  const mine = s => s && s.host_id === host.id && (admin || s.user_id === user.id);
  const sess = id => hs.get("sessions", { id: String(id) });
  let m;
  // these never touch bags/QR codes: skip the per-request housekeeping
  const light = path === "identify" || path === "train/sample" || path === "train/cards" || /^crop\//.test(path) || path === "mold-exceptions" || path === "parts/info";
  if (!light) { await migrateBags(hs, sh); await R.expire(); }

  if (path === "me") {
    const ss = await hs.list("sessions", { user_id: user.id }, "started desc", 10);
    const per = new Map((await hs.group("bags", "session_id", { session_id: ss.map(s => s.id), status: { ne: "void" } }, "qty")).map(r => [r.k, r]));
    const out = { user: { id: user.id, username: user.username, display: user.display, role: user.role }, host,
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
    return J2({ s, pay: pay(s, host), owner: owner?.username, cards, bags });
  }
  if ((m = path.match(/^session\/([\w-]+)\/end$/)) && M === "POST") {
    const s = await sess(m[1]); if (!mine(s)) return E2("not found", 404);
    await hs.put("sessions", { ...s, status: "closed", ended: now(), weight_lb: body.weight_lb ? +body.weight_lb : null }); return J2({ ok: true });
  }
  if (path === "identify" && M === "POST") {
    const b64 = String(body.image || "").replace(/^data:image\/\w+;base64,/, "");
    if (!b64 || b64.length > 3e6) return E2("bad image");
    const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const fd = new FormData(); fd.append("query_image", new Blob([bin], { type: "image/jpeg" }), "crop.jpg");
    const r = await fetch("https://api.brickognize.com/predict/", { method: "POST", body: fd, headers: { accept: "application/json" } });
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
      // the session's open bag collects confirmed lots until "Close bag"; no open bag -> start a new one (one QR per bag)
      const open = (await hs.list("qrcodes", { session_id: s.id, status: "open" })).map(q => q.code);
      let bag = open.length ? (await hs.list("bags", { code: open, session_id: s.id, status: "labelled" }, "id"))[0] : null;
      if (!bag) return E2("Scan the box QR and pick a bag first", 409);
      c.status = "confirmed"; c.bag_code = bag.code; await hs.put("cards", cardRow(c)); await R.syncBag(bag); await hs.staleTotals();
      if (c.image_id) await sh.confirmIdentification(c.image_id, c.part, c.color);
      return J2({ ok: true, code: bag.code, bag: await R.bagOut(bag), part: c.part, color: c.color, color_name: colorName(c.color), qty: c.qty, name: c.name });
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
    if (path === "host/train/delete" && M === "POST") { const n = Array.isArray(body.ids) ? await ts.deleteIds(host.id, body.ids) : await ts.deleteHost(host.id); return J2({ ok: true, deleted: n, ...(await ts.stats(host.id)) }); }
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
  // sorter: scan the box master QR (links the box's prepared bags to this session) or a bag QR (that bag gets the photos / parts list)
  if ((m = path.match(/^session\/([\w-]+)\/scan$/)) && M === "POST") {
    const s = await sess(m[1]); if (!mine(s) || s.status !== "open") return E2("session not open");
    const code = String(body.code || "").trim().toUpperCase(); let box = null, bag = null;
    if (/^BX\d+$/.test(code)) box = await hs.get("boxes", { barcode: code });
    else { bag = await R.bag(code); if (!bag || bag.status === "void") return E2(`${code}: not a known box or bag QR`, 404);
      if (!bag.session_id) { if (bag.box_id === null || bag.box_id === undefined) return E2("this bag QR is not on a prepared box sheet"); box = await hs.get("boxes", { id: bag.box_id }); }
      else if (bag.session_id !== s.id) return E2("this bag belongs to another sorting session", 409); }
    if (!box && !bag) return E2(`${code}: not a known box QR`, 404);
    if (box) { const bs = await hs.list("bags", { box_id: box.id, status: { ne: "void" } }, "id");
      if (!bs.length) return E2("this box has no bag QRs; print its sheet from Batch prep");
      if (bs.some(b => b.session_id && b.session_id !== s.id)) return E2("this box is already used by another sorting session", 409);
      const free = bs.filter(b => !b.session_id).map(b => b.code);
      for (let i = 0; i < free.length; i += 80) { const cs = free.slice(i, i + 80); await hs.update("bags", { code: cs }, { session_id: s.id, user_id: s.user_id }); await hs.update("qrcodes", { code: cs }, { session_id: s.id, user_id: s.user_id }); }
      if (!bag) { const open = await hs.list("qrcodes", { session_id: s.id, status: "open" }); if (!open.some(q => bs.some(b => b.code === q.code))) bag = bs.find(b => b.status === "labelled") || null; } }
    if (bag) { bag = await R.bag(bag.code); const q = await R.qr(bag.code);
      if (bag.status !== "labelled" || !q || !["open", "issued"].includes(q.status)) return E2("this bag is already bagged, boxed or expired", 409);
      await R.closeOpen(s.id, bag.code); await hs.update("qrcodes", { code: bag.code }, { status: "open" }); }
    return J2({ ok: true, bag: bag ? await R.bagOut(bag) : null, bags: await R.bagsOut(await hs.list("bags", { session_id: s.id, status: { ne: "void" } }, "id")) });
  }
  if ((m = path.match(/^bag\/([\w-]+)\/close$/)) && M === "POST") {
    const b = await R.bag(m[1]); if (!b || !mine(await sess(b.session_id))) return E2("not found", 404);
    await hs.update("qrcodes", { code: b.code, status: "open" }, { status: "issued" }); return J2({ ok: true, bag: await R.bagOut(b) });
  }
  if ((m = path.match(/^lot\/(\d+)$/)) && M === "POST") {   // a lot inside a bag: edit color/qty/part, remove from bag, or undo the removal
    const c = cardIn(await hs.get("cards", { id: +m[1] })); const s = c && c.bag_code && await sess(c.session_id);
    const b = s && await R.bag(c.bag_code); if (!b || !s || s.host_id !== host.id || !(admin || s.user_id === user.id || b.user_id === user.id)) return E2("not found", 404);
    if (body.action === "remove") c.status = "removed";
    else if (body.action === "restore") c.status = "confirmed";
    else { if (c.status !== "confirmed") return E2("this part was removed from the bag", 409);
      if (body.part && body.part !== c.part) { const np = String(body.part).trim().slice(0, 40); if (!validPart(np)) return E2("bad part number"); c.part = np; c.name = String(body.name || ""); }
      if (body.color !== undefined && body.color !== "") c.color = +body.color;
      if (body.qty) c.qty = Math.max(1, +body.qty); }
    await hs.put("cards", cardRow(c)); await R.syncBag(b); await hs.staleTotals();
    return J2({ ok: true, id: c.id, status: c.status, part: c.part, name: c.name, color: c.color, color_name: colorName(c.color), qty: c.qty, bag: await R.bagOut(b) });
  }
  if ((m = path.match(/^bag\/([\w-]+)\/bagged$/)) && M === "POST") {
    const b = await R.bag(m[1]); if (!b || b.status === "void") return E2("unknown or expired QR", 404);
    await hs.update("qrcodes", { code: b.code }, { status: "used" }); if (b.status === "labelled") await hs.update("bags", { id: b.id }, { status: "bagged" }); return J2({ ok: true });
  }
  if (path === "boxes") {
    if (M === "POST") {
      let n = (await hs.count("boxes")).n + 1, bc;
      do { bc = `BX${String(host.id).padStart(2, "0")}${String(n++).padStart(5, "0")}`; } while (await hs.get("boxes", { barcode: bc }));
      const id = await hs.nextId("box"); await hs.put("boxes", { id, barcode: bc, shelf: String(body.shelf || "").trim().toUpperCase().slice(0, 24), created: now() });
      return J2({ id });
    }
    const bx = await hs.list("boxes", {}, "id desc");
    const per = new Map((await hs.group("bags", "box_id", { box_id: bx.map(x => x.id), status: { ne: "void" } }, "qty")).map(r => [r.k, r]));
    return J2({ boxes: bx.map(x => ({ ...x, nb: per.get(x.id)?.n || 0, pcs: per.get(x.id)?.s || 0 })) });
  }
  if ((m = path.match(/^box\/(\d+)$/))) {
    const box = await hs.get("boxes", { id: +m[1] }); if (!box) return E2("not found", 404);
    let msg = null;
    if (M === "POST") {
      if (body.action === "shelf") { box.shelf = String(body.shelf || "").trim().toUpperCase().slice(0, 24); await hs.put("boxes", box); await hs.update("bags", { box_id: box.id }, { location: box.shelf }); msg = "Shelf address saved."; }
      if (body.action === "add") { let n = 0; for (const code of (body.codes || []).slice(0, 500)) { const b = await R.bag(code); if (b && b.status !== "void") {
          await hs.update("bags", { id: b.id }, { box_id: box.id, location: box.shelf, status: b.status === "labelled" ? "bagged" : b.status }); await hs.update("qrcodes", { code: b.code }, { status: "used" }); n++; } } msg = `Added ${n} bag(s).`; }
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
    return J2({ ok: true, added, updated, unchanged: same, colors_added: colorsAdded, errors: v.errors, n_errors: v.n_errors }); }
  if (path.startsWith("host")) {
    if (!admin) return E2("host admins only", 403);
    if (path === "host") { const us = await hs.list("users", {}, "id"), ns = new Map((await hs.group("sessions", "user_id")).map(r => [r.k, r.n]));
      const ss = await hs.list("sessions", {}, "started desc", 30), un = new Map(us.map(u => [u.id, u.username]));
      return J2({ host, users: us.map(u => ({ username: u.username, display: u.display, role: u.role, ns: ns.get(u.id) || 0 })), sessions: ss.map(s => ({ ...s, username: un.get(s.user_id), pay: pay(s, host) })) }); }
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
      await hs.batch(st); if (ok.length || boxes.length) await hs.staleTotals();
      return J2({ ok: true, deleted: Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.length])) });
    }
    if (path === "host/settings" && M === "POST") {
      Object.assign(host, { site_name: String(body.site_name || host.site_name).slice(0, 80), pay_mode: body.pay_mode === "hr" ? "hr" : "lb", rate_lb: +body.rate_lb || 1.35, rate_hr: +body.rate_hr || 10, low_threshold: Math.max(1, +body.low_threshold || 3) });
      await hs.put("hosts", host); return J2({ ok: true, msg: "Settings saved." });
    }
    if (path === "host/sorter" && M === "POST") {
      const un = String(body.username || "").trim().toLowerCase();
      if (!/^[a-z0-9_.-]{3,32}$/.test(un) || String(body.password || "").length < 8) return E2("Username 3-32 letters/numbers; password 8+ characters.");
      if (await findLogin(D1, un)) return E2("That username is taken.");
      await hs.put("users", { id: await hs.nextId("user"), username: un, pw_hash: await hashPw(body.password), role: "sorter", display: String(body.display || un).slice(0, 60), created: now() });
      return J2({ ok: true, msg: `Sorter ${un} added.` });
    }
    // ---- batch prep (admin, before the sorter leaves): N boxes, each = 1 master QR (box barcode) + M bag QRs (bag 1..M), printed as one sheet
    if (path === "host/batch" && M === "POST") {
      const nb = Math.min(20, Math.max(1, +body.boxes || 1)), nq = Math.min(30, Math.max(1, +body.bags || 1)), shelf = String(body.shelf || "").trim().toUpperCase().slice(0, 24), made = [];
      let n = (await hs.count("boxes")).n + 1;
      for (let k = 0; k < nb; k++) { let bc; do { bc = `BX${String(host.id).padStart(2, "0")}${String(n++).padStart(5, "0")}`; } while (await hs.get("boxes", { barcode: bc }));
        const id = await hs.nextId("box"); await hs.put("boxes", { id, barcode: bc, shelf, created: now() });
        const ids = await hs.nextIds("bag", nq), st = [];
        for (let q = 0; q < nq; q++) { let code; do { code = "PTS-" + rnd(4).toUpperCase(); } while (await R.qr(code));
          st.push(hs.putStmt("qrcodes", { code, session_id: null, user_id: null, created: now(), expires: Date.now() + PREP_TTL, status: "issued" }),
            hs.putStmt("bags", { id: ids[q], code, host_id: host.id, session_id: null, user_id: null, part: "", name: "", color: 0, qty: 0, box_id: id, location: shelf, status: "labelled", promoted_at: null, picked_at: null, created: now() })); }
        await hs.batch(st); made.push(id); }
      await hs.staleTotals(); return J2({ ok: true, boxes: made });
    }
    if (path === "host/batch") {
      const bx = await hs.list("boxes", {}, "id desc", 60), bags = bx.length ? await hs.list("bags", { box_id: bx.map(x => x.id), status: { ne: "void" } }, "id") : [];
      return J2({ boxes: bx.map(x => { const bs = bags.filter(b => b.box_id === x.id); return { ...x, nbags: bs.length, session_id: bs.find(b => b.session_id)?.session_id || null }; }) });
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
