# Live checks for paidtosort.com/alpha2 (read-mostly). Logins are read from the private file and never printed.
# Public pages + /alpha must match the deployed source; /alpha2 noindex; both logins; one full photo flow as sorter, then the test session is deleted.
import json, os, re, sys, time, urllib.request, http.cookiejar
from playwright.sync_api import sync_playwright
BASE = "https://paidtosort.com"; SRC = "/workspace/paidtosort-pages/site"; OUT = "/workspace/pts-alpha2/test/out/live"; os.makedirs(OUT, exist_ok=True)
L = open("/workspace/gbl/pts-alpha/ALPHA_LOGINS.txt").read(); U = dict((r, (u, p)) for r, u, p in re.findall(r"^\s*(host admin|sorter)\s*:\s*(\S+)\s*/\s*(\S+)\s*$", L, re.M))
BANNED = re.compile(r"brickognize|brickstore|bricqer|(?<!\.)bsx|github", re.I); res = {}
def check(k, v): res[k] = bool(v); print(("ok  " if v else "FAIL"), k); return v
def norm(b):  # undo Cloudflare's zone email obfuscation (a zone setting, not our source)
    b = re.sub(rb'<script data-cfasync="false" src="/cdn-cgi/scripts/[^"]+/cloudflare-static/email-decode.min.js"></script>', b"", b)
    return re.sub(rb'<a href="(?:/cdn-cgi/l/email-protection#[0-9a-f]+|mailto:[^"]+)">.*?</a>', b"<a>EMAIL</a>", b)
def get(path, **h):
    r = urllib.request.urlopen(urllib.request.Request(BASE + path, headers={"user-agent": "pts-livecheck", **h})); return r.status, dict(r.headers), r.read()
# public pages + /alpha: byte-compare the previous and the new deployment (their pages.dev hosts skip the zone's email obfuscation) and the source
OLD, NEW = os.environ.get("OLD_DEPLOY"), os.environ.get("NEW_DEPLOY")
for path, f in [("/", "index.html"), ("/game/", "game/index.html"), ("/links/", "links/index.html"), ("/alpha/", "alpha/index.html"), ("/alpha/app.js", "alpha/app.js"), ("/robots.txt", "robots.txt")]:
    if OLD and NEW:
        a, n = (urllib.request.urlopen(urllib.request.Request(f"https://{d}.paidtosort.pages.dev{path}", headers={"user-agent": "pts-livecheck"})).read() for d in (OLD, NEW))
        check(f"unchanged {path}", a == n == open(f"{SRC}/{f}", "rb").read())
    st, h, b = get(path); check(f"live 200 {path}", st == 200)
st, h, b = get("/alpha2/"); check("alpha2 noindex header", "noindex" in h.get("X-Robots-Tag", h.get("x-robots-tag", ""))); check("alpha2 noindex meta", b'name="robots" content="noindex' in b)
for r, (u, p) in U.items():
    cj = http.cookiejar.CookieJar(); o = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    req = lambda path, d=None: json.loads(o.open(urllib.request.Request(BASE + "/alpha2/api/" + path, json.dumps(d).encode() if d is not None else None, {"content-type": "application/json", "user-agent": "pts-livecheck"})).read())
    j = req("login", {"username": u, "password": p}); me = req("me"); check(f"login {r}", j.get("ok") and me.get("user", {}).get("username") == u); req("logout", {})
outside, errs = [], []
with sync_playwright() as pw:
    b = pw.chromium.launch(); c = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    c.route(re.compile(r"bricklink\.com"), lambda r: (outside.append(1), r.abort())); pg = c.new_page(); pg.on("pageerror", lambda e: errs.append(str(e)[:200]))
    pg.on("dialog", lambda d: d.accept())
    def shot(n, full=False):
        pg.wait_for_timeout(600); t = pg.inner_text("body"); check(f"no banned names: {n}", not BANNED.findall(t)); pg.screenshot(path=f"{OUT}/{n}.png", full_page=full); return t
    pg.goto(BASE + "/alpha2/"); pg.wait_for_selector("#lf"); shot("01-sign-in")
    u, p = U["sorter"]; pg.fill("input[name=username]", u); pg.fill("input[name=password]", p); pg.click("#lf button"); pg.wait_for_selector("#nf"); shot("02-home", True)
    pg.fill("#nf input[name=sname]", "LIVE CHECK - delete me"); pg.click("#nf button.gold"); pg.wait_for_selector("#cam", state="attached")
    sid = pg.evaluate("location.hash").split("/")[-1]; res["session"] = sid
    try:
        t0 = time.time(); pg.set_input_files("#pick", "/workspace/gbl/pts-alpha/detector-test/paper-real/p1.jpg"); pg.wait_for_selector("#r_done", timeout=180000); res["boxes_s"] = round(time.time() - t0, 1); shot("03-review-boxes")
        t1 = time.time(); pg.click("#r_done"); pg.wait_for_selector(".pcard", timeout=180000); pg.wait_for_function("document.querySelector('#prog').hidden", timeout=90000); res["identify_s"] = round(time.time() - t1, 1)
        res["timing"] = pg.evaluate("window.PTS_LAST"); res["cards"] = pg.locator(".pcard").count(); check("cards made", res["cards"] >= 8)
        pg.wait_for_timeout(3500); pg.evaluate("(() => { const c = document.querySelector('.pcard'), d = document.querySelector('#dock'), t = document.querySelector('.top'); scrollTo(0, c.getBoundingClientRect().top + scrollY - d.offsetHeight - t.offsetHeight - 6); })()"); shot("04-verify-card")
        f = pg.locator(".pcard").first; f.locator(".pcmp").scroll_into_view_if_needed(); shot("05-compare")
        pg.click("#confirmall"); pg.wait_for_function("!document.querySelector('.pcard')", timeout=60000); pg.wait_for_timeout(1500); t = shot("06-lot-list", True); check("lot list low estimate", "Estimated (low)" in t)
        pg.fill("#ff input[name=w]", "0.42"); pg.click("#ff button"); pg.wait_for_selector(".stat"); t = shot("07-finished-summary", True)
        check("summary shows estimated (low) and weighed (real)", "estimated (low)" in t.lower() and "weighed (real)" in t.lower() and " CT" in t)
        pg.goto(BASE + "/alpha2/#/help"); shot("08-help", True); check("help explains scale pay", "real pay comes from a scale weight" in pg.text_content("main").lower())
    finally:
        r = pg.evaluate("(sid) => fetch('/alpha2/api/session/' + sid, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({action: 'delete'})}).then(r => r.json())", sid)
        check("test session deleted", r.get("ok")); pg.evaluate("fetch('/alpha2/api/logout', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'})")
    b.close()
check("no page errors", not errs); check("no parts-site requests", not outside); res["errors"] = errs
json.dump(res, open(f"{OUT}/checks.json", "w"), indent=1); print(json.dumps({k: v for k, v in res.items() if k not in ("timing",)}, indent=0)[:1500]); print("timing", res.get("timing")); sys.exit(0 if all(v for k, v in res.items() if isinstance(v, bool)) else 1)
