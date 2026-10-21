#!/usr/bin/env bash
# Self-hosted Effigent on Kubernetes: a kind cluster where deploy/helm/effigent-cp
# brings up the bundled Postgres, the control plane (TLS from a private test CA)
# and the console; Dex stands in for the customer's OIDC provider. A pod signs in
# through the console like a browser and uses the token against the control
# plane; an effigentd on this machine enrolls through a port-forward (trusting
# the private CA with --ca-file) and syncs a policy published by the OIDC admin.
# Needs Docker, kind, helm, kubectl, go, jq, openssl, internet (Dex, curl and
# Postgres images). No Tetragon (effigentd runs in hooks mode).
# KEEP=1 leaves the cluster up (kind delete cluster --name effigent-selfhost).
set -euo pipefail
cd "$(dirname "$0")/../.."
CLUSTER=effigent-selfhost; NS=effigent; REL=effigent-cp
K=(kubectl --context "kind-$CLUSTER" -n "$NS")
H=(helm --kube-context "kind-$CLUSTER" -n "$NS")
PF_PORT=${PF_PORT:-18443}; D_PORT=${D_PORT:-17794}
W=$(mktemp -d); FAIL=0
CONSOLE=http://effigent-cp-console.$NS.svc:3000
CP_IN=https://effigent-cp.$NS.svc:8080
CP_OUT=https://127.0.0.1:$PF_PORT

check() { # name, got, want
  if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: got '$2', want '$3'"; FAIL=$((FAIL + 1)); fi
}
cleanup() {
  kill "${PF_PID:-}" "${D_PID:-}" 2>/dev/null || true
  [ -n "${KEEP:-}" ] || kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true
}
trap cleanup EXIT
if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  echo "kind cluster $CLUSTER exists; delete it first" >&2; exit 1
fi

echo "== images and binaries"
docker build -q -f Dockerfile.cp -t effigent-cp:dev . >/dev/null
docker build -q -f Dockerfile.console -t effigent-console:dev . >/dev/null
go build -o "$W/effigentd" ./cmd/effigentd

echo "== private CA and the control plane's certificate"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=effigent selfhost test CA" \
  -keyout "$W/ca.key" -out "$W/ca.pem" 2>/dev/null
printf 'subjectAltName=DNS:effigent-cp.%s.svc,DNS:effigent-cp.%s.svc.cluster.local,DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' "$NS" "$NS" >"$W/ext.cnf"
openssl req -newkey rsa:2048 -nodes -subj "/CN=effigent-cp" -keyout "$W/tls.key" -out "$W/tls.csr" 2>/dev/null
openssl x509 -req -in "$W/tls.csr" -CA "$W/ca.pem" -CAkey "$W/ca.key" -CAcreateserial -days 2 \
  -extfile "$W/ext.cnf" -out "$W/tls.crt" 2>/dev/null

kind create cluster --name "$CLUSTER" >/dev/null
# Only the local builds: kind can't load multi-platform images from Docker
# Desktop's store, so Dex, curl and Postgres are pulled by the node.
kind load docker-image effigent-cp:dev effigent-console:dev --name "$CLUSTER" >/dev/null
kubectl --context "kind-$CLUSTER" create namespace "$NS" >/dev/null
"${K[@]}" create secret tls selfhost-cp-tls --cert "$W/tls.crt" --key "$W/tls.key" >/dev/null
"${K[@]}" create configmap selfhost-ca --from-file=ca.pem="$W/ca.pem" >/dev/null
"${K[@]}" apply -f test/selfhost/dex.yaml >/dev/null

echo "== helm install (bundled Postgres, control plane, console)"
"${H[@]}" install "$REL" deploy/helm/effigent-cp -f test/selfhost/values.yaml --wait --timeout 5m >"$W/notes.txt"
"${K[@]}" wait --for=condition=Ready pod/browser --timeout 120s >/dev/null
"${K[@]}" rollout status deploy/dex --timeout 120s >/dev/null
check "control plane ready" "$("${K[@]}" get deploy "$REL" -o jsonpath='{.status.readyReplicas}')" 1
check "console ready" "$("${K[@]}" get deploy "$REL-console" -o jsonpath='{.status.readyReplicas}')" 1
check "postgres ready" "$("${K[@]}" get sts "$REL-postgres" -o jsonpath='{.status.readyReplicas}')" 1
check "NOTES print the redirect URI" "$(grep -c "$CONSOLE/auth/callback" "$W/notes.txt")" 1
PUB=$("${K[@]}" logs "deploy/$REL" | sed -n 's/.*policy signing public key \(.*\)$/\1/p' | head -1)
check "control plane serves TLS with a generated signing key" "$([ -n "$PUB" ] && "${K[@]}" logs "deploy/$REL" | grep -c 'tls=true')" 1

