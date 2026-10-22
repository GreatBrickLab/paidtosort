// Verify cards: one card per part + color from a photo. Pinned photo panel with numbered, score-coloured boxes (tap a box -> its card, tap a card -> its box),
// score bar, other matches, mold-variant double-check, side-by-side "our match / your photo" with zoom, color chips + sheet with "Show all colors",
// confirm by tap or swipe-up on the grip bar. Confirmed cards join the session's lot list (same part + color = one lot).
const chip = (id, on) => `<button type="button" class="chip${on ? " on" : ""}" data-c="${id}" title="${esc(cname(id))}"><i style="background:#${crgb(id)}"></i><span>${esc(cname(id))}</span></button>`;
const quickIds = c => [c.color, ...(c.color_guesses || []).filter(x => x !== c.color)].filter((x, i, a) => a.indexOf(x) === i).slice(0, 4);
const altHTML = c => { const as = (c.alts || []).filter(a => a.id !== c.part).slice(0, 3);
  return as.length ? `<div class="small muted">Other matches</div><div class="chips">${as.map(a => `<button type="button" class="chip alt" data-p="${esc(a.id)}" data-n="${esc(a.name || "")}"><img src="${ref(a.id)}" alt="" onerror="this.style.visibility='hidden'"><span><b class="mono">${esc(a.id)}</b> ${esc((a.name || "").slice(0, 28))} <small class="muted">${Math.round((a.score || 0) * 100)}%</small></span></button>`).join("")}</div>` : ""; };
const scoreCls = v => v >= 0.8 ? "hi" : v >= 0.7 ? "mid" : "lo";
const scoreHTML = v => { const p = Math.round((+v || 0) * 100), k = scoreCls(v);
  return `<div class="score ${k}" title="match score"><span class="sbar"><i style="width:${p}%"></i></span>${k === "lo" ? `<span class="warn small flagl">⚠ Low match ${p}%: double-check</span>` : `<span class="small">${k === "hi" ? "Sure" : "Likely"} · match ${p}%</span>`}</div>`; };
const cardHTML = c => `<div class="pcard" data-id="${c.id}" data-part="${esc(c.part)}" data-color="${c.color}" data-qty="${c.qty}">
 <button type="button" class="colorbtn"><i style="background:#${crgb(c.color)}"></i><span class="cn">${esc(cname(c.color))}</span><small>change ▾</small></button>
 <div class="quick">${quickIds(c).map(id => chip(id, id === c.color)).join("")}</div>
 <div class="pimg"><img src="${ref(c.part)}" alt="" onerror="this.onerror=null;${c.crop ? `this.src='${c.crop}'` : "this.style.visibility='hidden'"}"><button type="button" class="pno ${scoreCls(c.confidence)}" hidden aria-label="show this part on the photo"></button></div>
 <div class="pinfo"><div class="pn mono">${esc(c.part)}</div><div class="nm">${esc(c.name)}</div>
 <div class="qty"><button type="button" class="qbtn minus" aria-label="one less">−</button><b>${c.qty}</b><button type="button" class="qbtn plus" aria-label="one more">+</button></div>${scoreHTML(c.confidence)}</div>
 <div class="altbox">${altHTML(c)}</div>
 <div class="pcmp"><div class="ptile"><img class="mimg" src="${ref(c.part)}" alt="matched part" draggable="false" onerror="this.style.visibility='hidden'"><span>our match</span></div>${c.crop ? `<div class="pcrop"><img src="${c.crop}" alt="photo of this part" draggable="false"><span>your photo</span></div>` : ""}</div>
 <div class="mold" hidden></div>
 <div class="pact"><button type="button" class="btn gold ok">✓ Add to lots</button><button type="button" class="btn ghost drop">Drop</button></div><div class="grip" aria-label="swipe up here to confirm">⇡ swipe up here to confirm</div></div>`;

