#!/usr/bin/env bash
# Approval flow end to end, the way it runs on a Mac: the real hook process
# (`effigentd hook claude`, fed Claude Code's PreToolUse JSON) -> effigentd in
# hooks mode, enrolled in a local control plane -> an approver deciding
# through the console API. No Tetragon, no Docker, no sudo.
# Needs local Postgres (docker compose up -d postgres).
set -uo pipefail
cd "$(dirname "$0")/../.."
W=$(mktemp -d); CP=127.0.0.1:${CP_PORT:-8090}; EP=127.0.0.1:${EP_PORT:-7797}
T=org:hook-test-$$; A=(-H "Authorization: Bearer devadmin" -H "X-Effigent-Tenant: $T")
pass=0; fail=0
ok()  { echo "  PASS  $*"; pass=$((pass+1)); }
bad() { echo "  FAIL  $*"; fail=$((fail+1)); }

go build -o bin/effigent-cp ./cmd/effigent-cp && go build -o bin/effigentd ./cmd/effigentd || exit 1
DATABASE_URL=${DATABASE_URL:-postgres://effigent:effigent@localhost:5433/effigent} EFFIGENT_ADMIN_TOKEN=devadmin \
  EFFIGENT_ADMIN_TENANTS=$T EFFIGENT_CONSOLE_ORIGIN=http://console.test \
  ./bin/effigent-cp -listen $CP -key-file "$W/signing.key" >"$W/cp.log" 2>&1 & CPID=$!
trap 'kill $CPID ${EPID:-} 2>/dev/null; rm -rf "$W"' EXIT
for i in $(seq 1 50); do curl -s "http://$CP/healthz" >/dev/null && break; sleep 0.2; done

TOK=$(curl -s "${A[@]}" -X POST "http://$CP/api/v1/enrollment-tokens" -d '{}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"]["token"])')
./bin/effigentd enroll --server "http://$CP" --token "$TOK" --state-dir "$W/ep" >/dev/null || exit 1
./bin/effigentd -sensor hooks --state-dir "$W/ep" --listen $EP --output none --log-file "$W/events.jsonl" \
  -sync-interval 1s 2>"$W/ep.err" & EPID=$!

# denylist (curl denied) + approvals for `git push*` and GitHub MCP tools; short waits for the test
sed -e 's|^  mode: denylist$|  mode: denylist\n  command_approve: ["git push*"]\n  tool_approve: ["mcp__github__*"]|' \
  internal/endpoint/policy/default.yaml > "$W/policy.yaml"
printf 'approvals:\n  wait_seconds: 4\n  ttl_minutes: 10\n' >> "$W/policy.yaml"
python3 -c 'import json,sys;print(json.dumps({"body":open(sys.argv[1]).read(),"comment":"approvals test"}))' "$W/policy.yaml" |
  curl -s "${A[@]}" -X PUT "http://$CP/api/v1/policy" --data-binary @- >"$W/put.json"
for i in $(seq 1 50); do
  curl -s "http://$EP/health" | grep -q '"policy_version": *[1-9]' && break; sleep 0.2
done
curl -s "http://$EP/health" | grep -q '"policy_version": *[1-9]' && ok "policy with approval lists reached the endpoint" || { bad "policy not applied: $(cat "$W/put.json" "$W/ep.err")"; exit 1; }

hook() { # tool, input-json -> the hook's stdout
  printf '{"session_id":"sess-1","cwd":"/work","tool_name":"%s","tool_input":%s}' "$1" "$2" |
    EFFIGENT_API=$EP ./bin/effigentd hook claude
}
bash_hook() { hook Bash "{\"command\":\"$1\"}"; }
pending() { curl -s "${A[@]}" "http://$CP/api/v1/approvals?state=pending"; }
decide() { curl -s -o /dev/null -w '%{http_code}' "${A[@]}" -X POST "http://$CP/api/v1/approvals/$1/decision" \
  -d "{\"decision\":\"$2\",\"note\":\"$3\",\"name\":\"Sam Sec\"}"; }
first_id() { python3 -c 'import json,sys; a=json.load(sys.stdin); print(a[0]["id"] if a else "")'; }

echo "== allow / deny unchanged"
[ "$(bash_hook 'git status')" = "{}" ] && ok "git status runs" || bad "git status"
bash_hook 'curl -s x' | grep -q '"permissionDecision":"deny"' && ok "curl denied (exec_deny)" || bad "curl not denied"

echo "== approval needed, nobody answers"
t0=$(date +%s); out=$(bash_hook 'git push origin main'); dt=$(( $(date +%s) - t0 ))
echo "$out" | grep -q '"permissionDecision":"deny"' && echo "$out" | grep -q 'pending' && ok "git push paused, then told it is pending" || bad "pending: $out"
[ $dt -ge 3 ] && [ $dt -le 15 ] && ok "hook waited for an approver (${dt}s)" || bad "wait was ${dt}s"
ID=$(pending | first_id)
[ -n "$ID" ] && ok "request $ID listed for approvers" || bad "no pending request"
out=$(bash_hook 'git push origin main')
[ "$(pending | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))')" = 1 ] && ok "retry reuses the request" || bad "retry made a new request"

echo "== approved"
[ "$(decide "$ID" approve 'release day')" = 200 ] && ok "approver approved" || bad "approve failed"
t0=$(date +%s); out=$(bash_hook 'git push origin main')
[ "$out" = "{}" ] && [ $(( $(date +%s) - t0 )) -le 2 ] && ok "the same command now runs" || bad "after approval: $out"
out=$(bash_hook 'git push origin main')
echo "$out" | grep -q 'pending' && ok "the approval was single-use" || bad "approval reused: $out"
bash_hook 'git push origin other' | grep -q 'pending' && ok "a different command is a new request" || bad "different command"

echo "== approved while the agent waits"
NEW=$(printf '{"session_id":"sess-1","cwd":"/work","tool_name":"Bash","tool_input":{"command":"git push --tags"}}')
( printf '%s' "$NEW" | EFFIGENT_API=$EP ./bin/effigentd hook claude > "$W/wait.out" ) & HP=$!
for i in $(seq 1 30); do
  ID2=$(pending | python3 -c 'import json,sys; print(next((a["id"] for a in json.load(sys.stdin) if "--tags" in a["summary"]), ""))')
  [ -n "$ID2" ] && break; sleep 0.2
done
decide "$ID2" approve '' >/dev/null; wait $HP
[ "$(cat "$W/wait.out")" = "{}" ] && ok "approved during the wait: the call ran without a retry" || bad "wait: $(cat "$W/wait.out")"

echo "== denied (MCP tool)"
MCP='{"owner":"acme","repo":"web","title":"x"}'
hook mcp__github__create_issue "$MCP" | grep -q 'pending' && ok "GitHub MCP tool paused" || bad "mcp not paused"
ID3=$(pending | python3 -c 'import json,sys; print(next((a["id"] for a in json.load(sys.stdin) if a["tool"].startswith("mcp__github")), ""))')
decide "$ID3" deny 'not from an agent' >/dev/null
out=$(hook mcp__github__create_issue "$MCP")
echo "$out" | grep -q 'denied this action' && echo "$out" | grep -q 'not from an agent' && ok "denial reaches the agent with the note" || bad "deny: $out"
[ "$(hook mcp__linear__create_issue '{}')" = "{}" ] && ok "other MCP servers untouched" || bad "linear"

echo "== events"
sleep 1
for t in approval_pending approved approval_denied; do
  grep -q "\"type\":\"$t\"" "$W/events.jsonl" && ok "event $t recorded" || bad "no $t event"
done
grep -q '"type":"approved".*Sam Sec' "$W/events.jsonl" && ok "approver named in the event" || bad "approver name"

echo
echo "passed $pass, failed $fail"
[ $fail = 0 ]
