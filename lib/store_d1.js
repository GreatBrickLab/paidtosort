// Paid to Sort alpha storage on D1 (binding PTSDB). Not deployed.
// Shared catalog/ID data -> sharedStore(d1). Host data -> hostStore(d1, hostId): the ONLY way to touch host tables.
// hostStore binds the session's host_id into every WHERE / INSERT itself, rejects rows that carry another host_id,
// and only allows whitelisted tables and column names, so a host can never read or change another host's rows.

export const SHARED = ["colors", "parts", "part_images", "identifications", "mold_exceptions", "meta", "part_metrics", "part_color_price"];
export const HOST_TABLES = {   // table -> key columns (besides host_id)
  hosts: ["id"], users: ["id"], sessions: ["id"], cards: ["id"], qrcodes: ["code"], boxes: ["id"], bags: ["id"],
  store_inventory: ["part", "color"], pick_lists: ["id"], pick_items: ["pick_id", "bag_code"], host_seq: ["name"], bag_sizes: ["id"],
};
const COLS = {
  hosts: ["id", "site_name", "pay_mode", "rate_lb", "rate_hr", "low_threshold", "created", "payout_share", "bag_max_g", "bag_max_cm3", "loose_density"],
  users: ["host_id", "id", "username", "pw_hash", "role", "display", "created", "pay_share"],
  sessions: ["host_id", "id", "user_id", "started", "ended", "weight_lb", "status", "box_id"],
  cards: ["host_id", "id", "session_id", "part", "name", "color", "qty", "confidence", "alts", "color_guesses", "image_id", "status", "bag_code"],
  qrcodes: ["host_id", "code", "session_id", "user_id", "created", "expires", "status"],
  boxes: ["host_id", "id", "barcode", "shelf", "created", "batch_weight_g", "sorter_id", "bag_size_id"],
  bags: ["host_id", "id", "code", "session_id", "user_id", "part", "name", "color", "qty", "box_id", "location", "status", "promoted_at", "picked_at", "created"],
  store_inventory: ["host_id", "part", "color", "qty", "uploaded"],
  pick_lists: ["host_id", "id", "created", "export_bsx"],
  pick_items: ["host_id", "pick_id", "bag_code", "picked_at"],
  host_seq: ["host_id", "name", "v"],
  bag_sizes: ["host_id", "id", "name", "max_g", "max_cm3"],
};
const hcol = t => (t === "hosts" ? "id" : "host_id");   // the hosts row is keyed by its own id
const enc = v => (v === undefined ? null : v !== null && typeof v === "object" ? JSON.stringify(v) : v);

export class CrossHostError extends Error {}

function checkCols(t, obj) {
  if (!COLS[t]) throw new CrossHostError(`table ${t} is not a host table`);
  for (const k of Object.keys(obj)) if (!COLS[t].includes(k)) throw new CrossHostError(`bad column ${t}.${k}`);
}

