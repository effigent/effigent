# Effigent — engineering guide

> **Effigent** — the AI Agent Control Plane. A daemon on each Linux/macOS machine
> (`effigentd`) recognises AI coding agents (Claude Code, Cursor, Codex, …), attributes
> every process, file, network and MCP action to the agent that caused it, and enforces
> policy on the machine (Linux: BPF LSM via Tetragon). Policies are managed centrally
> (`effigent-cp`), signed, and keep working offline. The console shows agents, events,
> approvals and policy. Product spec: `PRD.md` (not committed; ask the founder).

Keep this file current when architecture, data model or deployment change.

## 1. Layout

| Path | What | Runs on |
|---|---|---|
| `cmd/effigentd`, `internal/endpoint/*` | Endpoint daemon (Go). `tetragon/` gRPC client + TracingPolicy rendering, `engine/` agent detection, attribution, per-agent kernel policy lifecycle, `policy/` the endpoint policy format (`default.yaml`), `cpclient/` enrollment + signed policy sync, `sink/` stdout/JSONL/HTTP, `api/` local REST, `procscan/`. Subcommands: `enroll`, `run` (zero-gap launcher). | Linux host next to Tetragon (dev: Docker Desktop VM) |
| `cmd/effigent-cp`, `internal/controlplane/*` | Control plane (Go): `store/` Postgres (schema `cp`, embedded migrations tracked in `cp.schema_migrations`), `server/` endpoint protocol `/ep/v1/*` + console API `/api/v1/*`. Image: `Dockerfile.cp`. | AWS App Runner `effigent-cp` (628713530358, us-east-1) at https://api.effigent.ai — redeploy with `AWS_PROFILE=effigent deploy/aws/deploy-cp.sh` |
| `internal/shared/*` | `action/` action model, fingerprint, state machine · `policy/` central policy types + evaluator · `sign/` ed25519 policy signing. | both |
| `packages/dashboard` | Console — Next.js 16 + Clerk. **Live** on `/api/v1` (`src/lib/api.ts`, Clerk Bearer token, `NEXT_PUBLIC_EFFIGENT_API_URL`): Overview, Enforcement (machines, enroll, revoke), Policies (YAML editor, versions), Audit (events + verifiable trail), Settings (workspace/role). No sample data by default: pages without a backend (Approvals, Allow/Deny Lists, Identity) show "Coming soon" empty states; the Agent Graph is built client-side from real events (`src/lib/live-graph.ts`). **Demo Mode** (Settings / user menu; localStorage `effigent.demoMode`) swaps in a sample workspace from `src/lib/fixture-api.ts` on every page and never calls the real API. | Vercel, app.effigent.ai |
| `packages/site` | Marketing site + docs, Next.js static export. | S3 + CloudFront, effigent.ai |
| `test/endpoint` | Endpoint e2e against Tetragon (37 checks). On a Mac with effigentd installed run `PORT=7787 ./test/endpoint/e2e.sh` (the installed daemon holds 7777). | Docker Desktop |
| `test/claude` | Real Claude Code in a container, enforced by effigentd, policy from the control plane. | Docker Desktop |
| `Dockerfile.effigentd`, `deploy/helm/effigent`, `deploy/docker` | effigentd for container hosts and Kubernetes. Image `ghcr.io/effigent/effigentd:<version>` + `:latest` (amd64/arm64), Helm repo `https://effigent.ai/charts` (chart `effigent`, DaemonSet: hostPID, hostNetwork, privileged, `/var/lib/effigent` hostPath, `EFFIGENT_HOSTNAME` = node name, token from a Secret). Both published by `release-effigentd.yml` after the binaries; the ghcr package must be public. Tetragon comes from its official chart with `tetragon.grpc.address=localhost:54321` + `tetragon.processAncestors.enabled=base,kprobe,lsm`. `deploy/docker/compose.yaml` = Tetragon (event cache 2 × 1s) + effigentd on a plain host. | customer clusters / Docker hosts |
| `test/containers` | `kind.sh` (2-node kind + Tetragon chart + our chart) and `docker.sh` (compose): stand-in agent's curl and `.env` blocked, blocks in the local control plane, restart keeps the machine. One Tetragon per kernel: stop the dev `tetragon` container first. | Docker Desktop |

