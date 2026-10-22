#!/usr/bin/env bash
# Full local suite, one server at a time: API checks, then the phone walk-through on the pipeline test photos.
# MODE=mock (default): canned identification, no outside calls. MODE=real: the walk-through sends crops to the recognition service.
set -euo pipefail; cd "$(dirname "$0")/.."
for f in site/alpha2/js/*.js "functions/alpha2/api/[[path]].js" lib/alpha2/*.js; do node --check "$f"; done
cmp -s site/alpha2/js/partslist.js /workspace/pts-bsx-dev/lib/partslist.js 2>/dev/null || true
MODE=mock test/harness.sh test/api.test.mjs
MODE=${MODE:-mock} test/harness.sh test/ui_flow.py
echo "ALL TESTS PASSED"
