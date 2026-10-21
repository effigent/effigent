# Cloud agents and containers

How Effigent covers agents that don't run on an enrolled laptop or server:
agents in a vendor's cloud (Claude Code on the web, GitHub Copilot's cloud
agent, Cursor cloud agents, Codex cloud, Devin), agents in containers on an
enrolled node, and WSL2. Research as of 2026-10-22. Vendor behaviour is quoted
from their docs (links inline). Anything not checked against a live agent says
so.

## 1. What the vendors let a customer run

| | Repo hooks run in the cloud | Setup step | Secrets reach the session | Egress control | Audit of tool calls |
|---|---|---|---|---|---|
| Claude Code on the web | Yes: the repository's `.claude/settings.json` hooks, in single-repository sessions, plus server-managed settings. `allowManagedHooksOnly` restricts it to managed hooks | Setup script set per environment by an admin, runs as root, result snapshot-cached | Environment variables, readable by the agent | Network access: Trusted (default list) or Custom allowlist | Compliance API excludes cloud sessions; OpenTelemetry is the only export |
| GitHub Copilot cloud agent | Yes: `.github/hooks/*.json` from the default branch (`preToolUse`, `PreToolUse`) | `.github/workflows/copilot-setup-steps.yml`, job `copilot-setup-steps` | Secrets of the `copilot` environment reach the setup steps. GitHub doesn't say whether they reach hooks (a hook's `env` can set values) | Firewall: GitHub/Copilot hosts by default, plus a custom allowlist. Applies to processes the Bash tool starts | Audit log has `actor:Copilot` and `agent_session_id`, no tool calls |
| Cursor cloud agents | Yes: the repository's `.cursor/hooks.json` command hooks (`beforeShellExecution`, `preToolUse`, `beforeReadFile`, `afterFileEdit`; not MCP or session events). Enterprise team / managed hooks run there too | `.cursor/environment.json` `install` | Runtime Secrets, as environment variables | Allow all / default + allowlist / allowlist only (the page names no default) | Audit logs exclude prompts and code; OTel tool calls are metrics only |
| Codex cloud | Not documented for cloud tasks (hooks are documented for the CLI) | Environment setup script | Secrets are removed before the agent phase | Agent internet off by default; allowlist possible | — |
| Devin | No hooks | Machine setup | Secrets as environment variables | Hostname allowlist | — |

Sources:
- Claude Code on the web:
  - https://code.claude.com/docs/en/cloud-environments
  - https://code.claude.com/docs/en/hooks
  - https://code.claude.com/docs/en/settings#settings-in-cloud-sessions
  - https://code.claude.com/docs/en/permission-modes
  - https://platform.claude.com/docs/en/manage-claude/compliance-sessions
  - https://code.claude.com/docs/en/monitoring-usage
  - Cloud sessions set `CLAUDE_CODE_REMOTE=true`. Hook edits apply live; writes under `.claude/` are prompted.
- GitHub Copilot:
  - https://docs.github.com/en/copilot/reference/hooks-reference
  - https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/use-hooks
  - https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-environment
  - https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/customize-the-agent-firewall
  - https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/configure-secrets-and-variables
  - https://docs.github.com/en/enterprise-cloud@latest/copilot/reference/agentic-audit-log-events
  - Hook answers:
    - `{"permissionDecision": "deny", "permissionDecisionReason": …}`.
    - Exit 2 also denies, and so does any other non-zero exit.
    - A timeout lets the call run. The default is 30 s; `timeoutSec` changes it.
  - Only the `bash` field of a hook runs in the cloud; the cwd is `/workspace`.
  - `preToolUse` sends `{sessionId, timestamp, cwd, toolName, toolArgs}`, where `toolArgs` is a JSON string. `PreToolUse` sends Claude Code's snake_case shape.
  - Documented tool names: ask_user, bash, create, edit, glob, grep, powershell, task, view, web_fetch. Their argument fields aren't documented.
  - The session sets GITHUB_COPILOT_API_TOKEN, GITHUB_COPILOT_GIT_TOKEN and HOME=/root.
