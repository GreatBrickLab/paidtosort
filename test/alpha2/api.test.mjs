// API checks against the local server (BASE, MODE=mock). Exits non-zero on the first failure.
const BASE = process.env.BASE + "/alpha2/api/"; let n = 0;
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } n++; console.log("ok -", m); };
const login = (u, p) => fetch(BASE + "login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: u, password: p }) });
const ck = r => (r.headers.get("set-cookie") || "").split(";")[0];
const get = (c, p) => fetch(BASE + p, { headers: { cookie: c } }), post = (c, p, b) => fetch(BASE + p, { method: "POST", headers: { cookie: c, "content-type": "application/json" }, body: JSON.stringify(b) });
const J = async r => ({ s: r.status, ...(await r.json().catch(() => ({}))) });
const S = ck(await login("sam", "test-sam-pass")), R = ck(await login("ria", "test-ria-pass")); ok(S && R, "both test users sign in");
let r = await fetch(process.env.BASE + "/alpha2/"); ok(/noindex/.test(r.headers.get("x-robots-tag") || "") && /noindex/.test(await r.text()), "noindex header + meta");
ok((await J(await get("", "me"))).s === 401, "no cookie -> 401");
ok((await J(await get("pts2=1:0.9999999999999.bad", "me"))).reason === "invalid", "forged cookie refused");
let j = await J(await get(S, "me")); ok(j.user.username === "sam", "me");
// sessions
j = await J(await post(S, "sessions", { name: "Tub 3" })); ok(j.ok && /^S-\d{6}-\w{4}$/.test(j.id), "start a session"); const sid = j.id;
ok((await J(await get(R, "session/" + sid))).s === 404, "another sorter can't see it");
j = await J(await get(S, "sessions")); ok(j.sessions.length === 1 && j.sessions[0].name === "Tub 3", "listed with its name");
// identify (mock) + cards
j = await J(await post(S, "identify", { image: "data:image/jpeg;base64," + "A".repeat(500) })); ok(Array.isArray(j.items), "identify proxy answers (test mode)");
ok((await J(await post(S, "identify", { image: "" }))).s === 400, "empty image rejected");
r = await get(S, "ref/3001"); ok(r.ok && /svg|image/.test(r.headers.get("content-type")), "reference picture route");
ok((await get(S, "ref/bad%20part!")).status === 404, "bad part number in ref route");
const crop = "data:image/jpeg;base64,/9j/" + "A".repeat(100);
j = await J(await post(S, `session/${sid}/cards`, { cards: [
  { part: "3001", name: "Brick 2 x 4", color: 5, qty: 2, confidence: 0.91, alts: [{ id: "3001", name: "Brick 2 x 4", score: 0.91 }, { id: "3003", name: "Brick 2 x 2", score: 0.4 }], color_guesses: [5, 4], crop },
  { part: "3001", name: "Brick 2 x 4", color: 5, qty: 1, confidence: 0.85, crop }, { part: "3023", name: "Plate 1 x 2", color: 11, qty: 3, confidence: 0.62 }, { part: "?", qty: 1 }, { part: "bad part!", qty: 1 }] }));
ok(j.ok && j.added === 3 && j.ids[3] === null && j.ids[4] === null, "3 cards saved; unrecognised and bad rows dropped");
const [c1, c2, c3] = j.ids;
ok((await J(await post(R, `session/${sid}/cards`, { cards: [{ part: "3001", color: 1 }] }))).error, "another sorter can't add cards");
j = await J(await get(S, "session/" + sid)); ok(j.check.length === 3 && j.lots.length === 0 && j.check[0].alts.length === 2 && j.check[0].color_guesses[0] === 5 && j.check[0].crop === crop, "cards waiting, with matches, guesses and crop");
// edit + confirm + merge
j = await J(await post(S, "lot/" + c1, { action: "edit", qty: 4 })); ok(j.ok && j.qty === 4, "qty edit");
j = await J(await post(S, "lot/" + c1, { action: "edit", part: "3003", name: "Brick 2 x 2" })); ok(j.part === "3003", "switch to another match");
j = await J(await post(S, "lot/" + c1, { action: "edit", part: "3001", name: "Brick 2 x 4" }));
ok((await J(await post(S, "lot/" + c1, { action: "edit", part: "x y" }))).s === 400, "bad part refused");
ok((await J(await post(R, "lot/" + c1, { action: "confirm" }))).s === 404, "another sorter can't confirm");
j = await J(await post(S, "lot/" + c1, { action: "confirm", qty: 4 })); ok(j.ok && !j.merged, "confirm -> lot");
j = await J(await post(S, "lot/" + c2, { action: "confirm" })); ok(j.ok && j.merged && j.lot === c1, "same part + color merges into one lot");
ok((await J(await post(S, "lot/" + c1, { action: "confirm" }))).s === 409, "confirm twice refused");
j = await J(await get(S, "session/" + sid)); ok(j.lots.length === 1 && j.lots[0].qty === 5 && j.check.length === 1, "lot list: 1 lot of 5, 1 card left");
// finish needs every card checked (or force, which drops them)
j = await J(await post(S, "session/" + sid, { action: "finish" })); ok(j.s === 409 && j.waiting === 1, "finish refused while a card waits");
j = await J(await post(S, "lot/" + c3, { action: "confirm" })); ok(j.ok, "last card confirmed");
j = await J(await post(S, "lot/" + c3, { action: "edit", color: 5, part: "3001", name: "Brick 2 x 4" })); ok(j.ok && j.merged_into === c1 && j.qty === 8, "editing a lot into an existing part + color merges them");
j = await J(await post(S, "session/" + sid, { action: "finish", weighed_g: 453.59 })); ok(j.ok, "finish with a weighed weight");
ok((await J(await post(S, "lot/" + c1, { action: "edit", qty: 1 }))).s === 409, "finished session is read-only");
// export
r = await get(S, `session/${sid}/export.csv`); let t = await r.text();
ok(r.ok && /attachment; filename="S-\d{6}-\w{4}-Tub_3\.csv"/.test(r.headers.get("content-disposition")), "CSV download");
ok(t.includes("3001,Brick 2 x 4,5,Red,8,") && /"estimated \(low\) weight \(lb, catalog x 0\.85\)",0\.03\d/.test(t) && t.includes("weighed - real (lb),1.000") && t.includes("est. low weight each (oz)") && /\r\n3001,Brick 2 x 4,5,Red,8,[\d.]+,[\d.]+,\d+\.\d{3},\d+\.\d\d,/.test(t) && /started,"\d\d\/\d\d\/\d{4}, \d\d:\d\d CT"/.test(t), "CSV: lot, color name, catalog weight in lb, weighed lb, CT times");
r = await get(S, `session/${sid}/export.bsx`); t = await r.text(); ok(r.ok && t.includes("<ItemID>3001</ItemID>") && t.includes("<Qty>8</Qty>") && t.includes("<ColorName>Red</ColorName>"), "inventory file");
ok((await get(R, `session/${sid}/export.csv`)).status === 404, "another sorter can't export it");
j = await J(await post(S, "session/" + sid, { action: "reopen" })); ok(j.ok && (await J(await post(S, "lot/" + c1, { action: "edit", qty: 7 }))).ok, "reopen allows edits again");
// formula-safe CSV
const s2 = (await J(await post(S, "sessions", { name: "=cmd" }))).id; await post(S, `session/${s2}/cards`, { cards: [{ part: "3024", name: "=HYPERLINK(1)", color: 1, qty: 1 }] });
const l2 = (await J(await get(S, "session/" + s2))).check[0].id; await post(S, "lot/" + l2, { action: "confirm" }); t = await (await get(S, `session/${s2}/export.csv`)).text(); ok(t.includes("'=HYPERLINK(1)") && t.includes("'=cmd"), "CSV cells can't run formulas");
// lockout + logout everywhere
for (let i = 0; i < 4; i++) await login("ria", "nope" + i); ok((await J(await login("ria", "nope"))).reason === "locked" && (await login("ria", "test-ria-pass")).status === 429, "5 wrong passwords lock for 15 min");
ok((await J(await get(R, "me"))).user, "an existing sign-in keeps working during a lock");
const S2 = ck(await login("sam", "test-sam-pass")); await post(S, "logout", { everywhere: true });
ok((await J(await get(S2, "me"))).reason === "signed_out", "log out everywhere ends other sign-ins");
// colored pictures: stored one is served immutable, missing one is a 404 (the app falls back), bad names refused
{ const B = process.env.BASE; let r = await fetch(B + "/alpha2/img/3001_5.webp"); ok(r.status === 200 && r.headers.get("content-type") === "image/webp" && /immutable/.test(r.headers.get("cache-control")) && (await r.arrayBuffer()).byteLength > 500, "colored picture served, immutable");
  r = await fetch(B + "/alpha2/img/3001_9999.webp"); ok(r.status === 404, "missing picture is 404"); r = await fetch(B + "/alpha2/img/..%2Fx_1.webp"); ok(r.status === 404, "bad picture name refused"); }
// clean up what this test made
const S3 = ck(await login("sam", "test-sam-pass")); for (const x of [sid, s2]) ok((await J(await post(S3, "session/" + x, { action: "delete" }))).ok, "deleted " + x);
ok((await J(await get(S3, "sessions"))).sessions.length === 0, "nothing left");
console.log(`\n${n} API checks passed`);
