#!/usr/bin/env bash
# Effigent on a plain Docker host: deploy/docker/compose.yaml (Tetragon + effigentd)
# enrolled with a local control plane. A container that acts like an agent runs curl
# and reads .env under a policy that denies both; the blocks must reach the control
# plane (what the console shows). Needs: Docker (Desktop) with a BTF + BPF LSM
# kernel and local Postgres (docker compose up -d postgres). Only one Tetragon per
# kernel: stop the dev `tetragon` container and the kind test's cluster first.
set -euo pipefail
cd "$(dirname "$0")/../.."
. test/containers/lib.sh
STATE="/var/lib/effigent-test/$(date +%s)" # on the Docker host; a fresh machine per run
DC=(docker compose -p effigent-test -f deploy/docker/compose.yaml)

require_one_tetragon
cleanup() {
  stop_cp
  "${DC[@]}" down >/dev/null 2>&1 || true
  # In the Docker host's mount namespace (on Docker Desktop, the VM, not the Mac).
  docker run --rm --privileged --pid host alpine nsenter -t 1 -m -- rm -rf /var/lib/effigent-test >/dev/null 2>&1 || true
}
trap cleanup EXIT
start_cp
build_images
docker tag effigentd:dev ghcr.io/effigent/effigentd:dev-test
publish_test_policy
TOK=$(enroll_token 1)

EFFIGENTD_VERSION=dev-test EFFIGENT_ENROLL_TOKEN="$TOK" EFFIGENT_SERVER="http://host.docker.internal:$CP_PORT" EFFIGENT_STATE_DIR="$STATE" \
  "${DC[@]}" up -d --pull never >/dev/null 2>&1
HOST=$(docker run --rm --network host alpine hostname)

echo "== the Docker host enrolls"
wait_endpoints 1
check "endpoint named after the host" "$(endpoint_names)" "$HOST"
wait_log() { for _ in $(seq 60); do "${DC[@]}" logs effigentd 2>&1 | grep -q "$1" && return; sleep 1; done; echo "effigentd never logged '$1'"; FAIL=$((FAIL + 1)); }
wait_log "connected to Tetragon"; wait_log "applied policy"

echo "== detected agent in a container"
out=$(docker run --rm effigent-agent:test /opt/ag/claude -c "sleep 4; $AGENT_ACTIONS"); echo "$out"
check "curl blocked" "$(grep -c 'curl exit=126' <<<"$out")" 1
check ".env blocked" "$(grep -c 'cat .env exit=1' <<<"$out")" 1
echo "== agent container started through effigentd run (zero gap)"
out=$(docker run --rm effigent-agent:test effigentd run --agent claude-code --strict --timeout 8s -- /opt/ag/claude -c "$AGENT_ACTIONS" 2>&1); echo "$out"
check "curl blocked" "$(grep -c 'curl exit=126' <<<"$out")" 1
check ".env blocked" "$(grep -c 'cat .env exit=1' <<<"$out")" 1

echo "== blocks in the control plane"
sleep 4 # events ship every 2s
check "curl blocks" "$(blocked_count 'exec /usr/bin/curl' "$HOST")" 2
check ".env blocks" "$(blocked_count /work/.env "$HOST")" 2

echo "== a restarted effigentd stays the same machine"
"${DC[@]}" restart effigentd >/dev/null 2>&1; sleep 5
check "still 1 endpoint" "$(endpoint_names | wc -w | tr -d ' ')" 1
check "no second enrollment" "$("${DC[@]}" logs effigentd 2>&1 | grep -c 'enrolled .* as endpoint')" 1
summary
