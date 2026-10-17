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

## 2. How policy reaches the kernel

1. Console/admin `PUT /api/v1/policy` with an endpoint policy YAML → validated with the
   endpoint's own parser → stored as the next version in `cp.policy_versions`.
2. `effigentd` (enrolled) polls `GET /ep/v1/policy?have=N` every `-sync-interval` (5s).
   The control plane signs the document (ed25519); the endpoint verifies signature and
   tenant against the key pinned at enrollment, refuses versions ≤ current, applies it
   live (`engine.SetPolicy`, make-before-break per agent), caches it in `policy.json`.
3. Offline restart → the cached signed policy is applied; a tampered cache is rejected and
   the built-in default applies. Local `PUT /policy` is refused while enrolled.
4. Events are POSTed in batches to `/ep/v1/events` and stored in `cp.events`.

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
  (`internal/controlplane/notify`): Slack incoming webhook per tenant (only
  `https://hooks.slack.com/services/…`, never returned by the API) and email over SMTP
  (`EFFIGENT_SMTP_URL=smtp://user:pass@host:587` or `smtps://…:465`), or — in production — the
  Amazon SES API with the instance role (`EFFIGENT_SES_REGION=us-east-1`; domain effigent.ai
  verified with Easy DKIM in Route 53), plus `EFFIGENT_EMAIL_FROM`.
  Messages carry Approve/Reject buttons: signed single-request links `/a/{token}`
  (`server/actionlinks.go`, HMAC keyed from the signing seed); GET shows a confirmation
  page, POST decides (so link scanners can't approve). Plus a link to
  `EFFIGENT_CONSOLE_ORIGIN/approvals?id=…`. Audit: `approval.request|approve|deny`,
  `notifications.update`.

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
make tetragon-up                                    # Tetragon in Docker Desktop's VM (BTF + BPF LSM)
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
  or the signed Approve/Reject buttons in Slack/email.
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
- Detected (not launched via `effigentd run`) agents are unenforced for ~0.8–1.1s while policies load.
- On a Mac dev box effigentd can't scan the Docker VM's /proc, so agents started before the daemon aren't tracked.

## 6. Conventions

- Prod DB: the control plane only touches schema `cp`; never ALTER v1 tables.
- Never commit secrets (`.env*`, `*.key`). Commit messages end with the Co-Authored-By trailer.
- Pushing `main` deploys the site (GitHub Action) and the console (Vercel).
