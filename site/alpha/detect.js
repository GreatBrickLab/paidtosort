// In-browser port of the v1 OpenCV part detector (background model in Lab, colour distance threshold,
// seam removal, close/fill, erosion+watershed split, filters, fragment merge, reading order) + colour guess.
window.PTSDetect = (() => {
  const K = (n, shape) => cv.getStructuringElement(shape ?? cv.MORPH_ELLIPSE, new cv.Size(Math.max(1, n | 0), Math.max(1, n | 0)));
  const R = (w, h) => cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(w, h));
  const morph = (src, op, k) => { const d = new cv.Mat(); cv.morphologyEx(src, d, op, k); k.delete(); return d; };
  const er = (src, k) => { const d = new cv.Mat(); cv.erode(src, d, k); k.delete(); return d; };
  const di = (src, k) => { const d = new cv.Mat(); cv.dilate(src, d, k); k.delete(); return d; };
  const bop = (f, a, b) => { const d = new cv.Mat(); cv[f](a, b, d); return d; };
  const bnot = a => { const d = new cv.Mat(); cv.bitwise_not(a, d); return d; };
  const nz = m => cv.countNonZero(m);
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

  function background(smallLab, w, h, woodThresh) { // smallLab: Float32Array w*h*3
    const X = smallLab, N = w * h;
    let mu = [0, 1, 2].map(c => median(Array.from({ length: N }, (_, p) => X[3 * p + c])));
    let keep = new Uint8Array(N).fill(1);
    for (let it = 0; it < 4; it++) { const g = maha(X, mu, inv3(cov(X, keep, mu))); const t = pct(g, 60);
      const s = [0, 0, 0]; let n = 0; for (let p = 0; p < N; p++) { keep[p] = g[p] < t ? 1 : 0; if (keep[p]) { n++; s[0] += X[3 * p]; s[1] += X[3 * p + 1]; s[2] += X[3 * p + 2]; } } mu = s.map(v => v / Math.max(1, n)); }
    const g = maha(X, mu, inv3(cov(X, keep, mu))).map(Math.sqrt);
    let wood = new Float32Array(N), warm = new Float32Array(N), nw = 0;
    for (let p = 0; p < N; p++) { const L = X[3 * p], a = X[3 * p + 1], b = X[3 * p + 2]; wood[p] = g[p] < woodThresh ? 1 : 0;
      if (wood[p] && b > Math.min(132, mu[2] - 4) && Math.abs(a - mu[1]) < 6 && L > 45) { warm[p] = 1; nw++; } }
    if (nw / N > 0.2) wood = warm;
    let wm = cv.matFromArray(h, w, cv.CV_32F, wood); const we = er(wm, K(5)); wm.delete();
    const wv = we.data32F; const num = new Float32Array(N * 3); for (let p = 0; p < N; p++) for (let c = 0; c < 3; c++) num[3 * p + c] = X[3 * p + c] * wv[p];
    const nm = cv.matFromArray(h, w, cv.CV_32FC3, num), nb = new cv.Mat(), db = new cv.Mat();
    cv.GaussianBlur(nm, nb, new cv.Size(0, 0), 15); cv.GaussianBlur(we, db, new cv.Size(0, 0), 15);
    const out = new Float32Array(N * 3), A = nb.data32F, D = db.data32F;
    for (let p = 0; p < N; p++) { const d = D[p] + 1e-3; for (let c = 0; c < 3; c++) out[3 * p + c] = D[p] + 1e-3 > 0.02 ? A[3 * p + c] / d : mu[c]; }
    [nm, nb, db, we].forEach(m => m.delete());
    return cv.matFromArray(h, w, cv.CV_32FC3, out);
  }

  function contourOf(mask) { const cs = new cv.MatVector(), hi = new cv.Mat(); cv.findContours(mask, cs, hi, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE); hi.delete();
    let best = null, ba = -1; for (let i = 0; i < cs.size(); i++) { const c = cs.get(i), a = cv.contourArea(c); if (a > ba) { if (best) best.delete(); best = c; ba = a; } else c.delete(); } cs.delete(); return best ? { c: best, a: ba } : null; }

  // img: HTMLCanvasElement (full res). returns parts [{box, crop(dataURL), lab:[...pixels], group, merged:{box,crop,lab}}]
  function detect(canvas, opt = {}) {
    const thresh = opt.thresh ?? 20, close = 7, woodThresh = 3, split = 31, minWidth = 20, work = 1000, pad = 0.08;
    const W0 = canvas.width, H0 = canvas.height, s = work / Math.max(W0, H0);
    const full = cv.imread(canvas), sm4 = new cv.Mat(); cv.resize(full, sm4, new cv.Size(Math.round(W0 * s), Math.round(H0 * s)), 0, 0, cv.INTER_AREA); full.delete();
    const sm = new cv.Mat(); cv.cvtColor(sm4, sm, cv.COLOR_RGBA2RGB); sm4.delete();
    const W = sm.cols, H = sm.rows;
    const bl = new cv.Mat(), lab = new cv.Mat(), labRaw = new cv.Mat(); cv.GaussianBlur(sm, bl, new cv.Size(5, 5), 0); cv.cvtColor(bl, lab, cv.COLOR_RGB2Lab); bl.delete(); cv.cvtColor(sm, labRaw, cv.COLOR_RGB2Lab);
    const sl = new cv.Mat(); cv.resize(lab, sl, new cv.Size(Math.round(W * .25), Math.round(H * .25)), 0, 0, cv.INTER_LINEAR);
    const slf = new cv.Mat(); sl.convertTo(slf, cv.CV_32FC3); sl.delete();
    const bgs = background(slf.data32F.slice(), slf.cols, slf.rows, woodThresh); slf.delete();
    const bg = new cv.Mat(); cv.resize(bgs, bg, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR); bgs.delete();
    const LD = lab.data, BG = bg.data32F, N = W * H, rawA = new Uint8Array(N);
    for (let p = 0; p < N; p++) { const d0 = (LD[3 * p] - BG[3 * p]) * .5, d1 = (LD[3 * p + 1] - BG[3 * p + 1]) * 2, d2 = (LD[3 * p + 2] - BG[3 * p + 2]) * 2; rawA[p] = Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2) > thresh ? 255 : 0; }
    let raw0 = cv.matFromArray(H, W, cv.CV_8U, rawA); const raw = morph(raw0, cv.MORPH_OPEN, K(3)); raw0.delete();
    const L = Math.round(0.12 * work);
    const lh = morph(raw, cv.MORPH_OPEN, R(L, 1)), lv = morph(raw, cv.MORPH_OPEN, R(1, L)), lines0 = bop("bitwise_or", lh, lv); lh.delete(); lv.delete();
    const t0 = morph(raw, cv.MORPH_OPEN, K(23)), thick = di(t0, K(9)); t0.delete();
    const nt = bnot(thick), l1 = bop("bitwise_and", lines0, nt), lines = di(l1, K(9, cv.MORPH_RECT)); [nt, l1, thick, lines0].forEach(m => m.delete());
    const nl = bnot(lines), m0 = bop("bitwise_and", raw, nl); nl.delete();
    let m = morph(m0, cv.MORPH_OPEN, K(5)); m0.delete();
    { const dm = di(m, K(31)), a = bop("bitwise_and", raw, lines), b = bop("bitwise_and", a, dm), o = bop("bitwise_or", m, b); [dm, a, b, m].forEach(x => x.delete()); m = o; }
    const pre = m.clone();
    { const c = morph(m, cv.MORPH_CLOSE, K(close)); m.delete(); m = c; const cs = new cv.MatVector(), hi = new cv.Mat(); cv.findContours(m, cs, hi, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      m.setTo(new cv.Scalar(0)); cv.drawContours(m, cs, -1, new cv.Scalar(255), -1); cs.delete(); hi.delete(); const o = morph(m, cv.MORPH_OPEN, K(11)); m.delete(); m = o; }
    const minA = 0.0006 * H * W;
    const labels = new cv.Mat(), n = cv.connectedComponents(m, labels), LB = labels.data32S;
    const blobs = [];
    const maskFrom = (pred) => { const a = new Uint8Array(N); for (let p = 0; p < N; p++) if (pred(p)) a[p] = 255; return cv.matFromArray(H, W, cv.CV_8U, a); };
    for (let i = 1; i < n; i++) {
      const comp = maskFrom(p => LB[p] === i); if (nz(comp) < minA) { comp.delete(); continue; }
      const pieces = []; const cp = bop("bitwise_and", comp, pre);
      for (let e = 3; e <= split; e += 2) {
        const ee = er(cp, K(e)), l2 = new cv.Mat(), st = new cv.Mat(), ce = new cv.Mat(); const k = cv.connectedComponentsWithStats(ee, l2, st, ce); ee.delete(); ce.delete();
        if (k <= 2) { l2.delete(); st.delete(); continue; }
        let mx = 0; for (let j = 1; j < k; j++) mx = Math.max(mx, st.intAt(j, cv.CC_STAT_AREA));
        const big = []; for (let j = 1; j < k; j++) { const a = st.intAt(j, cv.CC_STAT_AREA); if (a >= 0.2 * mx && a > 150) big.push(j); } st.delete();
        if (big.length < 2) { l2.delete(); continue; }
        const L2 = l2.data32S, CD = comp.data, mk = new Int32Array(N);
        for (let p = 0; p < N; p++) { const t = big.indexOf(L2[p]); if (t >= 0) mk[p] = t + 1; if (!CD[p]) mk[p] = big.length + 1; } l2.delete();
        const markers = cv.matFromArray(H, W, cv.CV_32S, mk); cv.watershed(sm, markers); const WS = markers.data32S;
        for (let t = 1; t <= big.length; t++) { const pm = maskFrom(p => WS[p] === t && CD[p]), pe = er(pm, K(3)); pm.delete(); const ct = contourOf(pe);
          if (!ct) { pe.delete(); continue; } const r = cv.minAreaRect(ct.c); pieces.push([pe, Math.min(r.size.width, r.size.height), ct.a]); ct.c.delete(); }
        markers.delete(); break;
      }
      cp.delete();
      if (pieces.length >= 2 && pieces.every(p => p[1] >= minWidth * work / 1000 && p[2] >= minA)) { const gid = blobs.length; pieces.forEach(p => blobs.push({ mask: p[0], merged: comp, group: gid })); }
      else { pieces.forEach(p => p[0].delete()); blobs.push({ mask: comp, merged: null, group: null }); }
    }
    labels.delete(); m.delete(); pre.delete();
    let out = [];
    for (const b of blobs) { const ct = contourOf(b.mask); if (!ct) continue; const a = ct.a, br = cv.boundingRect(ct.c), r = cv.minAreaRect(ct.c); ct.c.delete();
      const w = r.size.width, h = r.size.height;
      if (a < minA || Math.max(w, h) / Math.max(1, Math.min(w, h)) > 10) continue;
      if (br.x <= 2 || br.y <= 2 || br.x + br.width >= W - 2 || br.y + br.height >= H - 2) continue;
      out.push({ mask: b.mask, box: [br.x, br.y, br.x + br.width, br.y + br.height], area: a, merged: b.merged, group: b.group }); }
    let changed = true;
    while (changed) { changed = false;
      outer: for (let i = 0; i < out.length; i++) for (let j = 0; j < out.length; j++) { if (i === j) continue; const A = out[i], B = out[j]; if (A.area < B.area) continue;
        const a = A.box, b = B.box, ix = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), iy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]), ia = Math.max(0, ix) * Math.max(0, iy), sa = (b[2] - b[0]) * (b[3] - b[1]);
        if ((ia > 0.6 * sa && B.area < 0.5 * A.area) || (B.area < 0.12 * A.area && ix > -6 && iy > -6)) { const o = bop("bitwise_or", A.mask, B.mask); A.mask = o;
          A.box = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]; A.area += B.area; out.splice(j, 1); changed = true; break outer; } } }
    const cy = o => (o.box[1] + o.box[3]) / 2; out.sort((x, y) => cy(x) - cy(y));
    const rows = []; let cur = []; for (const o of out) { if (cur.length && cy(o) - cy(cur[0]) > 0.06 * H) { rows.push(cur); cur = []; } cur.push(o); } if (cur.length) rows.push(cur);
    out = rows.flatMap(r => r.sort((x, y) => x.box[0] - y.box[0]));
    const crop = (X0, Y0, X1, Y1) => { const c = document.createElement("canvas"), sc = Math.min(1, 800 / Math.max(X1 - X0, Y1 - Y0)); c.width = Math.round((X1 - X0) * sc); c.height = Math.round((Y1 - Y0) * sc);
      c.getContext("2d").drawImage(canvas, X0, Y0, X1 - X0, Y1 - Y0, 0, 0, c.width, c.height); return c.toDataURL("image/jpeg", 0.9); };
    const RAW = raw.data, LR = labRaw.data;
    const samp = (mask) => { const ie = er(mask, K(7)); let inner = ie; if (nz(ie) < 50) inner = mask; const I = inner.data; let sel = [];
      for (let p = 0; p < N; p++) if (I[p] && RAW[p]) sel.push(p); if (sel.length < 50) { sel = []; for (let p = 0; p < N; p++) if (I[p]) sel.push(p); } ie.delete();
      return sel.map(p => [LR[3 * p], LR[3 * p + 1], LR[3 * p + 2]]); };
    const res = [];
    for (const o of out) { const [x0, y0, x1, y1] = o.box, p = Math.max((x1 - x0) * pad, (y1 - y0) * pad, 8);
      const X0 = Math.max(0, (x0 - p) / s | 0), Y0 = Math.max(0, (y0 - p) / s | 0), X1 = Math.min(W0, (x1 + p) / s | 0), Y1 = Math.min(H0, (y1 + p) / s | 0);
      const r = { box: [X0, Y0, X1, Y1], crop: crop(X0, Y0, X1, Y1), lab: samp(o.mask), group: o.group };
      if (o.merged) { const ct = contourOf(o.merged); const br = cv.boundingRect(ct.c); ct.c.delete(); const q = Math.max(br.width, br.height) * pad;
        const MX0 = Math.max(0, (br.x - q) / s | 0), MY0 = Math.max(0, (br.y - q) / s | 0), MX1 = Math.min(W0, (br.x + br.width + q) / s | 0), MY1 = Math.min(H0, (br.y + br.height + q) / s | 0);
        r.merged = { box: [MX0, MY0, MX1, MY1], crop: crop(MX0, MY0, MX1, MY1), lab: samp(o.merged) }; }
      res.push(r); }
    const freed = new Set(); for (const b of blobs) { if (!freed.has(b.mask)) { try { b.mask.delete(); } catch (e) { } freed.add(b.mask); } if (b.merged && !freed.has(b.merged)) { try { b.merged.delete(); } catch (e) { } freed.add(b.merged); } }
    [sm, lab, labRaw, bg, raw, lines].forEach(x => x.delete());
    return res;
  }

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
  return { detect, estimateColor, cropLab };
})();
