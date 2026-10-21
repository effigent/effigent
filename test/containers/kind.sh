#!/usr/bin/env bash
# Effigent on Kubernetes: a 2-node kind cluster with the official Tetragon chart and
# deploy/helm/effigent, enrolled with a local control plane. A pod that acts like an
# agent runs curl and reads .env under a policy that denies both; the blocks must
# reach the control plane (what the console shows) under the node's name.
# Needs: Docker (Desktop) with a BTF + BPF LSM kernel, kind, helm, kubectl, local
# Postgres (docker compose up -d postgres). Only one Tetragon per kernel: stop the
# dev `tetragon` container and deploy/docker first. KEEP=1 leaves the cluster up
# (delete it with `kind delete cluster --name effigent-test` before the next run).
# PUBLISHED=1 installs what a customer gets — the chart from https://effigent.ai/charts
# and the image from ghcr.io — instead of local builds (a release check).
set -euo pipefail
cd "$(dirname "$0")/../.."
. test/containers/lib.sh
CLUSTER=effigent-test; K=(kubectl --context "kind-$CLUSTER")

require_one_tetragon
trap 'stop_cp; [ -n "${KEEP:-}" ] || kind delete cluster --name '"$CLUSTER"' 2>/dev/null' EXIT
start_cp
build_images
publish_test_policy
TOK=$(enroll_token 2)

kind create cluster --config test/containers/kind.yaml
if [ -n "${PUBLISHED:-}" ]; then
  kind load docker-image effigent-agent:test --name "$CLUSTER" >/dev/null
  helm repo add effigent https://effigent.ai/charts --force-update >/dev/null && helm repo update effigent >/dev/null
  CHART=(effigent/effigent); IMAGE=()
else
  kind load docker-image effigentd:dev effigent-agent:test --name "$CLUSTER" >/dev/null
  CHART=(deploy/helm/effigent); IMAGE=(--set image.repository=effigentd --set image.tag=dev --set image.pullPolicy=Never)
fi
helm repo add cilium https://helm.cilium.io >/dev/null 2>&1 || true
helm --kube-context "kind-$CLUSTER" upgrade --install tetragon cilium/tetragon --version 1.7.1 -n kube-system \
  --set tetragon.grpc.address=localhost:54321 --set 'tetragon.processAncestors.enabled=base\,kprobe\,lsm' --wait >/dev/null
"${K[@]}" create namespace effigent --dry-run=client -o yaml | "${K[@]}" apply -f - >/dev/null
"${K[@]}" -n effigent create secret generic effigent-enrollment --from-literal=token="$TOK" --dry-run=client -o yaml | "${K[@]}" apply -f - >/dev/null
helm --kube-context "kind-$CLUSTER" upgrade --install effigent "${CHART[@]}" -n effigent \
  --set server="http://host.docker.internal:$CP_PORT" ${IMAGE[@]+"${IMAGE[@]}"} >/dev/null
"${K[@]}" -n effigent rollout status ds/effigent --timeout 120s >/dev/null

echo "== one machine per node"
wait_endpoints 2
check "endpoints named after the nodes" "$(endpoint_names)" "effigent-test-control-plane effigent-test-worker"

agent() { # name, command…: run a pod on the worker and print its log
  "${K[@]}" delete pod "$1" --ignore-not-found --wait >/dev/null
  "${K[@]}" run "$1" --image=effigent-agent:test --image-pull-policy=Never --restart=Never \
    --overrides='{"spec":{"nodeName":"effigent-test-worker"}}' --command -- "${@:2}" >/dev/null
  "${K[@]}" wait --for=jsonpath='{.status.phase}'=Succeeded "pod/$1" --timeout 90s >/dev/null || true
  "${K[@]}" logs "$1"
}
echo "== detected agent (policy loads ~1-2s after it starts)"
out=$(agent agent-detected /opt/ag/claude -c "sleep 6; $AGENT_ACTIONS"); echo "$out"
check "curl blocked" "$(grep -c 'curl exit=126' <<<"$out")" 1
check ".env blocked" "$(grep -c 'cat .env exit=1' <<<"$out")" 1
echo "== agent started through effigentd run (zero gap)"
out=$(agent agent-run effigentd run --agent claude-code --strict -- /opt/ag/claude -c "$AGENT_ACTIONS"); echo "$out"
check "curl blocked" "$(grep -c 'curl exit=126' <<<"$out")" 1
check ".env blocked" "$(grep -c 'cat .env exit=1' <<<"$out")" 1

echo "== blocks in the control plane"
sleep 4 # events ship every 2s
check "curl block from the worker" "$(blocked_count 'exec /usr/bin/curl' effigent-test-worker)" 2
check ".env block from the worker" "$(blocked_count /work/.env effigent-test-worker)" 2

echo "== hooks in a pod reach the node's daemon (hook socket), events name the pod"
"${K[@]}" apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata: {name: agent-hook, namespace: default}
spec:
  nodeName: effigent-test-worker
  containers:
    - name: agent
      image: effigent-agent:test
      imagePullPolicy: Never
      command: [/opt/ag/claude, -c, "sleep 3600"]
      env: [{name: EFFIGENT_HOOK_SOCKET, value: /var/run/effigent/hook.sock}]
      volumeMounts: [{name: effigent-hooks, mountPath: /var/run/effigent}]
  volumes: [{name: effigent-hooks, hostPath: {path: /var/run/effigent, type: Directory}}]
EOF
"${K[@]}" wait --for=condition=Ready pod/agent-hook --timeout 90s >/dev/null
out=$("${K[@]}" exec agent-hook -- sh -c 'printf "{\"session_id\":\"k1\",\"cwd\":\"/work\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"curl -s https://example.com\"}}" | effigentd hook claude')
check "curl denied through the hook socket" "$(grep -c '"permissionDecision":"deny"' <<<"$out")" 1
sleep 4
check "the hook's block names the pod (Tetragon pod info)" "$(curl -sf "${A[@]}" "$CP/events?type=blocked&limit=200" |
  python3 -c 'import json,sys;print(sum(1 for e in json.load(sys.stdin) if e["body"].get("rule")=="exec_deny" and e["body"].get("pod")=="default/agent-hook"))')" 1

echo "== a restarted pod stays the same machine"
"${K[@]}" -n effigent delete pod -l app.kubernetes.io/instance=effigent --wait >/dev/null
"${K[@]}" -n effigent rollout status ds/effigent --timeout 120s >/dev/null; sleep 3
check "still 2 endpoints" "$(endpoint_names | wc -w | tr -d ' ')" 2
summary
