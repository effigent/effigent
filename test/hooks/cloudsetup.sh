#!/usr/bin/env bash
# The cloud environment setup as a vendor runs it, in a Linux container
# standing in for the session VM: packages/site/public/cloud-setup.sh
# (download + checksum + `effigentd cloud-setup`, as root) from a local
# releases dir, then deploy/cloud/cloud-hook.sh run by the hook config as a
# non-root agent user against the local control plane. Also: outside a
# cloud session the hook does nothing; in one without effigentd it blocks.
# Needs Docker and local Postgres (docker compose up -d postgres).
set -uo pipefail
cd "$(dirname "$0")/../.."
W=$(mktemp -d); CP_PORT=${CP_PORT:-8092}; REL_PORT=${REL_PORT:-8093}; CP=127.0.0.1:$CP_PORT
T=org:cloudsetup-test-$$; A=(-H "Authorization: Bearer devadmin" -H "X-Effigent-Tenant: $T")
HOST=${DOCKER_HOST_NAME:-host.docker.internal}
pass=0; fail=0
ok()  { echo "  PASS  $*"; pass=$((pass+1)); }
bad() { echo "  FAIL  $*"; fail=$((fail+1)); }

ARCH=$(docker version -f '{{.Server.Arch}}')
go build -o bin/effigent-cp ./cmd/effigent-cp || exit 1
mkdir -p "$W/rel/vtest" "$W/repo/.effigent"
GOOS=linux GOARCH=$ARCH CGO_ENABLED=0 go build -o "$W/rel/vtest/effigentd-linux-$ARCH" ./cmd/effigentd || exit 1
(cd "$W/rel/vtest" && shasum -a 256 "effigentd-linux-$ARCH" > "effigentd-linux-$ARCH.sha256")
echo vtest > "$W/rel/latest"
cp packages/site/public/cloud-setup.sh "$W/rel/cloud-setup.sh"
cp deploy/cloud/cloud-hook.sh "$W/repo/.effigent/cloud-hook.sh"
(cd "$W/rel" && exec python3 -m http.server --bind 0.0.0.0 "$REL_PORT" >/dev/null 2>&1) & RELPID=$!

