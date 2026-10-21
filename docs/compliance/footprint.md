# effigentd footprint and EDR coexistence

Covers vendor checklist item 25. Measured **2026-10-21** with `test/footprint/measure.sh` at
commit f9a7774 (Go 1.26.0). These are **single-machine development measurements, not fleet
data.** The Linux numbers come from Docker Desktop's VM, which also ran other containers.
Treat them as an order of magnitude, and repeat on a pilot machine (§4).

## 1. Setup

| | |
|---|---|
| Host | Apple M3 Max, 14 cores, 36 GB, macOS 26.6.2 |
| Linux side | Docker Desktop VM: kernel 6.11.11-linuxkit, aarch64, 14 vCPUs, 15.6 GB. Active LSMs: `capability,bpf` |
| Tetragon | v1.7.1 (the dev container from CLAUDE.md §4), `--enable-ancestors=base,kprobe,lsm`, `--export-filename /var/log/tetragon/tetragon.log`, default caches. The installer's event-cache settings were not applied |
| effigentd, hooks mode | Own daemon on 127.0.0.1:7797. Not enrolled. Built-in default policy (denylist). Events written to a local JSONL file and shipped every 2 s to a local mock backend, so batching and HTTP are included |
| effigentd, kernel mode | Linux build in its own container (`--pid host`, Tetragon's network namespace). Not enrolled. Default policy. Local JSONL only |

The installed daemon on this Mac (127.0.0.1:7777) was not touched; it was only read with `ps`.

**How the numbers were taken:**
- **CPU:** cumulative CPU time before and after each phase (ps on macOS, `/proc/<pid>/stat` on
  Linux), divided by wall time. 100% = one core.
- **RSS:** sampled once a second.
- **Hook latency:** measured in two ways:
  - (a) **end to end**: a new `effigentd hook claude` process per call, which is what Claude
    Code pays;
  - (b) **daemon only**: `POST /hook/claude` on the loopback.
- **Payload mix:** ten tool calls in rotation:
  - Bash: `git status`, `go test`, `npm install … && git push`;
  - Read, Write (with ~2 KB of content), Edit, Grep, WebFetch;
  - an MCP tool;
  - `curl` (denied: 10% of calls).

## 2. Results

### 2.1 Hooks mode (macOS; the same code path as Linux hooks)

| Measure | Result |
|---|---|
| Binary size | 27.1 MB |
| Idle, fresh daemon (60 s) | **0.03% CPU**, RSS 25–30 MB |
| Installed daemon on this Mac, real use (hooks mode, up 2 d 11 h) | RSS 54.8 MB, 531.9 s CPU over 214,426 s = **0.25% average** |
| Hook latency, end to end, sequential (500 calls) | **p50 10.7 ms, p95 18.2 ms, p99 28.0 ms**, max 61.8 ms |
| Daemon decision only, sequential (500 calls) | p50 0.24 ms, p95 0.35 ms, p99 0.50 ms, max 5.4 ms |
| Burst: 2000 hook processes, 8 at a time | 622 calls/s; latency p50 12.4 ms, p95 15.3 ms, p99 18.1 ms; daemon **23.6% of one core** during the 3.2 s burst; RSS peak 63.7 MB |
| Daemon CPU per hook call | ≈0.4 ms (0.77 s for 2000 calls; 0.22 s for 500) |
| After the load (15 s idle) | 0.07% CPU, RSS 63.7 MB (Go keeps the heap it grew) |
| One `effigentd hook` process | max RSS 19.6 MB, lives ~10 ms |
| Events | 3006 written locally, 3004 received by the backend (the last batch was in flight) |

**Reading.**
- Almost all of a hook call's ~11 ms is starting the Go process. The decision itself takes a
  quarter of a millisecond.
- Claude Code runs one hook per tool call, so agents see about 11 ms per tool call.
- Approval waits are a separate matter: by design they can hold a call for up to the
  approval wait.

### 2.2 Kernel mode (Linux, Tetragon BPF LSM)

| Measure | effigentd | Tetragon |
|---|---|---|
| Idle, 60 s (VM with other containers running, e.g. Postgres health checks) | 0.3–1.8% CPU, RSS 28 MB | 0.9–4.2% CPU, RSS 100–118 MB (cgroup memory incl. page cache: 167 MiB) |
| 10,000 execs, **not** an agent (3 runs) | +1.15–1.58 s CPU | +2.8–4.5 s CPU |
| 10,000 execs inside a detected agent (3 runs; kernel policy loaded, every exec attributed and reported) | +1.31–1.56 s CPU, RSS 58 MB | +4.5–5.5 s CPU |
| 10,000 execs under `effigentd run` (3 runs) | +1.23–2.01 s CPU | +4.0–7.7 s CPU |
| Tetragon RSS during the 9 bursts (90,000 short-lived processes) | — | grew to **547 MB peak**; back to 187 MB within 60 s of idle |
| 60 s idle after the bursts | 2.3% CPU, RSS 59 MB | 7.5% CPU, RSS 187–471 MB (shrinking) |

**Exec latency.** The time for 10,000 `/bin/true` execs was 366–510 µs per exec outside an
agent and 369–413 µs inside one, so there is **no measurable difference**. Run-to-run noise
(±70 µs) in the VM is larger than any enforcement cost. Tetragon was tracing in both cases, and
we did not stop it to get a no-Tetragon baseline. Events: 60,027 exec events for the 60,000
agent and launcher execs, none for the plain ones.

**Reading.**
- **effigentd's CPU follows the host's exec rate, not the agents' activity.** Tetragon streams
  every process exec to effigentd, which attributes it or drops it. That cost ≈0.12–0.16 ms of
  CPU per exec either way, or about 15% of one core at 1000 execs/s.
  - A developer laptop or CI runner with heavy build fan-out will see that.
  - An idle server won't.
  - Filtering exec events at Tetragon (an export allowlist) would cut it. That isn't built.
- **Tetragon uses about 2–3× effigentd's CPU per exec.** Its memory grows with its process
  cache under heavy process churn and shrinks again (its process-cache GC interval is 30 s by
  default). Expect ~100–200 MB steady and several hundred MB under bursts. Tetragon's
  `--process-cache-size` (default 65,536) bounds it.
- BPF map memory is kernel memory and is **not** included in Tetragon's RSS.
- The VM was not otherwise idle (other containers' health checks also exec), which is the spread in the idle rows.

**Not measured:**
- file-open and connect bursts;
- a real x86 server kernel;
- long-running fleet behaviour;
- shipping to the real control plane (TLS, network);
- Windows.

Hook latency on Linux should match §2.1. It is the same code, but this run didn't measure it
there.

### 2.3 Reproduce

```
test/footprint/measure.sh            # hooks on this machine + tetragon if the dev container runs
test/footprint/measure.sh hooks      # any OS, no root, no Docker
N=1000 BURST=5000 CONC=16 EXECS=20000 RUNS=5 test/footprint/measure.sh tetragon
```

The script never touches an installed daemon on :7777 or the Tetragon container. It removes
its own container (`eff-fp-daemon`) at the end. Results go to `$OUT/summary.txt`.

## 3. EDR / eBPF coexistence

### 3.1 What effigentd puts in the kernel

effigentd doesn't load BPF itself. It asks Tetragon to load **per-agent** TracingPolicies,
restricted by `matchPIDs` to the agent's process tree (`internal/endpoint/tetragon/render.go`):
- **BPF LSM hooks:**
  - `bprm_check_security`: exec deny/allow;
  - `file_open`: file deny and alert;
  - `socket_connect`: network deny.

  Blocking is Tetragon's `Override` action, which returns `-EPERM`.
- **A kprobe on `tcp_connect`:** reporting only (`Post`, no override).

Outside an agent's tree these programs match nothing. They still run on the hooks for every
process, though, and Tetragon's base sensors trace every exec and exit on the host.

### 3.2 Kernel facts that decide coexistence

- **LSMs stack. On a shared hook, the first module to deny wins.**
  - Hooks are called in the order set by `CONFIG_LSM` or the `lsm=` boot parameter
    ([kernel LSM docs](https://docs.kernel.org/security/lsm.html),
    [admin guide](https://docs.kernel.org/admin-guide/LSM/index.html)). The active list is in
    `/sys/kernel/security/lsm`.
  - LWN on the BPF LSM: "each defined hook for a given operation is called in order, the first
    that denies the operation 'wins' and the operation fails without calling any others"
    ([LWN 813261](https://lwn.net/Articles/813261/)).
  - `bpf` is last in the upstream default lists
    ([security/Kconfig](https://raw.githubusercontent.com/torvalds/linux/master/security/Kconfig)).
    So when SELinux or AppArmor denies first, Tetragon never sees that call and Effigent gets
    no event for it *(our reading of the kernel source)*.
- **Several BPF LSM programs on one hook run in sequence, and a non-zero return stops the
  rest.**
  - The kernel's BPF LSM docs show each program receiving "the return value from the previous
    BPF program" ([prog_lsm](https://docs.kernel.org/bpf/prog_lsm.html)).
  - The x86 and arm64 trampolines skip the remaining programs after the first deny
    (`invoke_bpf_mod_ret` in
    [x86](https://raw.githubusercontent.com/torvalds/linux/master/arch/x86/net/bpf_jit_comp.c) /
    [arm64](https://raw.githubusercontent.com/torvalds/linux/master/arch/arm64/net/bpf_jit_comp.c)
    `bpf_jit_comp.c`).
  - So two agents using BPF LSM (Tetragon and an EDR) both enforce, and whichever denies first
    decides. The other may not log that call.
- **Trampoline program limit.** Each kernel function has a cap on attached
  fentry/fexit/LSM programs, `BPF_MAX_TRAMP_LINKS`
  ([bpf.h](https://raw.githubusercontent.com/torvalds/linux/master/include/linux/bpf.h)): 36 on
  x86-64 and 37 on arm64 on current master; it varies by version. Every agent that attaches to
  the same hook shares that budget. Effigent uses one program per hook per agent policy, so
  many concurrent agents plus an EDR could approach it on busy hooks *(our reading; not
  observed)*.
- **BPF LSM isn't on everywhere.**
  - Tetragon's LSM hooks need kernel ≥ 5.7, `CONFIG_BPF_LSM=y`, and `bpf` in the active LSM
    list; otherwise you add it to `lsm=` on the kernel command line and reboot
    ([Tetragon hooks docs](https://tetragon.io/docs/concepts/tracing-policy/hooks/)).
  - **Ubuntu** builds `CONFIG_BPF_LSM` but does not list `bpf` in `CONFIG_LSM`, so it is off
    by default. An Ubuntu kernel-team proposal to change this was posted in September 2026
    ([thread](https://lists.ubuntu.com/archives/kernel-team/2026-September/171489.html)); its
    merge status is unverified.
  - **CentOS Stream 9 / RHEL 9** configs include `bpf`
    ([CONFIG_LSM](https://gitlab.com/redhat/centos-stream/src/kernel/centos-stream-9/-/raw/main/redhat/configs/common/generic/CONFIG_LSM)).
  - **An `lsm=` line replaces the whole list.** Copy the existing list and append `bpf`, or
    AppArmor/SELinux is switched off.
- **`Override` on LSM hooks** needs kernel ≥ 5.7. On kprobes it needs
  `CONFIG_BPF_KPROBE_OVERRIDE` and only works on functions that allow error injection
  ([Tetragon selectors](https://tetragon.io/docs/concepts/tracing-policy/selectors/)).
  Effigent blocks only through LSM hooks, so it doesn't need kprobe override.
- **One Tetragon per kernel.** If the customer already runs Tetragon (e.g. with Cilium), the
  installer leaves it running and effigentd connects to it (CLAUDE.md §5). That is supported,
  but its settings need `--enable-ancestors=base,kprobe,lsm`.

### 3.3 EDR products: what's known and what isn't tested

**Effigent has not been tested next to any EDR.**

| Product | What its vendor says about Linux kernel use | Coexistence notes | Tested with Effigent |
|---|---|---|---|
| CrowdStrike Falcon | Kernel mode and user mode. Falcon's blog says it uses "BPF" on Linux ([blog](https://www.crowdstrike.com/en-us/blog/tech-analysis-kernel-access-security-architecture/), [tech hub](https://crowdstrike.com/tech-hub/endpoint-security/installing-falcon-sensor-for-linux)). Sensor docs need a login | A 2024 RHEL 9.4 kernel panic involved Falcon's eBPF program ([Red Hat KB](https://access.redhat.com/solutions/7068083), [The Register](https://www.theregister.com/2024/07/21/crowdstrike_linux_crashes_restoration_tools/)): a kernel BPF verifier bug, not a conflict with another agent | **No** |
| Microsoft Defender for Endpoint | eBPF sensor is the default since agent 101.23082.0006, no kernel module ([learn.microsoft.com](https://learn.microsoft.com/en-us/defender-endpoint/linux-support-ebpf)) | Running alongside other **fanotify**-based products "isn't supported" ([prerequisites](https://learn.microsoft.com/en-us/defender-endpoint/mde-linux-prerequisites)). Tetragon/effigentd don't use fanotify. Microsoft's performance guide warns that "multiple security products may conflict" ([perf](https://learn.microsoft.com/en-us/defender-endpoint/linux-support-perf)) | **No** |
| SentinelOne | Cloud-workload Linux agents run "entirely in user space, making use of eBPF" ([blog](https://www.sentinelone.com/blog/feature-spotlight-announcing-general-availability-ga-of-linux-and-k8s-agents-v22-3-for-cloud-workload-security/)). Unverified for its general endpoint agent | No public statement found | **No** |

We found **no public report of two eBPF security agents conflicting on the same LSM hook**.
That is a search result, not a guarantee. The known risks are:
- deny ordering (§3.2);
- the trampoline cap;
- distro kernel BPF bugs that any BPF agent can trigger;
- combined CPU cost, since every agent traces execs.

**macOS and Windows:** effigentd uses only the agents' own hooks there, with no kernel
component. It runs as a normal service and doesn't compete with EDR kernel extensions or system
extensions. EDR products may still flag it (a root daemon reading process lists, `lsof`,
`ps`); add an allow rule if they do.

## 4. Pilot test plan the customer can run

Use one machine with the customer's EDR in its production configuration, plus one identical
machine without Effigent as a control.

1. **Preconditions.**
   - Record `uname -r`, `/sys/kernel/security/lsm` (must contain `bpf`), the distro, and the
     EDR name, version and mode (kernel/eBPF/user).
   - Ubuntu: add `bpf` to the existing `lsm=` list and reboot.
2. **Install Effigent** with the normal installer (Tetragon + effigentd), enrolled in a pilot
   workspace. Confirm `effigentd status` and a heartbeat in the console.
3. **Functional checks with the EDR active.** Use `effigentd run --agent claude-code -- bash`
   as a stand-in agent, or a real agent:
   - a denied exec (e.g. `curl`) fails with exit 126 and shows `blocked` in the console;
   - a denied file (`cat /etc/shadow`) fails;
   - `cat .env` is reported;
   - a connection to a `network_deny` IP is blocked;
   - the same commands outside the agent still work.
   - Repeat after an EDR policy update and after a reboot.
4. **EDR side.** Confirm:
   - the EDR still detects its own test case, e.g. the vendor's test detection;
   - it raised no alert on Tetragon or effigentd, or record what it raised and the allow rule
     used;
   - its health command is clean (MDE: `mdatp health`, check `conflicting_applications`;
     Falcon: its reduced-functionality-mode state, commonly `falconctl -g --rfm-state`; not verified, the docs need a login).
5. **Load.** Run `test/footprint/measure.sh tetragon` (or the customer's own build/test job)
   on both machines. Compare:
   - job wall time;
   - CPU and RSS of `tetragon`, `effigentd` and the EDR process;
   - `bpftool prog show | wc -l` (BPF program count).

   Then run a heavy exec workload for 30 minutes, such as a full build or test suite.
6. **Stability.**
   - Leave the machine running for 72 hours with normal use.
   - Check `dmesg` for BPF verifier errors, oopses or RCU stalls.
   - Check that Tetragon never restarted and that effigentd logged no `daemon_unclean_restart`.
   - Then stop and start each component in turn (EDR, Tetragon, effigentd): enforcement and
     the EDR must both come back.
7. **Exit criteria** (agree them before starting):
   - no kernel errors;
   - no lost EDR detections;
   - all Effigent checks pass;
   - build-time overhead under ⟨X⟩%.

Repeat for each EDR the customer runs. Report results to Effigent so this table can carry
"tested" rows.