export function hostStore(d1, hostId) {
  hostId = Number(hostId);
  if (!Number.isInteger(hostId) || hostId <= 0) throw new CrossHostError("no host in session");
  // filter values: scalar -> "k = ?", null -> "k is null", array -> "k in (...)" (empty array matches nothing),
  // {ne: v} -> "k is not v", {lt: v} / {gt: v} / {prefix: "abc"} / {contains: "abc"}. Column names are whitelisted per table.
  const where = (t, filt = {}) => { checkCols(t, filt); if (hcol(t) in filt && Number(filt[hcol(t)]) !== hostId) throw new CrossHostError("filter names another host");
    const f = { ...filt }; delete f[hcol(t)]; const sql = [`${hcol(t)} = ?`], args = [hostId];
    for (const [k, v] of Object.entries(f)) {
      if (v === null) sql.push(`${k} is null`);
      else if (Array.isArray(v)) { if (!v.length) sql.push("0"); else { sql.push(`${k} in (${v.map(() => "?").join(",")})`); args.push(...v.map(enc)); } }
      else if (v && typeof v === "object") { const [op, x] = Object.entries(v)[0] || [];
        if (op === "ne") { sql.push(`${k} is not ?`); args.push(enc(x)); } else if (op === "lt") { sql.push(`${k} < ?`); args.push(enc(x)); } else if (op === "gt") { sql.push(`${k} > ?`); args.push(enc(x)); }
        else if (op === "prefix") { sql.push(`lower(${k}) like ? escape '\\'`); args.push(String(x).toLowerCase().replace(/[\\%_]/g, m => "\\" + m) + "%"); }
        else if (op === "contains") { sql.push(`lower(${k}) like ? escape '\\'`); args.push("%" + String(x).toLowerCase().replace(/[\\%_]/g, m => "\\" + m) + "%"); }
        else throw new CrossHostError("bad filter op"); }
      else { sql.push(`${k} = ?`); args.push(enc(v)); }
    }
    return { sql: sql.join(" and "), args }; };
  const ORDER = /^[a-z_]+( desc)?(, ?[a-z_]+( desc)?)*$/;
  const chk = (t, order) => { if (order && (!ORDER.test(order) || order.split(",").some(o => !COLS[t].includes(o.trim().split(" ")[0])))) throw new CrossHostError("bad order"); };
  const self = {
    hostId,
    async list(t, filt = {}, order = "", limit = 0) {
      const w = where(t, filt); chk(t, order);
      // long IN lists are split (D1 allows ~100 bound parameters per statement)
      const big = Object.entries(filt).find(([, v]) => Array.isArray(v) && v.length > 80);
      if (big) { const [k, v] = big, out = []; for (let i = 0; i < v.length; i += 80) out.push(...await self.list(t, { ...filt, [k]: v.slice(i, i + 80) }, order)); return limit ? out.slice(0, limit) : out; }
      // "order by id" would make SQLite walk the (host_id, id) primary key instead of the filter's index: sort those in JS
      if (/^id( desc)?$/.test(order)) { const d = order === "id desc" ? -1 : 1;
        const rows = (await d1.prepare(`select * from ${t} where ${w.sql}`).bind(...w.args).all()).results.sort((a, b) => d * (a.id - b.id)); return limit ? rows.slice(0, limit) : rows; }
      return (await d1.prepare(`select * from ${t} where ${w.sql}${order ? " order by " + order : ""}${limit ? " limit " + (limit | 0) : ""}`).bind(...w.args).all()).results;
    },
    async get(t, filt) { return (await self.list(t, filt, "", 1))[0] || null; },
    async count(t, filt = {}, sumCol = null) {   // {n, s}: row count and (optionally) the sum of one whitelisted column
      const w = where(t, filt); if (sumCol && !COLS[t].includes(sumCol)) throw new CrossHostError("bad column");
      return d1.prepare(`select count(*) n${sumCol ? `, coalesce(sum(${sumCol}),0) s` : ""} from ${t} where ${w.sql}`).bind(...w.args).first();
    },
    async group(t, by, filt = {}, sumCol = null) {   // [{k, n, s}] grouped by one whitelisted column
      const w = where(t, filt); if (!COLS[t].includes(by) || (sumCol && !COLS[t].includes(sumCol))) throw new CrossHostError("bad column");
      return (await d1.prepare(`select ${by} k, count(*) n${sumCol ? `, coalesce(sum(${sumCol}),0) s` : ""} from ${t} where ${w.sql} group by ${by}`).bind(...w.args).all()).results;
    },
    updateStmt(t, filt, set) {   // "update t set ... where host_id = ? and ..." (never changes host_id or key columns)
      checkCols(t, set); if (!Object.keys(filt || {}).length) throw new CrossHostError("refusing unfiltered update");
      if (Object.keys(set).some(k => k === hcol(t) || k === "host_id")) throw new CrossHostError("cannot move rows between hosts");
      const w = where(t, filt), ks = Object.keys(set);
      return d1.prepare(`update ${t} set ${ks.map(k => `${k} = ?`).join(", ")} where ${w.sql}`).bind(...ks.map(k => enc(set[k])), ...w.args);
    },
    async update(t, filt, set) { return self.updateStmt(t, filt, set).run(); },
    // host-wide repository totals (home screen). Cached in host_seq (tot_nb / tot_n / tot_pcs) and recomputed only after a change
    // marked them stale (tot_ok = 0), so the home screen normally reads 4 rows instead of scanning the repository.
    async staleTotals() { await self.put("host_seq", { name: "tot_ok", v: 0 }); },
    async totals() {
      const c = Object.fromEntries((await self.list("host_seq", { name: ["tot_ok", "tot_nb", "tot_n", "tot_pcs"] })).map(r => [r.name, r.v]));
      if (c.tot_ok === 1) return { nb: c.tot_nb, n: c.tot_n, pcs: c.tot_pcs };
      await self.put("host_seq", { name: "tot_ok", v: 1 });   // set before counting: a change during the count marks it stale again
      const t = await self.countTotals();
      await self.batch([["tot_nb", t.nb], ["tot_n", t.n], ["tot_pcs", t.pcs]].map(([name, v]) => self.putStmt("host_seq", { name, v })));
      return t;
    },
    async countTotals() {
      const b = await d1.prepare("select count(*) nb, coalesce(sum(qty),0) pcs from bags where host_id = ? and status is not 'void'").bind(hostId).first();
      const c = await d1.prepare("select count(*) n from cards c join bags b on b.host_id = c.host_id and b.code = c.bag_code where c.host_id = ? and c.status = 'confirmed' and b.status is not 'void'").bind(hostId).first();
      return { nb: b.nb, pcs: b.pcs, n: c.n };
    },
    putStmt(t, row) {
      checkCols(t, row);
      if (hcol(t) in row && Number(row[hcol(t)]) !== hostId) throw new CrossHostError(`row for host ${row[hcol(t)]} rejected`);
      const r = { ...row, [hcol(t)]: hostId }, cols = Object.keys(r), keys = [hcol(t), ...HOST_TABLES[t]].filter((k, i, a) => a.indexOf(k) === i);
      const upd = cols.filter(c => !keys.includes(c));
      // conflict target includes host_id, and the update is guarded by host_id, so another host's row can never be overwritten
      return d1.prepare(`insert into ${t}(${cols.join(",")}) values(${cols.map(() => "?").join(",")}) on conflict(${keys.join(",")}) do ` +
        (upd.length ? `update set ${upd.map(c => `${c}=excluded.${c}`).join(",")} where ${t}.${hcol(t)} = ?` : "nothing"))
        .bind(...cols.map(c => enc(r[c])), ...(upd.length ? [hostId] : []));
    },
    async put(t, row) { return self.putStmt(t, row).run(); },
    delStmt(t, filt) { if (!Object.keys(filt || {}).length) throw new CrossHostError("refusing unfiltered delete");
      const w = where(t, filt); return d1.prepare(`delete from ${t} where ${w.sql}`).bind(...w.args); },
    async del(t, filt) { if (!Object.keys(filt || {}).length) throw new CrossHostError("refusing unfiltered delete");
      const w = where(t, filt); return d1.prepare(`delete from ${t} where ${w.sql}`).bind(...w.args).run(); },
    async batch(stmts) { for (let i = 0; i < stmts.length; i += 50) await d1.batch(stmts.slice(i, i + 50)); },
    async nextId(name) { return (await self.nextIds(name, 1))[0]; },
    async nextIds(name, n) {   // per-host sequence: reserve n ids in one step
      n = Math.max(1, n | 0);
      const r = await d1.prepare("insert into host_seq(host_id,name,v) values(?,?,?) on conflict(host_id,name) do update set v = v + ? returning v").bind(hostId, name, n, n).first();
      return Array.from({ length: n }, (_, i) => r.v - n + 1 + i);
    },
    // whole-host snapshot in the shape the current API code uses (db.bags, db.qrcodes[code], ...), host rows only
    async load() {
      const db = { host_id: hostId, qrcodes: {} };
      for (const t of ["hosts", "users", "sessions", "cards", "boxes", "bags"]) db[t] = (await self.list(t)).map(r => (t === "cards" ? { ...r, alts: JSON.parse(r.alts || "[]"), color_guesses: JSON.parse(r.color_guesses || "[]") } : r));
      for (const q of await self.list("qrcodes")) db.qrcodes[q.code] = q;
      db.seq = Object.fromEntries((await self.list("host_seq")).map(r => [r.name, r.v]));
      for (const c of db.cards) c.crop = c.image_id ? `/alpha/api/crop/${c.image_id}` : null;
      self._snap = snap(db); return db;
    },
    async save(db) {   // write back only changed rows; any row tagged with another host throws before anything is written
      const now = snap(db), st = [];
      for (const t of ["hosts", "users", "sessions", "cards", "boxes", "bags"]) for (const r of db[t] || []) {
        const k = t + ":" + HOST_TABLES[t].map(c => r[c]).join("|"); if (self._snap?.[k] !== now[k]) st.push(self.putStmt(t, pick(t, r))); }
      for (const [code, q] of Object.entries(db.qrcodes || {})) { const k = "qrcodes:" + code; if (self._snap?.[k] !== now[k]) st.push(self.putStmt("qrcodes", pick("qrcodes", { ...q, code }))); }
      for (const [name, v] of Object.entries(db.seq || {})) if (self._snap?.["seq:" + name] !== now["seq:" + name]) st.push(self.putStmt("host_seq", { name, v }));
      await self.batch(st); self._snap = now; return st.length;
    },
  };
  return self;
}
const pick = (t, r) => Object.fromEntries(COLS[t].filter(c => c in r).map(c => [c, r[c]]));
function snap(db) { const s = {};
  for (const t of ["hosts", "users", "sessions", "cards", "boxes", "bags"]) for (const r of db[t] || []) s[t + ":" + HOST_TABLES[t].map(c => r[c]).join("|")] = JSON.stringify(r);
  for (const [c, q] of Object.entries(db.qrcodes || {})) s["qrcodes:" + c] = JSON.stringify(q);
  for (const [n, v] of Object.entries(db.seq || {})) s["seq:" + n] = JSON.stringify(v); return s; }

