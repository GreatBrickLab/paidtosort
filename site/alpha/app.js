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
    const d = (await SHARDS[k])[q]; if (d) return { name: d[0], colors: d[1] }; } return { name: "", colors: [] }; }
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
const detectorChoice = () => localStorage.getItem("pts_detector") === "brickator" ? "brickator" : "standard";   // per phone; default Standard
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
  <div class="stat card"><div><b>${(j.stats || {}).nb ?? (j.stats || {}).n ?? "–"}</b><span>bags in repository</span></div><div><b>${(j.stats || {}).n ?? "–"}</b><span>part lots</span></div><div><b>${(j.stats || {}).pcs ?? "–"}</b><span>pieces</span></div></div>
  <p class="center"><a href="#/putaway" class="btn">Put-away</a> ${j.user.role === "admin" ? `<a href="#/host/settings" class="btn">Host settings</a>` : ""} <a href="#/logout" class="btn ghost">Sign out</a></p>`;
  $("#start").onclick = async () => { const r = await api("session/start", {}); location.hash = "#/s/" + r.id; }; };

V.session = async (sid) => { await palette(); const j = await api("session/" + sid); if (j.error) { main.innerHTML = `<p class="err">${esc(j.error)}</p>`; return; }
  const s = j.s, open = s.status === "open"; SESS_OPEN = open;
  main.innerHTML = `<div class="sess"><div><small class="muted">Session</small><h1 class="mono">${s.id}</h1></div>${pill(s.status)}</div>
  <p class="muted small">${esc(j.owner)} · started ${s.started.slice(5, 16)} UTC · ${esc(j.pay)}</p>
  ${open ? `<div class="card upload"><label class="btn gold wide big" for="cam">📷 Take photo of parts</label><input id="cam" type="file" accept="image/*" capture="environment" hidden>
   <label class="btn wide" for="pick">Upload a photo</label><input id="pick" type="file" accept="image/*" hidden>
   <p class="muted small">Lay parts flat and apart on a plain surface. Parts are found on your phone, then each crop is sent to the identification engine.</p>
   <label class="small detsel">Detector <select id="detsel"><option value="standard">Standard</option><option value="brickator">Brickator (demo)</option></select></label>
   <p class="small trainnote">ⓘ Part photos help improve detection.</p><button type="button" class="btn wide" id="missbtn" hidden>＋ Missed a part?</button>
   <div id="prog" class="prog" hidden><div class="spin"></div><span id="progt">Working…</span></div><canvas id="prev" class="prev" hidden></canvas><div id="review" class="review" hidden></div></div>` : ""}
  <h2>Verify <span class="muted small" id="pend">${j.cards.length} to check</span></h2>
  <p class="muted small">Swipe up on a card’s <b>⇡ bar</b> to confirm it (or tap ✓); scroll anywhere else. Confirmed lots go into the <b>open bag</b> (one QR label per bag) until you tap <b>Close bag</b> or <b>Start new bag</b>.</p>
  <div id="cards">${j.cards.map(c => cardHTML(c)).join("")}</div>
  <button type="button" class="btn gold wide big" id="confirmall" ${j.cards.length ? "" : "hidden"}>✓ Confirm all <span id="ca_n">${j.cards.length}</span> cards into the open bag</button>
  <h2>Bags <span class="muted small">${j.bags.length}</span></h2>
  <p id="bagbtns" ${j.bags.length ? "" : "hidden"}><a class="btn gold" href="#/labels?session=${s.id}">🖨 Print 2×1″ labels</a> <a class="btn" href="#/boxes">Put bags in a box</a></p>
  <div id="openbar">${open ? openBarHTML(j.bags.find(b => b.open)) : ""}</div><div id="bags" class="flatlist baglist">${[...j.bags].reverse().map((b, i, a) => bagHTML(b, { n: i + 1, open: b.open || (!a.some(x => x.open) && i === a.length - 1) })).join("")}</div><p class="muted small" id="swipehint" ${j.bags.length ? "" : "hidden"}>Tap a bag to show its parts. Swipe a part <b>left</b> to edit it or remove it from the bag.</p>
  ${open ? `<form class="card" id="endf"><h3>Finish session</h3>${ME.host.pay_mode === "lb" ? `<label>Weight sorted (lb)<input name="w" type="number" step="0.01" min="0" inputmode="decimal"></label>` : ""}<button class="btn wide">End session</button></form>` : ""}
