// Shared helpers: DOM, API, units (oz / lb), Central-time clock, palette + parts catalog lookups, toasts, offline banner.
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const BASE = "/alpha2";
const ref = p => `${BASE}/api/ref/${encodeURIComponent(p)}`;   // reference picture of a part (through our API)
let ME = null, PAL = null, PALBY = {}, Q = Promise.resolve();
const NET = (() => { let bar = null; const show = on => { if (on && !bar) { bar = document.createElement("div"); bar.id = "netbar"; bar.setAttribute("role", "alert"); bar.textContent = "Offline: photos can’t be identified and changes can’t be saved until you are back online."; document.body.appendChild(bar); } else if (!on && bar) { bar.remove(); bar = null; } };
  addEventListener("offline", () => show(true)); addEventListener("online", () => show(false)); if (navigator.onLine === false) setTimeout(() => show(true)); return { down: () => show(true), up: () => navigator.onLine !== false && show(false) }; })();
// writes are serialized (in order); a pressed button stays disabled until its request answers
const BUSY = (() => { let last = null, at = 0; document.addEventListener("click", e => { const b = e.target.closest("button"); if (b && !b.matches(".qbtn")) { last = b; at = Date.now(); } }, true);
  return { claim: () => { const b = last && Date.now() - at < 1500 && last.isConnected ? last : null; last = null; if (b) b.disabled = true; return b; } }; })();