// indexes for the per-request queries (host_id first, so every lookup stays inside one host's rows)
export const INDEXES = [
  "create index if not exists ix_cards_sess on cards(host_id, session_id, status)",
  "create index if not exists ix_cards_bag on cards(host_id, bag_code, status)",
  "create index if not exists ix_bags_sess on bags(host_id, session_id, status)",
  "create index if not exists ix_bags_status on bags(host_id, status)",
  "create index if not exists ix_bags_box on bags(host_id, box_id)",
  "create index if not exists ix_qr_sess on qrcodes(host_id, session_id, status)",
  "create index if not exists ix_qr_expiry on qrcodes(host_id, status, expires)",
  "create index if not exists ix_sess_user on sessions(host_id, user_id, started)",
  "create index if not exists ix_sess_started on sessions(host_id, started)",
  "create index if not exists ix_ident_image on identifications(image_id)",
];
// additive schema changes for databases made before the open-bag flow (each runs once; "duplicate column" errors mean it already ran)
export const MIGRATIONS = [
  "alter table hosts add column payout_share real not null default 0", "alter table hosts add column bag_max_g real not null default 110",
  "alter table hosts add column bag_max_cm3 real not null default 250", "alter table hosts add column loose_density real not null default 0.4",
  "alter table sessions add column box_id integer", "alter table boxes add column batch_weight_g real", "alter table boxes add column sorter_id integer",
  "create table if not exists part_metrics(part text primary key, name text, category text, weight_g real, dim_x real, dim_y real, dim_z real, volume_cm3 real, has_weight integer default 0, has_dims integer default 0)",
  // per-sorter pay + host bag sizes (seeded 4x6 = 110 g / 250 cm3 for hosts that have none)
  "alter table users add column pay_share real not null default 0", "alter table boxes add column bag_size_id integer",
  "create table if not exists bag_sizes(host_id integer not null, id integer not null, name text not null, max_g real not null default 110, max_cm3 real not null default 250, primary key(host_id, id))",
  "insert into bag_sizes(host_id, id, name, max_g, max_cm3) select h.id, 1, '4x6', 110, 250 from hosts h where not exists (select 1 from bag_sizes b where b.host_id = h.id)",
  "create table if not exists part_color_price(part text not null, color integer not null, price_used_avg real, price_qty_sold integer, thin_sales integer default 0, price_date text, primary key(part, color))",
];
const INDEX_VER = "indexes_v1:" + INDEXES.length + ":m" + MIGRATIONS.length;
let INDEXED = false;
export async function ensureIndexes(d1) { if (INDEXED) return;   // created once (marker row in meta), then just one 1-row check per isolate
  if (!(await d1.prepare("select 1 from meta where k = ?").bind(INDEX_VER).first())) {
    for (const q of MIGRATIONS) try { await d1.prepare(q).run(); } catch (e) { if (!/duplicate column/i.test(String(e.message || e))) throw e; }
    await d1.batch([...INDEXES.map(q => d1.prepare(q)), d1.prepare("insert or replace into meta(k,v) values(?,?)").bind(INDEX_VER, JSON.stringify(new Date().toISOString()))]); }
  INDEXED = true; }

