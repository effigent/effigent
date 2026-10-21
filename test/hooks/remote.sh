#!/usr/bin/env bash
# Remote hook mode end to end (docs/cloud-agents.md): a cloud environment
# created through the console API, then the real hook process
# (`effigentd hook claude|copilot --remote`, no daemon anywhere) deciding
# tool calls against the local control plane with the environment's token:
# deny, approval round trip, events stored under the environment, the
# setup step (`effigentd cloud-setup`), and what happens when the control
# plane is gone (cached policy still enforces; nothing cached -> deny, or
# the built-in policy with EFFIGENT_REMOTE_FAIL_OPEN=1).
# Needs local Postgres (docker compose up -d postgres). No Docker, no sudo.
set -uo pipefail
cd "$(dirname "$0")/../.."
W=$(mktemp -d); CP=127.0.0.1:${CP_PORT:-8091}
T=org:remote-test-$$; A=(-H "Authorization: Bearer devadmin" -H "X-Effigent-Tenant: $T")
pass=0; fail=0
ok()  { echo "  PASS  $*"; pass=$((pass+1)); }
bad() { echo "  FAIL  $*"; fail=$((fail+1)); }

go build -o bin/effigent-cp ./cmd/effigent-cp && go build -o bin/effigentd ./cmd/effigentd || exit 1
start_cp() {
  DATABASE_URL=${DATABASE_URL:-postgres://effigent:effigent@localhost:5433/effigent} EFFIGENT_ADMIN_TOKEN=devadmin \
    EFFIGENT_ADMIN_TENANTS=$T EFFIGENT_CONSOLE_ORIGIN=http://console.test \
    ./bin/effigent-cp -listen $CP -key-file "$W/signing.key" >>"$W/cp.log" 2>&1 & CPID=$!
  for i in $(seq 1 50); do curl -s "http://$CP/healthz" >/dev/null && return; sleep 0.2; done
}
start_cp
trap 'kill ${CPID:-} 2>/dev/null; rm -rf "$W"' EXIT

echo "== cloud environment"
curl -s "${A[@]}" -X POST "http://$CP/api/v1/cloud-environments" -d '{"name":"acme/web","vendor":"claude-code-web"}' >"$W/env.json"
TOKEN=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["token"])' "$W/env.json")
EPID_=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["endpoint"]["id"])' "$W/env.json")
case "$TOKEN" in efc_*) ok "created, token shown once" ;; *) bad "create: $(cat "$W/env.json")"; exit 1 ;; esac

sed -e 's|^  mode: denylist$|  mode: denylist\n  command_approve: ["git push*"]|' internal/endpoint/policy/default.yaml > "$W/policy.yaml"
printf 'approvals:\n  wait_seconds: 4\n  ttl_minutes: 10\n' >> "$W/policy.yaml"
python3 -c 'import json,sys;print(json.dumps({"body":open(sys.argv[1]).read(),"comment":"remote test"}))' "$W/policy.yaml" |
  curl -s "${A[@]}" -X PUT "http://$CP/api/v1/policy" --data-binary @- >"$W/put.json"

# Every call is a fresh process, as in a cloud session; the state dir is the session's.
S1="$W/session1"
hook() { # agent, tool, input-json [env...] -> the hook's stdout
  local agent=$1 tool=$2 input=$3; shift 3
  printf '{"session_id":"cloud-1","cwd":"%s","tool_name":"%s","tool_input":%s}' "$W" "$tool" "$input" |
    env EFFIGENT_STATE_DIR="${SD:-$S1}" EFFIGENT_CLOUD_TOKEN="$TOKEN" "$@" ./bin/effigentd hook "$agent" --remote
}
bash_hook() { local c=$1; shift; hook claude Bash "{\"command\":\"$c\"}" "$@"; }
pending() { curl -s "${A[@]}" "http://$CP/api/v1/approvals?state=pending"; }
decide() { curl -s -o /dev/null -w '%{http_code}' "${A[@]}" -X POST "http://$CP/api/v1/approvals/$1/decision" \
  -d "{\"decision\":\"$2\",\"note\":\"$3\",\"name\":\"Sam Sec\"}"; }
