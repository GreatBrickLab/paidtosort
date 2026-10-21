(() => {
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const main = $("#main");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const img = (p, c) => `https://img.bricklink.com/ItemImage/PN/${+c || 0}/${encodeURIComponent(p)}.png`;
let ME = null, PAL = null, PALBY = {};
let Q = Promise.resolve(); // serialize writes
async function api(path, body, method) {
  const run = async () => { const r = await fetch("/alpha/api/" + path, { method: method || (body ? "POST" : "GET"), headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" });
    const j = await r.json().catch(() => ({ error: "bad response" })); if (r.status === 401 && path !== "login") { ME = null; location.hash = "#/login"; } return Object.assign(j, { _status: r.status }); };
  if (body) { const p = Q.then(run); Q = p.catch(() => {}); return p; } return run();
}
async function palette() { if (!PAL) { PAL = await (await fetch("/alpha/data/palette.json")).json(); PAL.forEach(c => PALBY[c.id] = c); } return PAL; }
const SHARDS = {};
function candidates(p) { const c = [p]; let m = p.match(/^(\d+[a-z]?)(pb|pr|pat)\d+/); if (m) c.push(m[1]); if (/^\d+[a-z]$/.test(p)) c.push(p.slice(0, -1)); if (/^\d+$/.test(p)) c.push(p + "b", p + "a"); return c; }
async function partInfo(p) { for (const q of candidates(p)) { const k = q.slice(0, 3).toLowerCase().replace(/[^a-z0-9]/g, "_").padEnd(3, "_"); if (!SHARDS[k]) SHARDS[k] = fetch(`/alpha/data/pc/${k}.json`).then(r => r.ok ? r.json() : {}).catch(() => ({}));
    const d = (await SHARDS[k])[q]; if (d) return withShared(p, { name: d[0], colors: d[1] }); } return withShared(p, { name: "", colors: [] }); }
// shared parts data imported by host admins (Host > Import parts file): adds names + colors the bundled catalog lacks
const SHARED_PI = {};
async function withShared(p, info) { const sp = await (SHARED_PI[p] || (SHARED_PI[p] = api("parts/info?p=" + encodeURIComponent(p)).then(j => (j.parts || {})[p] || null).catch(() => null)));
  if (!sp) return info; return { name: info.name || sp.name || "", colors: [...info.colors, ...(sp.colors || []).filter(c => !info.colors.includes(c))] }; }
// "Undetermined Type" catalog entries are never offered or listed
async function isUndetermined(p) { return /undetermined/i.test((await partInfo(p)).name || ""); }
let MOLDEX = null; const moldEx = () => MOLDEX || (MOLDEX = api("mold-exceptions").then(j => new Set((j.parts || []).map(x => x.part))).catch(() => new Set()));
let MOLD = null; const moldMap = () => MOLD || (MOLD = fetch("/alpha/data/mold-variants.json").then(r => r.json()).catch(() => ({})));
const toks = s => (s || "").match(/[A-Za-z0-9\/.']+|\([^)]*\)|[-,]/g) || [];
function phrases(src, other) { const o = new Set(other), out = []; let cur = []; for (const t of src) { if (t === "-" || t === ",") { if (cur.length) { out.push(cur.join(" ")); cur = []; } continue; } if (!o.has(t)) cur.push(t); else if (cur.length) { out.push(cur.join(" ")); cur = []; } } if (cur.length) out.push(cur.join(" ")); return out; }
function moldDiff(curName, varName) { const a = toks(curName), b = toks(varName), plus = phrases(b, a), minus = phrases(a, b);
  const m = minus.map(x => x.replace(/^with\s+/i, "")), oneW = m.filter(x => !x.includes(" ")), multi = m.filter(x => x.includes(" "));
  const head = plus.length ? plus.join(", ") + (oneW.length ? ` (not ${oneW.join(", ")})` : "") : oneW.map(x => "no " + x).join(", ");
  return [head, multi.length ? "no " + multi.join(", ") : ""].filter(Boolean).join(" · ") || "same name, different mold"; }
const cname = id => PALBY[id]?.name || String(id), crgb = id => PALBY[id]?.rgb || "888888";
function toast(t, ms = 2200) { const d = document.createElement("div"); d.className = "toast"; d.textContent = t; document.body.appendChild(d); setTimeout(() => d.remove(), ms); }
const qrURL = code => { const q = qrcode(0, "M"); q.addData(code); q.make(); return q.createDataURL(6, 2); };
const barSVG = code => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); JsBarcode(s, code, { format: "CODE128", height: 60, fontSize: 14, margin: 4 }); return s.outerHTML; };
const pill = (t, cls) => `<span class="pill ${esc(cls || t)}">${esc(t)}</span>`;

// ---------------- scanning (BarcodeDetector where available)
function attachScan(btn, vid, onCode) { if (!("BarcodeDetector" in window) || !navigator.mediaDevices) return; btn.hidden = false; let stream = null, last = "";
  btn.onclick = async () => { if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; vid.hidden = true; return; }
    const det = new BarcodeDetector({ formats: ["qr_code", "code_128"] }); stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    vid.srcObject = stream; vid.hidden = false; await vid.play();
    const tick = async () => { if (!stream) return; try { const r = await det.detect(vid); if (r.length && r[0].rawValue !== last) { last = r[0].rawValue; onCode(last); setTimeout(() => last = "", 2500); } } catch (e) {} requestAnimationFrame(tick); }; tick(); }; }

// ---------------- views
const CS_HTML = `<dialog id="cs" class="sheet"><div class="card"><div class="cshead"><h3>Color for <span id="cs_part" class="mono"></span></h3><button type="button" class="btn ghost small" id="cs_x">✕</button></div>
  <input id="cs_q" type="search" enterkeyhint="done" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Type to search colors" autocomplete="off">
  <div id="cs_body"></div><label class="small tick" style="margin-top:8px"><input type="checkbox" id="cs_all" style="width:auto;display:inline"> Show all colors</label></div></dialog>`;
const V = {}; let FIRST = true, SESS_OPEN = false; const LASTK = () => "pts_last_sid:" + (ME?.host?.id ?? "") + ":" + (ME?.user?.username || "");   // first screen after the app (re)starts: auto-resume the last open session
V.login = () => { main.innerHTML = `<div class="login"><img src="/alpha/pts-mark.png" class="bigmark" alt="Paid to Sort"><h1>Sign in</h1><p class="muted">Sort parts. Get paid.</p><p class="err" id="err"></p>
  <form class="card" id="lf"><label>Username<input name="username" autocomplete="username" autocapitalize="none" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button class="btn gold wide">Sign in</button></form></div>`;
  $("#lf").onsubmit = async e => { e.preventDefault(); const f = new FormData(e.target); const j = await api("login", { username: f.get("username"), password: f.get("password") });
    if (j.ok) { await loadMe(); location.hash = "#/"; } else $("#err").textContent = j.error; }; };

V.home = async () => { const j = await api("me?stats=1"); ME = j; header();
  const h = j.host;
  const op = j.sessions.find(s => s.status === "open" && s.id === localStorage.getItem(LASTK())) || j.sessions.find(s => s.status === "open");
  if (op && FIRST && localStorage.getItem(LASTK()) === op.id) { FIRST = false; location.hash = "#/s/" + op.id; return; } FIRST = false;
  main.innerHTML = `<h1>Hi ${esc(j.user.display || j.user.username)}</h1>${op ? `<a class="btn gold wide big" id="resume" href="#/s/${op.id}">▶ Resume session <span class="mono">${op.id}</span></a>` : ""}<button class="btn ${op ? "" : "gold "}wide big" id="start">＋ Start a sorting session</button>
  <p class="muted small">Pay: ${h.pay_mode === "hr" ? `$${h.rate_hr.toFixed(2)} per hour` : `$${h.rate_lb.toFixed(2)} per lb sorted`}</p>
  <h2>Recent sessions</h2>${j.sessions.map(s => `<a class="row card" href="#/s/${s.id}"><b class="mono">${s.id}</b><span class="muted small">${s.nb} bags · ${s.pcs} pcs</span>${pill(s.status)}</a>`).join("") || `<p class="muted">No sessions yet.</p>`}
  <div class="stat card"><div><b>${(j.stats || {}).nb ?? (j.stats || {}).n ?? "–"}</b><span>bags sorted</span></div><div><b>${(j.stats || {}).n ?? "–"}</b><span>part lots</span></div><div><b>${(j.stats || {}).pcs ?? "–"}</b><span>pieces</span></div></div>
  <p class="center"><a href="#/putaway" class="btn">Put-away</a> ${j.user.role === "admin" ? `<a href="#/host/settings" class="btn">Host settings</a>` : ""} <a href="#/logout" class="btn ghost">Sign out</a></p>`;
  $("#start").onclick = async () => { const r = await api("session/start", {}); location.hash = "#/s/" + r.id; }; };

V.session = async (sid) => { await palette(); const j = await api("session/" + sid); if (j.error) { main.innerHTML = `<p class="err">${esc(j.error)}</p>`; return; }
  const s = j.s, open = s.status === "open"; SESS_OPEN = open; SBAGS = j.bags; SBOX = j.box; METER = j.meter; OPENLOTS = j.open_lots || [];
  main.innerHTML = `<div class="sess"><div><small class="muted">Session</small><h1 class="mono">${s.id}</h1></div>${pill(s.status)}</div>
  <p class="muted small">${esc(j.owner)} · started ${s.started.slice(5, 16)} UTC · ${esc(j.pay)}</p>
  ${open ? `<div class="card upload"><label class="btn gold wide big" for="cam">📷 Take photo of parts</label><input id="cam" type="file" accept="image/*" capture="environment" hidden>
   <label class="btn wide" for="pick">Upload a photo</label><input id="pick" type="file" accept="image/*" hidden>
   <p class="muted small">Lay parts flat and apart on a plain surface. Parts are found on your phone, then each crop is sent to the identification engine.</p>
   <p class="small trainnote">ⓘ Part photos help improve detection.</p><button type="button" class="btn wide" id="missbtn" hidden>＋ Missed a part?</button>
   <div id="prog" class="prog" hidden><div class="spin"></div><span id="progt">Working…</span></div><canvas id="prev" class="prev" hidden></canvas><div id="review" class="review" hidden></div></div>` : ""}
  <div id="openbar">${open ? openBarHTML() : ""}</div>
  <div id="dock" class="dock">${open && SBOX ? `<div id="openbag">${openBagHTML()}</div>` : ""}<div id="photo" hidden></div></div>
  <h2>Verify <span class="muted small" id="pend">${j.cards.length} to check</span></h2>
  <p class="muted small">Swipe up on a card’s <b>⇡ bar</b> to confirm it (or tap ✓); scroll anywhere else. Confirmed lots go into the open bag; when it is full, cut it off and scan its bag label.</p>
  <div id="cards">${j.cards.map(c => cardHTML(c)).join("")}</div>
  <button type="button" class="btn gold wide big" id="confirmall" ${j.cards.length ? "" : "hidden"}>✓ Confirm all <span id="ca_n">${j.cards.length}</span> cards into the open bag</button>
  ${summaryHTML(j.summary, !open)}
  <h2>Sealed bags <span class="muted small">${j.bags.filter(b => (b.lots || []).length).length}</span></h2>
  <div id="bags" class="flatlist baglist">${[...j.bags].filter(b => (b.lots || []).length).reverse().map((b, i, a) => bagHTML(b, { n: i + 1, open: b.open || (!a.some(x => x.open) && i === a.length - 1) })).join("")}</div><p class="muted small" id="swipehint" ${j.bags.length ? "" : "hidden"}>Tap a bag to show its parts. Swipe a part <b>left</b> to edit it or remove it from the bag.</p>
  ${open ? `<form class="card" id="endf"><h3>Batch done</h3><p class="muted small">Seal the last open bag first (scan its label). Then finish to see the batch summary.</p>${ME.host.pay_mode === "lb" ? `<label>Weight sorted (lb)<input name="w" type="number" step="0.01" min="0" inputmode="decimal"></label>` : ""}<button class="btn wide">Batch done · show summary</button></form>` : ""}
${CS_HTML}`;
  if (open) { ["#cam", "#pick"].forEach(id => $(id).onchange = e => processPhoto(sid, e.target.files[0]));
   
    $("#endf").onsubmit = async e => { e.preventDefault(); const r = await api(`session/${sid}/end`, { weight_lb: e.target.w?.value || null }); if (!r.ok) return toast(r.error || "failed", 4000); await trainCheck(sid, true); route(); }; }
  wireCards(j.cards); wireBags($("#bags")); wireOpenBar(); wireOpenBag(); PH.init(j.cards);
  if (open) { localStorage.setItem(LASTK(), sid); resumeReview(sid); } else if (localStorage.getItem(LASTK()) === sid) localStorage.removeItem(LASTK());
  trainHooks(sid, open);
};
// ---- training-data hooks: finalize when a photo's cards are all resolved, or when the sorter leaves / finishes the session
let TRAIN_SID = null, trainT = 0;
const trainCheck = (sid, force) => PTSTrain.check(sid, api, force).catch(e => console.warn(e));
window.addEventListener("hashchange", () => { if (TRAIN_SID && !location.hash.startsWith("#/s/" + TRAIN_SID)) { trainCheck(TRAIN_SID, true); TRAIN_SID = null; } });
async function trainHooks(sid, open) { TRAIN_SID = sid; await trainCheck(sid, !open);
  const mb = $("#missbtn"); if (!mb) return; const pend = await PTSTrain.pendingFor(sid); mb.hidden = !pend.length; mb.onclick = () => missedDialog(sid); }
function trainSoon(sid) { clearTimeout(trainT); trainT = setTimeout(() => trainCheck(sid), 1200); }
// "Missed a part?": drag a box (or tap) on the latest photo; saved as a 'missed' label, then identified into a new card
async function missedDialog(sid) { const r = (await PTSTrain.pendingFor(sid))[0]; if (!r) return toast("No photo waiting for review");
  $("#mdlg")?.remove(); document.body.insertAdjacentHTML("beforeend", `<dialog id="mdlg" class="sheet"><div class="card"><div class="cshead"><h3>Box the missed part</h3><button type="button" class="btn ghost small" id="m_x">✕</button></div>
  <p class="small muted">Drag a box around a part the finder missed (or tap its center).</p><canvas id="mcv" style="width:100%;touch-action:none;border-radius:8px"></canvas>
  <div class="row2"><button type="button" class="btn gold" id="m_save" disabled>Save + identify</button><button type="button" class="btn" id="m_only" disabled>Save box only</button></div><p class="small" id="m_msg"></p></div></dialog>`);
  const d = $("#mdlg"), cv = $("#mcv"), im = await PTSTrain.loadImg(r.photo); cv.width = im.width; cv.height = im.height; const g = cv.getContext("2d");
  const k = 1 / r.scale; let a = null, b = null, cur = null;   // canvas px (photo frame) -> detector frame via 1/scale
  const draw = () => { g.drawImage(im, 0, 0); g.lineWidth = Math.max(3, im.width / 300); g.strokeStyle = "#F2B233"; r.boxes.forEach(x => g.strokeRect(x.box[0] / k, x.box[1] / k, (x.box[2] - x.box[0]) / k, (x.box[3] - x.box[1]) / k));
    g.strokeStyle = "#e0245e"; r.missed.forEach(x => g.strokeRect(x.box[0] / k, x.box[1] / k, (x.box[2] - x.box[0]) / k, (x.box[3] - x.box[1]) / k)); if (cur) { g.setLineDash([12, 8]); g.strokeRect(cur[0], cur[1], cur[2] - cur[0], cur[3] - cur[1]); g.setLineDash([]); } };
  const pt = e => { const q = cv.getBoundingClientRect(); return [(e.clientX - q.left) * cv.width / q.width, (e.clientY - q.top) * cv.height / q.height]; };
  cv.onpointerdown = e => { a = pt(e); b = a; cv.setPointerCapture(e.pointerId); }; cv.onpointermove = e => { if (!a) return; b = pt(e); cur = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]; draw(); };
  cv.onpointerup = e => { if (!a) return; b = pt(e); const h = 0.05 * Math.max(cv.width, cv.height);
    cur = Math.hypot(b[0] - a[0], b[1] - a[1]) < 10 ? [a[0] - h, a[1] - h, a[0] + h, a[1] + h] : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    cur = [Math.max(0, cur[0]), Math.max(0, cur[1]), Math.min(cv.width, cur[2]), Math.min(cv.height, cur[3])]; a = null; draw(); $("#m_save").disabled = $("#m_only").disabled = false; };
  const save = async ident => { if (!cur) return; const box = cur.map(v => Math.round(v * k)); let card_id = null; $("#m_msg").textContent = "Saving…";
    if (ident) { const c = document.createElement("canvas"); c.width = cur[2] - cur[0]; c.height = cur[3] - cur[1]; c.getContext("2d").drawImage(im, cur[0], cur[1], c.width, c.height, 0, 0, c.width, c.height);
      const crop = await shrink(c.toDataURL("image/jpeg", 0.9), 800); const j = await identify(crop);
      const top = (j.items || [])[0];
      // color: same estimate as normal detections (part pixels of the crop vs the part's known colors), so the card shows it right away
      if (top) { await palette(); const info = await partInfo(top.id); const ranked = PTSDetect.estimateColor(PTSDetect.cropLab(c), top.id, info.colors, PAL), col = ranked[0]?.id ?? 0;
        const sv = await api(`session/${sid}/cards`, { cards: [{ part: top.id, name: top.name, color: col, qty: 1, confidence: Math.round(top.score * 1000) / 1000, crop: await shrink(crop, 220), color_guesses: ranked.slice(0, 5).map(x => x.id),
          alts: (j.items || []).slice(0, 4).map(a => ({ id: a.id, name: a.name, score: Math.round(a.score * 1000) / 1000 })) }] }); card_id = (sv.ids || [])[0] || null; } }
    if (card_id) try { await ZM.mapCard(card_id, await ZM.addPhoto(r.photo, im.width, im.height), box, r.scale); } catch (e) {}
    await PTSTrain.addMissed(r.id, box, card_id); r.missed.push({ box, card_id }); cur = null; draw(); $("#m_save").disabled = $("#m_only").disabled = true;
    $("#m_msg").textContent = card_id ? "Saved. A new card was added to Verify." : ident ? "Saved the box (part not recognised)." : "Saved the box."; if (card_id) d.dataset.added = "1"; };
  $("#m_save").onclick = () => save(true); $("#m_only").onclick = () => save(false); $("#m_x").onclick = () => d.close();
  d.onclose = () => { if (d.dataset.added) route(); }; draw(); d.showModal(); }
const chip = (id, on) => `<button type="button" class="chip${on ? " on" : ""}" data-c="${id}" title="${esc(cname(id))}"><i style="background:#${crgb(id)}"></i><span>${esc(cname(id))}</span></button>`;
const quickIds = c => { const g = (c.color_guesses || []).filter(x => x !== c.color); return [c.color, ...g].filter((x, i, a) => a.indexOf(x) === i).slice(0, 4); };
// top alternates from identification: one tap switches the card's part (color and qty kept)
const altHTML = c => { const as = (c.alts || []).filter(a => a.id !== c.part).slice(0, 3);
  return (as.length ? `<div class="small muted">Other matches</div><div class="chips">${as.map(a => `<button type="button" class="chip alt" data-p="${esc(a.id)}" data-n="${esc(a.name || "")}"><img src="${img(a.id, c.color)}" alt="" onerror="this.style.visibility='hidden'"><span><b class="mono">${esc(a.id)}</b> ${esc((a.name || "").slice(0, 28))} <small class="muted">${Math.round((a.score || 0) * 100)}%</small></span></button>`).join("")}</div>` : ""); };
// match score: one bar + words; green-teal sure, gold check, red double-check (same 0.7 line as before)
const scoreCls = v => v >= 0.8 ? "hi" : v >= 0.7 ? "mid" : "lo";
const scoreHTML = v => { const p = Math.round((+v || 0) * 100), k = scoreCls(v);
  return `<div class="score ${k}" title="identification match"><span class="sbar"><i style="width:${p}%"></i></span>${k === "lo" ? `<span class="warn small flagl">⚠ Low match ${p}%: double-check</span>` : `<span class="small">${k === "hi" ? "Sure" : "Likely"} · match ${p}%</span>`}</div>`; };
const cardHTML = (c, lot) => `<div class="pcard${lot ? " lotedit" : ""}" data-id="${c.id}"${lot ? ` data-lot="${c.id}"` : ""} data-part="${esc(c.part)}" data-color="${c.color}" data-qty="${c.qty}">
 <button type="button" class="colorbtn"><i style="background:#${crgb(c.color)}"></i><span class="cn">${esc(cname(c.color))}</span><small>change ▾</small></button>
 <div class="quick">${quickIds(c).map(id => chip(id, id === c.color)).join("")}</div>
 <div class="pimg"><img src="${img(c.part, c.color)}" onerror="this.onerror=null;this.src='${c.crop || ""}'" alt="">${lot ? "" : `<button type="button" class="pno ${scoreCls(c.confidence)}" hidden aria-label="show this part on the photo"></button>`}</div>
 <div class="pinfo"><div class="pn mono">${esc(c.part)}</div><div class="nm">${esc(c.name)}</div>
 <div class="qty"><button type="button" class="qbtn minus" aria-label="less">−</button><b>${c.qty}</b><button type="button" class="qbtn plus" aria-label="more">+</button></div>${scoreHTML(c.confidence)}</div>
 <div class="altbox">${altHTML(c)}</div>
 ${c.crop ? `<div class="pcmp"><div class="ptile"><img class="mimg" src="${img(c.part, c.color)}" alt="matched part" draggable="false" onerror="this.style.visibility='hidden'"><span>our match</span></div><div class="pcrop"><img src="${c.crop}" alt="photo of this part" draggable="false"><span>your photo</span></div></div>` : ""}
 <div class="mold" hidden></div>
 ${lot ? `<div class="pact"><button type="button" class="btn gold done">Done</button></div>` : `<div class="pact"><button class="btn gold ok">✓</button><button class="btn ghost drop">Drop</button></div><div class="grip" aria-label="swipe up here to confirm">⇡ swipe up here to confirm</div>`}</div>`;
const lotHTML = l => `<div class="lot" data-lot="${l.id}"><div class="lacts"><button type="button" class="lact ledit">Edit</button><button type="button" class="lact ldel">Delete</button></div>
 <div class="lfront">${lotThumb(l)}<span class="grow"><b>${l.qty}×</b> <span class="mono">${esc(l.part)}</span> · ${esc(l.color_name || cname(l.color))}<br><span class="small muted">${esc((l.name || "").slice(0, 44))}</span></span><span class="sw">‹</span></div></div>`;
// session list: parts sit directly under each other (no QR/code between parts); the QR lives on the bag view + label only
// bags come from the admin's batch-prep sheet (no printing in the sorter app)
// box + bag picker on the session screen: the sorter scans the box's master QR (from the batch-prep sheet), then scans or taps a bag QR; photos and the parts list go to that bag
let SBAGS = [];
const bagNo = b => { if (!b.box_id && b.box_id !== 0) return null; const same = SBAGS.filter(x => x.box_id === b.box_id).sort((a, c) => a.id - c.id); return same.findIndex(x => x.code === b.code) + 1 || null; };
// box at the start (master QR from the batch-prep sheet); after that, every bag QR scanned seals the open bag into that bag
let SBOX = null, METER = null, OPENLOTS = [];
const openBarHTML = () => `<div class="card openbar boxpanel"><div class="obtxt">${SBOX ? `<b>Box ${esc(SBOX.barcode)}</b> · photos and confirmed parts go into the <b>open bag</b>. Scan a bag label of this box to seal it.` : `<b>Scan the box’s master QR to start</b>`}</div>
  <div class="scanrow"><input id="bxscan" placeholder="${SBOX ? "Scan or type a bag label to seal the open bag" : "Scan or type the box master QR"}" autocapitalize="characters" autocomplete="off"><button type="button" class="btn small gold" id="bxgo">Go</button><button type="button" class="btn small" id="bxcam" hidden>📷 Scan</button></div><video id="bxvid" class="scanvid" hidden playsinline muted></video></div>`;
const fmt$ = v => "$" + (+v || 0).toFixed(2);
// open-bag meter: compact strip so the photo and cards stay on screen. Bar = whichever cap (weight or volume) is closer to full.
const meterHTML = m => { if (!m) return ""; const pw = m.max_g ? Math.min(100, Math.round(100 * m.weight_g / m.max_g)) : 0, ap = m.approx ? "≈ " : "";
  const pv = m.max_cm3 ? Math.min(100, Math.round(100 * m.volume_cm3 / m.max_cm3)) : 0, lead = pv > pw ? "volume" : "weight", pct = Math.max(pw, pv);
  const apx = m.approx || m.no_size ? [m.no_weight ? `${m.no_weight} lot${m.no_weight === 1 ? "" : "s"} without weight data` : "", m.no_size ? `${m.no_size} without size data` : "", m.no_price ? `${m.no_price} without price data` : ""].filter(Boolean).join(", ") : "";
  return `<div class="meter mini${m.full ? " full" : ""}${pct >= 85 && !m.full ? " near" : ""}" id="meter">
  <div class="mrow"><span class="mc"><b id="m_g">${ap}${m.weight_g}</b><small>/${m.max_g || "–"} g</small></span><span class="mc"><b id="m_v">≈${m.volume_cm3}</b><small>/${m.max_cm3 || "–"} cm³</small></span><span class="mc"><b id="m_n">${m.pcs}</b><small>pcs</small></span><span class="mc"><b id="m_e">${ap}${m.earnings !== null ? fmt$(m.earnings) : fmt$(m.value)}</b><small>est.</small></span></div>
  <div class="mbar2" title="${lead} ${pct}%"><i style="width:${pct}%"></i></div><div class="mlbl small"><span>${m.bag_size ? `${esc(m.bag_size)} bag · ` : ""}${pct}% full by ${lead}</span>${apx ? `<span class="mflag" id="m_ap" title="Approximate: ${esc(apx)}">⚑ approx.</span>` : ""}</div>
  ${m.full ? `<div class="bagfull" id="bagfull" role="status"><div><b>Bag looks full: cut it off and scan its label</b><div class="small" id="fullby">${m.full_by === "volume" ? `Volume limit reached (≈ ${m.volume_cm3} of ${m.max_cm3} cm³)` : m.full_by === "weight" ? `Weight limit reached (${m.weight_g} of ${m.max_g} g)` : `Weight and volume limits reached`}</div></div><button type="button" class="btn small sealgo">📷 Scan bag label</button></div>` : ""}</div>`; };
// lot row thumbnail: matched part image; if it cannot load, the sorter's crop; if neither, a neutral tile
const lotThumb = l => `<img src="${img(l.part, l.color)}" class="thumb" alt="" onerror="${l.crop ? `if(this.dataset.f){this.style.visibility='hidden'}else{this.dataset.f=1;this.src='${esc(l.crop)}'}` : "this.style.visibility='hidden'"}">`;
const openLotHTML = l => `<div class="olot row" data-lot="${l.id}">${lotThumb(l)}<span class="grow"><span class="mono">${esc(l.part)}</span> · ${esc(l.color_name || cname(l.color))}<br><span class="small muted">${esc((l.name || "").slice(0, 40))}</span></span>
  <span class="qty"><button type="button" class="qbtn ominus" aria-label="less">−</button><b>${l.qty}</b><button type="button" class="qbtn oplus" aria-label="more">+</button></span><button type="button" class="qbtn orm" aria-label="remove from open bag">✕</button></div>`;
let OB_OPEN = false;   // open-bag lots list folded by default (remembered while on the page)
const openBagHTML = () => `<div class="card openbagc"><details class="obd"${OB_OPEN ? " open" : ""}><summary><b>Open bag</b> <span class="muted small">${OPENLOTS.length} lot${OPENLOTS.length === 1 ? "" : "s"} ▾</span>${meterHTML(METER)}</summary>
  ${METER && (METER.approx || METER.no_size) ? `<p class="small muted">Approximate: ${[METER.no_weight ? `${METER.no_weight} lot${METER.no_weight === 1 ? "" : "s"} without weight data` : "", METER.no_size ? `${METER.no_size} without size data` : "", METER.no_price ? `${METER.no_price} without price data` : ""].filter(Boolean).join(", ")}. Value is ${METER.earnings !== null ? "your estimated earnings" : "the estimated parts value"}.</p>` : ""}
  <div class="olots">${OPENLOTS.map(openLotHTML).join("") || `<p class="muted small">Empty. Confirm parts to fill it.</p>`}</div></details></div>`;
function setOpenBag(j) { if (j.meter) METER = j.meter; if (j.open_lots) OPENLOTS = j.open_lots; const ob = $("#openbag"); if (!ob) return; const was = METER && $("#bagfull");
  ob.innerHTML = openBagHTML(); wireOpenBag(); PH.fit(); if (METER?.full && !was) toast("Bag looks full: cut it off and scan its label", 4000); }
function wireOpenBag() { const d = $("#openbag .obd"); if (d) { d.ontoggle = () => { OB_OPEN = d.open; PH.fit(); };
    d.querySelector(".sealgo")?.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); const i = $("#bxscan"); if (!i) return; $("#openbar").scrollIntoView({ block: "start" }); scrollBy(0, -56); i.focus({ preventScroll: true }); const cam = $("#bxcam"); if (cam && !cam.hidden) cam.click(); }); }
  $$("#openbag .olot").forEach(el => { const id = el.dataset.lot, l = OPENLOTS.find(x => x.id === +id);
  const q = d => { const n = Math.max(1, l.qty + d); if (n === l.qty) return; l.qty = n; el.querySelector(".qty b").textContent = n; api("lot/" + id, { action: "edit", qty: n }).then(j => j.ok ? setOpenBag(j) : toast(j.error || "failed")); };
  el.querySelector(".ominus").onclick = () => q(-1); el.querySelector(".oplus").onclick = () => q(1);
  el.querySelector(".orm").onclick = async () => { const j = await api("lot/" + id, { action: "remove" }); if (!j.ok) return toast(j.error || "failed"); setOpenBag(j);
    undoBar(`Removed ${l.part} from the open bag`, async () => { const r = await api("lot/" + id, { action: "restore" }); if (r.ok) setOpenBag(r); }); }; }); }