// ---- login: the only cross-host lookup. Returns just enough to verify the password and pick the host.
export async function findLogin(d1, username) {
  return d1.prepare("select host_id, id, pw_hash, role from users where username = ?").bind(String(username || "").trim().toLowerCase()).first();
}

// ---- shared repositories (no host_id by design)
export function sharedStore(d1) {
  return {
    colors: async () => (await d1.prepare("select * from colors order by name").all()).results,
    part: async p => d1.prepare("select * from parts where part = ?").bind(p).first(),
    addImage: async (part, color, b64) => (await d1.prepare("insert into part_images(part,color,jpeg_b64,created) values(?,?,?,datetime('now')) returning id").bind(part, color, b64).first()).id,
    image: async id => d1.prepare("select jpeg_b64 from part_images where id = ?").bind(+id).first(),
    addIdentification: async (imageId, enginePart, score) => d1.prepare("insert into identifications(image_id,engine_part,engine_score,created) values(?,?,?,datetime('now'))").bind(imageId, enginePart, score).run(),
    confirmIdentification: async (imageId, part, color) => d1.prepare("update identifications set confirmed_part=?, confirmed_color=? where image_id=?").bind(part, color, imageId).run(),
    moldExceptions: async () => (await d1.prepare("select part, note, added_by, created from mold_exceptions order by part").all()).results,
    addMoldException: async (part, note, by) => d1.prepare("insert or replace into mold_exceptions(part,note,added_by,created) values(?,?,?,datetime('now'))").bind(part, note || "", by || "").run(),
    removeMoldException: async part => d1.prepare("delete from mold_exceptions where part = ?").bind(part).run(),
    // crops of purged test cards (ids come from this host's own card rows); chunked for D1's bound-parameter limit
    images: async ids => { const out = []; for (let i = 0; i < ids.length; i += 80) { const c = ids.slice(i, i + 80).map(Number);
      out.push(...(await d1.prepare(`select * from part_images where id in (${c.map(() => "?").join(",")})`).bind(...c).all()).results,
        ...(await d1.prepare(`select * from identifications where image_id in (${c.map(() => "?").join(",")})`).bind(...c).all()).results.map(r => ({ ...r, _table: "identifications" }))); } return out; },
    deleteImagesStmts: ids => { const st = []; for (let i = 0; i < ids.length; i += 80) { const c = ids.slice(i, i + 80).map(Number), q = c.map(() => "?").join(",");
      st.push(d1.prepare(`delete from identifications where image_id in (${q})`).bind(...c), d1.prepare(`delete from part_images where id in (${q})`).bind(...c)); } return st; },
    // open-bag meter: weight/volume per part and used price per part+color (shared parts data)
    partData: async (parts, pairs) => { const m = new Map(), pr = new Map(), ps = [...new Set(parts)];
      for (let i = 0; i < ps.length; i += 80) { const c = ps.slice(i, i + 80), q = c.map(() => "?").join(",");
        for (const r of (await d1.prepare(`select part, weight_g, volume_cm3, has_weight, has_dims from part_metrics where part in (${q})`).bind(...c).all()).results) m.set(r.part, r);
        for (const r of (await d1.prepare(`select part, color, price_used_avg, thin_sales from part_color_price where part in (${q})`).bind(...c).all()).results) pr.set(r.part + "|" + r.color, r); }
      return { metrics: m, prices: pr }; },
    meta: async k => { const r = await d1.prepare("select v from meta where k=?").bind(k).first(); return r ? JSON.parse(r.v) : null; },
    setMeta: async (k, v) => d1.prepare("insert or replace into meta(k,v) values(?,?)").bind(k, JSON.stringify(v)).run(),
  };
}

