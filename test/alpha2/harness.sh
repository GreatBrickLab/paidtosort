#!/usr/bin/env bash
# Local throwaway server: fresh local D1 (migrations + 2 test users) under a temp dir, wrangler pages dev, then runs one test script.
# Usage: test/harness.sh <script.(py|mjs)>   MODE=mock (default: canned identification, no outside calls) | MODE=real (crops go to the recognition service)
# One run at a time (lock); everything it created is removed on exit.
set -euo pipefail
SCRIPT=$(realpath "${1:?usage: test/harness.sh <script>}"); cd "$(dirname "$0")/.."; ROOT=$PWD; MODE=${MODE:-mock}
exec 9>/tmp/pts-alpha2-test.lock; flock -n 9 || { echo "another test run is active"; exit 1; }
T=$(mktemp -d /tmp/pts2.XXXX); PORT=$(python3 -c "import socket;s=socket.socket();s.bind(('127.0.0.1',0));print(s.getsockname()[1])"); WR=${WRANGLER:-$(ls -d /home/box/.npm/_npx/*/node_modules/.bin/wrangler 2>/dev/null | head -1)}; [ -x "$WR" ] || WR="npx -y wrangler@3"   # cached wrangler 3 (npx can stall on its update check)
PID=; cleanup() { rc=$?; [ $rc != 0 ] && [ -f "$T/dev.log" ] && tail -20 "$T/dev.log"; [ -n "$PID" ] && kill -- -"$PID" 2>/dev/null; wait 2>/dev/null || true; rm -rf "$T"; rm -f /tmp/pts-alpha2-test.lock; }
trap cleanup EXIT
export CLOUDFLARE_API_TOKEN= CLOUDFLARE_ACCOUNT_ID= WRANGLER_SEND_METRICS=false
printf 'name = "pts2-local"\ncompatibility_date = "2024-09-01"\n[[d1_databases]]\nbinding = "ALPHA2_DB"\ndatabase_name = "pts2-local"\ndatabase_id = "pts2-local"\n' > "$T/wrangler.toml"
{ for f in migrations/*.sql; do cat "$f"; done; node scripts/adduser.mjs sam test-sam-pass Sam; node scripts/adduser.mjs ria test-ria-pass Ria; } > "$T/init.sql"
$WR d1 execute ALPHA2_DB --local --persist-to "$T/state" -c "$T/wrangler.toml" --file "$T/init.sql" >/dev/null
SECRET=$(python3 -c "import secrets;print(secrets.token_hex(24))"); B=(--binding "ALPHA2_SECRET=$SECRET"); [ "$MODE" = mock ] && B+=(--binding IDENTIFY_MOCK=1)
setsid bash -c "cd '$ROOT' && exec $WR pages dev site --port $PORT --ip 127.0.0.1 --persist-to '$T/state' --d1 ALPHA2_DB=pts2-local --compatibility-date 2024-09-01 ${B[*]}" >"$T/dev.log" 2>&1 & PID=$!
for i in $(seq 60); do curl -sf "http://127.0.0.1:$PORT/alpha2/" >/dev/null 2>&1 && break; sleep 1; done
export BASE="http://127.0.0.1:$PORT" MODE OUT="$ROOT/test/out"
case "$SCRIPT" in *.mjs) node "$SCRIPT";; *) python3 "$SCRIPT";; esac
