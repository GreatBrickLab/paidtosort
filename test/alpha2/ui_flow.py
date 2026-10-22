# Phone-width (390x844) walk-through on the pipeline test photos: sign in, start a session, photo -> boxes -> cards, check, lot list, finish, export.
# MODE=real: crops go to the recognition service (through the local API). Fails on page errors, banned words or any outside parts-site request.
import json, os, re, time
from playwright.sync_api import sync_playwright
BASE, OUT = os.environ["BASE"], os.path.join(os.environ["OUT"], "flow"); os.makedirs(OUT, exist_ok=True)
DT = "/workspace/gbl/pts-alpha/detector-test"; PHOTOS = [f"{DT}/paper-real/p1.jpg", f"{DT}/card/card_topdown_truth.jpg"]
BANNED = re.compile(r"brickognize|brickstore|bricqer|(?<!\.)bsx|github", re.I)
res, errs, outside = {}, [], []
def check(k, v): res[k] = v; assert v, (k, v)
with sync_playwright() as p:
    b = p.chromium.launch(); c = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, accept_downloads=True)
    c.route(re.compile(r"bricklink\.com"), lambda r: (outside.append(r.request.url), r.abort()))
    pg = c.new_page(); pg.on("pageerror", lambda e: errs.append(str(e)[:200])); pg.on("dialog", lambda d: d.accept("0.42") if d.type == "prompt" else d.accept())
    def shot(n, full=False, sel=None):
        if sel: pg.wait_for_selector(sel)
        pg.wait_for_timeout(500); t = pg.inner_text("body"); f = BANNED.findall(t)
        assert not f, (n, f); pg.screenshot(path=f"{OUT}/{n}.png", full_page=full); print("shot", n); return t
    pg.goto(BASE + "/alpha2/"); pg.wait_for_selector("#lf"); shot("01-sign-in")
    pg.fill("input[name=username]", "sam"); pg.fill("input[name=password]", "test-sam-pass"); pg.click("#lf button"); pg.wait_for_selector("#nf")
    t = shot("02-home-first-run", True); check("first_run_steps", "How it works" in t)
    pg.fill("#nf input[name=sname]", "Tub 3 · Oct 21"); pg.click("#nf button.gold"); pg.wait_for_selector("#cam", state="attached"); shot("03-new-session", True)
    for k, ph in enumerate(PHOTOS):
        t0 = time.time(); pg.set_input_files("#pick", ph); pg.wait_for_selector("#r_done", timeout=180000); res[f"photo{k}_boxes_s"] = round(time.time() - t0, 1)
        if k == 0: shot("04-review-boxes", False, "#rcv")
        t1 = time.time(); pg.click("#r_done"); pg.wait_for_selector(".pcard", timeout=180000); pg.wait_for_function("document.querySelector('#prog').hidden", timeout=60000); res[f"photo{k}_identify_s"] = round(time.time() - t1, 1)
        res[f"photo{k}"] = pg.evaluate("window.PTS_LAST"); pg.wait_for_timeout(1200)
        if k == 0:
            pg.wait_for_timeout(3500); pg.evaluate("(() => { const c = document.querySelector('.pcard'), d = document.querySelector('#dock'), t = document.querySelector('.top'); scrollTo(0, c.getBoundingClientRect().top + scrollY - d.offsetHeight - t.offsetHeight - 6); })()"); pg.wait_for_timeout(700); shot("05-verify-card")
            check("pinned_photo", pg.locator("#photo:not([hidden]) #pcv").count() == 1)
            check("numbered_boxes", pg.locator(".pcard .pno:not([hidden])").count() == pg.locator(".pcard").count())
            n3 = pg.locator(".pcard").nth(2); n3.locator(".pno").click(); pg.wait_for_timeout(500); check("tap_number_selects", "sel" in (n3.get_attribute("class") or ""))
            # tap a box on the pinned photo -> its card is selected and scrolled to
            tid = int(pg.locator(".pcard").nth(5).get_attribute("data-id"))
            xy = pg.evaluate("(id) => { const r = document.querySelector('#pcv').getBoundingClientRect(), w = PH.where(id); return [r.left + w[0], r.top + w[1]]; }", tid)
            pg.mouse.click(xy[0], xy[1]); pg.wait_for_timeout(900); check("tap_box_jumps_to_card", pg.locator(f".pcard.sel[data-id='{tid}']").count() == 1)
            shot("06-tap-to-jump")
            first = pg.locator(".pcard").first; first.scroll_into_view_if_needed(); first.locator(".pcmp").scroll_into_view_if_needed(); pg.wait_for_timeout(400); shot("07-compare-our-match-your-photo")
            check("compare_has_both", first.locator(".ptile img").count() == 1 and first.locator(".pcrop img").count() == 1)
            first.locator(".colorbtn").click(); pg.wait_for_selector("#cs[open] .chip"); n_known = pg.locator("#cs_body .chip").count(); pg.check("#cs_all"); pg.wait_for_timeout(300)
            check("show_all_colors_adds", pg.locator("#cs_body .chip").count() > n_known); shot("08-color-sheet-show-all"); pg.click("#cs_x"); pg.wait_for_timeout(300)
            # swipe up on the grip bar confirms
            g = pg.locator(".pcard").first.locator(".grip"); g.scroll_into_view_if_needed(); bb = g.bounding_box(); n0 = pg.locator(".pcard").count()
            pg.evaluate("""([x, y]) => { const el = document.elementFromPoint(x, y); const T = (yy) => new Touch({ identifier: 1, target: el, clientX: x, clientY: yy });
              el.dispatchEvent(new TouchEvent('touchstart', { touches: [T(y)], bubbles: true })); for (let i = 1; i <= 6; i++) el.dispatchEvent(new TouchEvent('touchmove', { touches: [T(y - i * 25)], bubbles: true, cancelable: true }));
              el.dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true })); }""", [bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2])
            pg.wait_for_timeout(1500); check("swipe_up_confirms", pg.locator(".pcard").count() == n0 - 1)
            pg.locator(".pcard").first.locator(".ok").click(); pg.wait_for_timeout(1200); check("tap_confirms", pg.locator(".pcard").count() == n0 - 2)
            pg.evaluate("document.querySelector('#lots').scrollIntoView({block:'center'})"); pg.wait_for_timeout(500); shot("09-lot-list-first-two")
        pg.click("#confirmall"); pg.wait_for_function("!document.querySelector('.pcard')", timeout=60000); pg.wait_for_timeout(1500)
    t = shot("10-lot-list-two-photos", True); res["lot_summary"] = pg.inner_text("#ltot"); check("lot_weights_oz_lb", re.search(r"\d (oz|lb)", res["lot_summary"]) is not None)
    check("lot_thumbnails", pg.locator("#lots .lot img.thumb").count() == pg.locator("#lots .lot").count() > 0)
    pg.locator("#lots .lot").first.click(); pg.wait_for_selector(".lotedit"); pg.locator(".lotedit .plus").click(); pg.wait_for_timeout(300); shot("11-edit-a-lot")
    pg.locator(".lotedit .ldone").click(); pg.wait_for_timeout(1500)
    pg.fill("#ff input[name=w]", "0.42"); pg.click("#ff button"); pg.wait_for_selector(".stat"); t = shot("12-finished-summary", True)
    check("summary_ct_and_weights", " CT" in t and ("0.42 lb" in t or "6.7 oz" in t) and "estimated (low)" in t.lower() and "weighed (real)" in t.lower())
    with pg.expect_download() as d: pg.click("a[href$='export.csv']")
    d.value.save_as(f"{OUT}/lot-list.csv"); csv = open(f"{OUT}/lot-list.csv", encoding="utf-8-sig").read(); check("csv_has_lots", csv.startswith("part,name,color id") and "estimated (low) weight" in csv)
    with pg.expect_download() as d: pg.click("a[href$='export.bsx']")
    d.value.save_as(f"{OUT}/lot-list.bsx"); check("inventory_file", "<Item>" in open(f"{OUT}/lot-list.bsx").read())
    pg.goto(BASE + "/alpha2/#/"); t = shot("13-home-with-session"); check("home_lists_session", "Tub 3" in t)
    pg.goto(BASE + "/alpha2/#/help"); shot("14-help", True); pg.goto(BASE + "/alpha2/#/privacy"); t = shot("15-privacy", True); check("privacy_no_vendor", "part-recognition service" in t)
    b.close()
res["page_errors"] = errs; res["parts_site_requests"] = len(outside); json.dump(res, open(f"{OUT}/checks.json", "w"), indent=1)
print(json.dumps(res, indent=1)); assert not errs and not outside; print("UI FLOW PASS")