// ---- one-time migration of the current single-host KV document into D1 (host rows get host_id; crops go to shared part_images)
export async function migrateFromKV(env) {
  const d1 = env.PTSDB, sh = sharedStore(d1);
  if (await sh.meta("migrated_from_kv")) return false;
  const kv = await env.PTSA.get("db", { type: "json" }); if (!kv) return false;
  await sh.setMeta("secret", kv.secret);
  for (const [id, [name]] of Object.entries(kv.palette || {})) await d1.prepare("insert or ignore into colors(id,name) values(?,?)").bind(+id, name).run();
  for (const h of kv.hosts) {
    const hs = hostStore(d1, h.id), st = [hs.putStmt("hosts", pick("hosts", h))];
    for (const u of kv.users.filter(x => x.host_id === h.id)) st.push(hs.putStmt("users", pick("users", u)));
    for (const s of kv.sessions.filter(x => x.host_id === h.id)) st.push(hs.putStmt("sessions", pick("sessions", s)));
    for (const b of kv.boxes.filter(x => x.host_id === h.id)) st.push(hs.putStmt("boxes", pick("boxes", b)));
    for (const b of kv.bags.filter(x => x.host_id === h.id)) st.push(hs.putStmt("bags", pick("bags", b)));
    for (const [code, q] of Object.entries(kv.qrcodes).filter(([, q]) => q.host_id === h.id)) st.push(hs.putStmt("qrcodes", pick("qrcodes", { ...q, code })));
    const sids = new Set(kv.sessions.filter(x => x.host_id === h.id).map(s => s.id));
    for (const c of kv.cards.filter(x => sids.has(x.session_id))) {
      let image_id = null; const b64 = c.crop ? await env.PTSA.get("crop:" + c.id) : null;
      if (b64) image_id = await sh.addImage(c.part, c.color, b64);
      st.push(hs.putStmt("cards", pick("cards", { ...c, image_id, alts: c.alts })));
    }
    for (const [name, v] of Object.entries(kv.seq || {})) st.push(hs.putStmt("host_seq", { name, v }));
    await hs.batch(st);
  }
  await sh.setMeta("migrated_from_kv", new Date().toISOString());
  return true;
}

