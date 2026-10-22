// Parts list for one photo / bag: identify results (one per detected crop) -> one row per part + color, qty summed.
// Pure: no DOM, no network. Low-confidence rows and unidentified crops stay in the list, flagged (never dropped).
// Loaded as a classic script in the browser (window.PTSPartsList) and with require() in node tests.
// site/alpha/partslist.js must be an identical copy (test/run.sh checks).
(function (root) {
  const LOW = 0.7, R3 = x => Math.round((+x || 0) * 1000) / 1000;
  // dets: [{ items: [{id, name, score, type}], crop?, color?, color_guesses? }] in photo order
  // opts.undetermined(id, item) -> true for "Undetermined Type" catalog entries (skipped, never top or alternate)
  // opts.colorFor(det, top) -> {color, guesses} for the chosen top part (pixel estimate in the app); default det.color
  // opts.low: score under this is flagged "low"; opts.nAlts: alternates kept per row
  function buildPartsList(dets, opts = {}) {
    const low = opts.low ?? LOW, nAlts = opts.nAlts ?? 3, und = opts.undetermined || (() => false);
    const colorFor = opts.colorFor || (d => ({ color: d.color ?? 0, guesses: d.color_guesses || [] }));
    const rows = [], byKey = new Map(), rowOf = [];
    (dets || []).forEach((d, i) => {
      const items = (d && Array.isArray(d.items) ? d.items : []).filter(it => it && it.id && (!it.type || it.type === "part") && !und(String(it.id), it))
        .map(it => ({ id: String(it.id), name: String(it.name || ""), score: R3(it.score) }));
      if (!items.length) { rowOf.push(rows.length); rows.push({ key: "?#" + i, part: "?", name: "", color: 0, qty: 1, score: 0, best: 0, flag: "unidentified", alts: [], crop: d?.crop || null, color_guesses: [], src: [i] }); return; }
      const top = items[0], c = colorFor(d, top) || {}, color = +c.color || 0, key = top.id + "|" + color;
      const alts = items.slice(1).filter((a, j, A) => a.id !== top.id && A.findIndex(b => b.id === a.id) === j);
      let r = byKey.get(key);
      if (!r) { r = { key, part: top.id, name: top.name, color, qty: 0, score: top.score, best: top.score, flag: "ok", alts: [], crop: d.crop || null, color_guesses: (c.guesses || []).map(Number).filter(Number.isFinite), src: [] }; byKey.set(key, r); rows.push(r); }
      r.qty++; r.src.push(i); r.score = Math.min(r.score, top.score);
      if (top.score > r.best) { r.best = top.score; if (d.crop) r.crop = d.crop; }   // thumbnail: the clearest crop
      for (const a of alts) { const e = r.alts.find(x => x.id === a.id); if (!e) r.alts.push({ ...a }); else e.score = Math.max(e.score, a.score); }
      rowOf.push(rows.indexOf(r));
    });
    for (const r of rows) { r.alts = r.alts.sort((a, b) => b.score - a.score).slice(0, nAlts); if (r.flag !== "unidentified" && r.score < low) r.flag = "low"; }
    return { rows, rowOf, summary: { crops: rowOf.length, rows: rows.length, pcs: rows.reduce((a, r) => a + r.qty, 0), low: rows.filter(r => r.flag === "low").length, unidentified: rows.filter(r => r.flag === "unidentified").length } };
  }
  // a row as the verify-card payload the session/cards endpoint takes (confidence = lowest score; alternates include the top for display order)
  const toCard = r => ({ part: r.part, name: r.name, color: r.color, qty: r.qty, confidence: r.score, flag: r.flag, crop: r.crop, color_guesses: r.color_guesses,
    alts: (r.part === "?" ? r.alts : [{ id: r.part, name: r.name, score: r.best }, ...r.alts]).slice(0, 4) });
  const api = { buildPartsList, toCard, LOW };
  if (typeof module === "object" && module.exports) module.exports = api; else root.PTSPartsList = api;
})(typeof self !== "undefined" ? self : this);