// ---- color sheet (shared by cards and lots): best guesses, the colors the part is made in, and every color behind "Show all colors"
const CS_HTML = `<dialog id="cs" class="sheet"><div class="card"><div class="cshead"><h3>Color for <span id="cs_part" class="mono"></span></h3><button type="button" class="btn ghost small" id="cs_x" aria-label="Close">✕</button></div>
  <input id="cs_q" aria-label="Search colors" type="search" enterkeyhint="done" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Type to search colors" autocomplete="off">
  <div id="cs_body"></div><label class="small tick"><input type="checkbox" id="cs_all"> Show all colors</label></div></dialog>`;
const CS = (() => { let cur = null, known = [], y = 0; const vv = window.visualViewport;
  const render = () => { const q = $("#cs_q").value.trim().toLowerCase(), all = $("#cs_all").checked || !known.length, match = id => !q || cname(id).toLowerCase().includes(q) || String(id) === q, byName = (a, b) => cname(a).localeCompare(cname(b));
    const sug = [cur.color, ...(cur.guesses || [])].filter((x, i, a) => a.indexOf(x) === i && match(x)), kn = known.filter(x => !sug.includes(x) && match(x)).sort(byName);
    const rest = all ? PAL.map(p => p.id).filter(x => !sug.includes(x) && !kn.includes(x) && match(x)).sort(byName) : [];
    $("#cs_body").innerHTML = (sug.length ? `<p class="small muted">Best guesses from the photo</p><div class="chips">${sug.map(x => chip(x, x === cur.color)).join("")}</div>` : "") +
      (known.length ? `<p class="small muted">Made in ${known.length} colors</p><div class="chips">${kn.map(x => chip(x, x === cur.color)).join("") || '<span class="small muted">no match</span>'}</div>` : `<p class="small warn">No known-color data for this part. Showing all colors.</p>`) +
      (rest.length ? `<p class="small muted">All other colors</p><div class="chips">${rest.map(x => chip(x, x === cur.color)).join("")}</div>` : "");
    $$("#cs_body .chip").forEach(b => b.onclick = () => { $("#cs").close(); cur.pick(+b.dataset.c); }); };
  const place = () => { const d = $("#cs"); if (!d?.open) return; const h = vv ? vv.height : innerHeight, top = vv ? vv.offsetTop : 0; Object.assign(d.style, { position: "fixed", margin: "0 auto", left: "0", right: "0", top: "auto", bottom: Math.max(0, innerHeight - h - top) + "px" }); d.querySelector(".card").style.maxHeight = Math.round(h * 0.82) + "px"; };
  if (vv) { vv.addEventListener("resize", place); vv.addEventListener("scroll", place); }
  const lock = () => { y = scrollY; Object.assign(document.body.style, { position: "fixed", top: -y + "px", left: "0", right: "0", width: "100%" }); };
  const unlock = () => { Object.assign(document.body.style, { position: "", top: "", left: "", right: "", width: "" }); scrollTo(0, y); };
  function wire() { $("#cs").onclose = unlock; $("#cs_x").onclick = () => $("#cs").close(); $("#cs_all").onchange = render; $("#cs_q").onkeydown = e => { if (e.key === "Enter") e.preventDefault(); };
    let raf = 0; $("#cs_q").oninput = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { const f = document.activeElement === $("#cs_q"); render(); if (f) $("#cs_q").focus({ preventScroll: true }); }); }; }
  return { wire, open: async o => { cur = o; $("#cs_part").textContent = o.part; $("#cs_q").value = ""; $("#cs_all").checked = false; known = (await partInfo(o.part)).colors || []; render(); lock(); $("#cs").showModal(); place(); } }; })();

