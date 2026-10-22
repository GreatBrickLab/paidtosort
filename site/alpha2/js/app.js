// Screens: sign in · my sessions · a session (photo → check cards → lot list → finish) · finished session (totals, export) · help & privacy.
const main = $("#main"), V = {};
const pcs = ls => ls.reduce((a, l) => a + l.qty, 0);
async function estWeight(ls) { const W = await weights(); let g = 0, miss = 0; for (const l of ls) { const w = W[l.part]; if (w) g += w * l.qty; else miss++; } return { g, miss }; }
const weightLine = (w, n) => `Estimated (low) ${fmtW(w.g)}${w.miss ? ` <span class="muted small">(${w.miss} lot${w.miss === 1 ? "" : "s"} without a catalog weight)</span>` : ""}`;
function header() { $("#who").textContent = ME ? ME.user.display : ""; $("#logoutbtn").hidden = !ME; }

V.login = () => { const why = sessionStorage.getItem("pts2-why") || ""; sessionStorage.removeItem("pts2-why");
  main.innerHTML = `<div class="login"><img src="${BASE}/pts-mark-256.png" class="bigmark" alt=""><h1>Sign in</h1>${why ? `<p class="card notice" role="status">${esc(why)}</p>` : ""}
  <form id="lf" class="card"><label>Username<input name="username" autocomplete="username" autocapitalize="off" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><p class="err" id="lerr" role="alert"></p><button class="btn gold wide big">Sign in</button></form>
  <p class="small muted">Alpha test: identify the parts in a photo and keep a sorted lot list.</p></div>`;
  $("#lf").onsubmit = async e => { e.preventDefault(); const f = e.target, j = await api("login", { username: f.username.value, password: f.password.value }); if (!j.ok) { $("#lerr").textContent = j.error || "Could not sign in"; return; } await loadMe(); location.hash = "#/"; }; };

V.home = async () => { const j = await api("sessions"); if (j.error) return;
  const open = j.sessions.filter(s => s.status === "open"), done = j.sessions.filter(s => s.status === "done");
  const row = s => `<a class="card row srow" href="#/s/${s.id}"><span class="grow"><b>${esc(s.name || "Session " + s.id.slice(-4))}</b><br><span class="small muted">${esc(ctime(s.started))} · ${s.lots} lot${s.lots === 1 ? "" : "s"} · ${s.pcs} pcs${s.checking ? ` · <b class="warn">${s.checking} to check</b>` : ""}</span></span><span class="pill ${s.status}">${s.status === "open" ? "open" : "done"}</span></a>`;
  main.innerHTML = `<h1>Hi ${esc(ME.user.display)}</h1>
  <form class="card" id="nf"><h3>Start a sorting session</h3><p class="small muted">One session = one batch of parts you took home. Give it a name you will recognise (the label on the bag or tub), or leave it blank.</p>
   <label>Name (optional)<span class="scanrow"><input name="sname" maxlength="60" placeholder="e.g. Tub 3 · Oct 21"><button type="button" class="btn small" id="nscan" hidden>📷 Scan</button></span></label><video id="nvid" class="scanvid" hidden></video>
   <button class="btn gold wide big">Start session</button></form>
  ${!j.sessions.length ? `<div class="card firstrun"><h3>How it works</h3><ol class="steps"><li>Start a session for the parts you took home.</li><li>Spread a handful of parts on a plain sheet and take a photo.</li><li>Check each card: part, color and count. Add it to your lots.</li><li>Repeat until the batch is done, then weigh it and tap <b>Finish</b>.</li><li>Download the lot list.</li></ol></div>` : ""}
  ${open.length ? `<h2>Open</h2>${open.map(row).join("")}` : ""}${done.length ? `<h2>Finished</h2>${done.map(row).join("")}` : ""}`;
  attachScan($("#nscan"), $("#nvid"), v => { $("#nf").sname.value = String(v).slice(0, 60); toast("Label scanned"); });
  $("#nf").onsubmit = async e => { e.preventDefault(); const r = await api("sessions", { name: e.target.sname.value }); if (r.ok) location.hash = "#/s/" + r.id; else toast(r.error || "failed"); }; };