const summaryHTML = (t, show) => { if (!t || !show) return ""; const ap = t.approx ? "≈ " : "";
  return `<div class="card summary" id="summary"><h3>Batch summary</h3><div class="stat"><div><b>${t.bags}</b><span>bags</span></div><div><b>${ap}${t.weight_g} g</b><span>sorted weight${t.batch_weight_g ? ` vs ${t.batch_weight_g} g prepped` : ""}</span></div>
  <div><b>${ap}${t.earnings !== null ? fmt$(t.earnings) : fmt$(t.value)}</b><span>${t.earnings !== null ? "estimated earnings" : "estimated parts value"}</span></div></div>
  ${t.batch_weight_g ? `<p class="small muted">${Math.round(100 * t.weight_g / t.batch_weight_g)}% of the prepped batch weight is accounted for in sealed bags.</p>` : ""}
  ${t.per_bag.map(b => `<div class="row small sumrow"><b>Bag ${b.n || "?"}</b><span class="mono muted">${esc(b.code)}</span><span class="grow">${b.pcs} pcs · ${b.approx ? "≈ " : ""}${b.weight_g} g · ${fmt$(b.value)}</span></div>`).join("")}</div>`; };
function wireOpenBar() { const ob = $("#openbar .openbar"); if (!ob) return; const sid = location.hash.match(/#\/s\/([\w-]+)/)?.[1];
  const go = async code => { code = String(code || "").trim(); if (!code) return; const j = await api(`session/${sid}/scan`, { code }); if (!j.ok) return toast(j.error || "failed", 3500);
    toast(j.sealed ? `Sealed into Bag ${j.sealed.n || ""} (${j.sealed.code}): ${j.sealed.meter.pcs} pcs, ${j.sealed.meter.weight_g} g. New open bag started.` : "Box linked. Photos and parts go into the open bag.", 3500); route(); };
  $("#bxgo").onclick = () => go($("#bxscan").value); $("#bxscan").onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); go($("#bxscan").value); } };
  attachScan($("#bxcam"), $("#bxvid"), go); }