${CS_HTML}`;
  if (open) { ["#cam", "#pick"].forEach(id => $(id).onchange = e => processPhoto(sid, e.target.files[0]));
    $("#detsel").value = detectorChoice(); $("#detsel").onchange = e => { localStorage.setItem("pts_detector", e.target.value); toast(e.target.value === "brickator" ? "Detector: Brickator (demo). Downloads ~15 MB on the next photo." : "Detector: Standard"); };
    $("#endf").onsubmit = async e => { e.preventDefault(); await api(`session/${sid}/end`, { weight_lb: e.target.w?.value || null }); await trainCheck(sid, true); route(); }; }
  wireCards(j.cards); wireBags($("#bags")); wireOpenBar();
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
      const crop = c.toDataURL("image/jpeg", 0.85); const j = await fetch("/alpha/api/identify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image: crop }) }).then(x => x.json()).catch(() => ({}));
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
const cardHTML = (c, lot) => `<div class="pcard${lot ? " lotedit" : ""}" data-id="${c.id}"${lot ? ` data-lot="${c.id}"` : ""} data-part="${esc(c.part)}" data-color="${c.color}" data-qty="${c.qty}">
 <button type="button" class="colorbtn"><i style="background:#${crgb(c.color)}"></i><span class="cn">${esc(cname(c.color))}</span><small>change ▾</small></button>
 <div class="quick">${quickIds(c).map(id => chip(id, id === c.color)).join("")}</div>
 <div class="pimg"><img src="${img(c.part, c.color)}" onerror="this.onerror=null;this.src='${c.crop || ""}'" alt=""></div>
 <div class="pinfo"><div class="pn mono">${esc(c.part)}</div><div class="nm">${esc(c.name)}</div>
 <div class="qty"><button type="button" class="qbtn minus" aria-label="less">−</button><b>${c.qty}</b><button type="button" class="qbtn plus" aria-label="more">+</button></div>${c.confidence < 0.7 ? `<div class="warn small">low confidence ${Math.round(c.confidence * 100)}%</div>` : ""}</div>
 ${c.crop ? `<div class="pcrop"><img src="${c.crop}" alt="photo of this part" draggable="false"><span>your photo</span></div>` : ""}
 <div class="mold" hidden></div>
 ${lot ? `<div class="pact"><button type="button" class="btn gold done">Done</button></div>` : `<div class="pact"><button class="btn gold ok">✓</button><button class="btn ghost drop">Drop</button></div><div class="grip" aria-label="swipe up here to confirm">⇡ swipe up here to confirm</div>`}</div>`;
const lotHTML = l => `<div class="lot" data-lot="${l.id}"><div class="lacts"><button type="button" class="lact ledit">Edit</button><button type="button" class="lact ldel">Delete</button></div>
 <div class="lfront"><img src="${img(l.part, l.color)}" class="thumb" alt="" onerror="this.style.visibility='hidden'"><span class="grow"><b>${l.qty}×</b> <span class="mono">${esc(l.part)}</span> · ${esc(l.color_name || cname(l.color))}<br><span class="small muted">${esc((l.name || "").slice(0, 44))}</span></span><span class="sw">‹</span></div></div>`;
// session list: parts sit directly under each other (no QR/code between parts); the QR lives on the bag view + label only
// explicit bag controls on the session screen: "Close bag" (closes the open bag) and "Start new bag" (closes it and opens an empty one). Photos go into the open bag.
const openBarHTML = b => `<div class="card openbar" data-code="${b ? b.code : ""}"><div class="obtxt">${b ? `<b>Open bag</b> · ${(b.lots || []).length} part${(b.lots || []).length === 1 ? "" : "s"} · ${(b.lots || []).reduce((a, l) => a + l.qty, 0)} pcs` : `<b>No open bag</b> · the next confirmed part starts one`}</div>
  <div class="row2 bagbtns2"><button type="button" class="btn closebag" ${b ? "" : "disabled"}>Close bag</button><button type="button" class="btn gold newbag">＋ Start new bag</button></div></div>`;
function wireOpenBar() { const ob = $("#openbar .openbar"); if (!ob) return; const sid = location.hash.match(/#\/s\/([\w-]+)/)?.[1];
  ob.querySelector(".closebag").onclick = async () => { const code = ob.dataset.code; if (!code) return; const j = await api(`bag/${code}/close`, {});
    if (j.ok) { replaceBag(j.bag); updateOpenBar(j.bag); toast("Bag closed. The next confirmed part starts a new bag."); } else toast(j.error || "failed"); };
  ob.querySelector(".newbag").onclick = async () => { const j = await api(`session/${sid}/newbag`, {}); if (!j.ok) return toast(j.error || "failed");
    (j.closed || []).forEach(replaceBag); $$("#bags details.bagc").forEach(d => { if (bagOpenPref(d.dataset.code) !== true) d.open = false; });
    $("#bags").insertAdjacentHTML("beforeend", bagHTML(j.bag, { n: $$("#bags .bagc").length + 1, open: true })); wireBags($("#bags"), $("#bags .bagc:last-child"));
    $("#bagbtns").hidden = false; $("#swipehint").hidden = false; updateOpenBar(j.bag); toast("New bag started. Confirmed parts go into it."); }; }
function updateOpenBar(b) { const ob = $("#openbar"); if (!ob) return; const cur = ob.querySelector(".openbar")?.dataset.code;
  if (b.open) ob.innerHTML = openBarHTML(b); else if (cur === b.code) ob.innerHTML = openBarHTML(null); wireOpenBar(); }
const bagHTML = (b, flat) => { const lots = b.lots || [], pcs = lots.reduce((a, l) => a + l.qty, 0);
  if (flat) { const st = bagOpenPref(b.code); const isOpen = st === null ? flat.open : st;
    return `<details class="bagc flat${b.open ? " active" : ""}" data-code="${b.code}"${isOpen ? " open" : ""}><summary class="bagsum"><span class="caret">▸</span><b class="bagn">Bag ${flat.n || ""}</b><span class="small muted">${lots.length} part${lots.length === 1 ? "" : "s"} · ${pcs} pcs</span>${b.open ? pill("Adding here", "open") : ""}${SESS_OPEN ? `<button type="button" class="bagcam${b.status === "labelled" ? "" : " locked"}" data-st="${esc(b.status)}" aria-label="Take a photo and add parts to this bag">📷<span>add parts</span></button>` : ""}</summary>
  <div class="lots">${lots.map(lotHTML).join("") || `<p class="muted small empty">No parts yet${b.open ? ". Take a photo and confirm parts to add them here." : "."}</p>`}</div>
  ${!b.open && b.status === "labelled" && SESS_OPEN ? `<button type="button" class="btn small reopen">↺ Reopen · add parts here</button>` : ""}</details>`; }
  return `<div class="bag bagc card" data-code="${b.code}"><div class="baghead"><img src="${qrURL(b.code)}" class="qr" alt=""><div class="grow"><b class="mono">${b.code}</b> ${b.open ? pill("open bag", "open") : ""}<br>
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
      if (bc.classList.contains("locked")) return toast(`${bagEl.querySelector(".bagn")?.textContent || "This bag"} is already ${bc.dataset.st}, so parts can't be added. Use “Start new bag”.`, 3500);
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
  const confirmCard = async (el, extra) => { if (el.classList.contains("going")) return; el.classList.add("going"); const j = await api("card/" + el.dataset.id, Object.assign({ action: "confirm", qty: +el.dataset.qty || 1 }, extra || {}));
    if (j.ok) { const ex = document.querySelector(`.bagc[data-code="${j.code}"]`); if (ex) replaceBag(j.bag); else { $$("#bags details.bagc").forEach(d => { if (bagOpenPref(d.dataset.code) !== true) d.open = false; }); $("#bags").insertAdjacentHTML("beforeend", bagHTML(j.bag, { n: $$("#bags .bagc").length + 1, open: true })); wireBags($("#bags"), $("#bags .bagc:last-child")); updateOpenBar(j.bag); }
      $("#bagbtns").hidden = false; $("#swipehint").hidden = false; setTimeout(() => el.remove(), 260); left(); if (TRAIN_SID) trainSoon(TRAIN_SID); } else { el.classList.remove("going"); toast(j.error || "failed"); } };
  // "Confirm all": every remaining card, with its current color / qty / part, goes into the open bag (in list order)
  const ca = $("#confirmall"); if (ca && !els.some(e => e.classList.contains("lotedit"))) ca.onclick = async () => { ca.disabled = true;
    await new Promise(r => setTimeout(r, 450)); await Q;   // let pending qty saves land first
    const todo = $$(".pcard:not(.lotedit):not(.going):not(.dropping)"); for (const el of todo) await confirmCard(el);
    ca.disabled = false; left(); toast(`Confirmed ${todo.length} card${todo.length === 1 ? "" : "s"} into the open bag`); };
  els.forEach(el => {
    const isLot = el.classList.contains("lotedit");
    if (!isLot) el.querySelector(".ok").onclick = () => confirmCard(el);
    if (!isLot) el.querySelector(".drop").onclick = async () => { if (!confirm("Drop this lot?")) return; el.classList.add("dropping"); await api("card/" + el.dataset.id, { action: "drop" }); setTimeout(() => el.remove(), 260); left(); if (TRAIN_SID) trainSoon(TRAIN_SID); };
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
    el.querySelector(".pimg img").src = img(j.part, j.color);
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
      el.querySelector(".pn").textContent = j.part; el.querySelector(".nm").textContent = j.name; el.querySelector(".pimg img").src = img(j.part, j.color);
      toast(`Switched to ${j.part} (color and qty kept)`); renderMold(el); }); }
}