const lotRow = l => `<div class="lot row" data-id="${l.id}" data-part="${esc(l.part)}" data-color="${l.color}"><img ${picAttrs(l.part, l.color, l.crop)} class="thumb" alt="">
  <span class="grow"><span class="mono"><b>${esc(l.part)}</b></span> <span class="small">${esc(l.name)}</span><br><span class="cdot" style="background:#${crgb(l.color)}"></span><span class="small">${esc(cname(l.color))}</span> <span class="small muted lw" data-part="${esc(l.part)}" data-qty="${l.qty}"></span></span>
  <b class="lq">×${l.qty}</b></div>`;
const lotEdit = l => `<div class="lotedit card" data-id="${l.id}"><div class="row"><b class="mono">${esc(l.part)}</b><span class="small grow">${esc(l.name)}</span></div>
  <div class="row2"><div class="qty"><button type="button" class="qbtn minus" aria-label="one less">−</button><b>${l.qty}</b><button type="button" class="qbtn plus" aria-label="one more">+</button></div><button type="button" class="colorbtn"><i style="background:#${crgb(l.color)}"></i><span class="cn">${esc(cname(l.color))}</span><small>change ▾</small></button></div>
  <div class="row2"><button type="button" class="btn ldone">Done</button><button type="button" class="btn ghost ldel">Remove lot</button></div></div>`;
async function fillWeights(root) { const W = await weights(); root.querySelectorAll(".lw").forEach(s => { const w = W[s.dataset.part]; s.textContent = w ? `· est. (low) ${fmtW(w * +s.dataset.qty)}` : ""; }); }