function updateOpenBar() {}
const bagHTML = (b, flat) => { const lots = b.lots || [], pcs = lots.reduce((a, l) => a + l.qty, 0);
  if (flat) { const st = bagOpenPref(b.code); const isOpen = st === null ? flat.open : st;
    return `<details class="bagc flat${b.open ? " active" : ""}" data-code="${b.code}"${isOpen ? " open" : ""}><summary class="bagsum"><span class="caret">▸</span><b class="bagn">Bag ${b.n || bagNo(b) || flat.n || ""}</b><span class="small muted">${lots.length} part${lots.length === 1 ? "" : "s"} · ${pcs} pcs</span>${b.open ? pill("Adding here", "open") : ""}</summary>
  <div class="lots">${lots.map(lotHTML).join("") || `<p class="muted small empty">No parts yet${b.open ? ". Take a photo and confirm parts to add them here." : "."}</p>`}</div>
</details>`; }
  return `<div class="bag bagc card" data-code="${b.code}"><div class="baghead"><div class="grow"><b class="mono">${b.code}</b> ${b.open ? pill("open bag", "open") : ""}<br>
  <span class="small">${lots.length} part${lots.length === 1 ? "" : "s"} · ${pcs} pcs</span><br><span class="muted small">${b.status || "labelled"}${b.location ? " · " + esc(b.location) : ""}</span></div></div>
  <div class="lots">${lots.map(lotHTML).join("") || `<p class="muted small">Empty bag.</p>`}</div>${b.open ? `<button type="button" class="btn small closebag">Close bag</button>` : ""}</div>`; };
// expanded/collapsed state the sorter chose, per bag, kept across re-renders, photo Done, reloads (sessionStorage)
const BOK = "pts_bag_open"; const bagPrefs = () => { try { return JSON.parse(sessionStorage.getItem(BOK) || "{}"); } catch (e) { return {}; } };
const bagOpenPref = code => { const v = bagPrefs()[code]; return v === undefined ? null : v; };
const setBagOpen = (code, v) => { const o = bagPrefs(); o[code] = v; sessionStorage.setItem(BOK, JSON.stringify(o)); };
// ---- parts inside a bag: swipe left -> Edit | Delete. Delete asks, then offers Undo. Edit opens the same card controls (color, quick chips, qty, mold variants).
function undoBar(text, onUndo) { $("#undo")?.remove(); const d = document.createElement("div"); d.id = "undo"; d.className = "toast undo"; d.innerHTML = `<span>${esc(text)}</span><button type="button" class="btn small gold">Undo</button>`;
  document.body.appendChild(d); const t = setTimeout(() => d.remove(), 7000); d.querySelector("button").onclick = async () => { clearTimeout(t); d.remove(); await onUndo(); }; }
function replaceBag(b) { updateOpenBar(b); const old = document.querySelector(`.bagc[data-code="${b.code}"]`); if (!old) return; const tmp = document.createElement("div"); tmp.innerHTML = bagHTML(b, old.classList.contains("flat") ? { n: old.querySelector(".bagn")?.textContent.replace(/\D/g, ""), open: old.open } : false); const nw = tmp.firstElementChild; old.replaceWith(nw); wireBags(nw.parentElement, nw); }
function wireBags(root, only) { if (!root) return;
  (only ? [only] : [...root.querySelectorAll(".bagc")]).forEach(bagEl => {
    // one tap = one toggle: we toggle ourselves and swallow the native toggle + any duplicate (touch + ghost click) within 400 ms
    const sum = bagEl.querySelector("summary"); if (sum) { let lastT = 0; sum.onclick = e => { e.preventDefault(); const t = Date.now(); if (t - lastT < 400) return; lastT = t;
      bagEl.open = !bagEl.open; setBagOpen(bagEl.dataset.code, bagEl.open); }; }
    // 📷 on a bag row: make this bag the open one (reopen if closed) and start the camera right away (file picker needs the tap's user gesture)
    const bc = bagEl.querySelector(".bagcam"); if (bc) bc.onclick = async e => { e.preventDefault(); e.stopPropagation();
      if (bc.classList.contains("locked")) return toast(`${bagEl.querySelector(".bagn")?.textContent || "This bag"} is already ${bc.dataset.st}, so parts can't be added. Scan or pick another bag of the box.`, 3500);
      $("#cam")?.click();
      if (bagEl.classList.contains("active")) return; const j = await api(`bag/${bagEl.dataset.code}/reopen`, {}); if (!j.ok) return toast(j.error || "failed");
      (j.closed || []).forEach(replaceBag); replaceBag(j.bag); updateOpenBar(j.bag); toast(`Adding to ${bagEl.querySelector(".bagn")?.textContent || "this bag"}`); };
    const ro = bagEl.querySelector(".reopen"); if (ro) ro.onclick = async () => { const j = await api(`bag/${bagEl.dataset.code}/reopen`, {}); if (!j.ok) return toast(j.error || "failed");
      (j.closed || []).forEach(replaceBag); setBagOpen(j.bag.code, true); replaceBag(j.bag); updateOpenBar(j.bag); toast("Bag reopened. New parts go into it."); };
    const cb = bagEl.querySelector(".closebag"); if (cb) cb.onclick = async () => { const j = await api(`bag/${bagEl.dataset.code}/close`, {}); if (j.ok) { replaceBag(j.bag); toast("Bag closed. The next confirmed part starts a new bag."); } else toast(j.error || "failed"); };
    bagEl.querySelectorAll(".lot").forEach(lot => {
      const fr = lot.querySelector(".lfront"), W = 168; let x0 = null, y0 = 0, dx = 0, base = 0, horiz = null;
      const setX = x => { fr.style.transform = x ? `translateX(${x}px)` : ""; lot.classList.toggle("open", x < 0); };
      const closeOthers = () => document.querySelectorAll(".lot.open").forEach(o => { if (o !== lot) { o.querySelector(".lfront").style.transform = ""; o.classList.remove("open"); } });
      fr.addEventListener("touchstart", e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; horiz = null; base = lot.classList.contains("open") ? -W : 0; fr.style.transition = "none"; }, { passive: true });
      fr.addEventListener("touchmove", e => { if (x0 === null) return; const ddx = e.touches[0].clientX - x0, ddy = e.touches[0].clientY - y0;
        if (horiz === null && (Math.abs(ddx) > 6 || Math.abs(ddy) > 6)) horiz = Math.abs(ddx) > Math.abs(ddy);
        if (!horiz) return; e.preventDefault(); dx = ddx; setX(Math.max(-W - 30, Math.min(0, base + dx))); }, { passive: false });
      fr.addEventListener("touchend", () => { if (x0 === null) return; fr.style.transition = ""; x0 = null; if (!horiz) return; const x = base + dx; if (x < -60) { closeOthers(); setX(-W); } else setX(0); });
      fr.onclick = () => { if (lot.classList.contains("open")) setX(0); };
      lot.querySelector(".ldel").onclick = async () => { const txt = fr.querySelector(".grow").firstChild ? fr.innerText.split("\n")[0].replace("‹", "").trim() : "this part";
        if (!confirm(`Remove ${txt} from bag ${bagEl.dataset.code}?`)) { setX(0); return; }
        lot.classList.add("removing"); const j = await api("lot/" + lot.dataset.lot, { action: "remove" }); if (!j.ok) { lot.classList.remove("removing"); setX(0); return toast(j.error || "failed"); }
        setTimeout(() => replaceBag(j.bag), 200);
        undoBar(`Removed ${txt} from ${bagEl.dataset.code}`, async () => { const r = await api("lot/" + j.id, { action: "restore" }); if (r.ok) { replaceBag(r.bag); toast("Restored"); } else toast(r.error || "undo failed"); }); };
      lot.querySelector(".ledit").onclick = async () => { await palette(); const b = await api("bag/" + bagEl.dataset.code); const l = (b.bag?.lots || []).find(x => x.id === +lot.dataset.lot); if (!l) return toast("Part not found");
        if (!$("#cs")) document.body.insertAdjacentHTML("beforeend", CS_HTML);
        const tmp = document.createElement("div"); tmp.innerHTML = cardHTML({ ...l, confidence: 1 }, true); const ed = tmp.firstElementChild; lot.replaceWith(ed);
        wireCards([{ ...l }], [ed]); ed.querySelector(".done").onclick = async () => { await new Promise(r => setTimeout(r, 450)); await Q; const r = await api("bag/" + bagEl.dataset.code); if (r.bag) replaceBag(r.bag); }; };
    }); }); }
