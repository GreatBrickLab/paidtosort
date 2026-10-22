// Photo -> cards: the part finder boxes the parts on the phone, the sorter can box missed ones, each crop is identified (8 at a time),
// the color is estimated from the part's pixels, and one card per part + color is saved. Unrecognised crops are dropped (counted in a toast).
// The photo and each card's boxes stay on the phone (IndexedDB) for the pinned photo panel and zoom.
const idbStore = (name, stores) => { let dbp = null; const db = () => dbp || (dbp = new Promise((res, rej) => { const r = indexedDB.open(name, 1); r.onupgradeneeded = () => stores.forEach(([s, k]) => r.result.createObjectStore(s, { keyPath: k })); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
  return async (st, mode, fn) => { const d = await db(); return new Promise((res, rej) => { const t = d.transaction(st, mode), q = fn(t.objectStore(st)); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }); }; };
const ZM = (() => { const tx = idbStore("pts2-photos", [["photos", "id"], ["cards", "card"]]);
  setTimeout(async () => { try { const old = Date.now() - 14 * 864e5; for (const p of await tx("photos", "readonly", s => s.getAll())) if (p.t < old) await tx("photos", "readwrite", s => s.delete(p.id)); } catch (e) {} }, 4000);
  // bytes, not Blobs: some WebKit builds refuse Blobs in IndexedDB
  return { addPhoto: async (blob, w, h) => { const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8), buf = await blob.arrayBuffer(); await tx("photos", "readwrite", s => s.put({ id, t: Date.now(), buf, type: blob.type || "image/jpeg", w, h })); return id; },
    mapCard: (card, pid, boxes) => tx("cards", "readwrite", s => s.put({ card, pid, boxes })),
    get: async card => { const m = await tx("cards", "readonly", s => s.get(card)); if (!m) return null; const p = await tx("photos", "readonly", s => s.get(m.pid)); if (!p) return null; p.blob = new Blob([p.buf], { type: p.type }); return { ...m, photo: p }; } }; })();
// the photo under review (before cards exist) survives a reload: one record per session until Done
const RV = (() => { const tx = idbStore("pts2-review", [["rv", "sid"]]);
  return { put: v => tx("rv", "readwrite", s => s.put(v)), get: sid => tx("rv", "readonly", s => s.get(sid)), del: sid => tx("rv", "readwrite", s => s.delete(sid)),
    setMissed: async (sid, missed) => { const r = await tx("rv", "readonly", s => s.get(sid)); if (r) { r.missed = missed; await tx("rv", "readwrite", s => s.put(r)); } } }; })();
const IDENT_CONC = 8, IDENT_MS = 8000;   // up to 8 calls at once, 8 s timeout, one retry
async function identify(image) { for (let t = 0; t < 2; t++) { try { const r = await fetch(`${BASE}/api/identify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image }), signal: AbortSignal.timeout(IDENT_MS) }); if (r.ok) return await r.json(); } catch (e) {} } return {}; }
const shrink = (src, max, q = 0.8) => new Promise(res => { const im = new Image(); im.onload = () => { const s = Math.min(1, max / Math.max(im.width, im.height)), c = document.createElement("canvas"); c.width = Math.max(1, Math.round(im.width * s)); c.height = Math.max(1, Math.round(im.height * s)); c.getContext("2d").drawImage(im, 0, 0, c.width, c.height); res(c.toDataURL("image/jpeg", q)); }; im.onerror = () => res(src); im.src = src; });

async function processPhoto(sid, file) {
  if (!file) return; const prog = $("#prog"), pt = $("#progt"); prog.hidden = false; $("#prog .spin").hidden = false;
  try {
    pt.textContent = "Getting the part finder ready…"; PTSBrickator.onprogress = (got, tot) => { pt.textContent = `Getting the part finder ready (first time only): ${Math.round(100 * got / tot)}% of ${Math.round(tot / 1048576)} MB`; };
    const t0 = performance.now(); await Promise.all([PTSBrickator.load(), palette()]); const loadMs = Math.round(performance.now() - t0);
    pt.textContent = "Finding parts…"; const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const sc = Math.min(1, 3200 / Math.max(bmp.width, bmp.height)), cvs = document.createElement("canvas"); cvs.width = Math.round(bmp.width * sc); cvs.height = Math.round(bmp.height * sc); cvs.getContext("2d").drawImage(bmp, 0, 0, cvs.width, cvs.height);
    await new Promise(r => setTimeout(r, 30)); const td = performance.now(), parts = await PTSBrickator.detect(cvs);
    window.PTS_LAST = { load_ms: loadMs, detect_ms: Math.round(performance.now() - td), boxes: parts.length };
    try { await RV.put({ sid, t: Date.now(), w: cvs.width, h: cvs.height, photo: await new Promise(r => cvs.toBlob(r, "image/jpeg", 0.92)), parts: parts.map(p => ({ box: p.box, crop: p.crop, lab: p.lab, group: p.group, merged: p.merged || null })), missed: [] }); } catch (e) {}
    return finishPhoto(sid, cvs, parts, []);
  } catch (e) { pt.textContent = "Something went wrong: " + e.message; $("#prog .spin").hidden = true; console.error(e); }
}
async function resumeReview(sid) { const r = await RV.get(sid).catch(() => null); if (!r || !$("#prog")) return false;
  const im = await createImageBitmap(r.photo), cvs = document.createElement("canvas"); cvs.width = r.w; cvs.height = r.h; cvs.getContext("2d").drawImage(im, 0, 0, r.w, r.h);
  toast("Picked up your photo where you left off"); finishPhoto(sid, cvs, r.parts, r.missed || []); return true; }
async function finishPhoto(sid, cvs, parts, missed0) {
  const pt = $("#progt"); $("#prog").hidden = false;
  try {
    const missed = await reviewPhoto(cvs, parts, pt, sid, missed0), total = parts.length + missed.length, T0 = performance.now();
    if (!total) { pt.textContent = "No parts found. Try a plain background and spread the parts out."; $("#prog .spin").hidden = true; await RV.del(sid).catch(() => {}); return; }
    const cropOf = b => { const c = document.createElement("canvas"); c.width = Math.max(1, b[2] - b[0]); c.height = Math.max(1, b[3] - b[1]); c.getContext("2d").drawImage(cvs, b[0], b[1], c.width, c.height, 0, 0, c.width, c.height); return c; };
    const mcrops = missed.map(cropOf), jobs = parts.map(p => p.crop), gj = {};
    parts.forEach(p => { if (p.group !== null && p.merged && !(p.group in gj)) { gj[p.group] = jobs.length; jobs.push(p.merged.crop); } });   // a split part is also sent whole
    const mj = jobs.length; mcrops.forEach(c => jobs.push(c.toDataURL("image/jpeg", 0.9)));
    for (let i = 0; i < jobs.length; i++) jobs[i] = await shrink(jobs[i], 800);
    let n = 0, k = 0; const res = new Array(jobs.length); pt.textContent = `Identifying ${total} parts… 0/${total}`;
    await Promise.all(Array.from({ length: IDENT_CONC }, async () => { while (k < jobs.length) { const i = k++; res[i] = (await identify(jobs[i])).items || []; if (i < parts.length || i >= mj) pt.textContent = `Identifying ${total} parts… ${++n}/${total}`; } }));
    let keep = parts.map((_, i) => i); const preds = res.slice(0, parts.length);
    for (const [gid, j] of Object.entries(gj)) { const mem = parts.map((p, i) => p.group == gid ? i : -1).filter(i => i >= 0), whole = res[j], ids = new Set(mem.map(i => preds[i][0]?.id)), best = Math.max(...mem.map(i => preds[i][0]?.score || 0));
      if (whole.length && ids.size > 1 && whole[0].score >= best - 0.02) { const f = mem[0]; parts[f] = { ...parts[f], ...parts[f].merged }; preds[f] = whole; keep = keep.filter(i => !mem.slice(1).includes(i)); } }
    const dets = [...keep.map(i => ({ items: preds[i], lab: parts[i].lab, crop: parts[i].crop, box: parts[i].box })), ...missed.map((b, m) => ({ items: res[mj + m], lab: PTSDetect.cropLab(mcrops[m]), crop: jobs[mj + m], box: b }))];
    const und = new Set(); for (const id of new Set(dets.flatMap(d => (d.items || []).map(it => String(it.id))))) if (await isUndetermined(id)) und.add(id);
    for (const d of dets) { const top = (d.items || []).find(it => it.id && (!it.type || it.type === "part") && !und.has(String(it.id)));
      if (top) { const ranked = PTSDetect.estimateColor(d.lab, top.id, (await partInfo(top.id)).colors, PAL); d.col = { color: ranked[0]?.id ?? 0, guesses: ranked.slice(0, 5).map(c => c.id) }; } }
    const PL = PTSPartsList.buildPartsList(dets, { undetermined: id => und.has(id), colorFor: d => d.col });
    const lineOf = [], lines = []; for (const r of PL.rows) { if (r.flag === "unidentified") { lineOf.push(null); continue; } lineOf.push(lines.length); lines.push({ ...PTSPartsList.toCard(r), crop: r.crop ? await shrink(r.crop, 220) : null }); }
    pt.textContent = "Saving cards…"; const sv = await api(`session/${sid}/cards`, { cards: lines }); if (!sv.ok) throw new Error(sv.error || "could not save");
    await RV.del(sid).catch(() => {});
    try { const pid = await ZM.addPhoto(await new Promise(r => cvs.toBlob(r, "image/jpeg", 0.9)), cvs.width, cvs.height), per = {};
      dets.forEach((d, i) => { const line = lineOf[PL.rowOf[i]], id = line === null ? null : sv.ids[line]; if (id) (per[id] = per[id] || []).push(d.box); });
      for (const [id, bs] of Object.entries(per)) await ZM.mapCard(+id, pid, bs); } catch (e) { console.warn("photo store", e); }
    window.PTS_LAST = { ...window.PTS_LAST, identify_ms: Math.round(performance.now() - T0), crops: total, cards: lines.length, unrecognised: PL.summary.unidentified };
    const unk = PL.summary.unidentified, low = PL.summary.low;
    $("#prog").hidden = true; toast(`${total} parts → ${lines.length} cards${low ? ` · ${low} to double-check` : ""}${unk ? ` · ${unk} not recognised (dropped; retake to try again)` : ""}`, 4000);
    await route(); setTimeout(() => $(".pcard")?.scrollIntoView({ behavior: "smooth", block: "center" }), 300);
  } catch (e) { pt.textContent = "Something went wrong: " + e.message; $("#prog .spin").hidden = true; console.error(e); }
}
// review: the photo with the found boxes (gold); tap or drag to box a part the finder missed (pink); Done identifies everything
function reviewPhoto(cvs, parts, pt, sid, missed0) { return new Promise(resolve => {
  const host = $("#review"); $("#prog .spin").hidden = true;
  pt.textContent = parts.length ? `${parts.length} parts found. Box any part that was missed, then tap Done.` : "No parts found automatically. Box the parts, then tap Done.";
  host.innerHTML = `<p class="small muted">Tap a part (or drag a box around it) if it has no box. Pink boxes are yours.</p><canvas id="rcv" class="prev"></canvas>
   <div class="row2"><button type="button" class="btn" id="r_undo" disabled>Undo box</button><button type="button" class="btn gold big" id="r_done">Done · make cards</button></div><p class="small" id="r_msg"></p>`; host.hidden = false;
  const cv = $("#rcv"), sc = Math.min(1, 1400 / Math.max(cvs.width, cvs.height)); cv.width = Math.round(cvs.width * sc); cv.height = Math.round(cvs.height * sc); const g = cv.getContext("2d");
  const added = [...(missed0 || [])]; let a = null, cur = null; const persist = () => RV.setMissed(sid, added).catch(() => {});
  const draw = () => { g.drawImage(cvs, 0, 0, cv.width, cv.height); g.lineWidth = Math.max(3, cv.width / 250); g.font = `bold ${Math.round(cv.width / 30)}px sans-serif`;
    g.strokeStyle = g.fillStyle = "#F2B233"; parts.forEach((p, i) => { const [x0, y0, x1, y1] = p.box.map(v => v * sc); g.strokeRect(x0, y0, x1 - x0, y1 - y0); g.fillText(i + 1, x0 + 4, y0 + cv.width / 30); });
    g.strokeStyle = g.fillStyle = "#e0245e"; added.forEach(b => { const [x0, y0, x1, y1] = b.map(v => v * sc); g.strokeRect(x0, y0, x1 - x0, y1 - y0); g.fillText("missed", x0 + 4, y0 + cv.width / 30); });
    if (cur) { g.setLineDash([12, 8]); g.strokeRect(cur[0], cur[1], cur[2] - cur[0], cur[3] - cur[1]); g.setLineDash([]); }
    $("#r_undo").disabled = !added.length; $("#r_msg").textContent = added.length ? `${added.length} missed part${added.length === 1 ? "" : "s"} boxed` : ""; };
  const pnt = e => { const q = cv.getBoundingClientRect(); return [(e.clientX - q.left) * cv.width / q.width, (e.clientY - q.top) * cv.height / q.height]; };
  cv.onpointerdown = e => { a = pnt(e); cv.setPointerCapture(e.pointerId); };
  cv.onpointermove = e => { if (!a) return; const b = pnt(e); cur = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]; draw(); };
  cv.onpointerup = e => { if (!a) return; const b = pnt(e), h = 0.05 * Math.max(cv.width, cv.height);
    let r = Math.hypot(b[0] - a[0], b[1] - a[1]) < 10 ? [a[0] - h, a[1] - h, a[0] + h, a[1] + h] : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    r = [Math.max(0, r[0]), Math.max(0, r[1]), Math.min(cv.width, r[2]), Math.min(cv.height, r[3])]; a = null; cur = null; if (r[2] - r[0] > 4 && r[3] - r[1] > 4) { added.push(r.map(v => Math.round(v / sc))); persist(); } draw(); };
  $("#r_undo").onclick = () => { added.pop(); persist(); draw(); };
  $("#r_done").onclick = () => { host.hidden = true; host.innerHTML = ""; $("#prog .spin").hidden = false; resolve(added); };
  draw(); host.scrollIntoView({ block: "start" }); }); }
