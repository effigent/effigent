#!/usr/bin/env bash
# effigentd footprint: CPU / RSS idle and under load, hook latency, Tetragon's RSS.
#
#   test/footprint/measure.sh            # hooks (this machine) + tetragon (Docker VM) when available
#   test/footprint/measure.sh hooks      # hooks mode only (macOS, Linux, no root needed)
#   test/footprint/measure.sh tetragon   # Linux kernel side only (needs the dev `tetragon` container)
#
# Knobs (env): N=500 sequential hook calls per latency run, BURST=2000 calls in the
# concurrent burst with CONC=8 workers, IDLE=60 seconds of idle sampling, EXECS=2000
# execs per exec burst (EXECS=10000), RUNS=3 exec bursts per variant, PORT=7797 / BPORT=9997 for the
# hooks daemon and its mock backend, LPORT=7798 for the Linux daemon.
#
# Never touches an installed effigentd (it holds 127.0.0.1:7777): it runs its own
# daemon on PORT with a throwaway state dir, not enrolled, built-in default policy,
# shipping events to a local mock backend. The installed daemon, if any, is only read
# with ps. The tetragon part needs the dev `tetragon` container (see CLAUDE.md §4); it
# doesn't start or stop it. It runs effigentd (linux build) in its own container
# `eff-fp-daemon` (host PID namespace, Tetragon's network namespace) and removes it
# at the end; that daemon's TracingPolicies are removed when it stops.
# Results: $OUT/summary.txt (default OUT: a new temp dir, printed at the end).
set -uo pipefail
cd "$(dirname "$0")/../.."
MODE=${1:-all}
N=${N:-500}; BURST=${BURST:-2000}; CONC=${CONC:-8}; IDLE=${IDLE:-60}
EXECS=${EXECS:-10000}; RUNS=${RUNS:-3}
PORT=${PORT:-7797}; BPORT=${BPORT:-9997}; LPORT=${LPORT:-7798}
W=${OUT:-$(mktemp -d)}; mkdir -p "$W"
S="$W/summary.txt"; : >"$S"
say() { echo "$*" | tee -a "$S"; }
PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
  docker rm -f eff-fp-daemon >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ---- helpers (python3 for timing and percentiles: BSD date has no %N) ----
cat >"$W/stats.py" <<'PY'
import sys
v = sorted(float(x) for x in sys.stdin if x.strip())
if not v:
    print("n=0"); sys.exit()
q = lambda p: v[min(len(v) - 1, int(round(p / 100 * (len(v) - 1))))]
print(f"n={len(v)} p50={q(50):.2f}ms p95={q(95):.2f}ms p99={q(99):.2f}ms max={v[-1]:.2f}ms mean={sum(v)/len(v):.2f}ms")
PY

# hookbench.py proc|http N CONC ADDR BIN CWD OUTFILE: times hook calls over a payload mix.
cat >"$W/hookbench.py" <<'PY'
import sys, json, os, time, subprocess, http.client, getpass
from concurrent.futures import ThreadPoolExecutor
kind, n, conc, addr, binary, cwd, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4], sys.argv[5], sys.argv[6], sys.argv[7]
body = "x = 1\n" * 300   # ~2 KB of file content in Write/Edit calls (the daemon drops it)
mix = [
    ("Bash", {"command": "git status"}),
    ("Bash", {"command": "go test ./... -run TestFoo -count=1"}),
    ("Bash", {"command": "npm install left-pad && git push origin feature/x"}),
    ("Read", {"file_path": cwd + "/main.go"}),
    ("Write", {"file_path": cwd + "/notes.txt", "content": body}),
    ("Edit", {"file_path": cwd + "/main.go", "old_string": "a", "new_string": "b"}),
    ("Grep", {"pattern": "TODO", "path": cwd}),
    ("WebFetch", {"url": "https://docs.example.com/page", "prompt": "summarise"}),
    ("mcp__github__get_issue", {"owner": "acme", "repo": "app", "issue_number": 7}),
    ("Bash", {"command": "curl -s https://example.com"}),                        # denied (exec_deny)
]
def payload(i):
    tool, inp = mix[i % len(mix)]
    return json.dumps({"session_id": "fp-%d" % (i % 4), "cwd": cwd, "hook_event_name": "PreToolUse",
                       "tool_name": tool, "tool_input": inp, "transcript_path": "/tmp/t.jsonl"}).encode()