const ep = el => (el.dataset.lot ? "lot/" : "card/") + el.dataset.id;
function wireCards(cards, els) { els = els || $$(".pcard:not(.lotedit)");
  const byId = Object.fromEntries(cards.map(c => [c.id, c]));
  const left = () => { const n = $$(".pcard:not(.lotedit):not(.going):not(.dropping)").length; $("#pend").textContent = n + " to check"; if ($("#ca_n")) { $("#ca_n").textContent = n; $("#confirmall").hidden = !n; } };
  let bulk = false; const confirmCard = async (el, extra) => { if (el.classList.contains("going")) return; el.classList.add("going"); const j = await api("card/" + el.dataset.id, Object.assign({ action: "confirm", qty: +el.dataset.qty || 1 }, extra || {}));
    if (j.ok) { setOpenBag(j); PH.done(+el.dataset.id, !bulk); setTimeout(() => el.remove(), 260); left(); if (TRAIN_SID) trainSoon(TRAIN_SID); } else { el.classList.remove("going"); toast(j.error || "failed"); } };
  // "Confirm all": every remaining card, with its current color / qty / part, goes into the open bag (in list order)
  const ca = $("#confirmall"); if (ca && !els.some(e => e.classList.contains("lotedit"))) ca.onclick = async () => { ca.disabled = true;
    await new Promise(r => setTimeout(r, 450)); await Q;   // let pending qty saves land first
    const todo = $$(".pcard:not(.lotedit):not(.going):not(.dropping)"); bulk = true; for (const el of todo) await confirmCard(el); bulk = false;
    ca.disabled = false; left(); toast(METER?.full ? "Bag looks full: cut it off and scan its label" : `Confirmed ${todo.length} card${todo.length === 1 ? "" : "s"} into the open bag`, 3500); };
  els.forEach(el => {
    const isLot = el.classList.contains("lotedit");
    if (!isLot) el.querySelector(".ok").onclick = () => confirmCard(el);
    if (!isLot) el.querySelector(".drop").onclick = async () => { if (!confirm("Drop this lot?")) return; el.classList.add("dropping"); await api("card/" + el.dataset.id, { action: "drop" }); PH.done(+el.dataset.id, true); setTimeout(() => el.remove(), 260); left(); if (TRAIN_SID) trainSoon(TRAIN_SID); };
    // qty − / + : saved immediately (min 1); rapid taps are coalesced into one save
    let qt = null; const bump = d => { const q = Math.max(1, (+el.dataset.qty || 1) + d); el.dataset.qty = q; el.querySelector(".qty b").textContent = q;
      el.querySelector(".minus").disabled = q <= 1; clearTimeout(qt); qt = setTimeout(async () => { const j = await api(ep(el), { action: "edit", qty: q }); if (!j.ok) toast(j.error || "save failed"); }, 350); };
    el.querySelector(".minus").onclick = () => bump(-1); el.querySelector(".plus").onclick = () => bump(1); el.querySelector(".minus").disabled = +el.dataset.qty <= 1;
    if (isLot) return;
    // swipe-up confirm only from the grip bar, so vertical scrolling anywhere else on the card scrolls the page
    const grip = el.querySelector(".grip"); let y0 = null, dy = 0;
    grip.addEventListener("touchstart", e => { y0 = e.touches[0].clientY; dy = 0; el.style.transition = "none"; }, { passive: true });
    grip.addEventListener("touchmove", e => { if (y0 === null) return; dy = Math.min(0, e.touches[0].clientY - y0); if (dy < -8) { e.preventDefault(); el.style.transform = `translateY(${dy}px)`; el.style.opacity = 1 + dy / 300; } }, { passive: false });
    grip.addEventListener("touchend", () => { if (y0 === null) return; el.style.transition = ""; el.style.transform = ""; el.style.opacity = ""; if (dy < -90) confirmCard(el); y0 = null; });
  });
  // ---- color: big button + quick chips on the card, bottom sheet with known colors + search. One tap changes.
  const setColor = async (el, id) => { const j = await api(ep(el), { action: "edit", color: id }); if (!j.ok) return toast(j.error || "failed");
    el.dataset.color = j.color; const c = byId[el.dataset.id]; if (c) c.color = j.color;
    el.querySelector(".colorbtn i").style.background = "#" + crgb(j.color); el.querySelector(".colorbtn .cn").textContent = j.color_name;
    el.querySelectorAll(".pimg img, .mimg").forEach(i => { i.style.visibility = ""; i.src = img(j.part, j.color); });
    el.querySelector(".quick").innerHTML = quickIds({ ...(c || {}), color: j.color }).map(x => chip(x, x === j.color)).join(""); wireQuick(el); };
  const wireQuick = el => el.querySelectorAll(".quick .chip").forEach(b => b.onclick = () => setColor(el, +b.dataset.c));
  let csEl = null, csKnown = [];
  const renderSheet = () => { const q = $("#cs_q").value.trim().toLowerCase(), all = $("#cs_all").checked || !csKnown.length, cur = +csEl.dataset.color, c = byId[csEl.dataset.id] || {};
    const match = id => !q || cname(id).toLowerCase().includes(q) || String(id) === q;
    const sug = [cur, ...(c.color_guesses || [])].filter((x, i, a) => a.indexOf(x) === i && match(x));
    const known = csKnown.filter(x => !sug.includes(x) && match(x)).sort((a, b) => cname(a).localeCompare(cname(b)));
    const rest = all ? PAL.map(p => p.id).filter(x => !sug.includes(x) && !known.includes(x) && match(x)).sort((a, b) => cname(a).localeCompare(cname(b))) : [];
    $("#cs_body").innerHTML = (sug.length ? `<p class="small muted">Best guesses from the photo</p><div class="chips">${sug.map(x => chip(x, x === cur)).join("")}</div>` : "") +
      (csKnown.length ? `<p class="small muted">Made by LEGO in ${csKnown.length} colors</p><div class="chips">${known.map(x => chip(x, x === cur)).join("") || '<span class="small muted">no match</span>'}</div>` : `<p class="small warn">No known-color data for this part. Showing all colors.</p>`) +
      (rest.length ? `<p class="small muted">All other colors</p><div class="chips">${rest.map(x => chip(x, x === cur)).join("")}</div>` : "");
    $$("#cs_body .chip").forEach(b => b.onclick = async () => { $("#cs").close(); await setColor(csEl, +b.dataset.c); }); };
  // iOS: lock the page behind the sheet, float the sheet above the keyboard, return to the edited card on close.
  let csY = 0; const vv = window.visualViewport;
  const placeSheet = () => { const d = $("#cs"); if (!d || !d.open) return; const h = vv ? vv.height : innerHeight, top = vv ? vv.offsetTop : 0;
    d.style.position = "fixed"; d.style.margin = "0 auto"; d.style.left = "0"; d.style.right = "0"; d.style.top = "auto"; d.style.bottom = Math.max(0, innerHeight - h - top) + "px";
    d.querySelector(".card").style.maxHeight = Math.round(h * 0.82) + "px"; };
  const lockBody = () => { csY = scrollY; const b = document.body.style; b.position = "fixed"; b.top = -csY + "px"; b.left = "0"; b.right = "0"; b.width = "100%"; };
  const unlockBody = () => { const b = document.body.style; b.position = b.top = b.left = b.right = b.width = ""; window.scrollTo(0, csY);
    if (csEl) { const r = csEl.getBoundingClientRect(); if (r.top < 0 || r.bottom > innerHeight) csEl.scrollIntoView({ block: "center" }); } };
  if (vv) { vv.addEventListener("resize", placeSheet); vv.addEventListener("scroll", placeSheet); }
  const openSheet = async el => { csEl = el; $("#cs_part").textContent = el.dataset.part; $("#cs_q").value = ""; $("#cs_all").checked = false;
    csKnown = (await partInfo(el.dataset.part)).colors || []; renderSheet(); lockBody(); $("#cs").showModal(); placeSheet(); };
  $("#cs").onclose = unlockBody;
  // typing only re-renders the results list (#cs_body); never the input, never auto-picks or closes; focus stays put
  let csRaf = 0; $("#cs_q").oninput = () => { cancelAnimationFrame(csRaf); csRaf = requestAnimationFrame(() => { const f = document.activeElement === $("#cs_q"); renderSheet(); if (f && document.activeElement !== $("#cs_q")) $("#cs_q").focus({ preventScroll: true }); }); };
  $("#cs_q").onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); } };
  $("#cs_all").onchange = renderSheet; $("#cs_x").onclick = () => $("#cs").close();
  els.forEach(el => { el.querySelector(".colorbtn").onclick = () => openSheet(el); wireQuick(el); renderMold(el);
    const pc = el.querySelector(".pcrop"); if (pc) pc.onclick = e => { e.stopPropagation(); e.preventDefault(); openZoom(+el.dataset.id, pc.querySelector("img").src); }; });
  // ---- alternates / part number: same edit as the mold switch, then the mold double-check re-runs for the new part
  const setPart = async (el, part, name) => { if (!name) name = (await partInfo(part)).name || ""; const j = await api(ep(el), { action: "edit", part, name }); if (!j.ok) return toast(j.error || "failed");
    el.dataset.part = j.part; const c = byId[el.dataset.id]; if (c) { c.part = j.part; c.name = j.name; }
    el.querySelector(".pn").textContent = j.part; el.querySelector(".nm").textContent = j.name; el.querySelectorAll(".pimg img, .mimg").forEach(i => { i.style.visibility = ""; i.src = img(j.part, j.color); });
    el.querySelector(".altbox").innerHTML = altHTML({ ...(c || {}), part: j.part, color: j.color }); wireAlts(el); renderMold(el); toast(`Set to ${j.part} (color and qty kept)`); };
  const wireAlts = el => el.querySelectorAll(".chip.alt").forEach(b => b.onclick = () => setPart(el, b.dataset.p, b.dataset.n));
  els.forEach(wireAlts);
  // ---- mold variants: notice + one-tap switch (keeps color and qty)
  async function renderMold(el) { const box = el.querySelector(".mold"), m = (await moldMap())[el.dataset.part], ex = await moldEx();
    const name = el.querySelector(".nm").textContent;
    const vs = ex.has(el.dataset.part) ? [] : (m?.v || []).filter(v => !/undetermined/i.test(v[1]) && !ex.has(v[0]));
    if (!vs.length) { box.hidden = true; box.innerHTML = ""; return; }
    box.innerHTML = `<b>⚠ Double-check: this part has a mold variant</b><div class="small">This one: <b class="mono">${esc(el.dataset.part)}</b> ${esc(name)}</div>
      <div class="chips">${vs.map(v => `<button type="button" class="chip mv" data-p="${esc(v[0])}" data-n="${esc(v[1])}"><img src="${img(v[0], el.dataset.color)}" alt="" onerror="this.style.visibility='hidden'"><span><b class="mono">${esc(v[0])}</b> ${esc(moldDiff(name, v[1]))}</span></button>`).join("")}</div>`;
    box.hidden = false;
    box.querySelectorAll(".mv").forEach(b => b.onclick = async () => { const j = await api(ep(el), { action: "edit", part: b.dataset.p, name: b.dataset.n });
      if (!j.ok) return toast(j.error || "failed"); el.dataset.part = j.part; const c = byId[el.dataset.id]; if (c) { c.part = j.part; c.name = j.name; }
      el.querySelector(".pn").textContent = j.part; el.querySelector(".nm").textContent = j.name; el.querySelectorAll(".pimg img, .mimg").forEach(i => { i.style.visibility = ""; i.src = img(j.part, j.color); });
      toast(`Switched to ${j.part} (color and qty kept)`); renderMold(el); }); }
}

