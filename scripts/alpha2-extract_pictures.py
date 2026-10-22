#!/usr/bin/env python3
"""Export colored part pictures from the desktop app's picture cache (read-only, on a copy).
Rows are keyed P<part>@<color> with WEBP data; written as <part>_<color>.webp.
Usage: scripts/extract_pictures.py [OUT_DIR]   (default /workspace/brickstore-feed/pictures)
Re-run any time after loading more request files in the app; only new/changed pictures are rewritten."""
import json, os, re, shutil, sqlite3, sys, tempfile
SRC = os.path.expanduser("~/.cache/BrickStore/picture_cache.sqlite")
OUT = sys.argv[1] if len(sys.argv) > 1 else "/workspace/brickstore-feed/pictures"
os.makedirs(OUT, exist_ok=True)
with tempfile.TemporaryDirectory() as td:
    cp = os.path.join(td, "pc.sqlite")
    src = sqlite3.connect(f"file:{SRC}?mode=ro", uri=True); dst = sqlite3.connect(cp); src.backup(dst); src.close()  # consistent copy incl. WAL
    n = new = skipped = 0; man = {}
    for pid, upd, data in dst.execute("select id, updated, data from pic"):
        m = re.fullmatch(r"P([^@]+)@(\d+)", pid or "")
        if not m or not data or data[:4] != b"RIFF" or data[8:12] != b"WEBP": skipped += 1; continue
        part, color = m.groups(); name = f"{re.sub(r'[^A-Za-z0-9.-]', '_', part)}_{color}.webp"; f = os.path.join(OUT, name); n += 1
        if not (os.path.exists(f) and os.path.getsize(f) == len(data) and open(f, "rb").read() == data):
            open(f, "wb").write(data); new += 1
        man[name] = {"part": part, "color": int(color), "bytes": len(data), "updated": upd}
    dst.close()
json.dump(man, open(os.path.join(OUT, "manifest.json"), "w"), indent=0, sort_keys=True)
print(f"cache pictures: {n} colored (part+color), {new} new or changed, {skipped} skipped (not part+color webp) -> {OUT}")