function wireCards(cards, onConfirmed) {
  const byId = Object.fromEntries(cards.map(c => [c.id, c])), els = $$(".pcard");
  const left = () => { const n = $$(".pcard:not(.going):not(.dropping)").length; $("#pend").textContent = n ? `${n} to check` : "all checked"; $("#confirmall").hidden = !n; $("#ca_n").textContent = n; $("#verhint").hidden = !n; if (!n) $("#checksec")?.classList.add("empty"); };
  let bulk = false;
  const confirmCard = async el => { if (el.classList.contains("going")) return; el.classList.add("going"); const j = await api("lot/" + el.dataset.id, { action: "confirm", qty: +el.dataset.qty || 1 });
    if (!j.ok) { el.classList.remove("going"); return toast(j.error || "Could not add the lot"); } PH.done(+el.dataset.id, !bulk); setTimeout(() => el.remove(), 260); left(); if (!bulk) onConfirmed(); };
  const ca = $("#confirmall"); ca.onclick = async () => { ca.disabled = true; await new Promise(r => setTimeout(r, 400)); await Q; const todo = $$(".pcard:not(.going):not(.dropping)"); bulk = true; for (const el of todo) await confirmCard(el); bulk = false; ca.disabled = false; left(); onConfirmed(); toast(`Added ${todo.length} card${todo.length === 1 ? "" : "s"} to the lot list`); };
  const setCard = (el, j) => { el.dataset.part = j.part; el.dataset.color = j.color; const c = byId[el.dataset.id]; Object.assign(c, { part: j.part, name: j.name, color: j.color });
    el.querySelector(".pn").textContent = j.part; el.querySelector(".nm").textContent = j.name; el.querySelector(".colorbtn i").style.background = "#" + crgb(j.color); el.querySelector(".colorbtn .cn").textContent = cname(j.color);
    el.querySelectorAll(".mimg, .pimg img").forEach(i => { i.style.visibility = ""; i.src = ref(j.part); }); el.querySelector(".quick").innerHTML = quickIds(c).map(x => chip(x, x === c.color)).join(""); wireQuick(el); };
  const edit = async (el, patch, msg) => { const j = await api("lot/" + el.dataset.id, { action: "edit", ...patch }); if (!j.ok) return toast(j.error || "Could not save"); setCard(el, j); if (msg) toast(msg(j)); return j; };
  const setColor = (el, id) => edit(el, { color: id });
  const wireQuick = el => el.querySelectorAll(".quick .chip").forEach(b => b.onclick = () => setColor(el, +b.dataset.c));
  const setPart = async (el, part, name) => { const j = await edit(el, { part, name: name || (await partInfo(part)).name || "" }, j => `Set to ${j.part} (color and qty kept)`); if (j) { el.querySelector(".altbox").innerHTML = altHTML(byId[el.dataset.id]); wireAlts(el); renderMold(el); } };
  const wireAlts = el => el.querySelectorAll(".chip.alt").forEach(b => b.onclick = () => setPart(el, b.dataset.p, b.dataset.n));
  async function renderMold(el) { const box = el.querySelector(".mold"), vs = ((await moldMap())[el.dataset.part]?.v || []).filter(v => !/undetermined/i.test(v[1])), name = el.querySelector(".nm").textContent;
    if (!vs.length) { box.hidden = true; box.innerHTML = ""; return; }
    box.innerHTML = `<b>⚠ Double-check: this part has a mold variant</b><div class="small">This one: <b class="mono">${esc(el.dataset.part)}</b> ${esc(name)}</div><div class="chips">${vs.map(v => `<button type="button" class="chip mv" data-p="${esc(v[0])}" data-n="${esc(v[1])}"><img src="${ref(v[0])}" alt="" onerror="this.style.visibility='hidden'"><span><b class="mono">${esc(v[0])}</b> ${esc(moldDiff(name, v[1]))}</span></button>`).join("")}</div>`;
    box.hidden = false; box.querySelectorAll(".mv").forEach(b => b.onclick = () => setPart(el, b.dataset.p, b.dataset.n)); }
  els.forEach(el => {
    el.querySelector(".ok").onclick = () => confirmCard(el);
    el.querySelector(".drop").onclick = async () => { el.classList.add("dropping"); const j = await api("lot/" + el.dataset.id, { action: "delete" }); if (!j.ok) { el.classList.remove("dropping"); return toast(j.error || "failed"); } PH.done(+el.dataset.id, true); setTimeout(() => el.remove(), 260); left(); toast("Card dropped"); };
    let qt = null; const bump = d => { const q = Math.max(1, (+el.dataset.qty || 1) + d); el.dataset.qty = q; el.querySelector(".qty b").textContent = q; el.querySelector(".minus").disabled = q <= 1; clearTimeout(qt); qt = setTimeout(() => api("lot/" + el.dataset.id, { action: "edit", qty: q }), 350); };
    el.querySelector(".minus").onclick = () => bump(-1); el.querySelector(".plus").onclick = () => bump(1); el.querySelector(".minus").disabled = +el.dataset.qty <= 1;
    const grip = el.querySelector(".grip"); let y0 = null, dy = 0;   // swipe-up confirm only from the grip bar; the rest of the card scrolls the page
    grip.addEventListener("touchstart", e => { y0 = e.touches[0].clientY; dy = 0; el.style.transition = "none"; }, { passive: true });
    grip.addEventListener("touchmove", e => { if (y0 === null) return; dy = Math.min(0, e.touches[0].clientY - y0); if (dy < -8) { e.preventDefault(); el.style.transform = `translateY(${dy}px)`; el.style.opacity = 1 + dy / 300; } }, { passive: false });
    grip.addEventListener("touchend", () => { if (y0 === null) return; el.style.transition = el.style.transform = el.style.opacity = ""; if (dy < -90) confirmCard(el); y0 = null; });
    el.querySelector(".colorbtn").onclick = () => { const c = byId[el.dataset.id]; CS.open({ part: el.dataset.part, color: +el.dataset.color, guesses: c.color_guesses, pick: id => setColor(el, id) }); };
    const pc = el.querySelector(".pcrop"); if (pc) pc.onclick = e => { e.stopPropagation(); openZoom(+el.dataset.id, pc.querySelector("img").src); };
    wireQuick(el); wireAlts(el); renderMold(el); });
  left();
}