V.session = async sid => { await palette(); const j = await api("session/" + sid); if (j.error) { main.innerHTML = `<p class="err">${esc(j.error)}</p>`; return; }
  const s = j.s, open = s.status === "open"; if (!open) return V.done(j);
  main.innerHTML = `<div class="sess"><div><small class="muted">Session · started ${esc(ctime(s.started))}</small><h1 id="sname">${esc(s.name || "Session " + s.id.slice(-4))}</h1></div><button type="button" class="btn small ghost" id="ren">Rename</button></div>
  <div class="card upload"><label class="btn gold wide big" for="cam">📷 Take a photo of parts</label><input id="cam" type="file" accept="image/*" capture="environment" hidden>
   <label class="btn wide" for="pick">Upload a photo</label><input id="pick" type="file" accept="image/*" hidden>
   <p class="muted small">Spread the parts out on a plain sheet, not touching. Parts are found on your phone; each part’s picture is then matched to a part number.</p>
   <div id="prog" class="prog" hidden><div class="spin"></div><span id="progt">Working…</span></div><div id="review" class="review" hidden></div></div>
  <div id="dock" class="dock"><div id="photo" hidden></div></div>
  <section id="checksec"${j.check.length ? "" : ' class="empty"'}><h2>Check <span class="muted small" id="pend"></span></h2>
  <p class="muted small" id="verhint">Is it the right part, color and count? Swipe up on the <b>⇡ bar</b> (or tap ✓) to add it to your lots. Not a part? Drop it.</p>
  <div id="cards">${j.check.map(cardHTML).join("")}</div>
  <button type="button" class="btn gold wide big" id="confirmall">✓ Add all <span id="ca_n"></span> cards to the lot list</button></section>
  <h2>Lot list <span class="muted small" id="ltot"></span></h2><div id="lots" class="card flatlist"></div>
  <form class="card" id="ff"><h3>Finish this session</h3><p class="small muted">Weigh everything you sorted in this session (optional). Unchecked cards are dropped.</p>
   <div class="row2"><label>Weight<input name="w" type="number" step="0.01" min="0" inputmode="decimal" value="${s.weighed_g ? (s.weighed_g / G_OZ / 16).toFixed(2) : ""}"></label><label>Unit<select name="u"><option value="lb">lb</option><option value="oz">oz</option></select></label></div>
   <button class="btn wide">Finish · see the lot list</button></form>${CS_HTML}`;
  CS.wire();
  ["#cam", "#pick"].forEach(id => $(id).onchange = e => { processPhoto(sid, e.target.files[0]); e.target.value = ""; });
  $("#ren").onclick = async () => { const n = prompt("Session name", s.name || ""); if (n === null) return; const r = await api("session/" + sid, { action: "rename", name: n }); if (r.ok) $("#sname").textContent = n.trim() || "Session " + sid.slice(-4); };
  $("#ff").onsubmit = async e => { e.preventDefault(); const f = e.target, v = f.w.value === "" ? null : +f.w.value * (f.u.value === "lb" ? 16 : 1) * G_OZ;
    let r = await api("session/" + sid, { action: "finish", weighed_g: v }); if (r.waiting) { if (!confirm(`${r.error} Drop them and finish?`)) return; r = await api("session/" + sid, { action: "finish", weighed_g: v, force: true }); }
    if (r.ok) route(); else toast(r.error || "failed"); };
  const showLots = async () => { const k = await api("session/" + sid); renderLots(k.lots, true); };
  wireCards(j.check, showLots); renderLots(j.lots, true); PH.init(j.check); resumeReview(sid);
};
async function renderLots(ls, editable) { const host = $("#lots"); const w = await estWeight(ls);
  $("#ltot").innerHTML = ls.length ? `${ls.length} lot${ls.length === 1 ? "" : "s"} · ${pcs(ls)} pcs · ${weightLine(w, 1)}` : "";
  host.innerHTML = ls.length ? ls.map(lotRow).join("") : `<p class="muted small empty">No lots yet. Checked cards land here, one line per part and color.</p>`; fillWeights(host);
  if (!editable) return; const sid = location.hash.match(/#\/s\/([\w-]+)/)[1];
  host.querySelectorAll(".lot").forEach(row => row.onclick = () => { const l = ls.find(x => x.id === +row.dataset.id); host.querySelector(".lotedit")?.remove(); row.insertAdjacentHTML("afterend", lotEdit(l)); const ed = row.nextElementSibling;
    const save = async patch => { const r = await api("lot/" + l.id, { action: "edit", ...patch }); if (!r.ok) return toast(r.error || "failed"); if (r.merged_into) toast("Merged with the matching lot"); const k = await api("session/" + sid); renderLots(k.lots, true); };
    let q = l.qty; const bump = d => { q = Math.max(1, q + d); ed.querySelector(".qty b").textContent = q; ed.querySelector(".minus").disabled = q <= 1; };   // saved on Done
    ed.querySelector(".minus").onclick = () => bump(-1); ed.querySelector(".plus").onclick = () => bump(1);
    ed.querySelector(".colorbtn").onclick = () => CS.open({ part: l.part, color: l.color, guesses: l.color_guesses, pick: id => save({ color: id }) });
    ed.querySelector(".ldone").onclick = () => { if (q !== l.qty) save({ qty: q }); else ed.remove(); };
    ed.querySelector(".ldel").onclick = async () => { if (!confirm(`Remove ${l.qty}× ${l.part} ${cname(l.color)}?`)) return; await api("lot/" + l.id, { action: "delete" }); const k = await api("session/" + sid); renderLots(k.lots, true); }; }); }

V.done = async j => { const s = j.s, ls = j.lots, w = await estWeight(ls), sid = s.id;
  main.innerHTML = `<div class="sess"><div><small class="muted">Finished ${esc(ctime(s.ended))}</small><h1>${esc(s.name || "Session " + sid.slice(-4))}</h1></div><span class="pill done">done</span></div>
  <div class="card stat"><div><b>${ls.length}</b><span>lots</span></div><div><b>${pcs(ls)}</b><span>pieces</span></div><div><b>${s.weighed_g ? fmtW(s.weighed_g) : "–"}</b><span>weighed (real)</span></div><div><b>${fmtW(w.g)}</b><span>estimated (low)</span></div></div>
  <p class="small muted">Started ${esc(ctime(s.started))} · finished ${esc(ctime(s.ended))}.${w.miss ? ` ${w.miss} lot${w.miss === 1 ? " has" : "s have"} no catalog weight, so they are not in the estimate.` : ""}</p>
  <div class="row2"><a class="btn gold" href="${BASE}/api/session/${sid}/export.csv" download>⬇ Spreadsheet (CSV)</a><a class="btn" href="${BASE}/api/session/${sid}/export.bsx" download>⬇ Inventory file</a></div>
  <h2>Lot list</h2><div id="lots" class="card flatlist"></div><span id="ltot" hidden></span>
  <button type="button" class="btn wide" id="reopen">Reopen to add or fix parts</button>`;
  renderLots(ls, false); $("#reopen").onclick = async () => { const r = await api("session/" + sid, { action: "reopen" }); if (r.ok) route(); }; };

V.help = () => { main.innerHTML = `<h1>Help</h1><div class="card faq">
  <details open><summary><b>Taking a good photo</b></summary><p class="small">Plain, light sheet of paper; parts flat and not touching; phone straight above; good light, no hard shadows. 10–25 parts per photo works best.</p></details>
  <details><summary><b>Estimated (low) vs. weighed</b></summary><p class="small">The <b>Estimated (low)</b> weight comes from catalog weights and is set about 15% low on purpose. It is only a rough advance while you build bags. <b>Your real pay comes from a scale weight</b>: the weighed weight entered at Finish (or weighed by us).</p></details>
  <details><summary><b>A part has no box</b></summary><p class="small">After the photo, tap the part (or drag a box around it), then tap <b>Done · make cards</b>.</p></details>
  <details><summary><b>The card is wrong</b></summary><p class="small">Tap another match under <b>Other matches</b>, change the color with the color button (tick <b>Show all colors</b> if it is not listed), or fix the count with − / +. Not a part at all? <b>Drop</b> it.</p></details>
  <details><summary><b>A part was not recognised</b></summary><p class="small">It is left out. Take another photo of just that part, turned over or from the side.</p></details>
  <details><summary><b>Weights</b></summary><p class="small">Each lot shows an estimate from the parts catalog. For the real figure, weigh the batch and enter it when you finish.</p></details></div>`; };
V.privacy = () => { main.innerHTML = `<h1>Privacy &amp; terms</h1><div class="card legal"><p><b>This is an alpha test.</b> Things may change or break, and data may be reset.</p>
  <h3>What is kept</h3><ul><li>Your username and a hashed password.</li><li>Your sessions and lot lists, with a small picture of each lot.</li><li>Your photos stay on your phone. Only the cut-out picture of each part is sent to a part-recognition service to identify it.</li></ul>
  <h3>Terms</h3><ul><li>Use the app only for sorting parts. Weights are estimates.</li><li>Provided as is, without warranty, during the alpha.</li></ul></div>`; };

async function loadMe() { const j = await api("me"); ME = j.error ? null : j; header(); return ME; }
async function route() { const h = location.hash.slice(1) || "/", path = h.split("?")[0]; scrollTo(0, 0); SCAN_STOP?.();
  if (path === "/logout") { await api("logout", {}); ME = null; header(); location.hash = "#/login"; return; }
  if (path === "/privacy") { if (!ME) await loadMe().catch(() => {}); return V.privacy(); }
  if (path === "/login") return V.login();
  if (!ME && !(await loadMe())) { location.hash = "#/login"; return; }
  let m; if (path === "/") return V.home(); if ((m = path.match(/^\/s\/([\w-]+)$/))) return V.session(m[1]); if (path === "/help") return V.help();
  main.innerHTML = `<div class="card"><h2>Page not found</h2><a class="btn gold wide" href="#/">Home</a></div>`; }
addEventListener("hashchange", route); route();
