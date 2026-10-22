// Part finder (the only detector): YOLO11n-seg "lego_brick" model run in the browser with onnxruntime-web (wasm), loaded on the first photo.
// Weights are distributed under AGPL-3.0 with this project (see THIRD_PARTY_NOTICES.md); upstream author confirmation is pending.
window.PTSBrickator = (() => {
  const VER = "brickator-y11n-1024", S = 1024, THR = 0.15, IOU = 0.5, FILL = 0.45, MODEL = "/alpha/models/brickator-y11n-seg-1024.onnx?v=1";
  let ready = null; const stats = { load_ms: null, infer_ms: null, post_ms: null, boxes: 0, raw: 0, paper: false };
  const script = src => new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("could not load " + src)); document.head.appendChild(s); });
  function load() { if (!ready) ready = (async () => { const t = performance.now();
      if (!window.ort) await script("/alpha/vendor/ort/ort.wasm.min.js?v=1");
      ort.env.wasm.wasmPaths = "/alpha/vendor/ort/"; ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
      // first time only: model + engine (~26 MB) with progress; afterwards both come from the browser cache (immutable headers)
      const WASM = "/alpha/vendor/ort/ort-wasm-simd-threaded.wasm?v=1", sizes = { [MODEL]: 12.5e6, [WASM]: 14.3e6 }, got = {};
      const tell = () => { const t = Object.values(sizes).reduce((a, b) => a + b, 0), g = Object.values(got).reduce((a, b) => a + b, 0); try { API.onprogress && API.onprogress(Math.min(g, t), t); } catch (e) {} };
      const pull = async url => { const r = await fetch(url); if (!r.ok) throw new Error("could not load " + url); const n = +r.headers.get("content-length"); if (n) sizes[url] = n;
        if (!r.body || !r.body.getReader) { const b = await r.arrayBuffer(); got[url] = b.byteLength; tell(); return b; }
        const rd = r.body.getReader(), parts = []; let k = 0; for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); k += value.length; got[url] = k; tell(); }
        const out = new Uint8Array(k); let o = 0; for (const c of parts) { out.set(c, o); o += c.length; } return out.buffer; };
      const [buf, wbin] = await Promise.all([pull(MODEL), pull(WASM).catch(() => null)]); if (wbin) ort.env.wasm.wasmBinary = wbin;   // engine bytes handed over: no second download
      const sess = await ort.InferenceSession.create(buf, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
      stats.load_ms = Math.round(performance.now() - t); return sess; })().catch(e => { ready = null; throw e; });
    return ready; }
  // white-paper mask (port of the offline test): bright, low-saturation region, largest blob with its holes filled (the parts sit in the holes)
  function paperMask(canvas) { const w = 256, h = Math.max(1, Math.round(canvas.height * w / canvas.width)), c = document.createElement("canvas"); c.width = w; c.height = h;
    const g = c.getContext("2d"); g.drawImage(canvas, 0, 0, w, h); const D = g.getImageData(0, 0, w, h).data, N = w * h, V = new Float32Array(N), m = new Uint8Array(N);
    for (let p = 0; p < N; p++) { const r = D[4 * p], gg = D[4 * p + 1], b = D[4 * p + 2], mx = Math.max(r, gg, b), mn = Math.min(r, gg, b); V[p] = mx; m[p] = mx > 170 && (mx ? (mx - mn) * 255 / mx : 0) < 35 ? 1 : 0; }
    const v60 = Float32Array.from(V).sort()[Math.floor(N * 0.6)]; for (let p = 0; p < N; p++) if (V[p] <= v60) m[p] = 0;
    const R = 5, dil = new Uint8Array(N); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let on = 0; for (let dy = -R; dy <= R && !on; dy++) { const yy = y + dy; if (yy < 0 || yy >= h) continue; for (let dx = -R; dx <= R; dx++) { const xx = x + dx; if (xx >= 0 && xx < w && m[yy * w + xx]) { on = 1; break; } } } dil[y * w + x] = on; }
    const lb = new Int32Array(N); let best = 0, bestN = 0, nl = 0;
    for (let s0 = 0; s0 < N; s0++) { if (!dil[s0] || lb[s0]) continue; nl++; let n = 0; const st = [s0]; lb[s0] = nl; while (st.length) { const p = st.pop(); n++; const x = p % w;
        for (const q of [p - 1, p + 1, p - w, p + w]) if (q >= 0 && q < N && dil[q] && !lb[q] && Math.abs((q % w) - x) <= 1) { lb[q] = nl; st.push(q); } } if (n > bestN) { bestN = n; best = nl; } }
    let dense = 0; for (let p = 0; p < N; p++) if (lb[p] === best && m[p]) dense++; stats.paper_cover = Math.round(100 * bestN / N); stats.paper_fill = Math.round(100 * dense / Math.max(1, bestN));
    if (bestN < 0.15 * N || dense < FILL * bestN) return null;   // no sheet of paper in view (or only scattered bright specks, e.g. light wood) -> no mask
    const out = new Uint8Array(N), seen = new Uint8Array(N), st = []; for (let x = 0; x < w; x++) { st.push(x, (h - 1) * w + x); } for (let y = 0; y < h; y++) st.push(y * w, y * w + w - 1);
    while (st.length) { const p = st.pop(); if (seen[p] || lb[p] === best) continue; seen[p] = 1; const x = p % w; for (const q of [p - 1, p + 1, p - w, p + w]) if (q >= 0 && q < N && !seen[q] && Math.abs((q % w) - x) <= 1) st.push(q); }
    for (let p = 0; p < N; p++) out[p] = seen[p] ? 0 : 1; return { w, h, m: out, sx: w / canvas.width, sy: h / canvas.height }; }
  async function detect(canvas, opt = {}) { const sess = await load(); const W = canvas.width, H = canvas.height, r = Math.min(S / W, S / H);
    const c = document.createElement("canvas"); c.width = S; c.height = S; const g = c.getContext("2d"); g.fillStyle = "rgb(114,114,114)"; g.fillRect(0, 0, S, S); g.drawImage(canvas, 0, 0, Math.round(W * r), Math.round(H * r));
    const D = g.getImageData(0, 0, S, S).data, x = new Float32Array(3 * S * S); for (let p = 0, n = S * S; p < n; p++) { x[p] = D[4 * p] / 255; x[n + p] = D[4 * p + 1] / 255; x[2 * n + p] = D[4 * p + 2] / 255; }
    let t = performance.now(); const out = await sess.run({ [sess.inputNames[0]]: new ort.Tensor("float32", x, [1, 3, S, S]) }); stats.infer_ms = Math.round(performance.now() - t); t = performance.now();
    const o = out[sess.outputNames[0]], P = o.data, K = o.dims[2]; let cand = [];
    for (let i = 0; i < K; i++) { const cf = P[4 * K + i]; if (cf <= THR) continue; const cx = P[i], cy = P[K + i], bw = P[2 * K + i], bh = P[3 * K + i];
      cand.push({ s: cf, b: [(cx - bw / 2) / r, (cy - bh / 2) / r, (cx + bw / 2) / r, (cy + bh / 2) / r] }); }
    stats.raw = cand.length; cand.sort((a, b) => b.s - a.s); const keep = [];
    const iou = (a, b) => { const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1])), i = ix * iy; return i / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i + 1e-9); };
    for (const d of cand) if (!keep.some(k => iou(k.b, d.b) >= IOU)) keep.push(d);
    const pm = opt.mask === false ? null : paperMask(canvas); stats.paper = !!pm;
    let boxes = keep.map(d => ({ s: d.s, b: [Math.max(0, d.b[0]), Math.max(0, d.b[1]), Math.min(W, d.b[2]), Math.min(H, d.b[3])] })).filter(d => d.b[2] - d.b[0] > 4 && d.b[3] - d.b[1] > 4);
    if (pm) boxes = boxes.filter(d => { const cx = (d.b[0] + d.b[2]) / 2 * pm.sx | 0, cy = (d.b[1] + d.b[3]) / 2 * pm.sy | 0; return pm.m[Math.min(pm.h - 1, cy) * pm.w + Math.min(pm.w - 1, cx)] && (d.b[2] - d.b[0]) * (d.b[3] - d.b[1]) < 0.03 * W * H; });
    else boxes = boxes.filter(d => (d.b[2] - d.b[0]) * (d.b[3] - d.b[1]) < 0.3 * W * H);
    // reading order like the standard detector
    const cy = d => (d.b[1] + d.b[3]) / 2; boxes.sort((a, b) => cy(a) - cy(b)); const rows = []; let cur = [];
    for (const d of boxes) { if (cur.length && cy(d) - cy(cur[0]) > 0.06 * H) { rows.push(cur); cur = []; } cur.push(d); } if (cur.length) rows.push(cur); boxes = rows.flatMap(rw => rw.sort((a, b) => a.b[0] - b.b[0]));
    const parts = boxes.map(d => { const [x0, y0, x1, y1] = d.b, p = Math.max((x1 - x0) * 0.08, (y1 - y0) * 0.08, 8);
      const X0 = Math.max(0, x0 - p | 0), Y0 = Math.max(0, y0 - p | 0), X1 = Math.min(W, x1 + p | 0), Y1 = Math.min(H, y1 + p | 0);
      const k = document.createElement("canvas"), sc = Math.min(1, 800 / Math.max(X1 - X0, Y1 - Y0)); k.width = Math.max(1, Math.round((X1 - X0) * sc)); k.height = Math.max(1, Math.round((Y1 - Y0) * sc));
      k.getContext("2d").drawImage(canvas, X0, Y0, X1 - X0, Y1 - Y0, 0, 0, k.width, k.height);
      // color: same as boxes the sorter draws (part pixels of the crop -> estimateColor in the app)
      return { box: [X0, Y0, X1, Y1], crop: k.toDataURL("image/jpeg", 0.9), lab: PTSDetect.cropLab(k), group: null, merged: null, score: Math.round(d.s * 1000) / 1000 }; });
    stats.post_ms = Math.round(performance.now() - t); stats.boxes = parts.length; return parts; }
  const API = { VER, load, detect, stats, paperMask, onprogress: null }; return API;
})();