async function api(path, body) {
  const go = async () => { let r; try { r = await fetch(`${BASE}/api/${path}`, { method: body ? "POST" : "GET", headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" }); }
    catch (e) { NET.down(); return { error: "No connection. Nothing was saved; try again when you have signal.", offline: true }; } NET.up();
    const j = await r.json().catch(() => ({ error: "Unexpected answer from the server." }));
    if (r.status === 401 && path !== "login") { ME = null; sessionStorage.setItem("pts2-why", j.reason && j.reason !== "none" ? j.error : ""); if (path !== "me") location.hash = "#/login"; }
    return Object.assign(j, { _status: r.status }); };
  if (!body) return go(); const b = BUSY.claim(), p = Q.then(go); Q = p.catch(() => {}); if (b) p.finally(() => { b.disabled = false; }); return p;
}
function toast(t, ms = 2400) { $$(".toast").forEach(x => x.remove()); const d = document.createElement("div"); d.className = "toast"; d.setAttribute("role", "status"); d.textContent = t; document.body.appendChild(d); setTimeout(() => d.remove(), ms); }
// time: server stores UTC; everything shown is Central time
const ctime = (t, opt) => { if (!t) return "–"; const d = new Date(String(t).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? "" : "Z"));
  return d.toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", ...(opt || { hour: "numeric", minute: "2-digit" }) }) + (opt ? "" : " CT"); };
// weight: grams in, oz under 1 lb, lb above
const G_OZ = 28.349523125;
const fmtW = g => { const oz = (+g || 0) / G_OZ; return oz >= 16 ? `${(oz / 16).toFixed(2)} lb` : `${oz > 0 && oz < 1 ? oz.toFixed(2) : oz.toFixed(1)} oz`; };
// deliberately LOW estimate: catalog grams x EST_LOW (real pay comes from a scale weight)
const EST_LOW = 0.85;
let WT = null; const weights = () => WT || (WT = fetch(`${BASE}/data/weights.json`).then(r => r.json()).then(w => { for (const k in w) w[k] *= EST_LOW; return w; }).catch(() => ({})));
async function palette() { if (!PAL) { PAL = await (await fetch(`${BASE}/data/palette.json`)).json(); PAL.forEach(c => PALBY[c.id] = c); } return PAL; }
const cname = id => PALBY[id]?.name || String(id), crgb = id => PALBY[id]?.rgb || "888888";
// parts catalog (static shards): name + known colors; part-number variants tried in order
const SHARDS = {};
const candidates = p => { const c = [p]; let m = p.match(/^(\d+[a-z]?)(pb|pr|pat)\d+/); if (m) c.push(m[1]); if (/^\d+[a-z]$/.test(p)) c.push(p.slice(0, -1)); if (/^\d+$/.test(p)) c.push(p + "b", p + "a"); return c; };
async function partInfo(p) { for (const q of candidates(String(p))) { const k = q.slice(0, 3).toLowerCase().replace(/[^a-z0-9]/g, "_").padEnd(3, "_");
    SHARDS[k] = SHARDS[k] || fetch(`${BASE}/data/pc/${k}.json`).then(r => r.ok ? r.json() : {}).catch(() => ({})); const d = (await SHARDS[k])[q]; if (d) return { name: d[0], colors: d[1] }; } return { name: "", colors: [] }; }
const isUndetermined = async p => /undetermined/i.test((await partInfo(p)).name || "");
let MOLD = null; const moldMap = () => MOLD || (MOLD = fetch(`${BASE}/data/mold-variants.json`).then(r => r.json()).catch(() => ({})));
const toks = s => (s || "").match(/[A-Za-z0-9\/.']+|\([^)]*\)|[-,]/g) || [];
function phrases(src, other) { const o = new Set(other), out = []; let cur = []; for (const t of src) { if (t === "-" || t === ",") { if (cur.length) { out.push(cur.join(" ")); cur = []; } continue; } if (!o.has(t)) cur.push(t); else if (cur.length) { out.push(cur.join(" ")); cur = []; } } if (cur.length) out.push(cur.join(" ")); return out; }
function moldDiff(a0, b0) { const a = toks(a0), b = toks(b0), plus = phrases(b, a), minus = phrases(a, b).map(x => x.replace(/^with\s+/i, "")), one = minus.filter(x => !x.includes(" ")), multi = minus.filter(x => x.includes(" "));
  const head = plus.length ? plus.join(", ") + (one.length ? ` (not ${one.join(", ")})` : "") : one.map(x => "no " + x).join(", "); return [head, multi.length ? "no " + multi.join(", ") : ""].filter(Boolean).join(" · ") || "same name, different mold"; }
// ---- camera QR / barcode scan (optional, for naming a session after a label): BarcodeDetector where present, else jsQR loaded on first use
let JSQR = null; const loadJsQR = () => JSQR || (JSQR = new Promise((ok, no) => { if (window.jsQR) return ok(window.jsQR); const s = document.createElement("script"); s.src = `${BASE}/vendor/jsQR.min.js?v=1`; s.onload = () => ok(window.jsQR); s.onerror = () => { JSQR = null; no(new Error("QR reader failed to load")); }; document.head.appendChild(s); }));
async function qrDecoder() { if ("BarcodeDetector" in window) try { const f = await BarcodeDetector.getSupportedFormats(); if (f.includes("qr_code")) { const d = new BarcodeDetector({ formats: f.filter(x => ["qr_code", "code_128"].includes(x)) }); return async v => (await d.detect(v))[0]?.rawValue || null; } } catch (e) {}
  const jsQR = await loadJsQR(), c = document.createElement("canvas"), g = c.getContext("2d", { willReadFrequently: true });
  return async v => { const w = v.videoWidth, h = v.videoHeight; if (!w || !h) return null; const k = Math.min(1, 720 / Math.max(w, h)); c.width = Math.round(w * k); c.height = Math.round(h * k); g.drawImage(v, 0, 0, c.width, c.height); return jsQR(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height, { inversionAttempts: "dontInvert" })?.data || null; }; }
const camErr = e => e?.name === "NotAllowedError" ? (/iphone|ipad/i.test(navigator.userAgent) ? "Camera blocked: allow camera access for this site (Settings › Safari › Camera)." : "Camera blocked: allow camera access for this site in the browser’s site settings.") : e?.name === "NotFoundError" ? "No camera found." : e?.name === "NotReadableError" ? "The camera is busy in another app." : (e?.message || "Camera failed");
let SCAN_STOP = null;
function attachScan(btn, vid, onCode) { if (!btn || !vid || !navigator.mediaDevices?.getUserMedia || !window.isSecureContext) return; btn.hidden = false; vid.setAttribute("playsinline", ""); vid.muted = true; let stream = null;
  const stop = () => { stream?.getTracks().forEach(t => t.stop()); stream = null; vid.srcObject = null; vid.hidden = true; btn.textContent = "📷 Scan"; if (SCAN_STOP === stop) SCAN_STOP = null; };
  btn.onclick = async () => { if (stream) return stop(); SCAN_STOP?.(); try { const decP = qrDecoder(); stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false }); SCAN_STOP = stop; vid.srcObject = stream; vid.hidden = false; btn.textContent = "✕ Stop"; await vid.play(); const dec = await decP;
      const tick = async () => { if (!stream || !vid.isConnected) return stop(); try { const v = await dec(vid); if (v) { navigator.vibrate?.(60); stop(); return onCode(v); } } catch (e) {} setTimeout(tick, 120); }; tick(); } catch (e) { stop(); toast(camErr(e), 5000); } }; }