// ---- shared training pool (all hosts, one model). Samples carry NO host/user/session data.
// The host->sample map is private, server-side only, used solely for "delete this host's samples".
let TRAIN_READY = false;
export function trainStore(d1, kv) {
  const ready = async () => { if (TRAIN_READY) return;
    await d1.batch([d1.prepare("create table if not exists train_samples(id text primary key, created text not null, app_ver text, det_ver text, labels text not null, img_bytes integer)"),
      d1.prepare("create table if not exists train_host_map(sample_id text primary key, host_id integer not null, created text not null)"),
      d1.prepare("create index if not exists ix_train_host on train_host_map(host_id)")]); TRAIN_READY = true; };
  return {
    async add(id, labels, jpegB64, hostId) { await ready();
      if (await d1.prepare("select 1 from train_samples where id=?").bind(id).first()) return false;
      await kv.put("train:img:" + id, jpegB64);
      await d1.batch([d1.prepare("insert into train_samples(id,created,app_ver,det_ver,labels,img_bytes) values(?,?,?,?,?,?)").bind(id, labels.created, labels.app_version, labels.detector_version, JSON.stringify(labels), Math.round(jpegB64.length * 0.75)),
        d1.prepare("insert into train_host_map(sample_id,host_id,created) values(?,?,datetime('now'))").bind(id, Number(hostId))]); return true; },
    async stats(hostId) { await ready(); return { total: (await d1.prepare("select count(*) n from train_samples").first()).n,
      host: (await d1.prepare("select count(*) n from train_host_map where host_id=?").bind(Number(hostId)).first()).n }; },
    async deleteHost(hostId) { await ready(); const ids = (await d1.prepare("select sample_id from train_host_map where host_id=?").bind(Number(hostId)).all()).results.map(r => r.sample_id);
      for (const id of ids) { await kv.delete("train:img:" + id); await d1.batch([d1.prepare("delete from train_samples where id=?").bind(id), d1.prepare("delete from train_host_map where sample_id=? and host_id=?").bind(id, Number(hostId))]); }
      return ids.length; },
    async deleteIds(hostId, ids) { await ready(); let n = 0;   // only samples this host contributed
      for (const id of [...new Set(ids.map(String))].slice(0, 500)) { if (!(await d1.prepare("select 1 from train_host_map where sample_id=? and host_id=?").bind(id, Number(hostId)).first())) continue;
        await kv.delete("train:img:" + id); await d1.batch([d1.prepare("delete from train_samples where id=?").bind(id), d1.prepare("delete from train_host_map where sample_id=? and host_id=?").bind(id, Number(hostId))]); n++; }
      return n; },
    async has(id) { await ready(); return !!(await d1.prepare("select 1 from train_samples where id=?").bind(id).first()); },
    async list(after) { await ready(); return (await d1.prepare("select id, created, labels from train_samples where created > ? order by created limit 1000").bind(after || "").all()).results.map(r => ({ id: r.id, created: r.created, labels: JSON.parse(r.labels) })); },
    image: async id => kv.get("train:img:" + id),
  };
}
