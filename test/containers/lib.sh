# Shared by kind.sh and docker.sh: a local control plane, the test images and
# policy, and checks against what the console reads (/api/v1).
CP_PORT=${CP_PORT:-8090}
TENANT="org:containers-$(date +%s)"
A=(-H "Authorization: Bearer devadmin" -H "X-Effigent-Tenant: $TENANT")
CP="http://127.0.0.1:$CP_PORT/api/v1"
W=$(mktemp -d)
FAIL=0
# What the stand-in agent does; exit codes 126 (exec) and 1 (open) mean blocked.
AGENT_ACTIONS='curl -s -o /dev/null https://example.com; echo "curl exit=$?"; cat .env >/dev/null; echo "cat .env exit=$?"'

require_one_tetragon() {
  if docker ps --format '{{.Names}} {{.Image}}' | grep -q 'cilium/tetragon'; then
    echo "a Tetragon container is running ($(docker ps --format '{{.Names}}' --filter ancestor=quay.io/cilium/tetragon:v1.7.1 | tr '\n' ' ')); stop it first: one Tetragon per kernel" >&2
    exit 1
  fi
  if kind get clusters 2>/dev/null | grep -qx effigent-test; then
    echo "the kind cluster effigent-test (with Tetragon) is up; delete it first: kind delete cluster --name effigent-test" >&2
    exit 1
  fi
}

start_cp() { # listens on all interfaces so pods and containers reach it via host.docker.internal
  go build -o bin/effigent-cp ./cmd/effigent-cp
  DATABASE_URL=${DATABASE_URL:-postgres://effigent:effigent@localhost:5433/effigent} EFFIGENT_ADMIN_TOKEN=devadmin \
    EFFIGENT_ADMIN_TENANTS="$TENANT" ./bin/effigent-cp -listen "0.0.0.0:$CP_PORT" -key-file "$W/signing.key" >"$W/cp.log" 2>&1 &
  CP_PID=$!
  for _ in $(seq 30); do curl -s -o /dev/null "http://127.0.0.1:$CP_PORT/" && return; sleep 0.5; done
  echo "control plane didn't start:"; cat "$W/cp.log"; exit 1
}
stop_cp() { kill "${CP_PID:-}" 2>/dev/null || true; }

build_images() {
  docker build -q -f Dockerfile.effigentd --build-arg VERSION=dev -t effigentd:dev . >/dev/null
  docker build -q --build-arg EFFIGENTD_IMAGE=effigentd:dev -f test/containers/Dockerfile.agent -t effigent-agent:test test/containers >/dev/null
}

publish_test_policy() { # the default policy (denies curl & co.) plus .env in file_deny
  python3 - "$W/policy.yaml" <<'EOF'
import sys
s = open('internal/endpoint/policy/default.yaml').read()
s = s.replace("  file_deny:            # path suffixes the kernel refuses to open for agents\n    - /etc/shadow\n",
              "  file_deny:            # path suffixes the kernel refuses to open for agents\n    - /etc/shadow\n    - /.env\n", 1)
assert "    - /.env\n  network" in s, "default.yaml changed: update the test policy"
open(sys.argv[1], 'w').write(s)
EOF
  python3 -c 'import json,sys;print(json.dumps({"body":open(sys.argv[1]).read(),"comment":"containers test: deny curl and .env"}))' "$W/policy.yaml" |
    curl -sf "${A[@]}" -X PUT "$CP/policy" --data-binary @- >/dev/null
}

enroll_token() { # max_uses
  curl -sf "${A[@]}" -X POST "$CP/enrollment-tokens" -d "{\"label\":\"containers test\",\"max_uses\":$1}" |
    python3 -c 'import json,sys;print(json.load(sys.stdin)["token"]["token"])'
}

endpoint_names() {
  curl -sf "${A[@]}" "$CP/endpoints" | python3 -c 'import json,sys;print(" ".join(sorted(e["hostname"] for e in json.load(sys.stdin) if not e["revoked"])))'
}

wait_endpoints() { # count
  for _ in $(seq 60); do [ "$(endpoint_names | wc -w | tr -d ' ')" -ge "$1" ] && return; sleep 1; done
  echo "expected $1 endpoints, have: $(endpoint_names)"; FAIL=$((FAIL + 1))
}

blocked_count() { # target, hostname: blocked events for target reported by that machine
  curl -sf "${A[@]}" "$CP/endpoints" >"$W/eps.json"
  curl -sf "${A[@]}" "$CP/events?type=blocked&limit=200" | python3 -c '
import json, sys
eps = {e["id"]: e["hostname"] for e in json.load(open(sys.argv[3]))}
print(sum(1 for e in json.load(sys.stdin) if e["body"].get("target") == sys.argv[1] and eps.get(e["endpoint_id"]) == sys.argv[2] and e["body"].get("node") == sys.argv[2]))
' "$1" "$2" "$W/eps.json"
}

check() { # name, got, want
  if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: got '$2', want '$3'"; FAIL=$((FAIL + 1)); fi
}

summary() {
  if [ "$FAIL" = 0 ]; then echo "PASS"; else echo "$FAIL check(s) failed (control plane log: $W/cp.log)"; exit 1; fi
}