first_id() { python3 -c 'import json,sys; a=json.load(sys.stdin); print(a[0]["id"] if a else "")'; }

echo "== decisions in the hook process"
[ "$(bash_hook 'git status')" = "{}" ] && ok "git status runs" || bad "git status"
[ -s "$S1/policy.json" ] && ok "signed policy cached in the state dir" || bad "no policy cache"
bash_hook 'curl -s https://x.example' | grep -q '"permissionDecision":"deny"' && ok "curl denied (exec_deny)" || bad "curl not denied"
hook claude Read '{"file_path":"/etc/shadow"}' | grep -q '"permissionDecision":"deny"' && ok "/etc/shadow read denied (file_deny)" || bad "shadow"

echo "== approval round trip"
out=$(bash_hook 'git push origin main')
echo "$out" | grep -q 'pending' && ok "git push paused: pending" || bad "pending: $out"
ID=$(pending | first_id)
[ -n "$ID" ] && ok "request $ID listed for approvers" || bad "no pending request"
pending | grep -q "\"endpoint_id\": *\"$EPID_\"" && ok "filed under the cloud environment" || bad "approval endpoint: $(pending)"
[ "$(decide "$ID" approve 'ok')" = 200 ] && ok "approved" || bad "approve failed"
[ "$(bash_hook 'git push origin main')" = "{}" ] && ok "the same command now runs" || bad "after approval"
bash_hook 'git push origin main' | grep -q 'pending' && ok "single-use" || bad "approval reused"

echo "== GitHub Copilot (preToolUse, arguments as a JSON string)"
cop() { printf '{"sessionId":"cop-1","timestamp":1760000000000,"cwd":"%s","toolName":"%s","toolArgs":%s}' "$W" "$1" "$2" |
  env EFFIGENT_STATE_DIR="$S1" EFFIGENT_CLOUD_TOKEN="$TOKEN" ./bin/effigentd hook copilot --remote; }