// ---- pinned photo panel: the newest photo with its boxes, numbered and coloured by score (gold sure/likely, red low, teal ✓ done)
let PH_RZ = 0;
const PH = (() => { let im = null, items = [], sel = null, view = null, small = sessionStorage.getItem("pts2_ph_small") === "1"; const el = () => $("#photo");
  async function init(cards) { const host = el(); if (!host) return; im = null; items = []; sel = null; host.hidden = true;
    const ms = []; for (const c of cards) { const m = await ZM.get(c.id).catch(() => null); if (m) ms.push({ c, m }); } if (!ms.length) return dock();
    const pid = ms.reduce((a, x) => x.m.photo.t > a.photo.t ? x.m : a, ms[0].m).pid, mine = ms.filter(x => x.m.pid === pid); im = await createImageBitmap(mine[0].m.photo.blob);
    items = mine.map((x, i) => ({ id: x.c.id, n: i + 1, k: scoreCls(x.c.confidence), boxes: x.m.boxes, done: false }));
    items.forEach(it => { const b = document.querySelector(`.pcard[data-id="${it.id}"] .pno`); if (b) { b.textContent = it.n; b.hidden = false; b.onclick = e => { e.stopPropagation(); pick(it.id, false); host.scrollIntoView?.({ block: "nearest" }); }; } });
    host.className = "card photop"; host.innerHTML = `<div class="phead small"><span><b>Your photo</b> · tap a box to jump to its card</span><button type="button" class="btn small ghost" id="ph_sz">${small ? "Bigger" : "Smaller"}</button></div><canvas id="pcv"></canvas>`; host.hidden = false;
    $("#ph_sz").onclick = () => { small = !small; sessionStorage.setItem("pts2_ph_small", small ? "1" : "0"); $("#ph_sz").textContent = small ? "Bigger" : "Smaller"; fit(); };
    const cv = $("#pcv"); cv.onclick = e => { const q = cv.getBoundingClientRect(), x = (e.clientX - q.left - view.ox) / view.s + view.x0, y = (e.clientY - q.top - view.oy) / view.s + view.y0;
      const hit = items.filter(it => !it.done && it.boxes.some(b => x >= b[0] - 8 && x <= b[2] + 8 && y >= b[1] - 8 && y <= b[3] + 8)).sort((a, b) => area(a) - area(b))[0]; pick(hit ? hit.id : null, !!hit); };
    $$(".pcard").forEach(c => c.addEventListener("click", e => { if (e.target.closest("button,input,.pcrop,.chip,a")) return; pick(+c.dataset.id, false, true); }));
    if (!PH_RZ) { PH_RZ = 1; addEventListener("resize", () => PH.fit()); } fit(); }
  const area = it => it.boxes.reduce((a, b) => a + (b[2] - b[0]) * (b[3] - b[1]), 0);
  function fit() { const host = el(), cv = $("#pcv"); if (!host || host.hidden || !cv || !im) return dock();
    const bs = items.flatMap(it => it.boxes); let [x0, y0, x1, y1] = [Math.min(...bs.map(b => b[0])), Math.min(...bs.map(b => b[1])), Math.max(...bs.map(b => b[2])), Math.max(...bs.map(b => b[3]))];
    const mg = 0.06 * Math.max(x1 - x0, y1 - y0); x0 = Math.max(0, x0 - mg); y0 = Math.max(0, y0 - mg); x1 = Math.min(im.width, x1 + mg); y1 = Math.min(im.height, y1 + mg);
    const W = host.clientWidth - 12, H = Math.round(innerHeight * (small ? 0.15 : 0.24)), s = Math.min(W / (x1 - x0), H / (y1 - y0)), dpr = devicePixelRatio || 1;
    cv.style.width = W + "px"; cv.style.height = H + "px"; cv.width = W * dpr; cv.height = H * dpr; view = { x0, y0, x1, y1, s, ox: (W - (x1 - x0) * s) / 2, oy: (H - (y1 - y0) * s) / 2, W, H, dpr }; draw(); dock(); }
  function draw() { const cv = $("#pcv"); if (!cv || !view) return; const g = cv.getContext("2d"), { x0, y0, x1, y1, s, ox, oy, W, H, dpr } = view;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.fillStyle = "#14282a"; g.fillRect(0, 0, W, H); g.drawImage(im, x0, y0, x1 - x0, y1 - y0, ox, oy, (x1 - x0) * s, (y1 - y0) * s);
    const R = b => [ox + (b[0] - x0) * s, oy + (b[1] - y0) * s, (b[2] - b[0]) * s, (b[3] - b[1]) * s];
    if (sel !== null) { g.fillStyle = "#0006"; g.fillRect(0, 0, W, H); items.find(x => x.id === sel)?.boxes.forEach(b => { const [x, y, w, h] = R(b); g.drawImage(im, b[0], b[1], b[2] - b[0], b[3] - b[1], x, y, w, h); }); }
    for (const it of [...items].sort((a, b) => (a.id === sel) - (b.id === sel))) { const on = it.id === sel, col = it.done ? "#0E4A4F" : it.k === "lo" ? "#e0245e" : "#F2B233";
      it.boxes.forEach((b, j) => { const [x, y, w, h] = R(b); g.lineWidth = on ? 4 : 2; g.strokeStyle = on ? "#fff" : col; if (it.done) g.setLineDash([5, 4]); g.strokeRect(x, y, w, h); g.setLineDash([]);
        if (on) { g.lineWidth = 2; g.strokeStyle = col; g.strokeRect(x - 3, y - 3, w + 6, h + 6); } if (j) return;
        const t = it.done ? "✓" : String(it.n), r = on ? 12 : 10; g.beginPath(); g.arc(x + 2, y + 2, r, 0, 7); g.fillStyle = it.done ? "#0E4A4F" : col; g.fill();
        g.fillStyle = it.done || it.k === "lo" ? "#fff" : "#0E4A4F"; g.font = `bold ${on ? 14 : 12}px system-ui,sans-serif`; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(t, x + 2, y + 3); }); } }
  const dock = () => document.documentElement.style.setProperty("--dockh", (($("#dock")?.offsetHeight || 0) + 56) + "px");
  function pick(id, scroll, fromCard) { if (fromCard && id === sel) id = null; sel = id; $$(".pcard.sel").forEach(c => c.classList.remove("sel"));
    const c = id !== null && document.querySelector(`.pcard[data-id="${id}"]`); if (c) { c.classList.add("sel"); if (scroll) c.scrollIntoView({ behavior: "smooth", block: "start" }); } draw(); }
  function done(id, next) { const it = items.find(x => x.id === id); if (it) it.done = true;
    if (next && (sel === id || sel === null)) { const nx = $$(".pcard:not(.going):not(.dropping)").find(c => +c.dataset.id !== id); pick(nx ? +nx.dataset.id : null, !!nx && items.some(x => x.id === +nx.dataset.id)); } else draw();
    if (!items.some(x => !x.done)) { const h = el(); if (h) h.hidden = true; dock(); } }
  const where = id => { const it = items.find(x => x.id === id); if (!it || !view) return null; const b = it.boxes[0]; return [view.ox + ((b[0] + b[2]) / 2 - view.x0) * view.s, view.oy + ((b[1] + b[3]) / 2 - view.y0) * view.s]; };   // a box's centre on the panel (CSS px)
  return { init, fit, done, pick, where }; })();