- Cursor:
  - https://cursor.com/docs/hooks
  - https://cursor.com/docs/cloud-agent/setup
  - https://cursor.com/docs/cloud-agent/security-network
  - https://cursor.com/docs/enterprise/compliance-and-monitoring
  - https://cursor.com/docs/enterprise/opentelemetry-export
  - `failClosed: true` makes a crash or timeout block.
- Codex:
  - https://learn.chatgpt.com/docs/hooks
  - https://learn.chatgpt.com/docs/environments/cloud-environments
  - https://learn.chatgpt.com/docs/cloud/internet-access
  - https://learn.chatgpt.com/docs/agent-approvals-security
  - https://learn.chatgpt.com/docs/enterprise/governance.md
- Devin:
  - https://docs.devin.ai/onboard-devin/environment
  - https://docs.devin.ai/product-guides/security-profiles

Conclusion: the three vendors that run repository hooks in their cloud (Claude
Code on the web, Copilot, Cursor) can be covered the way a laptop is covered
in hooks mode. Codex cloud and Devin can't be covered today: no hook runs
there. They stay visible only through their own logs and the git history.

## 2. Remote hook mode (design)

A cloud environment is one endpoint (`cp.endpoints.kind = 'cloud'`, migration 019) shared by all of its sessions.
- **Creation.** `POST /api/v1/cloud-environments {name, vendor}` (scope `endpoints`), with no enrollment. It returns one token, once:
  - `efc_` + base64url(JSON). The JSON holds the server, endpoint id, tenant, endpoint secret (`eps_…`) and the policy signing key.
  - The key is pinned when the token is made, so there is no first-use trust.
- **Protocol.** The environment uses the endpoint protocol as a machine does: signed policy compiled for it, events, approvals, heartbeat.
- **Lifecycle.** It is never marked offline, because a cloud environment is only heard from while a session runs. Revoking it (Machines → Revoke) stops its token.

`effigentd hook <claude|copilot|cursor|codex|gemini> --remote` is the whole endpoint for one tool call. `$EFFIGENT_CLOUD_TOKEN` being set also turns it on. For each call it:

1. Reads the credentials: `$EFFIGENT_CLOUD_TOKEN`, else `<state>/endpoint.json`, which `effigentd cloud-setup` wrote in the setup step.
   - State dir: `$EFFIGENT_STATE_DIR`, else `/var/tmp/effigent-cloud`. The path is fixed because a setup step and its agent may not share a home: Copilot's setup runs as the runner user, its agent with HOME=/root.
   - A directory there owned by another user (not root) is skipped for `~/.effigent-cloud`. An agent user that can't write the setup's directory keeps its cache, spool and session marks in `~/.effigent-cloud`.
2. Loads the cached signed policy and verifies the signature, tenant and endpoint, as the daemon does.
   - When the cache is older than `EFFIGENT_REMOTE_REFRESH` (default 60 s), or nothing is cached, it syncs: policy plus heartbeat, 3 s budget (6 s with nothing cached).
   - The cache is written with a rename, since calls run concurrently.
3. With no policy at all (never synced, control plane unreachable) it **denies**. `EFFIGENT_REMOTE_FAIL_OPEN=1` decides with the built-in default policy instead.
4. Decides the call with the daemon's own code: `hookHandlerSeen` → `hooks.EvaluateCall`, then approvals through `cp.RequestApproval` (long-poll).
   - Approval waits: the hook budget is 28 s, or 20 s for Copilot, whose timeouts let the call run. The daemon waits up to budget − 10 s.
   - `agent_start` goes out once per session, through marker files.
5. Posts the call's events (scrubbed by the engine) before answering, as one batch with a `batch_id`.
   - A batch that can't be sent goes to `<state>/spool`, at most 2000 batches. The next call that reaches the control plane sends up to 10 of them.
   - A refused batch (4xx other than 408/429) is dropped.

