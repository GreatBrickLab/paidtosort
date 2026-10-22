// Colour helpers for detected parts (estimateColor, cropLab), pure JS. The part finder itself is detect-brickator.js.
// (The former OpenCV part finder and its opencv.js load were removed: the ONNX finder is the only detector.)
window.PTSDetect = (() => {
  const median = a => { const s = Float64Array.from(a).sort(); return s.length ? s[s.length >> 1] : 0; };
  const pct = (a, p) => { const s = Float64Array.from(a).sort(); return s.length ? s[Math.min(s.length - 1, Math.floor(p / 100 * (s.length - 1)))] : 0; };
  function inv3(C) { const [a, b, c, d, e, f, g, h, i] = C; const A = e * i - f * h, B = -(d * i - f * g), Cc = d * h - e * g; const det = a * A + b * B + c * Cc;
    return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), Cc, -(a * h - b * g), a * e - b * d].map(x => x / det); }
  function cov(X, keep, mu) { const C = [0, 0, 0, 0, 0, 0, 0, 0, 0]; let n = 0;
    for (let p = 0; p < keep.length; p++) if (keep[p]) { n++; const v = [X[3 * p] - mu[0], X[3 * p + 1] - mu[1], X[3 * p + 2] - mu[2]]; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[3 * i + j] += v[i] * v[j]; }
    return C.map((x, k) => x / Math.max(1, n - 1) + (k % 4 === 0 ? 1 : 0)); }
  function maha(X, mu, Ci) { const N = X.length / 3, g = new Float64Array(N);
    for (let p = 0; p < N; p++) { const v0 = X[3 * p] - mu[0], v1 = X[3 * p + 1] - mu[1], v2 = X[3 * p + 2] - mu[2];
      g[p] = v0 * (Ci[0] * v0 + Ci[1] * v1 + Ci[2] * v2) + v1 * (Ci[3] * v0 + Ci[4] * v1 + Ci[5] * v2) + v2 * (Ci[6] * v0 + Ci[7] * v1 + Ci[8] * v2); } return g; }

  // colour guess (port of catalog.estimate_color). lab: [[L,a,b]...] 8-bit OpenCV Lab
  function estimateColor(lab, partId, allowed, PAL) {
    const BY = Object.fromEntries(PAL.map(c => [c.id, c]));
    const med = [0, 1, 2].map(i => median(lab.map(v => v[i]))), Ls = lab.map(v => v[0]);
    let chroma = Math.hypot(med[1] - 128, med[2] - 128); const printed = /(pb|pr|pat)\d/.test(partId || "");
    let cands = allowed && allowed.length ? PAL.filter(c => allowed.includes(c.id)) : PAL; if (!cands.length) cands = PAL;
    const has = id => cands.some(c => c.id === id);
    let L = pct(Ls, printed ? 90 : 70); if (printed) chroma = 0;
    const dl = c => Math.hypot(c.lab[0] - L, c.lab[1] - med[1], c.lab[2] - med[2]);
    let ranked;
    if (chroma < 15) {
      let order = L < 60 ? [11, 85] : L < 120 ? [85, 11, 86] : L < 236 ? [86, 1, 85] : [1, 86];
      if ((!printed && L > 150 && med[2] < 127.5 && has(12)) || (allowed && allowed.length <= 2 && allowed.includes(12))) order = [12, ...order];
      ranked = [...order.filter(has), ...order.filter(i => !has(i))].map(i => BY[i]).filter(Boolean);
      ranked = ranked.concat(cands.filter(c => !ranked.includes(c)).sort((a, b) => dl(a) - dl(b)));
    } else {
      const h0 = Math.atan2(med[2] - 128, med[1] - 128) * 180 / Math.PI;
      const dist = c => { const a = c.lab[1] - 128, b = c.lab[2] - 128, dh = Math.abs(((Math.atan2(b, a) * 180 / Math.PI - h0 + 180) % 360 + 360) % 360 - 180);
        return 1.2 * dh + 0.1 * Math.abs(c.lab[0] - med[0] * 1.1) + 0.15 * Math.abs(Math.hypot(a, b) - chroma); };
      ranked = cands.filter(c => !c.trans && Math.hypot(c.lab[1] - 128, c.lab[2] - 128) > 8).sort((a, b) => dist(a) - dist(b));
      ranked = ranked.concat(PAL.filter(c => !ranked.includes(c)));
    }
    return ranked.filter(Boolean).length ? ranked.filter(Boolean) : [BY[11]];
  }
  // part pixels of a hand-drawn crop (no OpenCV needed), in the same 8-bit OpenCV Lab that detect() samples for estimateColor:
  // background = median of the crop's border ring; part = pixels far from it (detector weighting); fallback = central region
  function cropLab(canvas) {
    const sc = Math.min(1, 240 / Math.max(canvas.width, canvas.height)), w = Math.max(1, Math.round(canvas.width * sc)), h = Math.max(1, Math.round(canvas.height * sc));
    const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d"); g.drawImage(canvas, 0, 0, w, h);
    const D = g.getImageData(0, 0, w, h).data, N = w * h, lab = new Array(N);
    const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }, f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    for (let p = 0; p < N; p++) { const r = lin(D[4 * p]), gg = lin(D[4 * p + 1]), b = lin(D[4 * p + 2]);
      const X = (0.412453 * r + 0.357580 * gg + 0.180423 * b) / 0.950456, Y = 0.212671 * r + 0.715160 * gg + 0.072169 * b, Z = (0.019334 * r + 0.119193 * gg + 0.950227 * b) / 1.088754;
      const L = Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y;
      lab[p] = [Math.round(L * 255 / 100), Math.round(500 * (f(X) - f(Y)) + 128), Math.round(200 * (f(Y) - f(Z)) + 128)]; }
    const bw = Math.max(1, Math.round(0.08 * Math.min(w, h))), ring = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < bw || y < bw || x >= w - bw || y >= h - bw) ring.push(lab[y * w + x]);
    const bg = [0, 1, 2].map(i => median(ring.map(v => v[i])));
    // foreground mask -> erode twice (drops edges, shadows, blur) -> keep the biggest blob touching the crop's centre (neighbouring parts excluded)
    let fg = new Uint8Array(N);
    for (let y = bw; y < h - bw; y++) for (let x = bw; x < w - bw; x++) { const v = lab[y * w + x], d0 = (v[0] - bg[0]) * .5, d1 = (v[1] - bg[1]) * 2, d2 = (v[2] - bg[2]) * 2;
      if (Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2) > 20) fg[y * w + x] = 1; }
    for (let it = 0; it < 2; it++) { const e = new Uint8Array(N); for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const p = y * w + x; e[p] = fg[p] && fg[p - 1] && fg[p + 1] && fg[p - w] && fg[p + w] ? 1 : 0; } fg = e; }
    const lb = new Int32Array(N), cx0 = w * .25, cx1 = w * .75, cy0 = h * .25, cy1 = h * .75; let best = null, nl = 0;
    for (let s0 = 0; s0 < N; s0++) { if (!fg[s0] || lb[s0]) continue; nl++; const st = [s0], pts = []; let central = 0; lb[s0] = nl;
      while (st.length) { const p = st.pop(), x = p % w, y = (p / w) | 0; pts.push(p); if (x >= cx0 && x <= cx1 && y >= cy0 && y <= cy1) central++;
        for (const q of [p - 1, p + 1, p - w, p + w]) if (q >= 0 && q < N && fg[q] && !lb[q] && Math.abs((q % w) - x) <= 1) { lb[q] = nl; st.push(q); } }
      if (central && (!best || pts.length > best.length)) best = pts; }
    const sel = best ? best.map(p => lab[p]) : [];
    if (sel.length >= Math.max(30, 0.01 * N)) return sel;
    const out = []; for (let y = h >> 2; y < h - (h >> 2); y++) for (let x = w >> 2; x < w - (w >> 2); x++) out.push(lab[y * w + x]); return out.length ? out : lab;
  }
  return { estimateColor, cropLab };
})();
