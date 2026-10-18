#!/usr/bin/env bash
# Real Claude Code under effigentd + Tetragon, managed by the control plane.
# Needs: the dev `tetragon` container (CLAUDE.md §4), local Postgres (docker compose up -d postgres),
# and ~/.effigent-claude.env with CLAUDE_CODE_OAUTH_TOKEN=… (from `claude setup-token`).
set -euo pipefail
cd "$(dirname "$0")/../.."
W=$(mktemp -d); A=(-H "Authorization: Bearer devadmin" -H "X-Effigent-Tenant: org:claude-test")
go build -o bin/effigent-cp ./cmd/effigent-cp && go build -o bin/effigentd ./cmd/effigentd
docker build -q -t effigent-claude test/claude >/dev/null
DATABASE_URL=${DATABASE_URL:-postgres://effigent:effigent@localhost:5433/effigent} EFFIGENT_ADMIN_TOKEN=devadmin EFFIGENT_ADMIN_TENANTS=org:claude-test \
  ./bin/effigent-cp -listen 127.0.0.1:8080 -key-file "$W/signing.key" >"$W/cp.log" 2>&1 & CP=$!
trap 'kill $CP ${EP:-} 2>/dev/null' EXIT; sleep 2
TOK=$(curl -s "${A[@]}" -X POST localhost:8080/api/v1/enrollment-tokens -d '{"label":"claude-test"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"]["token"])')
./bin/effigentd enroll --server http://127.0.0.1:8080 --token "$TOK" --state-dir "$W/ep"
./bin/effigentd -sensor tetragon --state-dir "$W/ep" --listen 127.0.0.1:7799 --output pretty >"$W/ep.out" 2>"$W/ep.err" & EP=$!
publish() { python3 -c 'import json,sys;print(json.dumps({"body":open(sys.argv[1]).read(),"comment":sys.argv[2]}))' "$1" "$2" |
  curl -s "${A[@]}" -X PUT localhost:8080/api/v1/policy --data-binary @- >/dev/null; sleep 8; }
ask() { echo "$1" | docker run -i --rm --env-file ~/.effigent-claude.env effigent-claude claude -p --allowedTools=Bash,Read 2>&1 | tail -4; }
publish internal/endpoint/policy/default.yaml "deny curl"
echo "== policy: curl denied";  ask "Run: curl -sS -o /dev/null -w '%{http_code}' https://example.com and report the exact output and exit code in one line."
sed '/\/usr\/bin\/curl$/d' internal/endpoint/policy/default.yaml > "$W/allow.yaml"; publish "$W/allow.yaml" "allow curl"
echo "== policy: curl allowed"; ask "Run: curl -sS -o /dev/null -w '%{http_code}' https://example.com and report the exact output and exit code in one line."
echo "== events in the control plane:"
curl -s "${A[@]}" "localhost:8080/api/v1/events?type=blocked&limit=5" | python3 -c 'import json,sys;[print(" ",e["time"][:19],e["type"],e["agent"],e["body"].get("target")) for e in json.load(sys.stdin)]'