// ---- zoom: full-screen original photo centred on the part's box; drag to pan, pinch / wheel to zoom, tap outside to close
async function openZoom(cardId, cropSrc) { $("#zoom")?.remove();
  document.body.insertAdjacentHTML("beforeend", `<div id="zoom" class="zoom" role="dialog" aria-label="Photo of this part"><canvas id="zcv"></canvas><button type="button" class="zx" id="zx" aria-label="Close">✕</button><p class="zhint" id="zhint">Drag to move · pinch to zoom · tap outside the photo or ✕ to close</p></div>`);
  const z = $("#zoom"), cv = $("#zcv"), g = cv.getContext("2d"), close = () => { z.remove(); document.body.style.overflow = ""; }; document.body.style.overflow = "hidden"; $("#zx").onclick = e => { e.stopPropagation(); close(); };
  const m = await ZM.get(cardId).catch(() => null); let im, box = null;
  if (m) { im = await createImageBitmap(m.photo.blob); box = m.boxes[0]; } else { im = await new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = cropSrc; }); $("#zhint").textContent = "Original photo not on this phone · showing the crop"; }
  const W = innerWidth, H = innerHeight, dpr = devicePixelRatio || 1; cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + "px"; cv.style.height = H + "px"; let s, tx, ty;
  if (box) { const bw = box[2] - box[0], bh = box[3] - box[1]; s = Math.min(W / (bw * 2.2), H * 0.8 / (bh * 2.2)); tx = W / 2 - (box[0] + box[2]) / 2 * s; ty = H / 2 - (box[1] + box[3]) / 2 * s; } else { s = Math.min(W / im.width, H * 0.8 / im.height); tx = (W - im.width * s) / 2; ty = (H - im.height * s) / 2; }
  const draw = () => { g.setTransform(dpr, 0, 0, dpr, 0, 0); g.fillStyle = "#000"; g.fillRect(0, 0, W, H); g.setTransform(dpr * s, 0, 0, dpr * s, dpr * tx, dpr * ty); g.drawImage(im, 0, 0); if (box) { g.lineWidth = 3 / s; g.strokeStyle = "#F2B233"; g.strokeRect(box[0], box[1], box[2] - box[0], box[3] - box[1]); } };
  const inImg = (x, y) => { const ix = (x - tx) / s, iy = (y - ty) / s; return ix >= 0 && iy >= 0 && ix <= im.width && iy <= im.height; };
  const pts = new Map(); let moved = false, last = null;
  cv.onpointerdown = e => { cv.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); moved = false; last = null; };
  cv.onpointermove = e => { if (!pts.has(e.pointerId)) return; const p0 = pts.get(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 1) { const dx = e.clientX - p0[0], dy = e.clientY - p0[1]; if (Math.abs(dx) + Math.abs(dy) > 1) moved = true; tx += dx; ty += dy; }
    else if (pts.size === 2) { const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]), mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2; if (last) { const f = d / last; tx = mx - (mx - tx) * f; ty = my - (my - ty) * f; s *= f; } last = d; moved = true; } draw(); };
  cv.onpointerup = cv.onpointercancel = e => { pts.delete(e.pointerId); if (pts.size < 2) last = null; if (!moved && !pts.size && !inImg(e.clientX, e.clientY)) close(); };
  cv.onwheel = e => { e.preventDefault(); const f = Math.exp(-e.deltaY / 300); tx = e.clientX - (e.clientX - tx) * f; ty = e.clientY - (e.clientY - ty) * f; s *= f; draw(); };
  draw(); }