Why the hook process decides instead of the control plane deciding over HTTP:
- The evaluator reads the agent's files: scripts to depth 2, package.json, `.git/HEAD`, AWS/kube configs. Those exist only in the session.
- A local decision costs no round trip. Copilot lets a call run when its hook times out.
- Every covered vendor has a setup step, and secrets reach it.

The control plane still makes every other decision: what the policy is, approvals, who is notified, and retention.

`effigentd cloud-setup [--token] [--state-dir] [--allow-offline] [--shared]`:
- Saves the token's credentials and fetches the policy.
- Exits non-zero when it can't, unless `--allow-offline` is set; the hooks then deny until a sync succeeds.
- `--shared` makes the state readable by other users, for an agent that runs as a different user than the setup.

`https://effigent.ai/cloud-setup.sh` (`packages/site/public/cloud-setup.sh`):
- Downloads `effigentd-linux-<arch>` and checks its `.sha256`.
- Installs it in `/usr/local/bin`, with sudo when needed.
- Runs `cloud-setup --shared` with the token from `$EFFIGENT_CLOUD_TOKEN`.

The repository commits `.effigent/cloud-hook.sh` (`deploy/cloud/cloud-hook.sh`). Every vendor's hook config runs it.
- It decides only in a cloud session. The markers:
  - `CLAUDE_CODE_REMOTE=true`.
  - Copilot's `GITHUB_COPILOT_API_TOKEN` or `GITHUB_ACTIONS=true`.
  - `EFFIGENT_CLOUD_TOKEN` set.
  - The setup step's `endpoint.json`, when owned by root or the caller (so another user can't plant one).
  - A developer's laptop that clones the repo is left to its own effigentd.
  - `CLAUDE_CODE_REMOTE` and `GITHUB_COPILOT_API_TOKEN` are documented. `GITHUB_ACTIONS` in the Copilot agent phase is unverified.
- In a cloud session without effigentd it blocks with exit 2.

Copilot answers: `hooks.ParseCopilot` reads both payload spellings and maps Copilot's tools onto the canonical ones:
- bash/powershell → Bash
- view → Read
- create → Write
- edit → Edit
- web_fetch → WebFetch
- glob, grep

`hooks.CopilotOutput` prints the flat deny with Claude Code's `hookSpecificOutput` added (for `PreToolUse`). The policy agent is `copilot-agent`. The argument field names (`command`, `path`, `url`, `pattern`) are the likely ones and haven't been checked against a live agent.

## 3. Setting up a vendor

The console builds the snippets with the real token and control plane host: Machines → Add a cloud environment. Allow `effigent.ai` (download) and the control plane host (`api.effigent.ai`) in the vendor's network settings. In your policy, add `file_write_deny: [/.effigent/, /.claude/settings.json, /.github/hooks/, /.cursor/hooks.json]`, so the agent's own edits to the hook files are refused where the hook can see them.

**Claude Code on the web.**
- Environment (claude.ai/code → environment → Edit):
  - Environment variable `EFFIGENT_CLOUD_TOKEN=efc_…`.
  - Setup script `curl -fsSL https://effigent.ai/cloud-setup.sh | sh`.
  - Network access: Custom, with both hosts.
- Commit `.effigent/cloud-hook.sh` and `.claude/settings.json`:
  ```json
  {"hooks": {"PreToolUse": [{"matcher": "*", "hooks": [
    {"type": "command", "command": "sh \"$CLAUDE_PROJECT_DIR/.effigent/cloud-hook.sh\" claude", "timeout": 60}]}]}}
  ```
- For stricter control, put the same hook in server-managed settings with `allowManagedHooksOnly`. The agent can't edit that, but it covers every repository.