// ---- tap-to-zoom on a card's photo: full-screen original photo centred on the part's detection box (box outlined); drag to pan, pinch / wheel to zoom
const ZM = (() => { let dbp = null; const idb = () => dbp || (dbp = new Promise((res, rej) => { const r = indexedDB.open("pts-zoom", 1);
    r.onupgradeneeded = () => { r.result.createObjectStore("photos", { keyPath: "id" }); r.result.createObjectStore("cards", { keyPath: "card" }); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
  const tx = async (st, mode, fn) => { const d = await idb(); return new Promise((res, rej) => { const t = d.transaction(st, mode), q = fn(t.objectStore(st)); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }); };
  const prune = async () => { const old = Date.now() - 14 * 864e5; const ps = await tx("photos", "readonly", s => s.getAll()); for (const p of ps) if (p.t < old) await tx("photos", "readwrite", s => s.delete(p.id)); };
  setTimeout(() => prune().catch(() => {}), 4000);
  // photos are stored as bytes (ArrayBuffer), not Blob: some WebKit builds refuse Blobs in IndexedDB; older Blob records still read
  return { addPhoto: async (blob, w, h) => { const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8), buf = await blob.arrayBuffer(); await tx("photos", "readwrite", s => s.put({ id, t: Date.now(), buf, type: blob.type || "image/jpeg", w, h })); return id; },
    mapCard: async (card, pid, box, scale, boxes) => { const ex = await tx("cards", "readonly", s => s.get(card)); if (!ex) await tx("cards", "readwrite", s => s.put({ card, pid, box, scale, boxes: boxes || [box] })); },
    get: async card => { const m = await tx("cards", "readonly", s => s.get(card)); if (!m) return null; const p = await tx("photos", "readonly", s => s.get(m.pid)); if (p && !p.blob && p.buf) p.blob = new Blob([p.buf], { type: p.type }); return p ? { ...m, photo: p } : null; } }; })();
async function openZoom(cardId, cropSrc) { $("#zoom")?.remove();
  document.body.insertAdjacentHTML("beforeend", `<div id="zoom" class="zoom" role="dialog" aria-label="Photo of this part"><canvas id="zcv"></canvas><button type="button" class="zx" id="zx" aria-label="Close">✕</button><p class="zhint" id="zhint">Drag to move · pinch to zoom · tap outside the photo or ✕ to close</p></div>`);
  const z = $("#zoom"), cv = $("#zcv"), g = cv.getContext("2d"), close = () => { z.remove(); document.body.style.overflow = ""; }; document.body.style.overflow = "hidden";
  $("#zx").onclick = e => { e.stopPropagation(); close(); };
  const m = await ZM.get(cardId).catch(() => null); let im, box = null;
  if (m) { im = await createImageBitmap(m.photo.blob); const k = m.scale || 1; box = m.box.map(v => v * k); z.dataset.src = "photo"; }
  else { im = await new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = cropSrc; }); z.dataset.src = "crop"; $("#zhint").textContent = "Original photo not on this phone · showing the crop"; }
  const W = innerWidth, H = innerHeight, dpr = devicePixelRatio || 1; cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + "px"; cv.style.height = H + "px";
  const iw = im.width, ih = im.height; let s, tx0, ty0;
  if (box) { const bw = box[2] - box[0], bh = box[3] - box[1], cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2; s = Math.min(W / (bw * 2.2), H * 0.8 / (bh * 2.2)); tx0 = W / 2 - cx * s; ty0 = H / 2 - cy * s; }
  else { s = Math.min(W / iw, H * 0.8 / ih); tx0 = (W - iw * s) / 2; ty0 = (H - ih * s) / 2; }
  z.dataset.scale = s.toFixed(3);
  const draw = () => { g.setTransform(dpr, 0, 0, dpr, 0, 0); g.fillStyle = "#000"; g.fillRect(0, 0, W, H); g.setTransform(dpr * s, 0, 0, dpr * s, dpr * tx0, dpr * ty0); g.drawImage(im, 0, 0);
    if (box) { g.lineWidth = 3 / s; g.strokeStyle = "#F2B233"; g.strokeRect(box[0], box[1], box[2] - box[0], box[3] - box[1]); } };
  const inImg = (x, y) => { const ix = (x - tx0) / s, iy = (y - ty0) / s; return ix >= 0 && iy >= 0 && ix <= iw && iy <= ih; };
  const pts = new Map(); let moved = false, last = null;
  cv.onpointerdown = e => { cv.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); moved = false; last = null; };
  cv.onpointermove = e => { if (!pts.has(e.pointerId)) return; const p0 = pts.get(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 1) { const dx = e.clientX - p0[0], dy = e.clientY - p0[1]; if (Math.abs(dx) + Math.abs(dy) > 1) moved = true; tx0 += dx; ty0 += dy; }
    else if (pts.size === 2) { const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]), mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      if (last) { const f = d / last; tx0 = mx - (mx - tx0) * f; ty0 = my - (my - ty0) * f; s *= f; } last = d; moved = true; } draw(); };
  cv.onpointerup = cv.onpointercancel = e => { pts.delete(e.pointerId); if (pts.size < 2) last = null; if (!moved && pts.size === 0 && !inImg(e.clientX, e.clientY)) close(); };
  cv.onwheel = e => { e.preventDefault(); const f = Math.exp(-e.deltaY / 300); tx0 = e.clientX - (e.clientX - tx0) * f; ty0 = e.clientY - (e.clientY - ty0) * f; s *= f; draw(); };
  draw(); }
// ---- photo panel (sticky, above the cards): the last photo with the finder's boxes, each numbered and linked to its card.
// Tap a box -> its card is selected and scrolled to; tap a card (or its number) -> its box lights up. Confirmed / dropped boxes turn teal ✓.
let PH_RZ = 0;
const PH = (() => { let im = null, items = [], sel = null, view = null, small = sessionStorage.getItem("pts_ph_small") === "1";
  const el = () => $("#photo");
  async function init(cards) { document.body.classList.remove("has-photo"); const host = el(); if (!host) return; im = null; items = []; sel = null; host.hidden = true;
    const ms = []; for (const c of cards) { const m = await ZM.get(c.id).catch(() => null); if (m) ms.push({ c, m }); } if (!ms.length) return;
    const pid = ms.reduce((a, x) => x.m.photo.t > a.photo.t ? x.m : a, ms[0].m).pid, mine = ms.filter(x => x.m.pid === pid);   // newest photo
    const p = mine[0].m.photo; im = await createImageBitmap(p.blob);
    items = mine.map((x, i) => ({ id: x.c.id, n: i + 1, k: scoreCls(x.c.confidence), boxes: (x.m.boxes || [x.m.box]).map(b => b.map(v => v * (x.m.scale || 1))), done: false }));
    items.forEach(it => { const b = document.querySelector(`.pcard[data-id="${it.id}"] .pno`); if (b) { b.textContent = it.n; b.hidden = false; } });
    host.className = "card photop"; host.innerHTML = `<div class="phead small"><span><b>Your photo</b> · tap a box to find its card</span><button type="button" class="btn small ghost" id="ph_sz">${small ? "Bigger" : "Smaller"}</button></div><canvas id="pcv"></canvas>`;
    host.hidden = false; document.body.classList.add("has-photo"); $("#ph_sz").onclick = () => { small = !small; sessionStorage.setItem("pts_ph_small", small ? "1" : "0"); $("#ph_sz").textContent = small ? "Bigger" : "Smaller"; fit(); };
    const cv = $("#pcv"); cv.onclick = e => { const q = cv.getBoundingClientRect(), x = (e.clientX - q.left - view.ox) / view.s + view.x0, y = (e.clientY - q.top - view.oy) / view.s + view.y0;
      const hit = items.filter(it => !it.done && it.boxes.some(b => x >= b[0] - 8 && x <= b[2] + 8 && y >= b[1] - 8 && y <= b[3] + 8))
        .sort((a, b) => area(a) - area(b))[0]; if (hit) pick(hit.id, true); else pick(null); };
    $$(".pcard:not(.lotedit)").forEach(c => { c.addEventListener("click", e => { if (e.target.closest("button:not(.pno),input,.pcrop,.chip,a")) return; pick(+c.dataset.id, false, true); }); });
    if (!PH_RZ) { PH_RZ = 1; addEventListener("resize", () => PH.fit()); } fit(); }
  const area = it => it.boxes.reduce((a, b) => a + (b[2] - b[0]) * (b[3] - b[1]), 0);
  function fit() { const host = el(), cv = $("#pcv"); if (!host || host.hidden || !cv || !im) return dockVar();
    // show the area the parts are in (union of boxes + margin), not the whole table
    const bs = items.flatMap(it => it.boxes); let [x0, y0, x1, y1] = [Math.min(...bs.map(b => b[0])), Math.min(...bs.map(b => b[1])), Math.max(...bs.map(b => b[2])), Math.max(...bs.map(b => b[3]))];
    const mg = 0.06 * Math.max(x1 - x0, y1 - y0); x0 = Math.max(0, x0 - mg); y0 = Math.max(0, y0 - mg); x1 = Math.min(im.width, x1 + mg); y1 = Math.min(im.height, y1 + mg);
    const W = host.clientWidth - 12, H = Math.round(innerHeight * (small ? 0.15 : 0.24)), s = Math.min(W / (x1 - x0), H / (y1 - y0)), dpr = devicePixelRatio || 1;
    cv.style.width = W + "px"; cv.style.height = H + "px"; cv.width = W * dpr; cv.height = H * dpr;
    view = { x0, y0, x1, y1, s, ox: (W - (x1 - x0) * s) / 2, oy: (H - (y1 - y0) * s) / 2, W, H, dpr }; draw(); dockVar(); }
  function draw() { const cv = $("#pcv"); if (!cv || !view) return; const g = cv.getContext("2d"), { x0, y0, x1, y1, s, ox, oy, W, H, dpr } = view;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.fillStyle = "#14282a"; g.fillRect(0, 0, W, H); g.drawImage(im, x0, y0, x1 - x0, y1 - y0, ox, oy, (x1 - x0) * s, (y1 - y0) * s);
    const R = b => [ox + (b[0] - x0) * s, oy + (b[1] - y0) * s, (b[2] - b[0]) * s, (b[3] - b[1]) * s];
    if (sel !== null) { g.fillStyle = "#0006"; g.fillRect(0, 0, W, H); const it = items.find(x => x.id === sel); if (it) it.boxes.forEach(b => { const [x, y, w, h] = R(b); g.drawImage(im, b[0], b[1], b[2] - b[0], b[3] - b[1], x, y, w, h); }); }
    for (const it of [...items].sort((a, b) => (a.id === sel) - (b.id === sel))) { const on = it.id === sel, col = it.done ? "#0E4A4F" : it.k === "lo" ? "#e0245e" : "#F2B233";
      it.boxes.forEach((b, j) => { const [x, y, w, h] = R(b); g.lineWidth = on ? 4 : 2; g.strokeStyle = on ? "#fff" : col; if (it.done) g.setLineDash([5, 4]); g.strokeRect(x, y, w, h); g.setLineDash([]);
        if (on) { g.lineWidth = 2; g.strokeStyle = col; g.strokeRect(x - 3, y - 3, w + 6, h + 6); }
        if (j) return; const t = it.done ? "✓" : String(it.n), r = on ? 12 : 10; g.beginPath(); g.arc(x + 2, y + 2, r, 0, 7); g.fillStyle = it.done ? "#0E4A4F" : col; g.fill();
        g.fillStyle = it.done || it.k === "lo" ? "#fff" : "#0E4A4F"; g.font = `bold ${on ? 14 : 12}px system-ui,sans-serif`; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(t, x + 2, y + 3); }); } }
  function dockVar() { const d = $("#dock"); document.documentElement.style.setProperty("--dockh", ((d ? d.offsetHeight : 0) + 56) + "px"); }
  function pick(id, scroll, fromCard) { if (fromCard && id === sel) id = null; sel = id; $$(".pcard.sel").forEach(c => c.classList.remove("sel"));
    const c = id !== null && document.querySelector(`.pcard[data-id="${id}"]`); if (c) { c.classList.add("sel"); if (scroll) c.scrollIntoView({ behavior: "smooth", block: "start" }); } draw(); }
  function done(id, next) { const it = items.find(x => x.id === id); if (it) it.done = true; const was = sel === id || sel === null;
    if (next && was) { const nx = $$(".pcard:not(.lotedit):not(.going):not(.dropping)").find(c => +c.dataset.id !== id); pick(nx ? +nx.dataset.id : null, !!nx && items.some(x => x.id === +nx.dataset.id)); } else draw();
    if (!items.some(x => !x.done)) { const h = el(); if (h) h.hidden = true; dockVar(); } }
  return { init, fit, done, pick }; })();
