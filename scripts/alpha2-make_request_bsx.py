#!/usr/bin/env python3
"""Request files for the desktop app: every parts_colors row (Inventory Research data, read-only) as a qty-1 used lot,
most-held first, split into files of 5,000 lots. Load them in the app to fill its picture cache, then run extract_pictures.py."""
import csv, html, os
D = "/workspace/gbl/paidtosort-parts-data"; OUT = "/workspace/brickstore-feed"; N = 5000
names = {r["part_id"]: (r["name"], r["category_id"], r["category"]) for r in csv.DictReader(open(f"{D}/parts_data.csv", encoding="utf-8"))}
cols = {}
for r in csv.DictReader(open("/workspace/gbl/brickstore/colors.csv", encoding="utf-8")):
    k = {x.lower(): x for x in r}; cid = r.get(k.get("color_id") or k.get("id") or k.get("colorid") or "", ""); nm = r.get(k.get("name") or k.get("color_name") or "", "")
    if cid: cols[cid] = nm
rows = list(csv.DictReader(open(f"{D}/parts_colors.csv", encoding="utf-8")))
rows.sort(key=lambda r: -float(r["gbl_qty"] or 0))
e = lambda s: html.escape(str(s), quote=False)
for i in range(0, len(rows), N):
    part = rows[i:i + N]; fn = f"{OUT}/all-part-colors-{i // N + 1:02d}.bsx"
    with open(fn, "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n<BrickStoreXML>\n <Inventory Currency="USD">\n')
        for r in part:
            nm, cat, catn = names.get(r["part_id"], ("", "", ""))
            f.write(f'  <Item>\n   <ItemID>{e(r["part_id"])}</ItemID>\n   <ItemTypeID>P</ItemTypeID>\n   <ColorID>{e(r["color_id"])}</ColorID>\n'
                    + (f'   <ItemName>{e(nm)}</ItemName>\n' if nm else '') + '   <ItemTypeName>Part</ItemTypeName>\n'
                    + (f'   <ColorName>{e(cols.get(r["color_id"], ""))}</ColorName>\n' if cols.get(r["color_id"]) else '')
                    + (f'   <CategoryID>{e(cat)}</CategoryID>\n   <CategoryName>{e(catn)}</CategoryName>\n' if cat else '')
                    + '   <Status>I</Status>\n   <Qty>1</Qty>\n   <Price>0.000</Price>\n   <Condition>U</Condition>\n  </Item>\n')
        f.write(' </Inventory>\n</BrickStoreXML>\n')
    print(fn, len(part))
print("total", len(rows))