env = dict(os.environ, EFFIGENT_API=addr)
host, port = addr.split(":")
user = getpass.getuser()
def call(i):
    p = payload(i)
    t = time.perf_counter()
    if kind == "proc":   # what the agent pays: a new `effigentd hook claude` process per call
        r = subprocess.run([binary, "hook", "claude"], input=p, capture_output=True, env=env).stdout
    else:                # the daemon's decision alone: POST /hook/claude over the loopback
        c = http.client.HTTPConnection(host, int(port), timeout=30)
        c.request("POST", "/hook/claude", body=p, headers={"Content-Type": "application/json",
                  "X-Effigent-Hook-Budget": "28", "X-Effigent-OS-User": user})
        r = c.getresponse().read(); c.close()
    ms = (time.perf_counter() - t) * 1000
    s = r.decode(errors="replace")
    verdict = "error" if ("effigentd is not running" in s or "could not decide" in s or not s.strip()) else ("deny" if '"deny"' in s else "allow")
    return ms, verdict
t0 = time.perf_counter()
with ThreadPoolExecutor(conc) as ex:
    res = list(ex.map(call, range(n)))
wall = time.perf_counter() - t0
with open(out, "w") as f:
    f.write("\n".join("%.3f" % ms for ms, _ in res) + "\n")
cnt = {k: sum(1 for _, v in res if v == k) for k in ("allow", "deny", "error")}
print("calls=%d wall=%.2fs rate=%.0f/s allow=%d deny=%d error=%d" % (n, wall, n / wall, cnt["allow"], cnt["deny"], cnt["error"]))
PY

# sampler.py PID SECONDS OUTFILE: RSS (KB) and cumulative CPU seconds once a second (ps).
cat >"$W/sampler.py" <<'PY'
import sys, subprocess, time
pid, secs, out = sys.argv[1], float(sys.argv[2]), sys.argv[3]
def cpu(s):  # ps cputime: [[dd-]hh:]mm:ss[.cc]
    s = s.strip(); d = 0
    if "-" in s:
        dd, s = s.split("-", 1); d = int(dd) * 86400
    parts = [float(x) for x in s.split(":")]
    t = 0.0
    for x in parts:
        t = t * 60 + x
    return d + t
end = time.time() + secs
with open(out, "w") as f:
    while True:
        r = subprocess.run(["ps", "-o", "rss=,time=", "-p", pid], capture_output=True, text=True).stdout.split()
        if len(r) < 2:
            break
        f.write("%.2f %s %.3f\n" % (time.time(), r[0], cpu(r[1]))); f.flush()
        if time.time() >= end:
            break
        time.sleep(1)
PY
# snap PID FILE: one more sample (so short runs still have a start and an end).
snap() { python3 "$W/sampler.py" "$1" 0 "$W/snap.txt" && cat "$W/snap.txt" >>"$2"; }
# report LABEL FILE: CPU% over the window (cputime delta / wall) and RSS min/max.
report() {
  python3 - "$1" "$2" <<'PY' | tee -a "$S"
import sys
rows = sorted((l.split() for l in open(sys.argv[2]) if l.strip()), key=lambda r: float(r[0]))
if len(rows) < 2:
    print(sys.argv[1] + ": not enough samples"); sys.exit()
t0, t1 = float(rows[0][0]), float(rows[-1][0]); c0, c1 = float(rows[0][2]), float(rows[-1][2])
rss = [int(r[1]) for r in rows]
print("%s: cpu=%.2f%% of one core over %.0fs (cputime +%.2fs), rss min=%.1fMB max=%.1fMB last=%.1fMB" % (
    sys.argv[1], 100 * (c1 - c0) / max(t1 - t0, 1e-9), t1 - t0, c1 - c0, min(rss) / 1024, max(rss) / 1024, rss[-1] / 1024))
PY
}