## 2. How policy reaches the kernel

1. Console/admin `PUT /api/v1/policy` with an endpoint policy YAML → validated with the
   endpoint's own parser → stored as the next version in `cp.policy_versions`.
2. `effigentd` (enrolled) polls `GET /ep/v1/policy?have=N` every `-sync-interval` (5s).
   The control plane signs the document (ed25519); the endpoint verifies signature and
   tenant against the key pinned at enrollment, refuses versions ≤ current, applies it
   live (`engine.SetPolicy`, make-before-break per agent), caches it in `policy.json`.
   With no usable cached policy (fresh enrollment) the daemon fetches the first one before its
   API answers and agents are tracked (≤15s; unreachable → built-in default until a sync succeeds).
3. Offline restart → the cached signed policy is applied; a tampered cache is rejected and
   the built-in default applies. Local `PUT /policy` is refused while enrolled.
4. Events are POSTed in batches to `/ep/v1/events` and stored in `cp.events`.
5. Containers enroll on start: with `EFFIGENT_ENROLL_TOKEN` (+ `EFFIGENT_SERVER`, default
   https://api.effigent.ai) and no `endpoint.json` in the state dir, the daemon enrolls first
   (`cpclient.EnsureEnrolled`: retries network errors/5xx, not a refused token). Saved
   credentials always win, so a restarted pod is the same machine. `EFFIGENT_HOSTNAME` overrides
   the machine name at enrollment and in every event's `node`.

**Central policies** (`internal/shared/policy`: rules for users / teams / agent types,
allow / deny / require_approval) are compiled per machine by `internal/controlplane/compile`:
- `PUT /api/v1/policy {"body": <base yaml>, "policies": [...]}` → `body` is the base every
  machine starts from (agent detection, modes, alerts; its denies are a floor), `policies`
  is stored in `cp.policy_versions.source`. Publish compiles for every endpoint and returns
  `report.unsupported` (clause, reason, `hooks_only` / `observe_only` / `not_enforced`) and
  what each machine gets. Omitting `policies` keeps the published ones; `[]` clears them.
- A machine's identity is `owner` (user id or email) + `teams` on `cp.endpoints`, set with
  `PATCH /api/v1/endpoints/{id}`; that republishes so endpoints refetch.
  `GET /api/v1/endpoints/{id}/policy` previews the compiled body.
- `GET /ep/v1/policy` compiles at serve time against the version's `created_at`
  (deterministic); the signed document carries `endpoint`, and effigentd refuses a
  document compiled for another machine.
- Kernel mapping: binaries → exact `exec_deny` paths (a bare name expands over
  `compile.ExecDirs`), `**/name` or absolute paths → `file_deny` suffixes (only when the
  rule covers reads and writes), IPs/CIDRs → `network_deny`. `require_approval` → deny.
  Arguments, tools, MCP, hostnames, ports, OS users, policy defaults and too-narrow
  allows are reported, never silently dropped. Precedence comes from `policy.Evaluate`.
- **Rollout order:** effigentd builds older than the `endpoint` field fail the signature
  check on compiled documents and stay on their current version (fail closed, logged every
  sync). Upgrade endpoints before a tenant's first central-policy publish. A machine whose
  compile fails gets 422 and keeps its version; it shows as a lagging `policy_version`.
  effigentd builds older than `domain_deny` support refuse a policy that uses it (parse
  error) and also stay on their current version: upgrade endpoints before publishing one.
  The same holds for the approval lists (`*_approve`, `approvals:`; effigentd < v0.5.0).
  Deploy order for approvals: control plane (`deploy-cp.sh`, migration 004) → push `main`
  (console) → tag effigentd → reinstall endpoints → publish a policy with approval lists.

## 2b. Approvals

- Endpoint policy lists `exec_approve`, `file_approve`, `domain_approve`, `network_approve`
  (matched like their deny twins), `command_approve` (`"git push*"`: a simple command
  after wrappers, exact or `*` prefix) and `tool_approve` (agent tool names, `mcp__github__*`);
  top-level `approvals: {wait_seconds (≤90, default 45), ttl_minutes (default 60)}`.
  A deny list always wins. Central `require_approval` compiles to these lists.
- Hooks (`hooks.EvaluateClaude` → `Decision.Approve`) in denylist/allowlist mode;
  monitor/learn report `would_block`. The daemon (`cmd/effigentd/hooks.go` `askApproval`)
  fingerprints the call (`action.Fingerprint`: tenant, endpoint, session, OS user, tool +
  full input), sends a redacted summary to `POST /ep/v1/approvals`, which creates or reuses
  the open request (one per endpoint+fingerprint), notifies once, and long-polls up to
  `wait_seconds` (≤90s). Approved → the call runs and the approval is used (single-use).
  Pending / denied / expired → deny with a message telling the agent what to do. Not
  enrolled or control plane unreachable → deny.
- Timeouts line up: daemon wait ≤ hook budget − 10s; `effigentd hook` sends
  `X-Effigent-Hook-Budget: 28` (so ≤18s of waiting; older hook binaries get 8s → no wait).
  Claude Code applies the hook `timeout` it read when the session started (install-hooks
  writes 120, but sessions started under v0.4.0 still use 30s) and a timeout blocks the
  call; an approval given later is used when the agent retries (verified 2026-10-17).
- Kernel (Linux): `Rule.Kernel()` turns the exec/file/domain/network approve lists into
  denies; command/tool lists are invisible to it.
- Control plane: `cp.approvals`, `cp.notification_settings` (migration 004). Console API
  `GET /api/v1/approvals`, `POST /api/v1/approvals/{id}/decision` (admin/security_admin),
  `GET|PUT /api/v1/notifications`, `POST /api/v1/notifications/test`. Notifications
  (`internal/controlplane/notify`):
  - **Slack app (preferred)** — `server/slackapp.go`. The workspace creates its own Slack app
    from the manifest the Settings card builds (scopes `chat:write`, `chat:write.public`,
    `users:read`, `users:read.email`; interactivity URL `<EFFIGENT_PUBLIC_URL>/slack/interactions`)
    and pastes bot token + signing secret + channel ID (`PUT|DELETE /api/v1/notifications/slack-app`;
    connect runs `auth.test` and posts a confirmation). Token and secret are sealed with
    AES-GCM under `EFFIGENT_SECRETS_KEY` (`server/secrets.go`, AAD = tenant + field; changing
    the key means reconnecting) and never returned. Requests go out via `chat.postMessage`
    with interactive Approve/Deny whose `value` is a link token (channel `slack-app`,
    recipient = Slack team id). `POST /slack/interactions`: HMAC token → that tenant's
    signing secret checks `X-Slack-Signature` (5 min skew) → team must match → 200 at once;
    then `users.info` (bots, deleted, guests, no visible email refused) and the approver rule:
    `members` (default) = the Slack email must be a verified email of a console
    admin/security_admin, via Clerk's Backend API (`CLERK_SECRET_KEY`, `server/directory.go`,
    2 min cache; without the key every click is refused); `workspace` = anyone in the Slack
    workspace. Decision: `decided_by = slack:<team>:<user>`, `decided_by_name = "Name <email>
    (via Slack)"`, audit actor_via `slack` with `slack_user_id/team_id/username`, `email`,
    `name`; the message is replaced via `response_url` (hooks.slack.com/actions only) with who
    decided. Repeat clicks / expired requests get an ephemeral answer. With an app connected
    the webhook isn't used.
  - Slack incoming webhook (only `https://hooks.slack.com/services/…`, never returned): the
    message's only button opens the console — a webhook can't tell who clicked, so it never
    carries a link that decides; `/a/` refuses old Slack link tokens.
  - Email over SMTP
  (`EFFIGENT_SMTP_URL=smtp://user:pass@host:587` or `smtps://…:465`), or — in production — the
  Amazon SES API with the instance role (`EFFIGENT_SES_REGION=us-east-1`; domain effigent.ai
  verified with Easy DKIM in Route 53), plus `EFFIGENT_EMAIL_FROM`.
  Email buttons: signed single-recipient links `/a/{token}`
  (`server/actionlinks.go`, HMAC keyed from the signing seed); GET shows a confirmation
  page, POST decides (so link scanners can't approve), recorded as `<email> (via email)`.
  Plus a link to
  `EFFIGENT_CONSOLE_ORIGIN/approvals?id=…`. Audit: `approval.request|approve|deny`,
  `notifications.update`, `notifications.slack_app.connect|disconnect`.

- **Approval routing** (migration 008, `server/routing.go`): per tenant one document in
  `cp.approval_routing` — approver groups (members by Clerk user id + email, picked in the
  console from Clerk's frontend org memberships; no backend Clerk key needed) and ordered rules
  (kinds command/website/tool/file from the approve list; patterns case-insensitive, `*`
  wildcard, unanchored over the redacted summary + reason; machines; agents) + default group.
  A new request is routed once when filed (`approvals.group_id/route_id`; first rule, else
  default, else workspace admins as before). Only the group's members are emailed; decisions
  (`POST /approvals/{id}/decision`, now gated in the handler, not the route) by members (any
  role), or admins/security_admins as an override (name + audit `admin_override`), or API keys
  with `approvals`. Email links re-check membership at decision time. Console: Team & Approvers
  (`/team`). `GET|PUT /api/v1/approval-routing` (audited before/after),
  `POST /api/v1/approval-routing/test` (also takes an unsaved `config`).

## 2c. Integrations (API keys, webhooks)

- **API keys** (`efk_…`, sha256 in `cp.api_keys`): scopes `read` (every GET; always
  added), `approvals` (decide), `endpoints` (enroll tokens, revoke, owner), `policy`
  (publish). Routes opt in with `s.scoped("<scope>", write, h)`; `s.console(write, h)`
  stays people-only (keys, webhooks, notifications). Principal `apikey:<id>`, via `api-key`.
- **Webhooks** (`cp.webhooks`, migration 005): https only; private/loopback/link-local/
  CGNAT refused on the dialed address (DNS rebinding), no redirects; the URL may carry
  the receiver's token and is never returned (`url_hint`). Signed
  `X-Effigent-Signature: t=<unix>,v1=hex(HMAC-SHA256(secret, "t.body"))`, secret shown once.
  Events: approval.requested, approval.decided, action.blocked (opt-in, 60/min cap,
  `dropped` counter), endpoint.enrolled, endpoint.revoked, policy.published, test.
  `emit()` only enqueues (`cp.webhook_deliveries`); the worker (started by `Handler()`)
  claims due rows with `for update skip locked` + a 60s lease and retries 10s, 1m, 5m,
  30m, 2h, 6h; 4xx except 408/429 are final. `EFFIGENT_DEV_INSECURE_WEBHOOKS=1` (local
  only) allows http:// and private targets.
- `GET /api/v1/approvals/{id}` lets automations re-check a request before acting.
- **Slack is off in production for now (email only)**: `EFFIGENT_SLACK=1` turns Slack
  approval messages on; off, nothing posts to Slack, Slack can't be connected
  (`/notifications` reports `slack_enabled: false`) and the console hides it. Next step is a
  B2B Slack app (one Effigent app, "Add to Slack" OAuth per customer workspace) instead of
  each customer creating their own app. Control plane env for Slack approvals:
  `EFFIGENT_SLACK=1`, `EFFIGENT_SECRETS_KEY` (≥ 32 chars) and `CLERK_SECRET_KEY`. Deploy order: control plane (migration 006) → console.
- **Agent events** (migration 007): `GET /api/v1/events?paged=1` → `{events, next_before,
  retention_days}`, cursor `before=<unixnanos>_<id>` over `(event_time desc, id desc)`, filters
  `since/until`, `type` (comma list), `agent`, `endpoint`, `q`. Each ingested batch is a row in
  `cp.event_batches` chained **per endpoint**; content/batch hashes are computed by Postgres
  (`cp.event_batch_content`, `cp.event_batch_hash`) at ingest and at `GET /api/v1/events/verify`.
  `cp.events` is append-only (trigger); deletes only with `set local effigent.retention='on'`
  and rows > 90 days old. effigentd ≥ v0.5.4 sends `batch_id` (unique per endpoint → replays
  stored once) and spools failed batches to `<state>/spool` (256 MB cap). Retention: hourly,
  advisory-locked, `EFFIGENT_EVENT_RETENTION_DAYS` (min 90) → one gzip'd JSON-lines object per
  tenant-day in `EFFIGENT_ARCHIVE_BUCKET` (`events/<tenant>/<yyyy>/<mm>/<dd>.jsonl.gz`, size
  checked) → delete in one tx; batch rows stay (`archived_at`), `cp.event_archives` lists days,
  console audit `events.archive`; no bucket or failed upload = nothing deleted. Archived days
  download via `POST /api/v1/events/archives/{day}/link` (10-min presigned URL, audited).
- Audit trail: `GET /api/v1/audit?paged=1` → `{entries, total, next_before}`; filters
  `action` (comma-separated prefixes), `via` (actor kinds), `actor`, `q` (words, ILIKE over
  action/target/actor/details/ip), `since`/`until` (RFC 3339), cursor `before=<seq>`,
  `limit` ≤ 500. Without `paged` it still returns the newest `limit` entries as an array.
- `integrations/windmill/`: resource type, scripts, and the Slack/Teams approval flow
  (tested against Windmill CE v1.837 locally; Slack/Teams buttons not exercised).

## 3. Auth

- Endpoints: one-time enrollment token (`eft_…`, hashed, expiry + max uses) →
  endpoint secret (`eps_…`, hashed) used as Bearer on `/ep/v1/*`. Revocation via console.
- API keys: see 2c.
- Console API: Clerk session JWT (verified via `CLERK_ISSUER`/.well-known/jwks.json;
  tenant = `org:<id>` or `user:<id>`, same refs as v1 `tenants.clerk_ref`), or
  `EFFIGENT_ADMIN_TOKEN` + `X-Effigent-Tenant` for automation.
- Console dev bypass: `EFFIGENT_DEV_NOAUTH=1 NEXT_PUBLIC_EFFIGENT_DEV_NOAUTH=1` (never in production builds).

## 4. Running locally

```
docker compose up -d postgres                       # localhost:5433
docker run -d --name tetragon --privileged --pid host -p 127.0.0.1:54321:54321 \
  -v /sys/kernel/btf/vmlinux:/var/lib/tetragon/btf quay.io/cilium/tetragon:v1.7.1 /usr/bin/tetragon \
  --server-address 0.0.0.0:54321 --export-filename /var/log/tetragon/tetragon.log \
  --enable-ancestors=base,kprobe,lsm               # Tetragon in Docker Desktop's VM (BTF + BPF LSM)
DATABASE_URL=postgres://effigent:effigent@localhost:5433/effigent EFFIGENT_ADMIN_TOKEN=devadmin \
  go run ./cmd/effigent-cp -listen 127.0.0.1:8080
curl -H 'Authorization: Bearer devadmin' -H 'X-Effigent-Tenant: org:dev' -X POST localhost:8080/api/v1/enrollment-tokens
go run ./cmd/effigentd enroll --server http://127.0.0.1:8080 --token eft_… --state-dir ~/.effigent
go run ./cmd/effigentd --state-dir ~/.effigent
./test/endpoint/e2e.sh                              # endpoint e2e (standalone, not enrolled)
./test/claude/run.sh                                # real Claude Code (needs ~/.effigent-claude.env)
./test/hooks/approval.sh                            # approval flow: real hook process -> hooks-mode daemon -> local control plane
# console against a local control plane (dev only): add to the dev command
#   NEXT_PUBLIC_EFFIGENT_API_URL=http://127.0.0.1:8080 NEXT_PUBLIC_EFFIGENT_DEV_ADMIN_TOKEN=devadmin NEXT_PUBLIC_EFFIGENT_DEV_TENANT=org:dev
#   (control plane: EFFIGENT_ADMIN_TENANTS=org:dev EFFIGENT_CONSOLE_ORIGIN=http://localhost:3000)
npm run -w @effigent/dashboard dev                  # console (with the dev bypass vars)
npm run -w @effigent/site build                     # site
```

## 5. Known limits (keep honest; the site's coverage matrix follows these)

- Kernel blocking is per resolved binary path and file path suffix; argument-level rules alert only.
- Network: connects to IPs/CIDRs in `network_deny` / outside `network_allow` are blocked (verified by hand, e7c5125; no automated e2e check yet).
- `domain_deny` (hostnames) is enforced by address: `internal/endpoint/domains` resolves each name every `-dns-refresh` (30s) via the system resolver + `-dns-servers` (1.1.1.1, 8.8.8.8, 9.9.9.9), keeps every address seen in the last 15 min (max 64 per name; a failed lookup never shrinks the set; loopback/link-local answers are dropped), and the engine adds them to `network_deny` at apply time, re-applying only agents whose names changed. While it is in force, a DNS bypass guard blocks agents from DoT (:853 anywhere) and from well-known public resolvers on :53/:443/:853, except the nameservers in effigentd's and the agent's own `resolv.conf` and single addresses listed in `network_allow`. effigentd itself queries the public resolvers every 30s; `-dns-servers ""` limits it to the system resolver. Limits: shared CDN IPs over-block or miss; names are exact (no wildcards, `www.` separate); private DoH, hard-coded IPs, `/etc/hosts` pins and proxies evade it; effigentd resolves from its own vantage point (split-horizon DNS can differ). `network_allow` is the stronger control. e2e section 6.
- macOS / Windows: no kernel enforcement (macOS needs an Endpoint Security entitlement).
  `-sensor hooks`: the agents' pre-tool hooks (`effigentd hook claude|codex|gemini`)
  ask the daemon before every tool call; `internal/endpoint/hooks.EvaluateClaude` denies
  in denylist/allowlist mode and reports `would_block` in monitor/learn. It checks Bash
  commands (a small shell reader: pipes, `&&`, `$( )`, `sh -c`, sudo/env/xargs wrappers)
  against `exec_deny`/`exec_allow` **by program name** (`/opt/homebrew/bin/curl` matches
  `/usr/bin/curl`), named/redirected files plus directories and globs that would reach
  them against `file_deny`/`file_alert`, and hosts/IPs named in commands or WebFetch
  against `domain_deny` (name + subdomains), `network_deny`, `network_allow` (IPs only).
  Limits: it reads the command, not what runs — scripts, interpreters (`python -c`),
  variables, aliases and tools that connect on their own aren't followed. Agent and MCP
  tools are matched by name: `tool_deny` refuses them (checked first), `tool_approve`
  pauses them. If the daemon is down
  the hook denies. Approvers: any console admin /
  security_admin (central `approval.users/teams` are not enforced yet), from the console
  in Slack via the workspace's Slack app (identity checked, see 2b), or from the signed
  email buttons.
  Every call is one event (`exec`, or `blocked`/`would_block`/`file_open`, kind `tool`).
- Agents with hooks (`effigentd install-hooks`, run by the macOS pkg and install.ps1;
  `--agents claude,codex,gemini`, `--remove`, `--exclusive`): each agent's calls are
  translated to Claude Code's canonical tools (`internal/endpoint/hooks/agents.go`), so
  one policy (deny + approval lists, `mcp__<server>__<tool>` names) covers all three.
  - Claude Code: managed-settings.json `PreToolUse`, timeout 120, `onFailure: block`.
  - Codex ≥ 0.124 (0.131 recommended): `/etc/codex/requirements.toml`
    (Windows `%ProgramData%\OpenAI\Codex\requirements.toml`) `[[hooks.PreToolUse]]` +
    `[features] hooks = true`; same deny JSON as Claude. Shell = `Bash`, edits =
    `apply_patch` (files parsed from the patch), MCP = `mcp__…`. Rewriting the TOML drops
    comments; the original is kept once as `requirements.toml.effigent-backup`. Limits:
    hosted `WebSearch` has no hook; a hook timeout or crash lets the call run (fail open).
  - Gemini CLI ≥ 0.27: system settings.json (`/etc/gemini-cli/`, macOS
    `/Library/Application Support/GeminiCli/`, Windows `%ProgramData%\gemini-cli\`)
    `hooks.BeforeTool`, timeout 120000 ms, `hooksConfig.enabled: true`; deny =
    `{"decision":"deny","reason":…}`. Tools: run_shell_command, read_file, read_many_files,
    write_file, replace, list_directory, glob, grep_search, web_fetch (URLs from the
    prompt), google_web_search (= `WebSearch`), `mcp_<server>_<tool>` (renamed from
    mcp_context). Limits: Gemini loads no hooks in folders the user hasn't trusted;
    users can disable a hook by name (`/hooks disable effigent`); timeouts fail open;
    `GEMINI_CLI_SYSTEM_SETTINGS_PATH` can point elsewhere. Gemini's admin policy TOML
    (`…/gemini-cli/policies`) is the harder backstop — not written by effigentd yet.
  - Cursor and the others: detection only (no hook).
  - Claude Cowork (Claude desktop app): runs Claude Code inside its own Linux VM (Apple
    Virtualization framework; `claude-code-vm/<ver>/claude`, `vm_bundles/claudevm.bundle`), even without
    `requireCoworkFullVmSandbox` — the Mac's managed settings and our hook don't exist there and the VM's
    127.0.0.1 isn't the daemon's (verified 2026-10-19: `cat /etc/shadow` ran on the VM's own file, only
    Cowork's `agent-proxy` refused example.com). Not enforceable. `internal/endpoint/vmwatch` (hooks mode,
    macOS, every 10s: `ps` for `com.apple.Virtualization.VirtualMachine`, `lsof` for Claude's VM images)
    reports each Cowork VM as agent `claude-cowork`, `mode: unmanaged` (`agent_start`/`agent_exit`); the
    console marks it "not under policy". Docker Desktop's VM is not matched. Remote Cowork sessions run in
    Anthropic's cloud and are invisible to the endpoint; Windows (Hyper-V) Cowork isn't detected yet.
- `effigentd run --agent NAME -- cmd` trusts NAME (it picks the policy rule; it is not checked against cmd). A launch inside an already-tracked agent tree stays under the outer agent (no relabel escape). The console marks a root whose command isn't NAME's program as "name set by effigentd run" (`launchedAs` in `lib/live-graph.ts`; e.g. the Grok-VM test 2026-10-18 ran `--agent codex -- sh -c …`).
- Detected (not launched via `effigentd run`) agents are unenforced for ~0.8–1.1s while policies load.
- On a Mac dev box effigentd can't scan the Docker VM's /proc, so agents started before the daemon aren't tracked.
- Hosts without systemd (Grok Bot's computer, plain containers; console tab "Grok Bot"): `install.sh` starts
  Tetragon and effigentd with `setsid nohup` (logs `/var/log/tetragon/tetragon.out`, `/var/log/effigent/effigentd.log`);
  nothing restarts them after a reboot, so rerun the installer (enrollment is kept). A Tetragon already running
  there (e.g. started by hand) is left as is and effigentd connects to its `--server-address` (warns without
  `--enable-ancestors`); the old effigentd is stopped only right before the new one starts. Verified 2026-10-18 in a
  no-systemd Ubuntu container: install, rerun, uninstall; an `effigentd run` child's curl and `/etc/shadow` blocked.
  Grok Bot runs every command as `bash -c` under its command server `/exec-daemon/node /exec-daemon/index.js
  serve …` (two instances; process tree 2026-10-18), so an agent rule `args_contains: ["/exec-daemon/index.js"]`
  covers it. Any policy change rescans /proc (after the startup scan), so a rule added for an agent that's
  already running applies without restarting effigentd, and removing it unblocks the same process.
  The installer double-forks the daemons so they leave the installing agent's tree at once. Tetragon's local log carries the installer's `--token` as an ancestor; the
  installer enrolls before Tetragon starts, so a one-time token is already spent.
- Kubernetes / Docker hosts: kernel layer only for agents in containers (their hooks can't reach the node's
  127.0.0.1:7777, so approvals and command/tool/MCP rules don't apply); one machine and policy per node;
  exec/file paths are the container's; an agent's policy loads ~1–2s after it starts in a pod (use
  `effigentd run` in the agent image, verified 2026-10-18 on kind). Autoscaled nodes need a valid token in
  the Secret. Docker Desktop: a bind path that doesn't exist on the Mac is created in the VM, while
  `/var/lib` itself maps to the Mac's `/private/var/lib`.

## 6. Conventions

- Prod DB: the control plane only touches schema `cp`; never ALTER v1 tables.
- Never commit secrets (`.env*`, `*.key`). Commit messages end with the Co-Authored-By trailer.
- Pushing `main` deploys the site (GitHub Action) and the console (Vercel).
