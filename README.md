# Paid to Sort

A phone-first web app for sorting bulk LEGO® parts: photograph a pile, detect the pieces with the in-browser Brickator YOLO11 model, identify them into a parts list, verify each part, and bag it using pre-printed box/bag QR sheets (admin Batch prep). Inventory can be exported and imported as BrickStore (.bsx) files. Several hosts can use one deployment (each host's data is kept separate).

Runs on Cloudflare Pages + Pages Functions with D1 and KV.

## Layout
- `site/alpha/`: front end (static files, vendored libraries, ONNX model, catalog data)
- `functions/alpha/api/[[path]].js`: API
- `lib/store_d1.js`: D1 storage layer with per-host isolation
- `lib/partslist.js`, `lib/invfile.js`: parts-list building and BSX inventory file import/export

## Deploy your own copy
1. Create a D1 database and bind it as `PTSDB`. Create a KV namespace and bind it as `PTSA`.
2. Set the secret `EXPORT_KEY` (a long random string) to enable the dataset export endpoint.
3. Change the footer source link in `site/alpha/index.html` (currently https://github.com/GreatBrickLab/paidtosort) to the public URL of the source you are running (AGPL-3.0 section 13).
4. `npx wrangler pages deploy site --project-name=<your-project>`

Do not commit ids, tokens or secrets. Set them in the Cloudflare dashboard or with `wrangler secret`.

## Identification service
Part identification calls the third-party Brickognize API, whose terms allow only personal, non-commercial use. This license does not grant you any right to use it. Get permission from Brickognize or swap in another identifier.

## License
AGPL-3.0-or-later. See LICENSE and THIRD_PARTY_NOTICES.md. If you modify this app and let people use it over a network, you must offer them your modified source.
Copyright (C) 2026 Great Brick Lab.