async function processPhoto(sid, file) {
  if (!file) return; const prog = $("#prog"), pt = $("#progt"); prog.hidden = false;
  try {
    // the ONNX part finder is the only detector (onnxruntime-web, model downloaded once and cached by the browser)
    pt.textContent = "Loading part finder (first time ~15 MB)…";
    const tl = performance.now(); await Promise.all([PTSBrickator.load(), palette()]); const loadMs = Math.round(performance.now() - tl);
    pt.textContent = "Finding parts…";
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const sc = Math.min(1, 3200 / Math.max(bmp.width, bmp.height)); const cvs = document.createElement("canvas"); cvs.width = Math.round(bmp.width * sc); cvs.height = Math.round(bmp.height * sc);
    cvs.getContext("2d").drawImage(bmp, 0, 0, cvs.width, cvs.height);
    await new Promise(r => setTimeout(r, 30));
    const td = performance.now(); const parts = await PTSBrickator.detect(cvs);
    window.PTS_LAST_DETECT = { detector: PTSBrickator.VER, load_ms: loadMs, detect_ms: Math.round(performance.now() - td), boxes: parts.length, infer_ms: PTSBrickator.stats.infer_ms, paper: PTSBrickator.stats.paper };
    // resume: the capture under review (photo + found boxes + boxes the sorter adds) is kept on the phone until Done
    try { await RV.put({ sid, t: Date.now(), w: cvs.width, h: cvs.height, photo: await new Promise(r => cvs.toBlob(r, "image/jpeg", 0.92)), det: window.PTS_LAST_DETECT.detector, parts: parts.map(p => ({ box: p.box, crop: p.crop, lab: p.lab, group: p.group, merged: p.merged || null })), missed: [] }); } catch (e) { console.warn("review save", e); }
    return finishPhoto(sid, cvs, parts, [], false, window.PTS_LAST_DETECT.detector);
  } catch (e) { pt.textContent = "Error: " + e.message; console.error(e); }
}
// review store (IndexedDB 'pts-review', one record per session) so a reload / app restart comes back to the same review
const RV = (() => { let dbp = null; const idb = () => dbp || (dbp = new Promise((res, rej) => { const r = indexedDB.open("pts-review", 1); r.onupgradeneeded = () => r.result.createObjectStore("rv", { keyPath: "sid" }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
  const tx = async (mode, fn) => { const d = await idb(); return new Promise((res, rej) => { const t = d.transaction("rv", mode), q = fn(t.objectStore("rv")); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }); };
  return { put: v => tx("readwrite", s => s.put(v)), get: sid => tx("readonly", s => s.get(sid)), del: sid => tx("readwrite", s => s.delete(sid)),
    setMissed: async (sid, missed) => { const r = await tx("readonly", s => s.get(sid)); if (r) { r.missed = missed; await tx("readwrite", s => s.put(r)); } } }; })();
async function resumeReview(sid) { const r = await RV.get(sid).catch(() => null); if (!r || !$("#prog")) return false;
  const im = await createImageBitmap(r.photo); const cvs = document.createElement("canvas"); cvs.width = r.w; cvs.height = r.h; cvs.getContext("2d").drawImage(im, 0, 0, r.w, r.h);
  toast("Resumed your photo review"); finishPhoto(sid, cvs, r.parts, r.missed || [], true, r.det || PTSBrickator.VER); return true; }
async function finishPhoto(sid, cvs, parts, missed0, resumed, det) {
  const prog = $("#prog"), pt = $("#progt"); prog.hidden = false;
  try {
    // preview with boxes
    const pv = $("#prev"), ps = Math.min(1, 700 / cvs.width); pv.width = cvs.width * ps; pv.height = cvs.height * ps; const g = pv.getContext("2d"); g.drawImage(cvs, 0, 0, pv.width, pv.height);
    g.strokeStyle = "#F2B233"; g.lineWidth = 3; g.font = "bold 18px sans-serif"; g.fillStyle = "#F2B233"; parts.forEach((p, i) => { const [a, b, c, d] = p.box.map(v => v * ps); g.strokeRect(a, b, c - a, d - b); g.fillText(i + 1, a + 4, b + 18); }); pv.hidden = false;
    // ---- review: photo stays on screen with the found boxes; tap/drag to box missed parts; nothing is identified or saved until Done
    pv.hidden = true; const missed = await reviewPhoto(cvs, parts, pt, sid, missed0);
    const total = parts.length + missed.length; if (!total) { pt.textContent = "No parts found. Try a plainer background and spread the parts out."; return; }
    const cropOf = b => { const c = document.createElement("canvas"); c.width = Math.max(1, b[2] - b[0]); c.height = Math.max(1, b[3] - b[1]); c.getContext("2d").drawImage(cvs, b[0], b[1], c.width, c.height, 0, 0, c.width, c.height); return c; };
    const mcrops = missed.map(b => cropOf(b));
    let n = 0; pt.textContent = `Identifying ${total} parts… 0/${total}`;
    const jobs = parts.map(p => p.crop); const gj = {}; parts.forEach(p => { if (p.group !== null && p.merged && !(p.group in gj)) { gj[p.group] = jobs.length; jobs.push(p.merged.crop); } });
    const mj = jobs.length; mcrops.forEach(c => jobs.push(c.toDataURL("image/jpeg", 0.9)));
    for (let i = 0; i < jobs.length; i++) jobs[i] = await shrink(jobs[i], 800);   // every crop (hand-drawn boxes too) fits 800 px, JPEG 0.8
    const res = new Array(jobs.length); let k = 0;
    await Promise.all(Array.from({ length: IDENT_CONC }, async () => { while (k < jobs.length) { const i = k++; let r = await identify(jobs[i]);
      res[i] = r.items || []; if (i < parts.length || i >= mj) pt.textContent = `Identifying ${total} parts… ${++n}/${total}`; } }));
    let keep = parts.map((_, i) => i), preds = res.slice(0, parts.length);
    for (const [gid, j] of Object.entries(gj)) { const mem = parts.map((p, i) => p.group == gid ? i : -1).filter(i => i >= 0), whole = res[j];
      const ids = new Set(mem.map(i => preds[i][0]?.id)), best = Math.max(...mem.map(i => preds[i][0]?.score || 0));
      if (whole.length && ids.size > 1 && whole[0].score >= best - 0.02) { const f = mem[0]; parts[f] = { ...parts[f], ...parts[f].merged }; preds[f] = whole; keep = keep.filter(i => !mem.slice(1).includes(i)); } }
    // detected parts and missed boxes share one path: identification -> color estimate from the part's pixels -> parts list (lib/partslist.js: one row per part+color, qty summed, low/unidentified flagged)
    const dets = [...keep.map(i => ({ items: preds[i], lab: parts[i].lab, crop: parts[i].crop, box: parts[i].box, kind: "t" })), ...missed.map((b, m) => ({ items: res[mj + m], lab: PTSDetect.cropLab(mcrops[m]), crop: jobs[mj + m], box: b, kind: "m" }))];
    const und = new Set(); for (const id of new Set(dets.flatMap(d => (d.items || []).map(it => String(it.id))))) if (await isUndetermined(id)) und.add(id);
    for (const d of dets) { const top = (d.items || []).find(it => it.id && (!it.type || it.type === "part") && !und.has(String(it.id)));
      if (top) { const ranked = PTSDetect.estimateColor(d.lab, top.id, (await partInfo(top.id)).colors, PAL); d.col = { color: ranked[0]?.id ?? 0, guesses: ranked.slice(0, 5).map(c => c.id) }; } }
    const PL = PTSPartsList.buildPartsList(dets, { undetermined: id => und.has(id), colorFor: d => d.col });
    // unidentified crops are counted (toast) but not shown or saved: the sorter notices the missing part while verifying and retakes the photo
    const lineOf = [], lines = []; for (const r of PL.rows) { if (r.flag === "unidentified") { lineOf.push(null); continue; } lineOf.push(lines.length); lines.push({ ...PTSPartsList.toCard(r), crop: r.crop ? await shrink(r.crop, 220) : null }); }
    const tboxes = [], mboxes = [];
    dets.forEach((d, i) => { const r = PL.rows[PL.rowOf[i]], line = lineOf[PL.rowOf[i]]; (d.kind === "t" ? tboxes : mboxes).push({ box: d.box, line, pred: r.part === "?" ? null : { part: r.part, color: r.color, score: Math.round(((d.items || []).find(it => it.id === r.part)?.score || 0) * 1000) / 1000 } }); });
    const unk = PL.summary.unidentified, lowN = PL.summary.low;
    pt.textContent = "Saving cards…"; const sv = await api(`session/${sid}/cards`, { cards: lines });
    if (sv.ok) await RV.del(sid).catch(() => {});
  // cards exist now: a later reload must not make them (or the training sample) again
    const cid = line => line === null ? null : (sv.ids || [])[line] ?? null;
    // tap-to-zoom: keep the source photo + each card's detection box on the phone (works after reload / resume)
    try { const pid = await ZM.addPhoto(await new Promise(r => cvs.toBlob(r, "image/jpeg", 0.9)), cvs.width, cvs.height);
      const per = {}; for (const b of [...tboxes, ...mboxes]) { const id = cid(b.line); if (id) (per[id] = per[id] || []).push(b.box); } for (const [id, bs] of Object.entries(per)) await ZM.mapCard(+id, pid, bs[0], 1, bs); } catch (e) { console.warn("zoom store", e); }     // training sample: kept on the phone until these cards are resolved, then uploaded in the background; review boxes are labelled 'missed'
    try { const tid = await PTSTrain.begin(sid, cvs, tboxes.map(b => ({ box: b.box.map(v => Math.round(v)), card_id: cid(b.line), pred: b.pred })), det);
      for (const b of mboxes) await PTSTrain.addMissed(tid, b.box.map(v => Math.round(v)), cid(b.line)); } catch (e) { console.warn("training sample", e); }
    toast(`${total} parts${missed.length ? ` (${missed.length} added by you)` : ""} → ${lines.length} lots${lowN ? ` · ${lowN} to double-check` : ""}${unk ? ` · ${unk} not recognised, retake the photo to try again` : ""}`, 3500); route();
  } catch (e) { pt.textContent = "Error: " + e.message; console.error(e); }
}
// photo review: keeps the photo on screen with the found boxes (gold); tap or drag to add a box (pink, 'missed'); Done resolves the list of missed boxes
function reviewPhoto(cvs, parts, pt, sid, missed0) { return new Promise(resolve => {
  const host = $("#review"); pt.textContent = parts.length ? `${parts.length} parts found. Box any part that was missed, then tap Done.` : "No parts found automatically. Box the parts, then tap Done.";
  $("#prog .spin").hidden = true;
  host.innerHTML = `<p class="small muted">Tap a part (or drag a box around it) if it has no box. Pink boxes are added by you.</p><canvas id="rcv" class="prev" style="width:100%;touch-action:none"></canvas>
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
    r = [Math.max(0, r[0]), Math.max(0, r[1]), Math.min(cv.width, r[2]), Math.min(cv.height, r[3])]; a = null; cur = null;
    if (r[2] - r[0] > 4 && r[3] - r[1] > 4) { added.push(r.map(v => Math.round(v / sc))); persist(); } draw(); };
  $("#r_undo").onclick = () => { added.pop(); persist(); draw(); };
  $("#r_done").onclick = () => { host.hidden = true; host.innerHTML = ""; $("#prog .spin").hidden = false; resolve(added); };
  draw(); host.scrollIntoView({ block: "start" }); }); }
// identification: up to 8 calls at once, ~8 s timeout per call and one retry
const IDENT_CONC = 8, IDENT_MS = 8000;
async function identify(image) { for (let t = 0; t < 2; t++) { try { const r = await fetch("/alpha/api/identify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image }), signal: AbortSignal.timeout(IDENT_MS) });
    if (r.ok) return await r.json(); } catch (e) {} } return {}; }
function shrink(dataURL, max) { return new Promise(res => { const im = new Image(); im.onload = () => { const s = Math.min(1, max / Math.max(im.width, im.height)), c = document.createElement("canvas"); c.width = im.width * s; c.height = im.height * s; c.getContext("2d").drawImage(im, 0, 0, c.width, c.height); res(c.toDataURL("image/jpeg", 0.8)); }; im.src = dataURL; }); }

V.boxes = async () => { const j = await api("boxes");
  main.innerHTML = `<h1>Boxes</h1><div class="card">${ME?.user.role === "admin" ? `<p class="muted small">New boxes and their bag QR sheets are made in Batch prep.</p><a class="btn gold wide" href="#/host/batch">Open Batch prep</a>` : `<p class="muted small">New boxes and bag QR sheets are made by a host admin in Batch prep.</p>`}<a class="btn wide" href="#/putaway" style="margin-top:8px">Put-away</a></div>
  ${j.boxes.map(x => `<a class="row card" href="#/box/${x.id}"><span style="max-width:130px">${barSVG(x.barcode).replace("<svg", '<svg class="bc"')}</span><span><b class="mono">${x.barcode}</b><br><span class="muted small">${x.nb} bags · ${x.pcs} pcs</span></span>${pill(x.shelf || "no shelf", "")}</a>`).join("") || `<p class="muted">No boxes yet.</p>`}`; };

V.box = async (id, j) => { await palette(); j = j || await api("box/" + id); const b = j.box;
  main.innerHTML = `<h1 class="mono">Box ${b.barcode}</h1>${j.msg ? `<p class="okmsg">${esc(j.msg)}</p>` : ""}
  <div class="card center">${barSVG(b.barcode).replace("<svg", '<svg class="bcbig"')}</div>
  <form class="card" id="sf"><label>Shelf address<input name="shelf" value="${esc(b.shelf || "")}" autocapitalize="characters"></label><button class="btn wide">Save shelf</button></form>
  <h2>In this box <span class="muted small">${j.bags.length}</span></h2>${j.bags.map(x => `<div class="bag card"><img src="${img(x.part, x.color)}" class="thumb" alt=""><div class="grow"><a href="#/bag/${x.code}">${contents(x)}</a><br><span class="mono small muted">${x.code} · ${x.status}</span></div><button class="btn ghost small rm" data-c="${x.code}">✕</button></div>`).join("")}`;
  $("#sf").onsubmit = async e => { e.preventDefault(); V.box(id, await api("box/" + id, { action: "shelf", shelf: e.target.shelf.value })); };
  $$(".rm").forEach(x => x.onclick = async () => V.box(id, await api("box/" + id, { action: "remove", code: x.dataset.c }))); };

V.host = async () => { if (ME?.user.role !== "admin") { main.innerHTML = `<p class="err">Host admins only.</p>`; return; } await palette();
  main.innerHTML = `<h1>Host · ${esc(ME.host.site_name)}</h1><p><a class="btn small" href="#/host/settings">Settings &amp; sorters</a> <a class="btn small gold" href="#/host/batch">Batch prep · print box sheets</a> <a class="btn small" href="#/host/molds">Mold-variant exceptions</a> <a class="btn small" href="#/host/train">Training data</a> <a class="btn small" href="#/host/parts">Import parts file</a></p>
  <div class="card"><h3>Download inventory file</h3><p class="muted small">All confirmed lots from every sorting session of this host, one line per part and color (.bsx file, price 0, condition used).</p><a class="btn wide" id="hostdl" href="/alpha/api/host/export" download>⬇ Download inventory file</a></div>
`; };
V.hostSettings = async (j, msg) => { j = j || await api("host"); if (j.error) { main.innerHTML = `<p class="err">${esc(j.error)}</p>`; return; } const h = j.host;
  main.innerHTML = `<h1>Host settings</h1>${msg ? `<p class="okmsg">${esc(msg)}</p>` : ""}<form class="card" id="hs"><label>Host site name<input name="site_name" value="${esc(h.site_name)}"></label>
  <label>Pay sorters<select name="pay_mode"><option value="lb" ${h.pay_mode === "lb" ? "selected" : ""}>per lb sorted</option><option value="hr" ${h.pay_mode === "hr" ? "selected" : ""}>per hour</option></select></label>
  <div class="row2"><label>$ per lb<input name="rate_lb" type="number" step="0.01" value="${h.rate_lb}"></label><label>$ per hour<input name="rate_hr" type="number" step="0.01" value="${h.rate_hr}"></label></div>
  <label>"Low stock" below<input name="low_threshold" type="number" min="1" value="${h.low_threshold}"></label>
  <h3 class="sechead">Open bag</h3><label>Default pay share for new sorters (0 to 1; 0 = show parts value only). Each sorter’s own share is set under People.<input name="payout_share" type="number" step="0.01" min="0" max="1" value="${h.payout_share ?? 0}"></label>
  <p class="small muted">Fallback bag limits, used only when the host has no bag sizes:</p><div class="row2"><label>Bag full at (g, 0 = off)<input name="bag_max_g" type="number" step="1" min="0" value="${h.bag_max_g ?? 110}"></label><label>…or at (cm³, 0 = off)<input name="bag_max_cm3" type="number" step="1" min="0" value="${h.bag_max_cm3 ?? 250}"></label></div>
  <label>Loose parts density (g per cm³ in a bag)<input name="loose_density" type="number" step="0.01" min="0.05" max="2" value="${h.loose_density ?? 0.4}"></label><button class="btn gold wide">Save</button></form>
  <h2>Bag sizes</h2><p class="muted small">The open bag is full at whichever limit comes first. Pick a size per box in Batch prep (boxes without one use the first size).</p>
  <div id="bsz">${(j.bag_sizes || []).map(z => `<form class="card row2 bsz" data-id="${z.id}"><label>Name<input name="name" value="${esc(z.name)}" required></label><label>Max g<input name="max_g" type="number" min="0" step="1" value="${z.max_g}"></label><label>Max cm³<input name="max_cm3" type="number" min="0" step="1" value="${z.max_cm3}"></label><span class="bszb"><button class="btn small gold">Save</button><button type="button" class="btn small ghost bszrm">Remove</button></span></form>`).join("") || `<p class="muted small">No bag sizes yet.</p>`}</div>
  <form class="card row2" id="bszadd"><label>New size<input name="name" placeholder="e.g. 6x9" required></label><label>Max g<input name="max_g" type="number" min="0" step="1" value="110"></label><label>Max cm³<input name="max_cm3" type="number" min="0" step="1" value="250"></label><span class="bszb"><button class="btn small gold">Add</button></span></form>
  <h2>People</h2>${j.users.map(u => `<div class="row card"><b>${esc(u.username)}</b><span class="muted small grow">${esc(u.display)} · ${u.ns} sessions</span>${u.role === "sorter" ? `<form class="pays" data-u="${esc(u.username)}"><input name="pay_share" type="number" step="0.01" min="0" max="1" value="${u.pay_share || 0}" aria-label="pay share of parts value" title="pay share of parts value (0 = show parts value only)"><button class="btn small">Save pay</button></form>` : ""}${pill(u.role, "")}</div>`).join("")}
  <form class="card" id="as"><h3>Add a sorter</h3><label>Username<input name="username" autocapitalize="none" required></label><label>Name<input name="display"></label><label>Password<input name="password" type="password" minlength="8" required></label><button class="btn wide">Add sorter</button></form>
  <h2>Sessions &amp; pay</h2>${j.sessions.map(s => `<a class="row card" href="#/s/${s.id}"><b class="mono">${s.id}</b><span class="small">${esc(s.username)} · ${esc(s.pay)}</span>${pill(s.status)}</a>`).join("")}`;
  const fo = f => Object.fromEntries(new FormData(f));
  $("#hs").onsubmit = async e => { e.preventDefault(); const r = await api("host/settings", fo(e.target)); await loadMe(); V.hostSettings(null, r.msg || r.error); };
  const bs = async b => { const r = await api("host/bag-sizes", b); V.hostSettings(null, r.ok ? "Bag sizes saved." : r.error); };
  $$("#bsz .bsz").forEach(f => { f.onsubmit = e => { e.preventDefault(); bs({ action: "edit", id: +f.dataset.id, ...fo(f) }); }; f.querySelector(".bszrm").onclick = () => { if (confirm("Remove this bag size?")) bs({ action: "remove", id: +f.dataset.id }); }; });
  $("#bszadd").onsubmit = e => { e.preventDefault(); bs({ action: "add", ...fo(e.target) }); };
  $$(".pays").forEach(f => f.onsubmit = async e => { e.preventDefault(); const r = await api("host/sorter/pay", { username: f.dataset.u, pay_share: f.pay_share.value }); toast(r.ok ? `Pay for ${r.username}: ${Math.round(r.pay_share * 100)}% of parts value` : r.error || "failed"); });
  $("#as").onsubmit = async e => { e.preventDefault(); const r = await api("host/sorter", fo(e.target)); V.hostSettings(null, r.msg || r.error); }; };

// ---- batch prep (admin): make boxes with N bag QRs and print one sheet per box (master QR + bag 1..N QRs with write-in lines). Labels are printed here, not by sorters.
V.hostBatch = async () => { if (ME?.user.role !== "admin") { main.innerHTML = `<p class="err">Host admins only.</p>`; return; } const j = await api("host/batch");
  main.innerHTML = `<h1>Batch prep</h1><p class="muted small">Before the sorter leaves: print one sheet per box. The sorter scans the box’s master QR, then a bag QR to choose where photos and parts go.</p>
  <form class="card" id="bf"><div class="row2"><label>Boxes<input name="boxes" type="number" min="1" max="20" value="1" inputmode="numeric"></label><label>Bags per box<input name="bags" type="number" min="1" max="30" value="6" inputmode="numeric"></label></div>
  <div class="row2"><label>Batch weight (g)<input name="weight_g" type="number" min="1" step="1" inputmode="numeric" placeholder="weigh it now"></label><label>Assigned sorter (optional)<select name="sorter"><option value="">anyone</option>${(j.sorters || []).map(u => `<option>${esc(u)}</option>`).join("")}</select></label></div>
  <div class="row2"><label>Bag size<select name="bag_size">${(j.bag_sizes || []).map(z => `<option value="${z.id}">${esc(z.name)} · ${z.max_g} g / ${z.max_cm3} cm³</option>`).join("") || `<option value="">host default</option>`}</select></label><label>Shelf address (optional)<input name="shelf" autocapitalize="characters" placeholder="e.g. A-01-2"></label></div><button class="btn gold wide">Create boxes + bag QRs</button></form>
  <h2>Boxes <span class="muted small">${j.boxes.length}</span></h2><div id="bxlist">${j.boxes.map(x => `<div class="row card"><b class="mono">${esc(x.barcode)}</b><span class="small grow">${x.nbags} bag QR${x.nbags === 1 ? "" : "s"}${x.batch_weight_g ? ` · ${x.batch_weight_g} g` : ""}${x.bag_size_id && j.bag_sizes ? ` · ${esc(j.bag_sizes.find(z => z.id === x.bag_size_id)?.name || "")} bags` : ""}${x.sorter ? ` · for ${esc(x.sorter)}` : ""}${x.session_id ? ` · in use: <span class="mono">${esc(x.session_id)}</span>` : " · not used yet"}</span>${x.nbags ? `<a class="btn small gold" href="#/host/sheet/${x.id}">🖨 Sheet</a>` : ""}</div>`).join("") || `<p class="muted">No boxes yet.</p>`}</div>`;
  $("#bf").onsubmit = async e => { e.preventDefault(); const f = e.target, r = await api("host/batch", { boxes: +f.boxes.value, bags: +f.bags.value, shelf: f.shelf.value, weight_g: f.weight_g.value || null, sorter: f.sorter.value || null, bag_size_id: +f.bag_size.value || null }); if (!r.ok) return toast(r.error || "failed");
    location.hash = r.boxes.length === 1 ? "#/host/sheet/" + r.boxes[0] : "#/host/batch"; if (r.boxes.length > 1) V.hostBatch(); }; };
V.hostSheet = async id => { if (ME?.user.role !== "admin") { main.innerHTML = `<p class="err">Host admins only.</p>`; return; } const j = await api("host/sheet/" + id); if (j.error) { main.innerHTML = `<p class="err">${esc(j.error)}</p>`; return; }
  main.innerHTML = `<div class="noprint card center"><b>Box sheet · ${j.bags.length} bag QR${j.bags.length === 1 ? "" : "s"}</b><br><button class="btn gold" id="prt">🖨 Print</button> <a class="btn ghost" href="#/host/batch">Back</a></div>
  <div class="sheet-print"><div class="master"><img class="q" src="${qrURL(j.box.barcode)}" alt=""><div><div class="small">BOX · scan first</div><div class="c mono">${esc(j.box.barcode)}</div>${j.box.shelf ? `<div class="small">Shelf ${esc(j.box.shelf)}</div>` : ""}${j.box.batch_weight_g ? `<div class="small">Batch ${esc(j.box.batch_weight_g)} g</div>` : ""}<div class="wl">Sorter</div><div class="wl">Date</div></div></div>
  <div class="bagqrs">${j.bags.map(b => `<div class="bq"><img class="q" src="${qrURL(b.code)}" alt=""><div class="t"><b>Bag ${b.n}</b><span class="mono small">${esc(b.code)}</span><div class="wl"></div><div class="wl"></div></div></div>`).join("")}</div></div>`;
  $("#prt").onclick = () => print(); };
V.hostMolds = async (msg) => { if (ME?.user.role !== "admin") { main.innerHTML = `<p class="err">Host admins only.</p>`; return; }
  const j = await api("mold-exceptions"), mm = await moldMap();
  main.innerHTML = `<h1>Mold-variant exceptions</h1><p class="muted small">Parts on this list never show the "Double-check: mold variant" notice and are never offered as a variant chip. Shared by all hosts.</p>
  ${msg ? `<p class="${msg.startsWith("✗") ? "err" : "okmsg"}">${esc(msg)}</p>` : ""}
  <form class="card" id="mf"><label>Part number<input name="part" autocapitalize="none" placeholder="e.g. 3003" required></label><label>Note (optional)<input name="note" placeholder="why"></label><button class="btn gold wide">Add to list</button></form>
  <h2>On the list <span class="muted small">${j.parts.length}</span></h2>
  ${j.parts.map(x => `<div class="bag card"><img src="${img(x.part, 1)}" class="thumb" alt="" onerror="this.style.visibility='hidden'"><div class="grow"><b class="mono">${esc(x.part)}</b> ${esc(x.note || "")}<br><span class="small muted">${(mm[x.part]?.v || []).length} variant(s) hidden · added by ${esc(x.added_by || "?")}</span></div><button class="btn ghost small rmx" data-p="${esc(x.part)}">Remove</button></div>`).join("") || `<p class="muted">Empty.</p>`}`;
  const after = r => { MOLDEX = null; V.hostMolds(r.ok ? "Saved." : "✗ " + (r.error || "failed")); };
  $("#mf").onsubmit = async e => { e.preventDefault(); after(await api("host/mold-exceptions", { action: "add", part: e.target.part.value, note: e.target.note.value })); };
  $$(".rmx").forEach(b => b.onclick = async () => { if (confirm("Remove " + b.dataset.p + " from the exception list?")) after(await api("host/mold-exceptions", { action: "remove", part: b.dataset.p })); }); };

V.putaway = () => { main.innerHTML = `<h1>Put-away</h1><p class="muted small">1) Scan the bag QR · 2) scan the shelf address (or a box barcode). Typing works too.</p>
  <div class="card"><label>1 · Bag QR<input id="code" placeholder="PTS-…" autocapitalize="characters" autocomplete="off"></label><label>2 · Shelf address or box<input id="shelf" placeholder="A-01-2 or BX0100001" autocapitalize="characters" autocomplete="off"></label>
  <div class="row2"><button class="btn gold" id="save">Put away</button><button class="btn" id="camscan" hidden>📷 Scan</button></div></div><div id="bagview"></div><video id="vid" playsinline hidden></video><div id="log"></div>`;
  const c = $("#code"), s = $("#shelf");
  const show = async () => { const v = c.value.trim(); if (!/^PTS-/i.test(v)) { $("#bagview").innerHTML = ""; return; } await palette(); const j = await api("bag/" + encodeURIComponent(v.toUpperCase()));
    $("#bagview").innerHTML = j.bag ? `<div class="card"><p class="small muted">In this bag:</p>${j.bag.lots.map(l => `<div class="small">${l.qty}× <b class="mono">${esc(l.part)}</b> ${esc(l.color_name)}</div>`).join("") || "empty"}</div>` : `<p class="err small">${esc(j.error || "")}</p>`; };
  c.onchange = show; c.addEventListener("blur", show);
  const save = async () => { if (!c.value || !s.value) return; const j = await api("putaway", { code: c.value, shelf: s.value }); const p = document.createElement("p"); p.className = (j.ok ? "okmsg" : "err") + " small"; p.textContent = j.ok ? "✓ " + j.msg : "✗ " + j.error; $("#log").prepend(p); if (j.ok) c.value = ""; c.focus(); };
  c.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); s.focus(); } }; s.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); save(); } }; $("#save").onclick = save;
  attachScan($("#camscan"), $("#vid"), v => { if (!c.value) { c.value = v; show(); s.focus(); } else { s.value = v; save(); } }); };

const contents = b => (b.lots || []).map(l => `${l.qty}× ${esc(l.part)} ${esc(l.color_name)}`).join(", ") || "empty";
V.bag = async code => { SESS_OPEN = false; await palette(); const j = await api("bag/" + encodeURIComponent(code)); if (!j.bag) { main.innerHTML = `<p class="err">${esc(j.error || "not found")}</p>`; return; } const b = j.bag;
  main.innerHTML = `<h1>Bag</h1><div id="bags">${bagHTML(b)}</div><p class="muted small">Swipe a part <b>left</b> to edit it or remove it from this bag.</p>
  <p>${b.session_id ? `<a class="btn small" href="#/s/${b.session_id}">Session</a>` : ""}</p>${CS_HTML}`; wireBags($("#bags")); };
V.hostTrain = async msg => { if (ME?.user.role !== "admin") { main.innerHTML = `<p class="err">Host admins only.</p>`; return; } const j = await api("host/train");
  main.innerHTML = `<h1>Training data</h1><p class="muted small">Part photos from sorting (with what sorters confirmed, dropped, corrected or added) go into one shared pool that improves part detection for every host. Samples hold no names, logins, sessions or pay.</p>
  ${msg ? `<p class="okmsg">${esc(msg)}</p>` : ""}<div class="stat card"><div><b id="t_host">${j.host ?? 0}</b><span>samples from this host</span></div><div><b id="t_total">${j.total ?? 0}</b><span>samples in the shared pool</span></div></div>
  <button class="btn wide" id="t_del" ${j.host ? "" : "disabled"}>Delete this host's samples</button>`;
  $("#t_del").onclick = async () => { if (!confirm(`Delete all ${j.host} training samples from this host? This cannot be undone.`)) return; const r = await api("host/train/delete", {}); V.hostTrain(r.ok ? `Deleted ${r.deleted} sample(s).` : r.error); }; };
V.hostParts = async msg => { if (ME?.user.role !== "admin") { main.innerHTML = `<p class="err">Host admins only.</p>`; return; }
  main.innerHTML = `<h1>Import parts file</h1><p><a class="btn small" href="#/host">← Host</a></p>${msg ? `<p class="okmsg">${esc(msg)}</p>` : ""}
  <form class="card" id="pf"><p class="muted small">Load an inventory file (.bsx) exported from your inventory software. Part numbers, part names and the colors in the file are added to the shared parts list that the color picker on the verify card uses. Only part data is shared with other hosts; your customers, sorters and sessions are not. Up to 5 MB / 20,000 lines.</p>
  <input type="file" name="f" accept=".bsx,.xml" required><button class="btn gold wide">Read file</button></form><div id="pres"></div>`;
  $("#pf").onsubmit = async e => { e.preventDefault(); const f = e.target.f.files[0]; if (!f) return; let r;
    try { if (f.size > PTSInvFile.LIMITS.bytes) throw new Error("File is larger than 5 MB."); r = PTSInvFile.parse(await f.text()); } catch (er) { $("#pres").innerHTML = `<p class="err">${esc(er.message)}</p>`; return; }
    if (!r.parts.length) { $("#pres").innerHTML = `<p class="err">No parts found in ${esc(f.name)}.</p>`; return; }
    const nc = r.parts.reduce((a, p) => a + p.colors.length, 0);
    $("#pres").innerHTML = `<h2>${r.parts.length} parts <span class="muted small">${nc} part/color pairs · ${r.items} lines${r.skipped ? ` · ${r.skipped} skipped (not parts or unreadable)` : ""}</span></h2>
    <div class="flatlist">${r.parts.slice(0, 30).map(p => `<div class="row card"><b class="mono">${esc(p.part)}</b><span class="small grow">${esc(p.name || "")}</span><span class="muted small">${p.colors.map(c => esc(c.name || "#" + c.id)).join(", ")}</span></div>`).join("")}</div>
    ${r.parts.length > 30 ? `<p class="muted small">…and ${r.parts.length - 30} more</p>` : ""}<button class="btn gold wide big" id="pimp">Import ${r.parts.length} parts</button>`;
    $("#pimp").onclick = async () => { $("#pimp").disabled = true; const t = { added: 0, updated: 0, unchanged: 0, colors_added: 0, n_errors: 0 };
      for (let i = 0; i < r.parts.length; i += 500) { $("#pimp").textContent = `Importing… ${i}/${r.parts.length}`; const j = await api("host/parts/import", { parts: r.parts.slice(i, i + 500) });
        if (j.error) { $("#pres").insertAdjacentHTML("beforeend", `<p class="err">${esc(j.error)}</p>`); return; } for (const k in t) t[k] += j[k] || 0; }
      Object.keys(SHARED_PI).forEach(k => delete SHARED_PI[k]);
      V.hostParts(`Imported: ${t.added} new parts, ${t.updated} updated, ${t.unchanged} unchanged${t.colors_added ? `, ${t.colors_added} new colors` : ""}${t.n_errors ? `, ${t.n_errors} rows rejected` : ""}.`); }; }; };

// ---------------- router
async function loadMe() { const j = await api("me"); ME = j.error ? null : j; header(); return ME; }
function header() { $("#who").textContent = ME ? `${ME.host.site_name} · ${ME.user.username}` : ""; $("#tabs").hidden = !ME; $("#hosttab").hidden = !(ME && ME.user.role === "admin"); }
async function route() {
  const h = location.hash.slice(1) || "/", [path, qs] = h.split("?");
  if (path === "/logout") { await api("logout", {}); ME = null; header(); location.hash = "#/login"; return; }
  if (path !== "/login" && !ME && !(await loadMe())) { location.hash = "#/login"; return; }
  const tab = path.startsWith("/box") ? "box" : path.startsWith("/putaway") ? "box" : path.startsWith("/host") ? "host" : "sort";
  $$("#tabs a").forEach(a => a.classList.toggle("on", a.dataset.t === tab));
  let m; window.scrollTo(0, 0);
  if (path === "/login") return V.login();
  if (path === "/") return V.home();
  if ((m = path.match(/^\/s\/([\w-]+)$/))) return V.session(m[1]);
  if ((m = path.match(/^\/bag\/([\w-]+)$/))) return V.bag(m[1]);
  if (path === "/boxes") return V.boxes();
  if ((m = path.match(/^\/box\/(\d+)$/))) return V.box(m[1]);
  if (path === "/host") return V.host();
  if (path === "/host/settings") return V.hostSettings();
  if (path === "/host/molds") return V.hostMolds();
  if (path === "/host/train") return V.hostTrain();
  if (path === "/host/parts") return V.hostParts();
  if (path === "/host/batch") return V.hostBatch(qs || "");
  if ((m = path.match(/^\/host\/sheet\/(\d+)$/))) return V.hostSheet(m[1]);
  if (path === "/putaway") return V.putaway();
  main.innerHTML = `<p>Not found. <a href="#/">Home</a></p>`;
}
window.addEventListener("hashchange", route); route();
// phones keep the app open for hours: when it comes back to the foreground, check for a newer build and offer a reload
const BUILD = (document.querySelector('script[src*="/alpha/app.js"]')?.getAttribute("src") || "").split("v=")[1];
document.addEventListener("visibilitychange", async () => { if (document.hidden || $("#newbuild")) return;
  try { const h = await (await fetch("/alpha/", { cache: "no-store" })).text(); const v = (h.match(/\/alpha\/app\.js\?v=(\w+)/) || [])[1];
    if (v && BUILD && v !== BUILD) { const d = document.createElement("div"); d.id = "newbuild"; d.className = "toast undo"; d.innerHTML = `<span>A new version of the app is ready.</span><button type="button" class="btn small gold">Reload</button>`;
      document.body.appendChild(d); d.querySelector("button").onclick = () => location.reload(); } } catch (e) {} });
})();
