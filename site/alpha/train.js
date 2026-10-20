// Paid to Sort alpha: training-data capture. One shared pool for all hosts; samples hold no host/user/session data.
// Photo (downscaled, kept locally until the cards are resolved) + per-box labels -> IndexedDB queue -> background upload with retry.
window.PTSTrain = (() => {
  const APP_VER = "alpha-24", DET_VER = "cv-blob-1", MAXSIDE = 1600, TARGET = 520 * 1024;
  let dbp = null;
  const idb = () => dbp || (dbp = new Promise((res, rej) => { const r = indexedDB.open("pts-train", 1);
    r.onupgradeneeded = () => { r.result.createObjectStore("pending", { keyPath: "id" }); r.result.createObjectStore("queue", { keyPath: "id" }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
  const tx = async (store, mode, fn) => { const d = await idb(); return new Promise((res, rej) => { const t = d.transaction(store, mode), s = t.objectStore(store); const r = fn(s); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); }); };
  const all = store => tx(store, "readonly", s => s.getAll());
  const put = (store, v) => tx(store, "readwrite", s => s.put(v));
  const del = (store, k) => tx(store, "readwrite", s => s.delete(k));
  const rid = () => [...crypto.getRandomValues(new Uint8Array(16))].map(x => x.toString(16).padStart(2, "0")).join("");
  const toBlob = (c, q) => new Promise(r => c.toBlob(r, "image/jpeg", q));
  async function jpeg(c) { let q = 0.86, b = await toBlob(c, q); while (b.size > TARGET && q > 0.4) { q -= 0.08; b = await toBlob(c, q); } return b; }
  const blobURL = b => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });
  const loadImg = b => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = URL.createObjectURL(b); });

  // called right after detection + card save. canvas = the detector's frame; boxes = [{box:[x1,y1,x2,y2], card_id, pred:{part,color,score}}]
  async function begin(sid, canvas, boxes, det) {
    const s = Math.min(1, MAXSIDE / Math.max(canvas.width, canvas.height)), c = document.createElement("canvas");
    c.width = Math.round(canvas.width * s); c.height = Math.round(canvas.height * s); c.getContext("2d").drawImage(canvas, 0, 0, c.width, c.height);
    const rec = { id: rid(), sid, t: Date.now(), frame: { w: canvas.width, h: canvas.height }, scale: s, photo: await jpeg(c), boxes, missed: [], det: det || DET_VER };
    await put("pending", rec); return rec.id;
  }
  const pendingFor = async sid => (await all("pending")).filter(r => r.sid === sid).sort((a, b) => b.t - a.t);
  async function addMissed(id, box, card_id) { const r = (await all("pending")).find(x => x.id === id); if (!r) return; r.missed.push({ box, card_id: card_id || null }); await put("pending", r); }

  // finalize: resolved (or forced on leave/finish) -> labels + cropped photo -> upload queue
  async function check(sid, api, force) {
    for (const r of await pendingFor(sid)) {
      const ids = [...r.boxes, ...r.missed].map(b => b.card_id).filter(Boolean);
      const j = ids.length ? await api("train/cards?ids=" + [...new Set(ids)].join(",")) : { cards: [] }; if (!j.cards) continue;
      const by = Object.fromEntries(j.cards.map(c => [c.id, c]));
      const open = ids.some(id => !by[id] || by[id].status === "pending");
      if (open && !force && Date.now() - r.t < 864e5) continue;
      await finalize(r, by);
    }
    flush();
  }
  async function finalize(r, by) {
    const W = r.frame.w, H = r.frame.h, all4 = [...r.boxes.map(b => b.box), ...r.missed.map(m => m.box)];
    // privacy: no sheet-boundary detector yet, so crop to the work area (all boxes + margin). TODO: blur hands/faces.
    let crop = [0, 0, W, H];
    if (all4.length) { const m = 0.12 * Math.max(W, H); crop = [Math.max(0, Math.min(...all4.map(b => b[0])) - m), Math.max(0, Math.min(...all4.map(b => b[1])) - m), Math.min(W, Math.max(...all4.map(b => b[2])) + m), Math.min(H, Math.max(...all4.map(b => b[3])) + m)].map(Math.round); }
    const s = r.scale, im = await loadImg(r.photo), c = document.createElement("canvas");
    c.width = Math.round((crop[2] - crop[0]) * s); c.height = Math.round((crop[3] - crop[1]) * s);
    c.getContext("2d").drawImage(im, crop[0] * s, crop[1] * s, c.width, c.height, 0, 0, c.width, c.height);
    const bi = b => [(b[0] - crop[0]) * s, (b[1] - crop[1]) * s, (b[2] - crop[0]) * s, (b[3] - crop[1]) * s];
    const lab = (b, missed) => { const c = b.card_id ? by[b.card_id] : null; let status, part = null, color = null;
      if (missed) { status = "missed"; if (c && c.status !== "dropped" && c.status !== "pending") { part = c.part; color = c.color; } }
      else if (!c || c.status === "pending") status = "unreviewed";
      else if (c.status === "dropped") status = "dropped";
      else { part = c.part; color = c.color; status = b.pred && (b.pred.part !== c.part || +b.pred.color !== +c.color) ? "corrected" : "confirmed"; }
      return { box: b.box, box_img: bi(b.box), status, pred: missed ? null : b.pred, part, color }; };
    const labels = { app_version: APP_VER, detector_version: r.det || DET_VER, frame: r.frame, crop, scale: s, image: { w: c.width, h: c.height },
      boxes: [...r.boxes.map(b => lab(b, false)), ...r.missed.map(m => lab(m, true))] };
    await put("queue", { id: r.id, image: await blobURL(await jpeg(c)), labels, tries: 0, next: 0 }); await del("pending", r.id);
  }
  // background upload with exponential backoff; retried on 'online' and every 30 s
  let busy = false; const LOG = [];
  async function flush() { if (busy || !navigator.onLine) return; busy = true;
    try { for (const q of await all("queue")) { if (q.next > Date.now()) continue;
        let ok = false; try { const r = await fetch("/alpha/api/train/sample", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ id: q.id, image: q.image, labels: q.labels }) }); ok = r.ok; if (r.status === 400) ok = true; LOG.push([q.id.slice(0, 8), r.status]); } catch (e) { LOG.push([q.id.slice(0, 8), "net"]); }
        if (ok) await del("queue", q.id); else { q.tries++; q.next = Date.now() + Math.min(300e3, 2000 * 2 ** q.tries); await put("queue", q); } } }
    finally { busy = false; } }
  addEventListener("online", flush); setInterval(flush, 30e3); setTimeout(flush, 3000);
  return { log: LOG, begin, check, addMissed, pendingFor, flush, queue: () => all("queue"), pending: () => all("pending"), loadImg };
})();