**GitHub Copilot cloud agent.**
- Secret: `EFFIGENT_CLOUD_TOKEN` in the repository's `copilot` environment.
- `.github/workflows/copilot-setup-steps.yml`, job `copilot-setup-steps`, with the step `run: curl -fsSL https://effigent.ai/cloud-setup.sh | sh` and `env: EFFIGENT_CLOUD_TOKEN: ${{ secrets.EFFIGENT_CLOUD_TOKEN }}`.
- Commit `.effigent/cloud-hook.sh` and `.github/hooks/effigent.json` on the default branch:
  ```json
  {"version": 1, "hooks": {"preToolUse": [{"type": "command", "bash": "sh .effigent/cloud-hook.sh copilot", "timeoutSec": 45}]}}
  ```
- Firewall: add both hosts to the custom allowlist.

**Cursor cloud agents.**
- Runtime Secret `EFFIGENT_CLOUD_TOKEN`.
- `.cursor/environment.json` `"install": "curl -fsSL https://effigent.ai/cloud-setup.sh | sh"`.
- Commit `.effigent/cloud-hook.sh` and `.cursor/hooks.json`. Each of `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile` and `preToolUse` gets `{"command": "sh .effigent/cloud-hook.sh cursor", "timeout": 60, "failClosed": true}`.

**Other agents with Claude Code-style hooks:** run the setup step, then use `effigentd hook claude --remote` as the pre-tool hook.

## 4. Limits (cloud)

- **Hooks only.** There is no kernel layer. Interpreters, scripts deeper than 2, SDK calls from code and anything else the hook can't read aren't seen, as in hooks mode on a Mac (CLAUDE.md §5).
- **The agent can edit the repository's hooks.**
  - It can rewrite the hook config or `.effigent/cloud-hook.sh`. The change applies at once on Claude Code (hooks reload live).
  - Copilot loads hooks from the default branch, so a branch edit doesn't apply to the running session.
  - `file_write_deny` on those paths refuses the edits the hook can see (Write/Edit, redirects, cp/mv/tee/sed -i), not a Python one-liner.
  - Claude Code's server-managed settings with `allowManagedHooksOnly` is the only vendor-enforced hook.
- **The token is readable by the agent.** Vendors expose environment secrets and setup files to the session.
  - With the token, the agent or anything it runs can fetch this environment's compiled policy, post events as the environment, and file approval requests. It can't decide approvals, publish policy or read other endpoints.
  - Revoke the environment to stop the token. One environment per repository keeps the blast radius small.
- **Fail-closed holes the vendor decides.**
  - Copilot lets a call run when the hook times out. Effigent stays inside 20 s; set `timeoutSec` above that.
  - On Claude Code a hook that exits with an error other than 2 doesn't block. `cloud-hook.sh` exits 2 when effigentd is missing, and `effigentd hook` prints a deny on every internal failure.
  - Cursor needs `failClosed: true`.
  - If the setup step didn't run and the session has no other marker (Cursor without its secret), the wrapper can't tell it is in the cloud, and the call runs.
- **Local side effects.**
  - `EFFIGENT_CLOUD_TOKEN` set in a developer's own shell turns their local hooks into remote mode, under the cloud environment's identity.
  - `--shared` (what `cloud-setup.sh` uses) writes the token world-readable (0644) in `/var/tmp/effigent-cloud`. That is fine in a single-tenant session VM; don't run it on a shared machine.
- **Copilot specifics.**
  - Its tool argument fields aren't documented. The spellings read are the likely ones and are not verified against a live agent.
  - Whether the `copilot` environment's secrets reach hooks isn't documented, which is why `cloud-setup` saves the credentials in the setup step.
  - The firewall covers the Bash tool's processes; whether it covers hook processes isn't documented.
