#!/usr/bin/env bash
# End-to-end test against Tetragon running in Docker (see README "Dev setup").
# Runs effigentd + a mock backend on this machine, fake agents in a container,
# and asserts on what was blocked, reported and shipped.
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT=${OUT:-$(mktemp -d)}
API=http://127.0.0.1:7777
api() { curl -s -H "Authorization: Bearer apitoken" "$@"; }
pass=0; fail=0
ok()   { echo "  PASS  $*"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $*"; fail=$((fail+1)); }
check() { if grep -q -- "$2" "$1"; then ok "$3"; else bad "$3"; fi; }

VM_ARCH=$(docker info --format '{{.Architecture}}'); case $VM_ARCH in aarch64|arm64) VM_ARCH=arm64;; *) VM_ARCH=amd64;; esac
go build -o bin/effigentd ./cmd/effigentd && go build -o bin/mockbackend ./test/endpoint/mockbackend &&
  GOOS=linux GOARCH=$VM_ARCH CGO_ENABLED=0 go build -o bin/effigentd-linux ./cmd/effigentd || exit 1
docker build -q -t effigent-scenario -f test/endpoint/Dockerfile.scenario . >/dev/null || exit 1
docker ps --format '{{.Names}}' | grep -qx tetragon || { echo "tetragon container is not running"; exit 1; }
for port in 7777 9999; do
  lsof -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1 && { echo "port $port is busy (another effigentd/mockbackend running?)"; exit 1; }
done

./bin/mockbackend -out "$OUT/backend.jsonl" -token testtoken >"$OUT/backend.log" 2>&1 & BPID=$!
EFFIGENT_API_TOKEN=apitoken EFFIGENT_BACKEND_TOKEN=testtoken ./bin/effigentd -output json -log-file "$OUT/events.jsonl" \
  -backend-url http://127.0.0.1:9999/ingest >/dev/null 2>"$OUT/effigent.err" & EPID=$!
trap 'kill $EPID $BPID 2>/dev/null; docker rm -f eff-longlived >/dev/null 2>&1' EXIT
sleep 2

echo "== 1. denylist scenario (agent waits 1s before acting)"
docker run --rm effigent-scenario >"$OUT/scenario.txt" 2>&1; sleep 2
check "$OUT/scenario.txt" "curl http=200"                         "curl outside any agent still works"
check "$OUT/scenario.txt" "curl exit=126 (126"                    "agent's curl blocked (exec deny)"
check "$OUT/scenario.txt" "\[mcp-server-github\] curl exit=126"   "MCP server's curl blocked (followForks)"
check "$OUT/scenario.txt" "/etc/shadow exit=1"                    "agent's read of /etc/shadow blocked (file deny)"
check "$OUT/events.jsonl" '"type":"file_open".*"target":"/work/.env"' ".env read reported"
check "$OUT/events.jsonl" '"type":"connect".*1.1.1.1:80'           "raw TCP connect reported"
check "$OUT/events.jsonl" '"via":"mcp:github"'                     "tool calls attributed to mcp:github"
[ "$(grep -c '"type":"file_open".*"/work/.env"' "$OUT/events.jsonl")" = 1 ] && ok "file_open de-duplicated" || bad "file_open de-duplicated"
grep -o 'kernel policies loaded in [0-9]*ms' "$OUT/events.jsonl" | sed 's/^/        /'

echo "== 2. race window: agent acts immediately (AGENT_DELAY=0)"
docker run --rm -e AGENT_DELAY=0 effigent-scenario >"$OUT/race.txt" 2>&1; sleep 2
echo "        agent curl results with no delay: $(grep -o 'curl exit=[0-9]*' "$OUT/race.txt" | tr '\n' ' ')"
echo "        (0 = slipped through before the policy loaded; 126 = blocked)"
check "$OUT/race.txt" "launcher curl exit=126"                      "effigentd run closes the race (blocked with no delay)"
grep -o 'claude-code enforced after [0-9.a-z]*' "$OUT/race.txt" | sed 's/^/        launcher: /'

echo "== 3. hot policy update with curl on a running agent"
docker run -d --name eff-longlived effigent-scenario /opt/ag/claude -c \
  'while :; do [ -e /tmp/go ] && { rm /tmp/go; curl -s -o /dev/null https://example.com; echo "curl exit=$?"; }; sleep 0.2; done' >/dev/null
