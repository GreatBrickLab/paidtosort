# Third-party components

Paid to Sort is AGPL-3.0-or-later (see LICENSE). It includes or calls the components below.

| Component | Version | Location | License | Notes |
|---|---|---|---|---|
| onnxruntime-web (Microsoft) | 1.30.0 | site/alpha/vendor/ort/ | MIT | Include Microsoft's MIT copyright notice. |
| JsBarcode (Johan Lindell) | 3.11.6 | site/alpha/vendor/JsBarcode.min.js | MIT | Header kept. |
| qrcode-generator (Kazuhiko Arase) | 1.4.4 | site/alpha/vendor/qrcode.min.js | MIT | "QR Code" is a registered trademark of DENSO WAVE. |
| Brickator detector weights (YOLO11n-seg "lego_brick") | exported with Ultralytics 8.4.126 | site/alpha/models/brickator-y11n-seg-1024.onnx | AGPL-3.0 (license field in the model's own metadata); the upstream README says MIT but has no LICENSE file | Treat as AGPL-3.0. Get the upstream author to confirm in writing. |
| Ultralytics YOLO11 (architecture, export tools) | 8.4.126 | not bundled (used to produce the weights) | AGPL-3.0 | This is the reason the app is released under AGPL. |
| Rebrickable catalog data | dumps from 2026 | site/alpha/data/ (pc/, palette.json, mold-variants.json) | Rebrickable data terms (free to use, attribution requested) | "Part data from Rebrickable.com". |
| Brickognize identification API | hosted service | functions/alpha/api/[[path]].js (POST https://api.brickognize.com/predict/) | Proprietary service; its terms limit use to personal, non-commercial purposes | NOT covered by this license. Anyone running a deployment needs their own permission. |
| BrickLink catalog images | hotlinked | site/alpha/app.js (img.bricklink.com) | BrickLink/LEGO terms | Not redistributed. |

LEGO® is a trademark of the LEGO Group, which does not sponsor, authorize or endorse this project.