machine() {
  say "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  say "commit: $(git rev-parse --short HEAD) ($(go version | awk '{print $3}'))"
  if [ "$(uname)" = Darwin ]; then
    say "machine: $(sysctl -n machdep.cpu.brand_string), $(sysctl -n hw.ncpu) cores, $(( $(sysctl -n hw.memsize) / 1073741824 )) GB, macOS $(sw_vers -productVersion)"
  else
    say "machine: $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2), $(nproc) cores, $(awk '/MemTotal/{printf "%d GB", $2/1048576}' /proc/meminfo), $(uname -sr)"
  fi
}

# ---------------------------------------------------------------- hooks mode
hooks_mode() {
  say "== hooks mode (this machine)"
  for port in $PORT $BPORT; do
    curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$port/" && { say "port $port is busy; set PORT/BPORT"; return 1; }
  done
  go build -o bin/effigentd ./cmd/effigentd && go build -o bin/mockbackend ./test/endpoint/mockbackend || return 1
  mkdir -p "$W/repo" && (cd "$W/repo" && git init -q && git config user.email dev@example.com && echo 'package main' >main.go)
  ./bin/mockbackend -listen 127.0.0.1:$BPORT -out "$W/backend.jsonl" -token fp >"$W/backend.log" 2>&1 & PIDS+=($!)
  EFFIGENT_BACKEND_TOKEN=fp ./bin/effigentd -sensor hooks -listen 127.0.0.1:$PORT -state-dir "$W/state" \
    -output none -log-file "$W/events.jsonl" -backend-url http://127.0.0.1:$BPORT/ingest 2>"$W/effigentd.err" & EPID=$!; PIDS+=($EPID)
  for i in $(seq 1 50); do curl -s "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.2; done
  curl -s "http://127.0.0.1:$PORT/health" >/dev/null || { say "daemon did not start: $(cat "$W/effigentd.err")"; return 1; }
  say "binary: $(ls -l bin/effigentd | awk '{printf "%.1f MB", $5/1048576}')"
  sleep 5
  python3 "$W/sampler.py" $EPID "$IDLE" "$W/idle.txt"; report "idle ${IDLE}s (fresh daemon)" "$W/idle.txt"

  for kind in proc http; do
    python3 "$W/sampler.py" $EPID 100000 "$W/seq-$kind.txt" & SP=$!
    r=$(python3 "$W/hookbench.py" $kind "$N" 1 127.0.0.1:$PORT "$PWD/bin/effigentd" "$W/repo" "$W/lat-$kind.ms")
    kill $SP 2>/dev/null; wait $SP 2>/dev/null; snap $EPID "$W/seq-$kind.txt"
    label=$([ $kind = proc ] && echo "hook process (effigentd hook claude, end to end)" || echo "daemon decision (POST /hook/claude)")
    say "latency, $label, sequential: $r"
    say "  $(python3 "$W/stats.py" <"$W/lat-$kind.ms")"
    report "  daemon during this run" "$W/seq-$kind.txt"
  done

  python3 "$W/sampler.py" $EPID 100000 "$W/burst.txt" & SP=$!
  r=$(python3 "$W/hookbench.py" proc "$BURST" "$CONC" 127.0.0.1:$PORT "$PWD/bin/effigentd" "$W/repo" "$W/lat-burst.ms")
  kill $SP 2>/dev/null; wait $SP 2>/dev/null; snap $EPID "$W/burst.txt"
  say "burst: $BURST hook processes, $CONC at a time: $r"
  say "  $(python3 "$W/stats.py" <"$W/lat-burst.ms")"
  report "  daemon during the burst" "$W/burst.txt"
  python3 "$W/sampler.py" $EPID 15 "$W/after.txt"; report "idle 15s after the load" "$W/after.txt"

  # peak RSS of one short-lived hook process
  pl='{"session_id":"fp","cwd":"/tmp","tool_name":"Bash","tool_input":{"command":"git status"}}'
  if [ "$(uname)" = Darwin ]; then
    m=$(echo "$pl" | EFFIGENT_API=127.0.0.1:$PORT /usr/bin/time -l ./bin/effigentd hook claude 2>&1 >/dev/null | awk '/maximum resident set size/{printf "%.1f MB", $1/1048576}')
  else
    m=$(echo "$pl" | EFFIGENT_API=127.0.0.1:$PORT /usr/bin/time -v ./bin/effigentd hook claude 2>&1 >/dev/null | awk -F: '/Maximum resident/{printf "%.1f MB", $2/1024}')
  fi
  say "one hook process: max RSS $m"
  sleep 3
  say "events: $(wc -l <"$W/events.jsonl" | tr -d ' ') written locally, $(wc -l <"$W/backend.jsonl" | tr -d ' ') received by the mock backend"
  kill $EPID 2>/dev/null; wait $EPID 2>/dev/null

  # an installed daemon, read only
  ip=$(pgrep -f '^/usr/local/bin/effigentd' | head -1)
  if [ -n "$ip" ]; then
    say "installed daemon (read only, pid $ip): $(ps -o rss=,etime=,time=,args= -p "$ip" | awk '{printf "rss=%.1fMB uptime=%s cputime=%s args=", $1/1024, $2, $3; for(i=4;i<=NF;i++) printf "%s ", $i}')"
  fi
}