- **Not covered:** Codex cloud (no hooks in cloud tasks, secrets removed before the agent runs) and Devin (no hooks).
- **Not verified live.** None of the three vendors has been run against this yet. Verified:
  - `test/hooks/remote.sh`: 32 checks. The real hook binary against a local control plane, covering deny, approval round trip, Copilot payloads, events, setup, offline cache, fail closed, fail open, spool drain and revocation.
  - `test/hooks/cloudsetup.sh`: 9 checks. In a Linux container, the setup script installs from a local releases dir as root and a non-root agent user runs the wrapper.
- **Identity.** The OS user on events is the session's, so it is usually `root`. A cloud session has no person behind it the endpoint can see. The vendor's own audit log (Copilot `agent_session_id`) is the join key.

## 5. Containers on an enrolled node (hook socket)

Agents in containers reach the node's effigentd through a unix socket, not
127.0.0.1:7777.
- `effigentd -hook-socket /var/run/effigent/hook.sock` serves the same hook API. In the Helm chart it is on by default (`hookSocket.enabled`, hostPath `/var/run/effigent`); `deploy/docker/compose.yaml` mounts the same host directory.
- The agent's pod mounts the directory. `effigentd hook` finds the socket by itself; `EFFIGENT_HOOK_SOCKET` / `EFFIGENT_DAEMON_URL` override it.
- The kernel identifies the caller, not the hook (`internal/endpoint/peer`):
  - SO_PEERCRED gives pid, uid and gid. `/proc/<pid>/cgroup` gives the container id and pod UID.
  - Tetragon's exec events give the pod's namespace/name, cached by container id.
  - The uid is named from the container's own `/etc/passwd`, opened with `openat2(RESOLVE_IN_ROOT)` so a symlink can't leave the container.
  - Files the evaluator reads are opened inside the caller's root (`/proc/<pid>/root`) when its mount namespace differs.
  - An agent that Tetragon tracks above the caller gives the policy agent name, which wins over the hook's own agent name.
  - Approvals and events carry the kernel's uid, container and pod, not the `X-Effigent-OS-User` claim.
- Limits:
  - Anything that can open the socket can ask for decisions and file approvals under its own kernel identity. It's 0666, and the hostPath is the access control.
  - Pod Security Admission must allow hostPath (privileged level) for the agent pods.
  - A container's root (uid 0) is treated as unknown for file reads: world-readable files only.
- Verified:
  - `test/containers/hooksock.sh`: kind, chart with `-sensor=hooks`, a pod as uid 1234 — deny, approval round trip, kernel uid, container id and pod uid on events and approvals, missing socket → deny.
  - `cred_linux_test.go` / `socket_linux_test.go` in a Linux container.
  - **Not run:** the `agent-hook` section of `test/containers/kind.sh` (pod name via Tetragon), because it needs the Tetragon chart and only one Tetragon can run per kernel.

## 6. WSL2 (on paper)

Not tested. From Microsoft's kernel configs:
- https://raw.githubusercontent.com/microsoft/WSL2-Linux-Kernel/linux-msft-wsl-6.18.y/arch/x86/configs/config-wsl
- https://lists.ubuntu.com/archives/kernel-team/2026-September/171517.html

What the configs show:
- **6.18.y** has `CONFIG_BPF_LSM=y`, `bpf` in `CONFIG_LSM` and BTF.
- **6.6.y** has BPF_LSM but not in the default LSM list. It needs `kernelCommandLine = lsm=…,bpf` in `.wslconfig` (https://learn.microsoft.com/en-us/windows/wsl/wsl-config).
- Neither sets `CONFIG_FUNCTION_ERROR_INJECTION`. Tetragon's override actions need `BPF_KPROBE_OVERRIDE` (https://tetragon.io/docs/installation/faq/); our enforcement uses the LSM hooks, which shouldn't need it, but that is unverified.

Expected:
- `install.sh` inside a WSL2 distro on a 6.18 kernel works as on Linux. Without systemd, Tetragon and effigentd run as background processes; the installer handles that.
- Agents run inside WSL get kernel enforcement.
- Agents run on the Windows side are covered by the Windows hooks (install.ps1), not by WSL.