# The control plane must be reachable from the container: listen on all interfaces, for this test only.
DATABASE_URL=${DATABASE_URL:-postgres://effigent:effigent@localhost:5433/effigent} EFFIGENT_ADMIN_TOKEN=devadmin \
  EFFIGENT_ADMIN_TENANTS=$T EFFIGENT_PUBLIC_URL=http://$HOST:$CP_PORT \
  ./bin/effigent-cp -listen 0.0.0.0:$CP_PORT -key-file "$W/signing.key" >"$W/cp.log" 2>&1 & CPID=$!
trap 'kill $CPID $RELPID 2>/dev/null; rm -rf "$W"' EXIT
for i in $(seq 1 50); do curl -s "http://$CP/healthz" >/dev/null && break; sleep 0.2; done
python3 -c 'import json,sys;print(json.dumps({"body":open(sys.argv[1]).read(),"comment":"cloud setup test"}))' internal/endpoint/policy/default.yaml |
  curl -s "${A[@]}" -X PUT "http://$CP/api/v1/policy" --data-binary @- >/dev/null
TOKEN=$(curl -s "${A[@]}" -X POST "http://$CP/api/v1/cloud-environments" -d '{"name":"acme/web","vendor":"copilot"}' |
  python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
[ -n "$TOKEN" ] && ok "cloud environment created" || { bad "no token"; exit 1; }

cat > "$W/repo/session.sh" <<'EOF'
set -u
call() { printf '{"sessionId":"s1","cwd":"/workspace","toolName":"bash","toolArgs":"{\\"command\\":\\"%s\\"}"}' "$1"; }
echo "--setup"; curl -fsSL "$EFFIGENT_RELEASES/../cloud-setup.sh" | EFFIGENT_RELEASES="$EFFIGENT_RELEASES" sh; echo "rc=$?"
ls -l /var/tmp/effigent-cloud/endpoint.json
useradd -m agent
# the agent's session: Copilot sets GITHUB_ACTIONS; the token isn't in the hook's environment
echo "--curl"; call 'curl -s https://x.example' | su agent -c 'unset EFFIGENT_CLOUD_TOKEN; cd /workspace && GITHUB_ACTIONS=true sh .effigent/cloud-hook.sh copilot'; echo " rc=$?"
echo "--ls"; call 'ls -la' | su agent -c 'unset EFFIGENT_CLOUD_TOKEN; cd /workspace && GITHUB_ACTIONS=true sh .effigent/cloud-hook.sh copilot'; echo " rc=$?"
echo "--local"; call 'curl -s x' | su agent -c 'unset EFFIGENT_CLOUD_TOKEN; cd /workspace && EFFIGENT_STATE_DIR=/nonexistent sh .effigent/cloud-hook.sh copilot'; echo " rc=$?"
echo "--marker"; call 'curl -s x' | su agent -c 'unset EFFIGENT_CLOUD_TOKEN; cd /workspace && sh .effigent/cloud-hook.sh copilot'; echo " rc=$?"
echo "--root"; call 'curl -s https://x.example' | (unset EFFIGENT_CLOUD_TOKEN; cd /workspace && GITHUB_ACTIONS=true sh .effigent/cloud-hook.sh copilot); echo " rc=$?"
rm /usr/local/bin/effigentd
echo "--missing"; call 'ls' | su agent -c 'unset EFFIGENT_CLOUD_TOKEN; cd /workspace && GITHUB_ACTIONS=true sh .effigent/cloud-hook.sh copilot' 2>&1; echo " rc=$?"
EOF
docker run --rm --add-host host.docker.internal:host-gateway -e EFFIGENT_CLOUD_TOKEN="$TOKEN" \
  -e EFFIGENT_RELEASES="http://$HOST:$REL_PORT/." -v "$W/repo:/workspace" golang:1.26 bash /workspace/session.sh >"$W/out.txt" 2>&1
sec() { awk -v s="--$1" '$0==s{f=1;next} /^--/{f=0} f' "$W/out.txt"; }
sec setup | grep -q 'ready (policy v1' && sec setup | grep -q 'rc=0' && ok "setup step: downloaded, checksum ok, credentials and policy saved" || bad "setup: $(sec setup)"
grep -q -- '-rw-r--r--.* root root .*endpoint.json' "$W/out.txt" && ok "state shared read-only with the agent user" || bad "state mode: $(grep endpoint.json "$W/out.txt")"
sec curl | grep -q '"permissionDecision":"deny"' && ok "non-root agent: curl denied by the cloud policy" || bad "curl: $(sec curl)"
sec ls | grep -q '^{} rc=0' && ok "non-root agent: ls runs" || bad "ls: $(sec ls)"
sec local | grep -q '^ rc=0' && ok "outside a cloud session: no decision, no output" || bad "local: $(sec local)"
sec marker | grep -q '"permissionDecision":"deny"' && ok "no vendor marker, but the setup step's state: decided (curl denied)" || bad "marker: $(sec marker)"
sec root | grep -q '"permissionDecision":"deny"' && ok "root agent: curl denied" || bad "root: $(sec root)"
sec missing | grep -q 'not installed in this cloud environment' && sec missing | grep -q 'rc=2' && ok "effigentd missing in a cloud session: blocked (exit 2)" || bad "missing: $(sec missing)"
curl -s "${A[@]}" "http://$CP/api/v1/events?paged=1&limit=100" | python3 -c '
import json,sys
ev=json.load(sys.stdin)["events"]
assert any(e["type"]=="blocked" and e["agent"]=="copilot-agent" for e in ev), [e["type"] for e in ev]' && ok "events from the session reached the control plane" || bad "events"

echo
echo "$pass passed, $fail failed"
[ $fail = 0 ] || { echo "--- container output"; cat "$W/out.txt"; }
[ $fail = 0 ]