echo "== sign in through the console (Dex)"
B=("${K[@]}" exec browser -- curl -s --cacert /ca/ca.pem)
code=$("${B[@]}" -c /tmp/jar -b /tmp/jar -L -o /dev/null -w '%{http_code} %{url_effective}' "$CONSOLE/auth/login")
check "login lands back on the console" "$code" "200 $CONSOLE/"
TOK=$("${B[@]}" -b /tmp/jar "$CONSOLE/auth/token" | jq -r .token)
check "console hands out the provider's token" "$([ "${#TOK}" -gt 100 ] && echo yes)" yes
AUTH=(-H "Authorization: Bearer $TOK")
me=$("${B[@]}" "${AUTH[@]}" "$CP_IN/api/v1/me")
check "control plane: who" "$(jq -r '[.tenant, .via, .role, .email] | join(" ")' <<<"$me")" \
  "org:self-hosted oidc admin kilgore@kilgore.trout"
check "members list the signed-in user" \
  "$("${B[@]}" "${AUTH[@]}" "$CP_IN/api/v1/members" | jq -r '.members[0].name + " " + .members[0].role')" "Kilgore Trout admin"
check "no token, no access" "$("${B[@]}" -o /dev/null -w '%{http_code}' "$CP_IN/api/v1/me")" 401
check "console refuses unauthenticated pages" \
  "$("${K[@]}" exec browser -- curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$CONSOLE/")" \
  "307 $CONSOLE/auth/login?returnTo=%2F"
ET=$("${B[@]}" "${AUTH[@]}" -X POST "$CP_IN/api/v1/enrollment-tokens" -d '{"label":"selfhost test","max_uses":1}' | jq -r .token.token)
check "OIDC admin creates an enrollment token" "${ET:0:4}" eft_

echo "== effigentd enrolls over TLS (private CA) and syncs a policy"
"${K[@]}" port-forward "svc/$REL" "$PF_PORT:8080" >"$W/pf.log" 2>&1 &
PF_PID=$!; disown
for _ in $(seq 30); do curl -s --cacert "$W/ca.pem" -o /dev/null "$CP_OUT/healthz" && break; sleep 0.5; done
check "the CA is required" "$("$W/effigentd" enroll --server "$CP_OUT" --token "$ET" --state-dir "$W/nostate" >/dev/null 2>&1 && echo enrolled || echo refused)" refused
"$W/effigentd" enroll --server "$CP_OUT" --token "$ET" --ca-file "$W/ca.pem" --state-dir "$W/state" >"$W/enroll.log" 2>&1
check "enrolled" "$([ -f "$W/state/endpoint.json" ] && [ -f "$W/state/ca.pem" ] && echo yes)" yes
"$W/effigentd" -sensor hooks -state-dir "$W/state" -listen "127.0.0.1:$D_PORT" >"$W/effigentd.log" 2>&1 &
D_PID=$!; disown
jq -Rs '{body: ., comment: "selfhost test"}' internal/endpoint/policy/default.yaml >"$W/policy.json"
V=$(curl -s --cacert "$W/ca.pem" "${AUTH[@]}" -X PUT "$CP_OUT/api/v1/policy" --data-binary @"$W/policy.json" | jq -r .version)
check "OIDC admin publishes a policy" "$([ "$V" -ge 1 ] 2>/dev/null && echo yes)" yes
got=""
for _ in $(seq 40); do
  got=$(curl -s --cacert "$W/ca.pem" "${AUTH[@]}" "$CP_OUT/api/v1/endpoints" | jq -r '.[0].policy_version')
  [ "$got" = "$V" ] && break; sleep 1
done
check "machine synced the published version" "$got" "$V"

echo "== helm upgrade keeps the generated keys"
SK=$("${K[@]}" get secret "$REL-keys" -o jsonpath='{.data.signing-key}')
"${H[@]}" upgrade "$REL" deploy/helm/effigent-cp -f test/selfhost/values.yaml --wait --timeout 5m >/dev/null
"${K[@]}" rollout restart "deploy/$REL" >/dev/null && "${K[@]}" rollout status "deploy/$REL" --timeout 120s >/dev/null
check "signing key unchanged" "$("${K[@]}" get secret "$REL-keys" -o jsonpath='{.data.signing-key}')" "$SK"
kill "$PF_PID" 2>/dev/null || true
"${K[@]}" port-forward "svc/$REL" "$PF_PORT:8080" >"$W/pf.log" 2>&1 &
PF_PID=$!; disown
for _ in $(seq 30); do curl -s --cacert "$W/ca.pem" -o /dev/null "$CP_OUT/healthz" && break; sleep 0.5; done
V2=$(curl -s --cacert "$W/ca.pem" "${AUTH[@]}" -X PUT "$CP_OUT/api/v1/policy" --data-binary @"$W/policy.json" | jq -r .version)
got=""
for _ in $(seq 40); do
  got=$(curl -s --cacert "$W/ca.pem" "${AUTH[@]}" "$CP_OUT/api/v1/endpoints" | jq -r '.[0].policy_version')
  [ "$got" = "$V2" ] && break; sleep 1
done
check "after the upgrade the machine still verifies and syncs (v$V2)" "$got" "$V2"
check "no signature errors on the machine" "$(grep -ci 'signature' "$W/effigentd.log" || true)" 0

if [ "$FAIL" = 0 ]; then echo "PASS"; else echo "$FAIL check(s) failed (logs in $W)"; exit 1; fi
