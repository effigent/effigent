#!/usr/bin/env bash
# Agent hooks inside Kubernetes pods: the chart's hook socket (hostPath
# /var/run/effigent) lets an agent pod's `effigentd hook claude` reach the node's
# effigentd. A stand-in agent pod (running as uid 1234, which has no name in its
# image) calls the real hook binary: curl is denied, `git push` waits for an
# approval that the script gives through the console API, and the events reach
# the control plane with the caller's container id and kernel uid, not anything
# the hook claimed.
#
# Runs without Tetragon (effigentd -sensor=hooks), so it can run next to the dev
# `tetragon` container; pod *names* come from Tetragon's pod info and are checked
# by kind.sh instead (here the pod is known by its uid, from the cgroup).
# Needs: Docker (Desktop), kind, helm, kubectl, local Postgres. KEEP=1 leaves the
# cluster up (kind delete cluster --name effigent-hooks).
set -euo pipefail
cd "$(dirname "$0")/../.."
. test/containers/lib.sh
CLUSTER=effigent-hooks; K=(kubectl --context "kind-$CLUSTER")

trap 'stop_cp; [ -n "${KEEP:-}" ] || kind delete cluster --name '"$CLUSTER"' >/dev/null 2>&1' EXIT
kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true
start_cp
build_images
# denylist (curl denied) + an approval list, with a short wait for the test
sed -e 's|^  mode: denylist$|  mode: denylist\n  command_approve: ["git push*"]|' internal/endpoint/policy/default.yaml >"$W/policy.yaml"
printf 'approvals:\n  wait_seconds: 3\n  ttl_minutes: 10\n' >>"$W/policy.yaml"
python3 -c 'import json,sys;print(json.dumps({"body":open(sys.argv[1]).read(),"comment":"hook socket test"}))' "$W/policy.yaml" |
  curl -sf "${A[@]}" -X PUT "$CP/policy" --data-binary @- >/dev/null
TOK=$(enroll_token 2)

sed -e "s/name: effigent-test/name: $CLUSTER/" test/containers/kind.yaml >"$W/kind.yaml"
kind create cluster --config "$W/kind.yaml" >/dev/null 2>&1
kind load docker-image effigentd:dev effigent-agent:test --name "$CLUSTER" >/dev/null
"${K[@]}" create namespace effigent >/dev/null
"${K[@]}" -n effigent create secret generic effigent-enrollment --from-literal=token="$TOK" >/dev/null
helm --kube-context "kind-$CLUSTER" upgrade --install effigent deploy/helm/effigent -n effigent \
  --set server="http://host.docker.internal:$CP_PORT" --set image.repository=effigentd --set image.tag=dev \
  --set image.pullPolicy=Never --set 'extraArgs={-sensor=hooks,-sync-interval=1s}' >/dev/null
"${K[@]}" -n effigent rollout status ds/effigent --timeout 120s >/dev/null
wait_endpoints 2

echo "== an agent pod with the hook socket mounted"
"${K[@]}" apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata: {name: agent, namespace: default}
spec:
  nodeName: $CLUSTER-worker
  securityContext: {runAsUser: 1234}
  containers:
    - name: agent
      image: effigent-agent:test
      imagePullPolicy: Never
      command: [sleep, "3600"]
      env: [{name: EFFIGENT_HOOK_SOCKET, value: /var/run/effigent/hook.sock}]
      volumeMounts: [{name: effigent-hooks, mountPath: /var/run/effigent}]
  volumes: [{name: effigent-hooks, hostPath: {path: /var/run/effigent, type: Directory}}]
EOF
"${K[@]}" wait --for=condition=Ready pod/agent --timeout 90s >/dev/null
CID=$("${K[@]}" get pod agent -o jsonpath='{.status.containerStatuses[0].containerID}'); CID=${CID#*://}
for _ in $(seq 30); do # the node's daemon has the policy once a deny comes back
  "${K[@]}" exec agent -- sh -c 'printf "{\"session_id\":\"s1\",\"cwd\":\"/work\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"curl -s https://example.com\"}}" | effigentd hook claude' >"$W/deny.out" 2>&1 || true
  grep -q '"permissionDecision":"deny"' "$W/deny.out" && grep -q 'curl' "$W/deny.out" && break; sleep 1
done
check "curl in the pod is denied by the node's daemon" "$(grep -c '"permissionDecision":"deny"' "$W/deny.out")" 1

hook_push() {
  "${K[@]}" exec agent -- sh -c 'printf "{\"session_id\":\"s1\",\"cwd\":\"/work\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git push origin feature\"}}" | effigentd hook claude'
}
echo "== approval round trip"
out=$(hook_push); grep -q 'pending' <<<"$out" && check "git push waits for an approval" pending pending || check "git push waits for an approval" "$out" pending
ID=$(curl -sf "${A[@]}" "$CP/approvals?state=pending" | python3 -c 'import json,sys;d=json.load(sys.stdin);a=d if isinstance(d,list) else d.get("approvals",[]);print(a[0]["id"] if a else "")')
check "one pending request" "$([ -n "$ID" ] && echo yes)" yes
check "approver approves" "$(curl -s -o /dev/null -w '%{http_code}' "${A[@]}" -X POST "$CP/approvals/$ID/decision" -d '{"decision":"approve","note":"ok","name":"Sam Sec"}')" 200
check "the same call now runs" "$(hook_push)" "{}"
check "the request records the kernel's uid" "$(curl -sf "${A[@]}" "$CP/approvals/$ID" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("os_user",""))')" uid:1234

echo "== events carry the container, the pod and the kernel's uid"
sleep 4 # events ship every 2s
curl -sf "${A[@]}" "$CP/events?limit=200" | python3 -c '
import json, sys
cid = sys.argv[1]
evs = [e["body"] for e in json.load(sys.stdin) if e["body"].get("rule") in ("hook", "exec_deny", "command_approve") or e["body"].get("type") in ("blocked", "approved")]
mine = [e for e in evs if e.get("container") == cid]
print("events", len(mine) > 0)
print("os_user", sorted({e.get("os_user") for e in mine}))
print("pod", all(e.get("pod", "").startswith("uid:") or e.get("pod") == "default/agent" for e in mine))
print("blocked", sum(1 for e in mine if e["type"] == "blocked"))
print("approved", sum(1 for e in mine if e["type"] == "approved"))
' "$CID" >"$W/ev.txt"
cat "$W/ev.txt"
check "events from the agent's container" "$(grep -c '^events True' "$W/ev.txt")" 1
check "os_user is the kernel's uid" "$(grep -c "^os_user \['uid:1234'\]" "$W/ev.txt")" 1
check "pod known (uid without Tetragon)" "$(grep -c '^pod True' "$W/ev.txt")" 1
check "the deny is a blocked event" "$(grep -c '^blocked [1-9]' "$W/ev.txt")" 1
check "the approval is recorded" "$(grep -c '^approved 1' "$W/ev.txt")" 1

echo "== a pod without the socket fails closed"
out=$("${K[@]}" exec agent -- sh -c 'printf "{\"session_id\":\"s1\",\"cwd\":\"/work\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls\"}}" | EFFIGENT_HOOK_SOCKET=/nope.sock effigentd hook claude')
check "no daemon -> deny" "$(grep -c '"permissionDecision":"deny"' <<<"$out")" 1
summary