# ---------------------------------------------------------------- tetragon (Linux kernel side)
tetragon_mode() {
  say "== tetragon mode (Docker VM, BPF LSM)"
  command -v docker >/dev/null && docker ps --format '{{.Names}}' | grep -qx tetragon || { say "tetragon container is not running: Linux numbers not measured"; return 0; }
  docker ps -a --format '{{.Names}}' | grep -qx eff-fp-daemon && { say "a container eff-fp-daemon already exists; remove it first"; return 1; }
  say "docker vm: kernel $(docker info --format '{{.KernelVersion}}'), $(docker info --format '{{.NCPU}}') cpus, $(docker info --format '{{.MemTotal}}' | awk '{printf "%.1f GB", $1/1073741824}'), $(docker info --format '{{.Architecture}}')"
  say "tetragon: $(docker inspect tetragon --format '{{.Config.Image}} {{join .Args " "}}')"
  VM_ARCH=$(docker info --format '{{.Architecture}}'); case $VM_ARCH in aarch64|arm64) VM_ARCH=arm64;; *) VM_ARCH=amd64;; esac
  GOOS=linux GOARCH=$VM_ARCH CGO_ENABLED=0 go build -o bin/effigentd-linux ./cmd/effigentd || return 1
  docker build -q -t effigent-footprint -f test/endpoint/Dockerfile.scenario . >/dev/null || return 1
  say "lsm: $(docker run --rm --privileged effigent-footprint sh -c 'mount -t securityfs none /sys/kernel/security 2>/dev/null; cat /sys/kernel/security/lsm 2>/dev/null || echo unknown')"
  docker run -d --name eff-fp-daemon --privileged --pid host --network container:tetragon effigent-footprint \
    effigentd -sensor tetragon -tetragon 127.0.0.1:54321 -listen 127.0.0.1:$LPORT -state-dir /var/lib/eff-fp \
    -output none -log-file /tmp/events.jsonl >/dev/null || return 1
  sleep 3
  docker exec eff-fp-daemon curl -s -o /dev/null --max-time 2 http://127.0.0.1:$LPORT/health || { say "linux daemon did not start: $(docker logs eff-fp-daemon 2>&1 | tail -5)"; return 1; }
  # lsample SECONDS: effigentd and tetragon from the host PID namespace, once a second:
  #   time effigentd_ticks effigentd_rss_kb tetragon_ticks tetragon_rss_kb
  cat >"$W/lsample.sh" <<'SH'