// ---- tap-to-zoom on a card's photo: full-screen original photo centred on the part's detection box (box outlined); drag to pan, pinch / wheel to zoom
const ZM = (() => { let dbp = null; const idb = () => dbp || (dbp = new Promise((res, rej) => { const r = indexedDB.open("pts-zoom", 1);
    r.onupgradeneeded = () => { r.result.createObjectStore("photos", { keyPath: "id" }); r.result.createObjectStore("cards", { keyPath: "card" }); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
  const tx = async (st, mode, fn) => { const d = await idb(); return new Promise((res, rej) => { const t = d.transaction(st, mode), q = fn(t.objectStore(st)); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }); };
  const prune = async () => { const old = Date.now() - 14 * 864e5; const ps = await tx("photos", "readonly", s => s.getAll()); for (const p of ps) if (p.t < old) await tx("photos", "readwrite", s => s.delete(p.id)); };
  setTimeout(() => prune().catch(() => {}), 4000);
  return { addPhoto: async (blob, w, h) => { const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8); await tx("photos", "readwrite", s => s.put({ id, t: Date.now(), blob, w, h })); return id; },
    mapCard: async (card, pid, box, scale) => { const ex = await tx("cards", "readonly", s => s.get(card)); if (!ex) await tx("cards", "readwrite", s => s.put({ card, pid, box, scale })); },
    get: async card => { const m = await tx("cards", "readonly", s => s.get(card)); if (!m) return null; const p = await tx("photos", "readonly", s => s.get(m.pid)); return p ? { ...m, photo: p } : null; } }; })();
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
let cvReady = null;
function loadCV() { if (!cvReady) cvReady = new Promise((res, rej) => { const s = document.createElement("script"); s.src = "/alpha/vendor/opencv.js"; s.async = true;
  s.onload = () => { const done = () => res(); if (window.cv && cv.Mat) done(); else if (window.cv instanceof Promise) cv.then(m => { window.cv = m; done(); }); else cv.onRuntimeInitialized = done; }; s.onerror = rej; document.head.appendChild(s); }); return cvReady; }
async function processPhoto(sid, file) {
  if (!file) return; const prog = $("#prog"), pt = $("#progt"); prog.hidden = false;
  try {
    const det = detectorChoice(), demo = det === "brickator";
    // DEMO ONLY: Brickator runs in onnxruntime-web and is only downloaded when switched on; the standard finder still provides the colour helpers
    pt.textContent = demo ? "Loading Brickator (demo) part finder (first time ~15 MB download)…" : "Loading part finder (first time ~10 MB)…";
    const tl = performance.now(); await Promise.all([demo ? PTSBrickator.load() : loadCV(), palette()]); const loadMs = Math.round(performance.now() - tl);
    pt.textContent = "Finding parts…";
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const sc = Math.min(1, 3200 / Math.max(bmp.width, bmp.height)); const cvs = document.createElement("canvas"); cvs.width = Math.round(bmp.width * sc); cvs.height = Math.round(bmp.height * sc);
    cvs.getContext("2d").drawImage(bmp, 0, 0, cvs.width, cvs.height);
    await new Promise(r => setTimeout(r, 30));
    const td = performance.now(); const parts = demo ? await PTSBrickator.detect(cvs) : PTSDetect.detect(cvs);
    window.PTS_LAST_DETECT = { detector: demo ? PTSBrickator.VER : "cv-blob-1", load_ms: loadMs, detect_ms: Math.round(performance.now() - td), boxes: parts.length, ...(demo ? { infer_ms: PTSBrickator.stats.infer_ms, paper: PTSBrickator.stats.paper } : {}) };
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
  toast("Resumed your photo review"); finishPhoto(sid, cvs, r.parts, r.missed || [], true, r.det || "cv-blob-1"); return true; }
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
    const res = new Array(jobs.length); let k = 0;
    await Promise.all(Array.from({ length: 4 }, async () => { while (k < jobs.length) { const i = k++; let r = await fetch("/alpha/api/identify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image: jobs[i] }) }).then(r => r.json()).catch(() => ({}));
      res[i] = r.items || []; if (i < parts.length || i >= mj) pt.textContent = `Identifying ${total} parts… ${++n}/${total}`; } }));
    let keep = parts.map((_, i) => i), preds = res.slice(0, parts.length);
    for (const [gid, j] of Object.entries(gj)) { const mem = parts.map((p, i) => p.group == gid ? i : -1).filter(i => i >= 0), whole = res[j];
      const ids = new Set(mem.map(i => preds[i][0]?.id)), best = Math.max(...mem.map(i => preds[i][0]?.score || 0));
      if (whole.length && ids.size > 1 && whole[0].score >= best - 0.02) { const f = mem[0]; parts[f] = { ...parts[f], ...parts[f].merged }; preds[f] = whole; keep = keep.filter(i => !mem.slice(1).includes(i)); } }
    const lines = [], idx = {}, tboxes = [], mboxes = [];
    // detected parts and missed boxes share one path: identification -> color estimate from the part's pixels -> merge duplicates
    const add = async (items0, lab, crop, onLine) => { const items = []; for (const it of items0) if (!(await isUndetermined(it.id))) items.push(it);
      if (!items.length) return onLine(null, null); const top = items[0];
      const ranked = PTSDetect.estimateColor(lab, top.id, (await partInfo(top.id)).colors, PAL), col = ranked[0]; const key = top.id + "|" + col.id;
      const pred = { part: top.id, color: col.id, score: Math.round(top.score * 1000) / 1000 };
      if (idx[key]) { idx[key].qty++; idx[key].confidence = Math.min(idx[key].confidence, top.score); return onLine(lines.indexOf(idx[key]), pred); }
      lines.push(idx[key] = { part: top.id, name: top.name, color: col.id, qty: 1, confidence: Math.round(top.score * 1000) / 1000, alts: items.slice(0, 4).map(a => ({ id: a.id, name: a.name, score: Math.round(a.score * 1000) / 1000 })), crop: await shrink(crop, 220), color_guesses: ranked.slice(0, 5).map(c => c.id) });
      onLine(lines.length - 1, pred); };
    for (const i of keep) { const p = parts[i]; await add(preds[i], p.lab, p.crop, (line, pred) => tboxes.push({ box: p.box, line, pred })); }
    for (let m = 0; m < missed.length; m++) await add(res[mj + m], PTSDetect.cropLab(mcrops[m]), jobs[mj + m], line => mboxes.push({ box: missed[m], line }));
    const unk = tboxes.filter(b => b.line === null).length + mboxes.filter(b => b.line === null).length;
    pt.textContent = "Saving cards…"; const sv = await api(`session/${sid}/cards`, { cards: lines });
    if (sv.ok) await RV.del(sid).catch(() => {});
  // cards exist now: a later reload must not make them (or the training sample) again
    const cid = line => line === null ? null : (sv.ids || [])[line] ?? null;
    // tap-to-zoom: keep the source photo + each card's detection box on the phone (works after reload / resume)
    try { const pid = await ZM.addPhoto(await new Promise(r => cvs.toBlob(r, "image/jpeg", 0.9)), cvs.width, cvs.height);
      for (const b of [...tboxes, ...mboxes]) { const id = cid(b.line); if (id) await ZM.mapCard(id, pid, b.box, 1); } } catch (e) { console.warn("zoom store", e); }     // training sample: kept on the phone until these cards are resolved, then uploaded in the background; review boxes are labelled 'missed'
    try { const tid = await PTSTrain.begin(sid, cvs, tboxes.map(b => ({ box: b.box.map(v => Math.round(v)), card_id: cid(b.line), pred: b.pred })), det);
      for (const b of mboxes) await PTSTrain.addMissed(tid, b.box.map(v => Math.round(v)), cid(b.line)); } catch (e) { console.warn("training sample", e); }
    toast(`${total} parts${missed.length ? ` (${missed.length} added by you)` : ""} → ${lines.length} lots${unk ? ` (${unk} not recognised)` : ""}`, 3500); route();
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
function shrink(dataURL, max) { return new Promise(res => { const im = new Image(); im.onload = () => { const s = Math.min(1, max / Math.max(im.width, im.height)), c = document.createElement("canvas"); c.width = im.width * s; c.height = im.height * s; c.getContext("2d").drawImage(im, 0, 0, c.width, c.height); res(c.toDataURL("image/jpeg", 0.8)); }; im.src = dataURL; }); }

V.labels = async (qs) => { await palette(); const j = await api("labels?" + qs);
  main.innerHTML = `<div class="noprint card center"><b>${j.bags.length} bag label(s)${j.box ? " + 1 box label" : ""}</b> · 2×1″ thermal<br><button class="btn gold" onclick="print()">🖨 Print</button> <button class="btn ghost" onclick="history.back()">Back</button></div>
  ${j.bags.map(b => { const ls = b.lots || [], shown = ls.slice(0, ls.length > 4 ? 3 : 4);
    return `<div class="lbl" data-code="${b.code}"><img class="q" src="${qrURL(b.code)}" alt=""><div class="t"><span class="c">${b.code}</span><ul class="lc">${shown.map(l => `<li>${l.qty}× <b>${esc(l.part)}</b> ${esc(l.color_name)}</li>`).join("")}${ls.length > shown.length ? `<li>+${ls.length - shown.length} more</li>` : ""}</ul>
    <span class="meta">${ls.length} part${ls.length === 1 ? "" : "s"} · ${ls.reduce((a, l) => a + l.qty, 0)} pcs · ${b.session_id || ""}</span></div></div>`; }).join("")}
  ${j.box ? `<div class="lbl box">${barSVG(j.box.barcode)}<div class="t">BOX ${j.box.barcode} · shelf ${esc(j.box.shelf || "—")}</div></div>` : ""}`; };

V.boxes = async () => { const j = await api("boxes");
  main.innerHTML = `<h1>Boxes</h1><form class="card" id="nb"><h3>New box</h3><label>Shelf address<input name="shelf" placeholder="e.g. A-01-2" autocapitalize="characters"></label><button class="btn gold wide">Create box + batch barcode</button></form>
  ${j.boxes.map(x => `<a class="row card" href="#/box/${x.id}"><span style="max-width:130px">${barSVG(x.barcode).replace("<svg", '<svg class="bc"')}</span><span><b class="mono">${x.barcode}</b><br><span class="muted small">${x.nb} bags · ${x.pcs} pcs</span></span>${pill(x.shelf || "no shelf", "")}</a>`).join("") || `<p class="muted">No boxes yet.</p>`}`;
  $("#nb").onsubmit = async e => { e.preventDefault(); const r = await api("boxes", { shelf: e.target.shelf.value }); location.hash = "#/box/" + r.id; }; };

V.box = async (id, j) => { await palette(); j = j || await api("box/" + id); const b = j.box;
  main.innerHTML = `<h1 class="mono">Box ${b.barcode}</h1>${j.msg ? `<p class="okmsg">${esc(j.msg)}</p>` : ""}
  <div class="card center">${barSVG(b.barcode).replace("<svg", '<svg class="bcbig"')}<br><a class="btn small" href="#/labels?box=${b.id}&codes=${j.bags.map(x => x.code).join(",")}">🖨 Box + bag labels</a></div>
  <form class="card" id="sf"><label>Shelf address<input name="shelf" value="${esc(b.shelf || "")}" autocapitalize="characters"></label><button class="btn wide">Save shelf</button></form>
  <form class="card" id="af"><h3>Add bags</h3><label>Scan or type bag QR codes<input name="codes" id="scanin" placeholder="PTS-…" autocapitalize="characters"></label>
  ${j.loose.length ? `<p class="muted small">Or tick loose bags:</p>` + j.loose.map(x => `<label class="tick"><input type="checkbox" name="bag" value="${x.code}"><img src="${img(x.part, x.color)}" alt=""><span>${contents(x)} <span class="mono small muted">${x.code}</span></span></label>`).join("") : ""}
  <button class="btn gold wide">Add to box</button></form>
  <h2>In this box <span class="muted small">${j.bags.length}</span></h2>${j.bags.map(x => `<div class="bag card"><img src="${img(x.part, x.color)}" class="thumb" alt=""><div class="grow"><a href="#/bag/${x.code}">${contents(x)}</a><br><span class="mono small muted">${x.code} · ${x.status}</span></div><button class="btn ghost small rm" data-c="${x.code}">✕</button></div>`).join("")}`;
  $("#sf").onsubmit = async e => { e.preventDefault(); V.box(id, await api("box/" + id, { action: "shelf", shelf: e.target.shelf.value })); };
  $("#af").onsubmit = async e => { e.preventDefault(); const codes = e.target.codes.value.split(/[\s,]+/).filter(Boolean).concat($$("#af input[name=bag]:checked").map(x => x.value)); V.box(id, await api("box/" + id, { action: "add", codes })); };
  $$(".rm").forEach(x => x.onclick = async () => V.box(id, await api("box/" + id, { action: "remove", code: x.dataset.c }))); };

V.repo = async (qs) => { await palette(); const p = new URLSearchParams(qs); const j = await api("repo?" + p.toString()); const tot = j.rows.reduce((a, b) => a + b.qty, 0);
  main.innerHTML = `<h1>Repository</h1><form class="card search" id="rf"><input name="q" value="${esc(p.get("q") || "")}" placeholder="Part number, name or bag QR" autocapitalize="none">
  <select name="color"><option value="">any color</option>${[...PAL].sort((a, b) => a.name.localeCompare(b.name)).map(c => `<option value="${c.id}" ${p.get("color") == c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
  <select name="status"><option value="">any status</option>${["labelled", "bagged", "promoted", "picked"].map(s => `<option ${p.get("status") === s ? "selected" : ""}>${s}</option>`).join("")}</select><button class="btn gold">Search</button></form>
  <p class="muted small">${j.rows.length} bag(s) · ${j.rows.reduce((a, b) => a + (b.lots || []).length, 0)} part lot(s) · ${tot} pcs</p>
  ${j.rows.map(b => `<a class="bag card rrow" href="#/bag/${b.code}"><img src="${img(b.part, b.color)}" class="thumb" alt=""><div class="grow">${(b.lots || []).map(l => `<div><b class="mono">${esc(l.part)}</b> · ${esc(l.color_name)} <span class="muted">× ${l.qty}</span></div>`).join("")}<span class="mono small muted">${b.code}</span></div>
   <div class="loc"><b>${esc(b.location || "—")}</b><br><span class="small muted">${b.box_code || "loose"}</span><br>${pill(b.status)}</div></a>`).join("") || `<p class="muted">Nothing found.</p>`}`;
  $("#rf").onsubmit = e => { e.preventDefault(); location.hash = "#/repo?" + new URLSearchParams(new FormData(e.target)).toString(); }; };

function parseInventory(txt, name) { const out = [];
  if (txt.includes("<Item>") || /\.(bsx|xml)$/i.test(name)) { for (const m of txt.matchAll(/<Item>([\s\S]*?)<\/Item>/g)) { const t = k => (m[1].match(new RegExp(`<${k}>([\\s\\S]*?)</${k}>`)) || [])[1];
      if ((t("ItemTypeID") || "P") !== "P") continue; out.push([String(t("ItemID")).trim(), +(t("ColorID") || 0), +(t("Qty") || 0)]); } return out; }
  const rows = txt.replace(/^\uFEFF/, "").split(/\r?\n/).filter(l => l.trim()).map(l => l.split(",").map(x => x.trim().replace(/^"|"$/g, "")));
  const h = rows.shift().map(x => x.toLowerCase()); const pi = h.findIndex(x => ["part", "itemid", "item_id", "part_num", "item no"].includes(x)), ci = h.findIndex(x => ["color", "colorid", "color_id", "colour", "color name"].includes(x)), qi = h.findIndex(x => ["qty", "quantity", "count"].includes(x));
  if (pi < 0) throw new Error("CSV needs a 'part' column (plus 'color' and 'qty')");
  const byName = n => { const s = n.toLowerCase().replace(/[^a-z]/g, ""); const al = { lbg: "lightbluishgray", dbg: "darkbluishgray" }; const t = al[s] || s; return (PAL.find(c => c.name.toLowerCase().replace(/[^a-z]/g, "") === t) || {}).id ?? 0; };
  for (const r of rows) { if (!r[pi]) continue; const cv0 = ci >= 0 ? r[ci] : "0"; out.push([r[pi], /^\d+$/.test(cv0) ? +cv0 : byName(cv0), qi >= 0 ? +r[qi] || 0 : 1]); } return out; }

V.host = async () => { if (ME?.user.role !== "admin") { main.innerHTML = `<p class="err">Host admins only.</p>`; return; } await palette();
  main.innerHTML = `<h1>Host · ${esc(ME.host.site_name)}</h1><p><a class="btn small" href="#/host/settings">Settings &amp; sorters</a> <a class="btn small" href="#/repo">Search repository</a> <a class="btn small" href="#/host/molds">Mold-variant exceptions</a> <a class="btn small" href="#/host/train">Training data</a></p>
  <form class="card" id="cf"><h3>Compare with your store</h3><p class="muted small">Upload your store inventory file (the XML file your store software exports, or a CSV with part, color, qty). We list repository lots your store is missing or low on (under ${ME.host.low_threshold}).</p>
  <input type="file" name="inv" accept=".bsx,.xml,.csv,text/csv" required><button class="btn gold wide">Compare</button></form><div id="cres"></div>`;
  $("#cf").onsubmit = async e => { e.preventDefault(); const f = e.target.inv.files[0]; let items; try { items = parseInventory(await f.text(), f.name); } catch (er) { $("#cres").innerHTML = `<p class="err">${esc(er.message)}</p>`; return; }
    const j = await api("host/compare", { items });
    $("#cres").innerHTML = `<h2>Gaps <span class="muted small">${j.res.length} lots · ${esc(f.name)} (${j.n_inv} lines)</span></h2><p><label class="small"><input type="checkbox" id="all" style="display:inline;width:auto"> select all</label></p>
    ${j.res.map(r => `<label class="bag card tick2"><input type="checkbox" class="pb" value="${r.code}" data-lot="${r.lot_id}" ${r.status === "promoted" ? "disabled" : ""}><img src="${img(r.part, r.color)}" class="thumb" alt=""><div class="grow"><b class="mono">${esc(r.part)}</b> · ${esc(r.color_name)}<br><span class="small">repo × ${r.qty} · store has ${r.store_qty}</span><br><span class="small muted">${esc(r.location || "no shelf")} · ${r.code}</span></div>${pill(r.status === "promoted" ? "promoted" : r.tag)}</label>`).join("") || `<p class="muted">Your store already has everything in the repository.</p>`}
    ${j.res.length ? `<button class="btn gold wide big" id="prom">★ Promote selected + export store inventory file</button>` : ""}`;
    $("#all") && ($("#all").onclick = ev => $$(".pb:not([disabled])").forEach(x => x.checked = ev.target.checked));
    $("#prom") && ($("#prom").onclick = async () => { const codes = [...new Set($$(".pb:checked").map(x => x.value))]; if (!codes.length) return toast("Tick some lots first");
      const r = await api("host/promote", { codes, lots: $$(".pb:checked").map(x => +x.dataset.lot) }); const blob = new Blob([r.bsx], { type: "application/xml" }); window.PTS_LAST_EXPORT = r.bsx;
      sessionStorage.setItem("pts_export", URL.createObjectURL(blob)); location.hash = "#/pick?exported=" + r.n; }); }; };

V.hostSettings = async (j, msg) => { j = j || await api("host"); if (j.error) { main.innerHTML = `<p class="err">${esc(j.error)}</p>`; return; } const h = j.host;
  main.innerHTML = `<h1>Host settings</h1>${msg ? `<p class="okmsg">${esc(msg)}</p>` : ""}<form class="card" id="hs"><label>Host site name<input name="site_name" value="${esc(h.site_name)}"></label>
  <label>Pay sorters<select name="pay_mode"><option value="lb" ${h.pay_mode === "lb" ? "selected" : ""}>per lb sorted</option><option value="hr" ${h.pay_mode === "hr" ? "selected" : ""}>per hour</option></select></label>
  <div class="row2"><label>$ per lb<input name="rate_lb" type="number" step="0.01" value="${h.rate_lb}"></label><label>$ per hour<input name="rate_hr" type="number" step="0.01" value="${h.rate_hr}"></label></div>
  <label>"Low stock" below<input name="low_threshold" type="number" min="1" value="${h.low_threshold}"></label><button class="btn gold wide">Save</button></form>
  <h2>People</h2>${j.users.map(u => `<div class="row card"><b>${esc(u.username)}</b><span class="muted small">${esc(u.display)} · ${u.ns} sessions</span>${pill(u.role, "")}</div>`).join("")}
  <form class="card" id="as"><h3>Add a sorter</h3><label>Username<input name="username" autocapitalize="none" required></label><label>Name<input name="display"></label><label>Password<input name="password" type="password" minlength="8" required></label><button class="btn wide">Add sorter</button></form>
  <h2>Sessions &amp; pay</h2>${j.sessions.map(s => `<a class="row card" href="#/s/${s.id}"><b class="mono">${s.id}</b><span class="small">${esc(s.username)} · ${esc(s.pay)}</span>${pill(s.status)}</a>`).join("")}`;
  const fo = f => Object.fromEntries(new FormData(f));
  $("#hs").onsubmit = async e => { e.preventDefault(); const r = await api("host/settings", fo(e.target)); await loadMe(); V.hostSettings(null, r.msg || r.error); };
  $("#as").onsubmit = async e => { e.preventDefault(); const r = await api("host/sorter", fo(e.target)); V.hostSettings(null, r.msg || r.error); }; };

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

V.pick = async (qs) => { const p = new URLSearchParams(qs); const j = await api("pick"); const todo = j.rows.filter(r => r.status === "promoted").length; const ex = sessionStorage.getItem("pts_export");
  main.innerHTML = `<h1>Pick sheet</h1>${p.get("exported") && ex ? `<p class="okmsg">Promoted ${esc(p.get("exported"))} lot(s). <a href="${ex}" download="promoted-lots.bsx" id="dl">⬇ Download store inventory file for these lots</a></p>` : ""}
  <p class="muted small"><span id="left">${todo}</span> to pull · sorted by shelf address · scan the bag QR or tap ✓</p>
  <div class="card scan"><input id="scan" placeholder="Scan / type bag QR" autocapitalize="characters" autocomplete="off"><button class="btn gold" id="go">✓</button><button class="btn" id="camscan" hidden>📷</button></div>
  <video id="vid" playsinline hidden></video><p id="msg" class="small"></p>
  <div id="picklist">${j.rows.map(b => `<div class="prow card ${b.status === "picked" ? "done" : ""}" data-code="${b.code}"><div class="shelf">${esc(b.location || "—")}</div><img src="${img(b.part, b.color)}" class="thumb" alt="">
   <div class="grow">${(b.lots || []).map(l => `<b>${l.qty}× ${esc(l.part)}</b> <span class="small">${esc(l.color_name)}</span><br>`).join("")}<span class="mono small muted">${b.code}${b.box_code ? " · " + b.box_code : ""}</span></div><button class="btn gold tap">✓</button></div>`).join("") || `<p class="muted">Nothing to pick. Promote lots from Host.</p>`}</div>
  <p class="center"><a href="#/putaway" class="btn">Put-away mode</a></p>`;
  const pickIt = async code => { code = code.trim().toUpperCase(); if (!code) return; const r = await api("pick/" + encodeURIComponent(code), {}); const m = $("#msg");
    if (r.ok) { document.querySelector(`.prow[data-code="${code}"]`)?.classList.add("done"); m.textContent = "✓ " + code + " picked: " + (r.bag?.lots || []).map(l => `${l.qty}× ${l.part} ${l.color_name}`).join(", "); m.className = "okmsg small"; $("#left").textContent = $$(".prow:not(.done)").length; }
    else { m.textContent = "✗ " + r.error; m.className = "err small"; } };
  $$(".tap").forEach(b => b.onclick = () => pickIt(b.closest(".prow").dataset.code));
  const s = $("#scan"); $("#go").onclick = () => { pickIt(s.value); s.value = ""; }; s.onkeydown = e => { if (e.key === "Enter") { pickIt(s.value); s.value = ""; } };
  attachScan($("#camscan"), $("#vid"), pickIt); };

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
  <p><a class="btn small" href="#/labels?codes=${b.code}">🖨 Print label</a> ${b.session_id ? `<a class="btn small" href="#/s/${b.session_id}">Session</a>` : ""}</p>${CS_HTML}`; wireBags($("#bags")); };
V.hostTrain = async msg => { if (ME?.user.role !== "admin") { main.innerHTML = `<p class="err">Host admins only.</p>`; return; } const j = await api("host/train");
  main.innerHTML = `<h1>Training data</h1><p class="muted small">Part photos from sorting (with what sorters confirmed, dropped, corrected or added) go into one shared pool that improves part detection for every host. Samples hold no names, logins, sessions or pay.</p>
  ${msg ? `<p class="okmsg">${esc(msg)}</p>` : ""}<div class="stat card"><div><b id="t_host">${j.host ?? 0}</b><span>samples from this host</span></div><div><b id="t_total">${j.total ?? 0}</b><span>samples in the shared pool</span></div></div>
  <button class="btn wide" id="t_del" ${j.host ? "" : "disabled"}>Delete this host's samples</button>`;
  $("#t_del").onclick = async () => { if (!confirm(`Delete all ${j.host} training samples from this host? This cannot be undone.`)) return; const r = await api("host/train/delete", {}); V.hostTrain(r.ok ? `Deleted ${r.deleted} sample(s).` : r.error); }; };
// ---------------- router
async function loadMe() { const j = await api("me"); ME = j.error ? null : j; header(); return ME; }
function header() { $("#who").textContent = ME ? `${ME.host.site_name} · ${ME.user.username}` : ""; $("#tabs").hidden = !ME; $("#hosttab").hidden = !(ME && ME.user.role === "admin"); }
async function route() {
  const h = location.hash.slice(1) || "/", [path, qs] = h.split("?");
  if (path === "/logout") { await api("logout", {}); ME = null; header(); location.hash = "#/login"; return; }
  if (path !== "/login" && !ME && !(await loadMe())) { location.hash = "#/login"; return; }
  const tab = path.startsWith("/box") ? "box" : path.startsWith("/repo") ? "repo" : path.startsWith("/pick") || path.startsWith("/putaway") ? "pick" : path.startsWith("/host") ? "host" : "sort";
  $$("#tabs a").forEach(a => a.classList.toggle("on", a.dataset.t === tab));
  let m; window.scrollTo(0, 0);
  if (path === "/login") return V.login();
  if (path === "/") return V.home();
  if ((m = path.match(/^\/s\/([\w-]+)$/))) return V.session(m[1]);
  if (path === "/labels") return V.labels(qs || "");
  if ((m = path.match(/^\/bag\/([\w-]+)$/))) return V.bag(m[1]);
  if (path === "/boxes") return V.boxes();
  if ((m = path.match(/^\/box\/(\d+)$/))) return V.box(m[1]);
  if (path === "/repo") return V.repo(qs || "");
  if (path === "/host") return V.host();
  if (path === "/host/settings") return V.hostSettings();
  if (path === "/host/molds") return V.hostMolds();
  if (path === "/host/train") return V.hostTrain();
  if (path === "/pick") return V.pick(qs || "");
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