sleep 3
docker exec eff-longlived touch /tmp/go; sleep 2
api $API/policy | sed '/\/usr\/bin\/curl$/d' > "$OUT/no-curl.yaml"
api -X PUT --data-binary @"$OUT/no-curl.yaml" $API/policy > "$OUT/put.json"
check "$OUT/put.json" '"reapplied_to_agents": 1'                    "PUT /policy re-applied to the live agent"
sleep 1; docker exec eff-longlived touch /tmp/go; sleep 2
api -X PUT --data-binary 'defaults: {mode: allowlist}' $API/policy > "$OUT/bad.json"
check "$OUT/bad.json" 'empty exec_allow'                             "invalid policy rejected (400)"
code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT --data-binary 'defaults: {mode: monitor}' $API/policy)
[ "$code" = 401 ] && ok "PUT /policy without the API token refused (401)" || bad "PUT /policy without the API token refused (got $code)"
docker logs eff-longlived 2>&1 | grep '^curl exit' > "$OUT/longlived.txt"
[ "$(sed -n 1p "$OUT/longlived.txt")" = "curl exit=126" ] && ok "before update: curl blocked" || bad "before update: curl blocked ($(sed -n 1p "$OUT/longlived.txt"))"
[ "$(sed -n 2p "$OUT/longlived.txt")" = "curl exit=0" ]   && ok "after update: curl allowed"  || bad "after update: curl allowed ($(sed -n 2p "$OUT/longlived.txt"))"
docker rm -f eff-longlived >/dev/null; sleep 2

echo "== 4. learn mode -> /learned"
api -X PUT --data-binary @internal/endpoint/policy/default.yaml $API/policy >/dev/null
sed 's/^  mode: denylist/  mode: learn/' internal/endpoint/policy/default.yaml > "$OUT/learn.yaml"
api -X PUT --data-binary @"$OUT/learn.yaml" $API/policy >/dev/null
docker run --rm effigent-scenario >"$OUT/learn-run.txt" 2>&1; sleep 2
check "$OUT/learn-run.txt" "curl exit=0"                             "learn mode does not block"
check "$OUT/events.jsonl" '"type":"would_block".*exec /usr/bin/curl' "learn mode reports would_block for curl"
api $API/learned > "$OUT/learned.json"
check "$OUT/learned.json" '/usr/bin/uname'                           "/learned lists binaries the agent ran"
api -X PUT --data-binary @internal/endpoint/policy/default.yaml $API/policy >/dev/null

echo "== 5. allowlist built from learn mode (via the launcher)"
LAUNCH='effigentd run --agent allowtest --strict -- bash -c'  # fresh agent name: clean /learned
TOOLS='ls / >/dev/null && echo ls-ok; uname >/dev/null && echo uname-ok; curl -s -o /dev/null https://example.com; echo "curl exit=$?"'
api -X PUT --data-binary @"$OUT/learn.yaml" $API/policy >/dev/null
docker run --rm effigent-scenario bash -c "EFFIGENT_RUN_QUIET=1 $LAUNCH 'ls / >/dev/null; uname >/dev/null'" >/dev/null 2>&1; sleep 2
api $API/learned > "$OUT/learned2.json"
# exec_allow = what the agent ran (incl. its own binary via the launcher) + 60 padding entries to test list size
python3 - "$OUT/learned2.json" internal/endpoint/policy/default.yaml > "$OUT/allow.yaml" <<'PY'
import json, sys
learned = json.load(open(sys.argv[1]))["allowtest"]
allow = sorted(set(learned)) + [f"/opt/padding/tool-{i}" for i in range(60)]
pol = open(sys.argv[2]).read()
entry = "  - name: allowtest\n    binary_names: [allowtest-only-via-launcher]\n    mode: allowlist\n    exec_allow:\n" + "".join(f"      - {b}\n" for b in allow)
pol = pol.replace("agents:\n", "agents:\n" + entry, 1)
print(pol)
PY
echo "        exec_allow learned: $(python3 -c 'import json,sys; print(" ".join(json.load(open(sys.argv[1]))["allowtest"]))' "$OUT/learned2.json")"
api -X PUT --data-binary @"$OUT/allow.yaml" $API/policy > "$OUT/put-allow.json"
check "$OUT/put-allow.json" '"ok": true'                              "allowlist policy (learned + 60 entries) accepted"
docker run --rm effigent-scenario bash -c "$LAUNCH '$TOOLS'" > "$OUT/allow-run.txt" 2>&1; sleep 2
check "$OUT/allow-run.txt" "ls-ok"                                    "allowlisted ls runs"
check "$OUT/allow-run.txt" "curl exit=126"                            "non-allowlisted curl blocked"
check "$OUT/events.jsonl" '"type":"blocked".*"agent":"allowtest".*"mode":"allowlist"' "allowlist block reported"
api -X PUT --data-binary @internal/endpoint/policy/default.yaml $API/policy >/dev/null

echo "== 6. backend"
sleep 6
check "$OUT/backend.log" "received batch"                            "backend received batches (bearer token)"
check "$OUT/backend.jsonl" '"type":"blocked"'                         "blocked events shipped to backend"
api $API/agents | grep -q '^\[\]$' && ok "no agents left tracked" || bad "no agents left tracked"

echo; echo "passed $pass, failed $fail   (artifacts: $OUT)"
[ $fail = 0 ]