hz=$(getconf CLK_TCK); end=$(( $(date +%s) + $1 ))
find() { for d in /proc/[0-9]*; do [ "$(cat $d/comm 2>/dev/null)" = "$1" ] && { echo ${d#/proc/}; return; }; done; }
e=$(find effigentd); t=$(find tetragon)
tick() { awk '{print $14+$15}' /proc/$1/stat; }
rss() { awk '/VmRSS/{print $2}' /proc/$1/status; }
echo "hz $hz"
while :; do
  echo "$(date +%s.%N) $(tick $e) $(rss $e) $(tick $t) $(rss $t)"
  [ "$(date +%s)" -ge "$end" ] && break; sleep 1
done
SH
  docker cp "$W/lsample.sh" eff-fp-daemon:/lsample.sh >/dev/null
  lreport() { # LABEL FILE
    python3 - "$1" "$2" <<'PY' | tee -a "$S"
import sys
lines = [l.split() for l in open(sys.argv[2]) if l.strip()]
hz = float(lines[0][1]); rows = sorted([float(x) for x in l] for l in lines[1:] if len(l) == 5)
if len(rows) < 2:
    print(sys.argv[1] + ": not enough samples"); sys.exit()
dt = rows[-1][0] - rows[0][0]
for name, c, m in (("effigentd", 1, 2), ("tetragon", 3, 4)):
    cpu = (rows[-1][c] - rows[0][c]) / hz
    rss = [r[m] for r in rows]
    print("%s: %s cpu=%.2f%% of one core over %.1fs (cputime +%.2fs), rss min=%.1fMB max=%.1fMB" % (sys.argv[1], name, 100 * cpu / dt, dt, cpu, min(rss) / 1024, max(rss) / 1024))
PY
  }
  lsnap() { docker exec eff-fp-daemon bash /lsample.sh 0; }
  sleep 5
  docker exec eff-fp-daemon bash /lsample.sh "$IDLE" >"$W/l-idle.txt"; lreport "idle ${IDLE}s" "$W/l-idle.txt"
  say "tetragon memory (cgroup, incl. page cache): $(docker stats --no-stream --format '{{.MemUsage}}' tetragon)"

  loop='s=$(date +%s%N); for i in $(seq '$EXECS'); do /bin/true; done; echo "ms=$(( ($(date +%s%N)-s)/1000000 ))"'
  for variant in plain agent launcher; do
    case $variant in
      plain)    cmd=(bash -c "$loop");;                                          # not an agent: Tetragon sees it, effigentd ignores it
      agent)    cmd=(/opt/ag/claude -c "sleep 3; $loop");;                       # detected agent: kernel policy loaded, every exec attributed
      launcher) cmd=(effigentd run --agent claude-code -- bash -c "$loop");;     # started through effigentd run
    esac
    for r in $(seq "$RUNS"); do
      f="$W/l-$variant-$r.txt"; lsnap >"$f"
      docker exec eff-fp-daemon bash /lsample.sh 100000 >"$f.peak" & SP=$!
      ms=$(docker run --rm -e EFFIGENT_RUN_QUIET=1 effigent-footprint "${cmd[@]}" 2>/dev/null | grep -o 'ms=[0-9]*' | cut -d= -f2)
      sleep 3   # let effigentd drain Tetragon's events for the burst before the end sample
      kill $SP 2>/dev/null; wait $SP 2>/dev/null
      grep -v '^hz' "$f.peak" >>"$f"; lsnap | grep -v '^hz' >>"$f"
      say "exec burst ($variant, run $r): $EXECS execs of /bin/true in ${ms:-?} ms ($( [ -n "$ms" ] && awk -v m="$ms" -v n="$EXECS" 'BEGIN{printf "%.0f us/exec", 1000*m/n}'))"
      lreport "  during $variant run $r" "$W/l-$variant-$r.txt"
      sleep 2
    done
  done
  docker exec eff-fp-daemon bash /lsample.sh 60 >"$W/l-after.txt"; lreport "idle 60s after the bursts" "$W/l-after.txt"
  say "events: $(docker exec eff-fp-daemon sh -c 'wc -l </tmp/events.jsonl') written by the linux daemon; exec events: $(docker exec eff-fp-daemon sh -c 'grep -c "\"type\":\"exec\"" /tmp/events.jsonl')"
  docker stop -t 10 eff-fp-daemon >/dev/null; docker rm eff-fp-daemon >/dev/null
}

machine
case $MODE in
  hooks) hooks_mode;;
  tetragon) tetragon_mode;;
  all) hooks_mode; tetragon_mode;;
  *) echo "usage: $0 [hooks|tetragon|all]"; exit 2;;
esac
echo "results: $S"