[ "$(cop bash '"{\"command\":\"ls -la\"}"')" = "{}" ] && ok "copilot: ordinary command runs" || bad "copilot ls"
cop bash '"{\"command\":\"curl -s x\"}"' | grep -q '"permissionDecision":"deny","permissionDecisionReason":"Blocked by Effigent' && ok "copilot: curl denied (flat answer)" || bad "copilot curl"
cop view '"{\"path\":\"/etc/shadow\"}"' | grep -q '"permissionDecision":"deny"' && ok "copilot: view /etc/shadow denied" || bad "copilot view"

echo "== events"
sleep 1
curl -s "${A[@]}" "http://$CP/api/v1/events?paged=1&endpoint=$EPID_&limit=200" >"$W/ev.json"
python3 - "$W/ev.json" <<'PY' >"$W/ev.txt"
import json, sys
d = json.load(open(sys.argv[1]))
for e in d.get("events", []):
    print(e.get("type"), e.get("agent"), (e.get("body") or {}).get("target", "")[:60])
PY
grep -q '^agent_start claude-code' "$W/ev.txt" && ok "session start recorded" || bad "no agent_start: $(head -3 "$W/ev.txt")"
[ "$(grep -c '^agent_start claude-code' "$W/ev.txt")" = 1 ] && ok "once per session, across processes" || bad "agent_start count $(grep -c '^agent_start claude-code' "$W/ev.txt")"
grep -q '^blocked claude-code Bash: curl' "$W/ev.txt" && ok "blocked call recorded" || bad "no blocked event: $(cat "$W/ev.txt")"
grep -q '^approved claude-code' "$W/ev.txt" && ok "approval recorded" || bad "no approved event"
grep -q '^blocked copilot-agent' "$W/ev.txt" && ok "copilot calls recorded" || bad "no copilot event"
curl -s "${A[@]}" "http://$CP/api/v1/endpoints" | python3 -c '
import json,sys
e=[x for x in json.load(sys.stdin) if x["id"]==sys.argv[1]][0]
assert e["kind"]=="cloud" and e["policy_version"]>=1, e' "$EPID_" && ok "listed as cloud, policy version reported" || bad "endpoint listing"

echo "== setup step"
S2="$W/session2"
env -u EFFIGENT_CLOUD_TOKEN ./bin/effigentd cloud-setup --token "$TOKEN" --state-dir "$S2" >"$W/setup.out" 2>&1 && grep -q 'ready (policy v' "$W/setup.out" &&
  ok "cloud-setup saved credentials and the policy" || bad "cloud-setup: $(cat "$W/setup.out")"
out=$(printf '{"session_id":"s2","cwd":"/w","tool_name":"Bash","tool_input":{"command":"curl x"}}' | env -u EFFIGENT_CLOUD_TOKEN EFFIGENT_STATE_DIR="$S2" ./bin/effigentd hook claude --remote)
echo "$out" | grep -q '"permissionDecision":"deny"' && ok "hook without the token in its environment uses the saved one" || bad "saved creds: $out"
./bin/effigentd cloud-setup --token efc_junk --state-dir "$W/x" >/dev/null 2>&1; [ $? -ne 0 ] && ok "a bad token fails the setup step" || bad "bad token accepted"

echo "== control plane gone"
kill $CPID; wait $CPID 2>/dev/null; CPID=
bash_hook 'curl -s x' | grep -q '"permissionDecision":"deny"' && ok "cached policy still enforces (curl denied)" || bad "offline cached"
[ "$(bash_hook 'git status' EFFIGENT_REMOTE_REFRESH=0s)" = "{}" ] && ok "and allows the rest" || bad "offline allow"
ls "$S1/spool/"*.json >/dev/null 2>&1 && ok "events spooled while offline" || bad "nothing spooled"
t0=$(date +%s); out=$(SD="$W/fresh" bash_hook 'git status'); dt=$(( $(date +%s) - t0 ))
echo "$out" | grep -q '"permissionDecision":"deny".*no Effigent policy' && ok "nothing cached: denied (fail closed, ${dt}s)" || bad "fail closed: $out"
[ "$(SD="$W/fresh2" bash_hook 'git status' EFFIGENT_REMOTE_FAIL_OPEN=1)" = "{}" ] && ok "EFFIGENT_REMOTE_FAIL_OPEN=1: built-in policy decides (git status runs)" || bad "fail open allow"
SD="$W/fresh3" bash_hook 'curl -s x' EFFIGENT_REMOTE_FAIL_OPEN=1 | grep -q '"permissionDecision":"deny"' && ok "  ... and still denies curl" || bad "fail open deny"
printf '{}' | env -u EFFIGENT_CLOUD_TOKEN EFFIGENT_STATE_DIR="$W/none" ./bin/effigentd hook claude --remote | grep -q 'no Effigent credentials' && ok "no credentials: denied" || bad "no creds"

echo "== back online: the spool drains"
start_cp
n0=$(ls "$S1/spool/"*.json 2>/dev/null | wc -l | tr -d ' ')
bash_hook 'git status' EFFIGENT_REMOTE_REFRESH=0s >/dev/null
n1=$(ls "$S1/spool/"*.json 2>/dev/null | wc -l | tr -d ' ')
[ "$n0" -ge 1 ] && [ "$n1" = 0 ] && ok "spooled batches sent ($n0)" || bad "spool $n0 -> $n1"

echo "== revoked"
curl -s -o /dev/null "${A[@]}" -X DELETE "http://$CP/api/v1/endpoints/$EPID_"
SD="$W/fresh4" bash_hook 'git status' | grep -q '"permissionDecision":"deny"' && ok "a revoked environment's token gets no policy: denied" || bad "revoked"

echo
echo "$pass passed, $fail failed"
[ $fail = 0 ]
