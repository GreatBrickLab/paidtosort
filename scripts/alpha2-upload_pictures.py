#!/usr/bin/env python3
"""Upload extracted pictures (<part>_<color>.webp) to the live KV namespace paidtosort-alpha2-img as img/<name>.
Only new or changed files are sent (state in <dir>/.uploaded.json). Uses wrangler@3 with the box token; ids and tokens are never printed.
Usage: scripts/upload_pictures.py [PICTURE_DIR]   (default /workspace/brickstore-feed/pictures)"""
import base64, glob, hashlib, json, os, subprocess, sys, tempfile
D = sys.argv[1] if len(sys.argv) > 1 else "/workspace/brickstore-feed/pictures"; ST = os.path.join(D, ".uploaded.json")
WR = sorted(glob.glob("/home/box/.npm/_npx/*/node_modules/.bin/wrangler"))[0]
env = {**os.environ, "CLOUDFLARE_ACCOUNT_ID": "41130be4ef559a528281bb15fb9adbb4", "CLOUDFLARE_API_TOKEN": open(os.path.expanduser("~/.cloudflare/token")).read().strip(), "WRANGLER_SEND_METRICS": "false"}
ns = json.loads(subprocess.run([WR, "kv", "namespace", "list"], env=env, capture_output=True, text=True, check=True).stdout)
nid = next(n["id"] for n in ns if n["title"] == "paidtosort-alpha2-img")
done = json.load(open(ST)) if os.path.exists(ST) else {}
todo = []
for f in sorted(glob.glob(os.path.join(D, "*.webp"))):
    b = open(f, "rb").read(); h = hashlib.sha1(b).hexdigest(); n = os.path.basename(f)
    if done.get(n) != h: todo.append((n, b, h))
print(f"{len(todo)} to upload, {len(done)} already uploaded")
for i in range(0, len(todo), 2000):
    chunk = todo[i:i + 2000]
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as t:
        json.dump([{"key": "img/" + n, "value": base64.b64encode(b).decode(), "base64": True} for n, b, _ in chunk], t)
    r = subprocess.run([WR, "kv", "bulk", "put", t.name, "--namespace-id", nid], env=env, capture_output=True, text=True); os.unlink(t.name)
    if r.returncode: sys.exit("upload failed: " + (r.stderr or r.stdout)[-400:].replace(nid, "<ns>"))
    for n, _, h in chunk: done[n] = h
    json.dump(done, open(ST, "w")); print(f"uploaded {min(i + 2000, len(todo))}/{len(todo)}")
print("done:", len(done), "pictures live")
