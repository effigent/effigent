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
| `cmd/effigentd`, `internal/endpoint/*` | Endpoint daemon (Go). `tetragon/` gRPC client + TracingPolicy rendering, `engine/` agent detection, attribution, per-agent kernel policy lifecycle, `policy/` the endpoint policy format (`default.yaml`), `cpclient/` enrollment + signed policy sync + heartbeat (incl. hook state), `sink/` stdout/JSONL/HTTP, `api/` local REST, `procscan/`, `vmwatch/` (agents in their own VM: Claude Cowork), `hooks/` agent hook payloads → canonical tools, `hookstate/` hook file locations + per-agent hook health (see 2e), `gateway/` local model gateway (2j). Subcommands: `enroll`, `run` (zero-gap launcher), `install-hooks`, `install-gateway`. | Linux host next to Tetragon (dev: Docker Desktop VM) |
| `cmd/effigent-cp`, `internal/controlplane/*` | Control plane (Go): `store/` Postgres (schema `cp`, embedded migrations tracked in `cp.schema_migrations`), `server/` endpoint protocol `/ep/v1/*` + console API `/api/v1/*`, `compile/` central policies per machine, `spend/` Pricing Leaks (see 2d). Image: `Dockerfile.cp`. | AWS App Runner `effigent-cp` (628713530358, us-east-1) at https://api.effigent.ai — redeploy with `AWS_PROFILE=effigent deploy/aws/deploy-cp.sh` |
| `internal/shared/*` | `action/` action model, fingerprint, state machine · `policy/` central policy types + evaluator · `sign/` ed25519 policy signing. | both |
| `packages/dashboard` | Console — Next.js 16 + Clerk. **Live** on `/api/v1` (`src/lib/api.ts`, Clerk Bearer token, `NEXT_PUBLIC_EFFIGENT_API_URL`): Overview, Enforcement (machines, enroll, revoke), Policies (YAML editor, versions), Audit (events + verifiable trail), Settings (workspace/role). No sample data by default: pages without a backend (Allow/Deny Lists) show "Coming soon" empty states; the Agent Graph is built client-side from real events (`src/lib/live-graph.ts`). **Demo Mode** (Settings / user menu; localStorage `effigent.demoMode`) swaps in a sample workspace from `src/lib/fixture-api.ts` on every page and never calls the real API. | Vercel, app.effigent.ai |
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
  Likewise effigentd builds older than the action lists (2f) refuse a policy using any of
  `actions_*`, `command_deny`, `file_write_*`, `protected_branches`, `package_*`, `mcp_allow`,
  `model_hosts_allow`, top-level `environments:` or `redact:` (parse error → stay on the current
  version): upgrade endpoints before publishing one.

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

- **Requester, second approver, tickets** (migration 012, `server/votes.go`): each route and
  the routing `default_rules` carry `approvals_required` (1 | 2), `exclude_requester` (missing =
  true) and `require_ticket`; copied onto the request when it is filed, with its `requester`
  (`requesterOf`: the machine owner, the people its OS user, hostname or git emails map to in
  People, and the git emails that OS user used on that machine in 30 days, lower-cased). Every vote (console, email link,
  Slack) goes through `castVote` → `cp.approval_votes`: decided requests answer
  `already_decided` first; the requester is refused (`self_approval_refused`, audited
  `approval.self_approval_refused`, admins included); API keys and the admin token aren't
  people (`not_a_person`) when 2 are needed; one vote per person
  (`SamePerson`: voter, user id or a shared email; `already_voted`); approving with
  `require_ticket` needs `ticket` (a Jira key `ABC-123` or an https link; `ticket_required`).
  Any deny denies; the request is `approved` only at quorum (an admin override is one vote,
  never a bypass), so the endpoint keeps waiting until then (`/ep/v1/approvals` returns
  `approvals`, `approvals_required`, `approved_by`). Console list: `votes`, `can_approve`,
  `approve_refusal(_message)`, `quorum_warning`; `GET|PUT /approval-routing` return `warnings`
  (group smaller than its quorum, or exactly 2 with the requester excluded); `/test` takes
  `hostname`/`endpoint_id`/`os_user` and returns `requester`, `eligible_approvers`,
  `excluded_members`, `warning`. Tickets link through the tenant's `ticket_url_template`
  (`PUT /notifications`, https with `{key}`). With `require_ticket`, email and Slack buttons
  send the approver to the console (a link can't carry a ticket). Webhook `approval.voted` for
  a vote short of the quorum; the Slack message is updated with "1 of 2" (`chat.update`).
  The requester check needs `CLERK_SECRET_KEY` to know a console user's emails
  (`UserEmails`, 2 min cache); without it only user ids and the Slack/email address match.

- **Policy change approval** (migration 013, `server/proposals.go`): per tenant
  `cp.policy_settings.policy_change_approval`. On, every change that publishes a version —
  `PUT /policy`, `POST|DELETE /exceptions`, `PATCH /endpoints/{id}` (owner/teams) — is
  validated as usual (policies dry-run compiled) and filed in `cp.policy_proposals` (202
  `{pending_approval, proposal, message}`; audit `policy.propose`, webhook `policy.proposed`,
  email to the notification emails). `GET /api/v1/policy/proposals` (with `stale`,
  `can_decide`/`why`, `base` for the diff), `POST /policy/proposals/{id}/decision`
  (`approve` | `reject`; people only: an admin/security_admin who isn't the author nor, for
  a key-made proposal, the key's creator; refusals audited `policy.self_approval_refused`),
  `DELETE /policy/proposals/{id}` (author withdraws). Approving claims the proposal first, then
  applies it exactly as the direct call (re-opened if applying fails on a 5xx, superseded on a
  4xx). A policy proposal written on an older version is superseded on approval (re-propose);
  exceptions and owner changes apply on the latest. `GET|PUT /policy/settings`: on applies at
  once, off is itself a proposal. No break-glass. Expiring exceptions are removed without a
  proposal (only tightens). Audit `policy.approve|reject|withdraw|supersede`,
  `policy.settings.update`.

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
  `dropped` counter), endpoint.enrolled, endpoint.revoked, policy.published,
  pricing_leaks.runaway_cost (opt-in, see 2d), endpoint.hooks_missing / endpoint.offline /
  endpoint.online (opt-in, see 2e), test.
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
  download via `POST /api/v1/events/archives/{day}/link` (10-min presigned URL of the stored
  `version_id`, audited).
- **Per-workspace retention and legal hold** (migration 015, `server/retention.go`,
  `store/retention.go`): `cp.event_retention` — `retention_days` (0 = the control plane's
  default, else 90…3650) and `legal_hold` + `hold_reason` (required to turn it on).
  `GET|PUT /api/v1/events/retention` (people, admins write; audit `events.retention.update`,
  `events.legal_hold.on|off|reason`). On hold: retention skips the tenant (`DueArchiveDays`),
  `CompleteArchiveDay` refuses under a per-tenant xact lock (`ErrLegalHold`; an object
  uploaded as the hold landed is put on hold at once), and the `cp.events_guard` trigger refuses
  any delete of a held tenant's rows. `syncHolds` (after each change, at start and every
  5 min; session advisory lock, generation counter, `hold_error` kept until it succeeds) puts
  or lifts an S3 Object Lock legal hold on every version under `events/<tenant>/`
  (`archive.S3.SetLegalHold`: ListObjectVersions + PutObjectLegalHold; audit
  `events.legal_hold.sync`). A held object version is never removed by lifecycle rules; a
  lifecycle expiration still adds a delete marker on top, which is why downloads are pinned
  to the version. Without an archive bucket the hold only needs the database (nothing is
  deleted then anyway). IAM: `deploy/aws/set-event-archive.sh` (rerunnable) adds
  `s3:PutObjectLegalHold`, `s3:GetObjectLegalHold`, `s3:GetObjectVersion`,
  `s3:ListBucketVersions`. Console: Settings → Event retention & legal hold
  (`components/EventRetention.tsx`; the older `components/Storage.tsx` is the v1 run storage).
- **Deploy order for 012/013/015**: control plane (`deploy-cp.sh`; migrations 012, 013, 015)
  → rerun `deploy/aws/set-event-archive.sh` in CloudShell (legal-hold permissions) → push `main`
  (console). effigentd needs no upgrade (it already waits while a request is `pending`).
- Audit trail: `GET /api/v1/audit?paged=1` → `{entries, total, next_before}`; filters
  `action` (comma-separated prefixes), `via` (actor kinds), `actor`, `q` (words, ILIKE over
  action/target/actor/details/ip), `since`/`until` (RFC 3339), cursor `before=<seq>`,
  `limit` ≤ 500. Without `paged` it still returns the newest `limit` entries as an array.
- `integrations/windmill/`: resource type, scripts, and the Slack/Teams approval flow
  (tested against Windmill CE v1.837 locally; Slack/Teams buttons not exercised).

## 2d. Pricing Leaks (AI tool spend)

Full write-up: `docs/pricing-leaks.md`.
- `internal/controlplane/spend` (pure, no DB): vendor clients behind `spend.Client`
  (Cursor, Anthropic Admin API incl. Claude Code usage report, GitHub Copilot seats/billing,
  OpenAI usage/costs; `Server.SpendBaseURLs` points them at fakes in tests), `ParseCSV`
  (seats/usage exports, columns by header name), `Directory` (identity), `Analyze` (the four
  leaks: `unused_seat`, `duplicate_tool`, `shadow_spend`, `runaway_cost`; thresholds at the
  top of `detect.go`), `DefaultPrices` (seat and personal-plan prices in cents, overridable
  per tenant). Money is always US cents.
- Migration 009: `cp.spend_connectors` (per tenant+vendor; admin key sealed with
  `EFFIGENT_SECRETS_KEY`, field `spend_<vendor>_key`, only the last 4 chars ever returned),
  `cp.spend_seats` / `cp.spend_usage` (source `api` | `csv`; API wins), `cp.spend_settings`
  (People directory + price overrides). No secrets key → keys refused (503), CSV still works.
- Sync: on saving a key, `POST /api/v1/pricing-leaks/sync`, and the vendor poller below
  (every `SpendSyncEvery`, 24h). Last 30 days, one tx.
- Identity (migration 010): effigentd events carry `os_user` (Tetragon uid → name on the host; the
  hook's OS user), `git_email` (repo/global git config of the cwd, read from files), `session_id`,
  `model`, `transcript_path` (hook payload) — `internal/endpoint/ident`, `hooks.Meta`. Ingest
  upserts `cp.agent_activity_daily` (machine, agent, OS user, git email, model) in the batch's
  transaction; Pricing Leaks reads it, never scans `cp.events`. People mapping `cp.people` +
  `cp.person_identities` (`os_user` [`user@host`], `git_email`, `host`, `github`, `email`,
  `api_key`; one owner per identity). Activity → person: mapped OS user, git email (mapped or a
  known work email), machine owner, mapped hostname, else `host:<name>` (unattributed); leaks
  carry `attribution`. `spend.Suggest` proposes mappings (never auto-applied). A host mapping
  doesn't change `cp.endpoints.owner` (central policies compile against the owner).
- Vendor poller: per connector `next_poll_at` / `failures`; `runSpendSyncs` ticks every minute,
  each poll under a per tenant+vendor session advisory lock (`Store.SpendPollLock`, the
  RetentionLock pattern) and re-checked as due under it; 15 min doubling backoff. Manual sync
  shares the lock (`already_running`).
- Console API (people only, `s.console`): `GET /api/v1/pricing-leaks`, `GET /pricing-leaks/connectors`,
  `PUT|DELETE /pricing-leaks/connectors/{vendor}`, `POST /pricing-leaks/sync`,
  `POST /pricing-leaks/import` (`{vendor, kind, csv}`, ≤ 20 MB), `DELETE /pricing-leaks/import/{vendor}`,
  `PUT /pricing-leaks/settings` (`{prices?, alerts?}`, an omitted part is kept),
  `GET /pricing-leaks/metrics`, `GET /pricing-leaks/alerts`; `GET /api/v1/people`, `PUT|DELETE /people/{email}`,
  `POST|DELETE /people/identities`. Audit `pricing_leaks.*`, `people.*`. Console: Monitor →
  Pricing Leaks (`/pricing-leaks`: leaks, Spend over time `components/SpendTrend.tsx`, Alerts
  `components/SpendAlerts.tsx`, `?leak=<id>` focuses a row), Workspace → People (`/identity`), Settings → AI vendors
  (`components/SpendVendors.tsx`); Demo Mode data in `lib/pricing-leaks-fixture.ts`, `lib/people-fixture.ts`.
- TODO / unverified: not yet exercised against the live vendor APIs (unit tests use fakes from
  the documented shapes; OpenAI's were written without its docs); hook `os_user` is self-asserted;
  Claude Code's PreToolUse may not send `model`; container uids aren't resolved; the console
  chart/alerts were checked with typecheck + build + Demo Mode data, not in a browser. Deploy
  order: control plane (migrations 009, 010, 011) → console → effigentd release.
- History + alerts (migration 011, `server/spend_rollup.go`, `store/spend_rollup.go`):
  `cp.spend_rollups.changed_at` is bumped by every spend write (sync, CSV import/clear, connector
  delete, settings); `runSpendRollups` ticks every minute and rolls up tenants whose data changed
  or that weren't rolled up for `SpendRollupEvery` (1h), under a per-tenant session advisory lock
  (`SpendRollupLock`). A rollup computes the page's own report (`spendReport`) and in one tx
  replaces today's `cp.spend_report_daily` (per vendor) and `cp.spend_leaks_daily` (per leak type
  + vendor) rows and updates the leak log `cp.spend_leaks` (first/last seen, resolved; a resolved
  leak that reappears is a new episode). Seat history starts at the first rollup (seats are
  replaced on every sync); `GET /pricing-leaks/metrics?days=7…365` (default 90) → `{usage}` (daily
  vendor cost from `cp.spend_usage`, from the first sync), `{activity}` (machines/events per billed
  vendor from `cp.agent_activity_daily`), `{report, leaks}` (rolled up). Alerts: runaway cost only
  (`spend.AlertTypes`), claimed exactly once across instances (`update … notified_at … returning`),
  repeated every 7 days while open (`spend.AlertRepeat`); webhook event `pricing_leaks.runaway_cost`
  (`{leak, review_url}`), email per recipient (`alerts.emails`, else the notification emails), Slack
  only with `EFFIGENT_SLACK=1`; audit `pricing_leaks.alert` (actor via `system`) with where it went.
  Alerts off (`alerts.runaway_cost: false`) → the leak is still claimed and recorded `alerts: off`,
  nothing is sent, and turning them back on doesn't replay it.

## 2e. Endpoint health (hooks, offline, stops)

Migration 014 (`cp.endpoints.hooks/hooks_reported_at/hooks_changed_at/offline_at/stopped_at/stop`,
`cp.endpoint_health_settings`), `server/endpoint_health.go`, `store/endpoint_health.go`.
- **Hook state**: effigentd (`internal/endpoint/hookstate`, read at most once a minute, files only)
  reports per agent (`claude`, `codex`, `gemini`, `cursor`) `installed` / `missing` / `modified`
  (switched off: Claude `onFailure` not `block`, matcher changed, `disableAllHooks` in the file or a
  `managed-settings.d/*.json` drop-in; Codex `[features] hooks = true` pin gone; Gemini name changed,
  `hooksConfig.enabled` not true, listed in `hooksConfig.disabled`; Cursor an event or `failClosed`
  missing; any: the hook's effigentd binary is gone; invalid JSON/TOML) / `unreadable`, plus
  `disabled_by` (Gemini users whose `~/.gemini/settings.json` disables `effigent`) and `present`
  (agent program found in PATH, common install dirs or each home; Cursor app bundles). It rides the
  heartbeat (`hooks`) only when it differs from what the control plane last acknowledged (every
  start sends it once); the heartbeat now goes out even when the policy fetch fails.
  The control plane stores it under a row lock and keeps `expected` = agents whose hook it has seen
  installed. A **problem** = not installed or user-disabled where it matters: the agent is present on
  a `hooks`-sensor machine, or the agent is in `expected` (a Linux/Tetragon machine that never had
  hooks is not an alarm). A new problem → webhook `endpoint.hooks_missing` (`{endpoint_id, hostname,
  os, agents[{agent, state, file, detail, disabled_by, agent_installed}], review_url}`), email to the notification
  emails (if `email_hooks`), audit `endpoint.hooks_missing` (actor via `system`); fixed →
  audit `endpoint.hooks_restored` only. effigentd builds before this release don't report hooks
  (the console says so).
- **Stops**: SIGTERM / SIGINT / Windows service stop or shutdown → event `daemon_stop` (high;
  `target` = signal, `rule` = `systemd` | `launchd` (job `ai.effigent.effigentd`) | `windows-service` |
  `terminal` | `background`, `os_user` only for a terminal run: `SUDO_USER` or the current user) before
  any teardown; the control-plane sink's last batch gets 3s (`HTTPConfig.CloseTimeout`), then it waits
  in the spool and is sent after the next start. Ingest records the newest stop in `stopped_at`/`stop`.
  Enrolled daemons keep `<state>/running` (pid, start, version); one left at start →
  `daemon_unclean_restart` (high: kill -9, crash, power loss).
- **Offline detector**: `runEndpointHealth` ticks every minute (`HealthTick`) under a session
  advisory lock (`EndpointHealthLock`); `MarkEndpointsOffline` sets `offline_at` once per outage
  (`update … where offline_at is null … for update skip locked`) for unrevoked machines silent
  longer than the tenant's threshold (default `EFFIGENT_ENDPOINT_OFFLINE_AFTER`, 5m; tenant 2 min …
  7 days); the first tick after a newer heartbeat/ingest clears it (`MarkEndpointsOnline`). Detection time = threshold +
  up to one tick. Offline → webhook `endpoint.offline` (`reason: stopped` when a `daemon_stop` came
  within 30s of the last heartbeat, else `silent`; `stop`, `last_seen`, `review_url`), email (if
  `email_offline`), audit `endpoint.offline`; back → webhook `endpoint.online` + audit only (laptops
  sleep: no email for coming back).
- Console API: `GET|PUT /api/v1/endpoint-health` (`offline_after_minutes`, `email_offline`,
  `email_hooks`; people only; audited `endpoint_health.update` before/after). `GET /api/v1/endpoints`
  carries the new columns. Console: Machines (`views/Enforcement.tsx`) shows each machine's hooks,
  a warning per problem, offline (detector) and "stopped · SIGTERM" vs "went silent", and the
  Machine health alerts card; Demo Mode data in `lib/fixture-api.ts` (`demoHealth`).
- Deploy order: control plane (migration 014) → console → effigentd release (endpoints reinstall).

## 2f. Actions (what a tool call does)

Agent hooks only (Claude Code, Codex, Gemini CLI, Cursor; the kernel sees none of it). `hooks.classify`
(`internal/endpoint/hooks/actions.go`, `bashact.go`, `git.go`, `sql.go`, `cloud.go`,
`packages.go`, `env.go`) reads a canonical call (Bash command, Write/Edit/Read path, WebFetch
URL, `mcp__server__tool`) and returns `event.Action{kind, target, attrs, envs, in}`. Kinds:
`policy.ActionKinds` (git: protected_push / force_push / branch_delete / history_rewrite /
hook_bypass; destructive_sql / sql_write; cloud_change / cloud_destroy / access; package_install
/ _unlisted / _registry / _scripts / _malicious / _vulnerable; guardrail_edit; credential_read;
remote_script; fs_destroy; mcp_unlisted; model_endpoint / model_api_key). Every hook event
carries them (`actions`), matched or not; `engine.scrub` redacts their targets.
- Read from the command line, the scripts it runs (`bash x.sh`, `./x.sh`, `source`, package.json
  scripts incl. pre/post, `yarn <script>`; depth 2; `in` names the script), heredocs / here-strings
  / `< file` / piped `echo`/`cat` feeding a DB client, `.sql` files, `docker exec` inner commands.
  Script commands also go through exec/file/command deny and approve lists.
- Targets: AWS profile (`--profile`, `AWS_PROFILE`, `~/.aws/config` → account via `sso_account_id`
  / `role_arn`, `source_profile` followed), kube context (`--context` / kubeconfig
  `current-context`), gcloud project (flag, env, active configuration), Azure default
  subscription (`azureProfile.json`), Terraform workspace (`.terraform/environment`,
  `TF_WORKSPACE`), Pulumi stack, DB host (flags, URLs, `PGHOST`…, client default localhost),
  pushed branch (refspec, else `.git/HEAD`). Policy top-level `environments: {prod: {aws_profiles,
  aws_accounts, kube_contexts, gcloud_projects, azure_subscriptions, terraform_workspaces,
  pulumi_stacks, hosts, mcp_servers, match_unknown}}`; an entry `kind@prod` matches only actions
  whose target is in it. `access` covers every action on a target and must name an environment.
- Lists (per rule, merged like the others, compile `overrides`/`sameRule` carry them):
  `actions_deny` / `actions_approve` (kind or kind@env; `sql_write` ⊇ `destructive_sql`,
  `cloud_change` ⊇ `cloud_destroy`), `command_deny` (like `command_approve`; `*` anywhere in
  both), `file_write_deny` / `file_write_approve` (writes only: Write/Edit, redirects, tee/cp/mv/
  sed -i/curl -o… targets), `protected_branches` (default main, master, trunk, prod, production,
  release*), `package_deny` / `package_approve` / `package_allow` (`npm:name[@ver]`, `pypi:`,
  `cargo:`, `go:`, `gem:`, `brew:`; `*` wildcards; PyPI names normalised), `package_registries`
  (URL prefixes; extra PyPI indexes are always package_registry), `mcp_allow`,
  `model_hosts_allow`. Precedence in `EvaluateClaude`: tool_deny, exec/file/domain/network
  denies, command_deny, file_write_deny, package_deny, actions_deny; then tool/command/exec/…
  approve, file_write_approve, package_approve, actions_approve. Monitor/learn → would_block.
- File lists: an entry ending in `/` is a directory tree, matched by hooks; `Rule.Kernel()` drops
  such entries (Tetragon matches suffixes). `default.yaml` alerts on more credential files.
- OSV (`internal/endpoint/osv`): only when a list names package_malicious / package_vulnerable.
  One `querybatch` per call (4s budget, 1h cache, ≤1000), MAL- ids for unversioned packages only
  when the advisory covers every version (`/v1/vulns/{id}`), lockfile versions for `npm ci`;
  vulnerabilities only for pinned versions. Fails open: the error is `osv_error` on the installs.
- Agent environment: `effigentd hook` sends `X-Effigent-Agent-Env` (base64 JSON;
  `hooks.AgentEnv`): cloud profile/project/subscription names, DB hosts, model base URLs,
  registries, git-hook switches; API keys only as `set`; URLs without credentials. The daemon
  keeps only those names (`CleanAgentEnv`), records them on the session's `agent_start`
  (`agent_env`), and uses them for targets, model_endpoint and model_api_key.
- Files are read as the agent's OS user (`perm_unix.go`: owner/group/other bits, groups via
  os/user; unknown user or a claimed root = world-readable only; Windows: not checked),
  ≤512 KB. The OS user and the environment are the hook process's claims.
- Approvals: rules `actions_approve`, `package_approve`, `file_write_approve` route as command /
  file (`server/routing.go`); exceptions (`compile.ExceptionLists`) don't cover the new lists
  yet (refused with the list of allowed ones). Central `require_approval` rules don't compile to
  them; they live in the base policy.
- Redaction (`internal/endpoint/redact`): gitleaks, then `NAME_TOKEN=…`-style assignments,
  `--password`-style flags, `mysql -p…`, `user:pass@` in URLs, bearer tokens, private key
  blocks; then policy `redact: {pii: bool, patterns: [{name, pattern}]}` (RE2, ≤50, ≤300 chars;
  pii = email, phone, card, IBAN), applied by the engine on every policy change. Approval
  summaries and reasons are redacted before they're sent.
- Tests: `hooks/actions_test.go` (classification + decisions, fake OSV), `osv/osv_test.go`,
  `compile/actions_test.go` (round trip), `redact_test.go`; `test/hooks/approval.sh` (42 checks)
  runs force_push / curl|sh / workflow writes / DROP TABLE approval / prod AWS_PROFILE via the
  hook env through a real hook process, daemon and local control plane. OSV's response shape was
  checked against the live API (2026-10-21); the live lookup isn't in an automated test.

## 2j. Model gateway

- `internal/endpoint/gateway`: a plain-HTTP listener on loopback, `-gateway` (default
  `127.0.0.1:7779`, `""` = off; not the 7777 API), started after the first policy sync. It is not TLS
  interception: an agent uses it because its base URL says so. URL = `http://127.0.0.1:7779/<provider>/<agent>/<provider path>`,
  providers fixed in `gateway.Providers` (`anthropic` → api.anthropic.com, `openai` → api.openai.com,
  `codex` → chatgpt.com/backend-api/codex for a ChatGPT sign-in and api.openai.com/v1 for an `sk-` key,
  `gemini` → generativelanguage.googleapis.com). The request picks only the path below that base, and `..` is cleaned.
  Refused: `Origin` header or non-loopback `Host` (browsers, DNS rebinding), bodies > 64 MB,
  `Upgrade: websocket` → 426 (Codex then falls back to HTTP streaming at once).
- Per model call (Anthropic `/v1/messages`, OpenAI `…/chat/completions` + `…/responses`, Gemini
  `…/models/{m}:generateContent|streamGenerateContent`; everything else passes through without an event):
  1. Read the model and the output limit from the body (zstd/gzip bodies are decoded for this; Codex
     zstd-compresses to the ChatGPT backend by default).
  2. Check them against the policy's `models:`.
  3. Forward the request, then stream the response back unbuffered (read → write → flush).
  4. Parse usage from a tee of the response and emit a `model_call` event (`kind: model`, `model`,
     `session_id`, `os_user`/`git_email`, `target` host+path without query) with `model_call:
     {provider, requested_model, status, stream, latency_ms, first_byte_ms, request_id, rewritten,
     input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, stop_reason, error}`.
  - Token rules: `input_tokens` excludes cache reads and writes, `output_tokens` includes reasoning.
  - Bodies, prompts, query strings and credentials are never read into events or logs. `Authorization`,
    `x-api-key`, `anthropic-beta` (it carries the claude.ai OAuth capability) etc. pass through as sent.
  - The events feed `cp.agent_activity_daily` (model, OS user, git email) with no control plane change.
- Policy (`policy/models.go`, top-level so compile keeps it):
  `models: {allow: [..], deny: [..], max_tokens: N, require_gateway: bool, agents: {<agent>: {allow, deny, max_tokens}}}`.
  - Patterns: case-insensitive `*` wildcards; no match-all; a deny wins. An agent's list replaces the default list.
  - Denylist/allowlist mode: a refused model gets **400** in the provider's error shape
    (`invalid_request_error`; Gemini `INVALID_ARGUMENT`), `X-Should-Retry: false`, and a `blocked` event.
    Not 403: Claude Code shows a 403 as "Failed to authenticate"; verified with real Claude Code 2.1.306,
    which shows "API Error: 400 Blocked by Effigent: model … is not allowed …".
  - Monitor/learn: `would_block`, then forwarded.
  - `max_tokens` lowers a larger request limit in enforcing modes only (Anthropic `thinking.budget_tokens`
    below it). A request that names no limit passes.
  - Body rewrites, the only ones: that cap, and `stream_options.include_usage` on streamed chat
    completions (without it there is no usage). Everything else is forwarded byte for byte.
- `require_gateway`: hooks treat a Claude Code / Codex / Gemini session as `model_endpoint`
  (`Rule.GatewayDeny()` adds it to `actions_deny` unless it's already in the deny or approve lists) unless
  - the gateway has seen that session in the last 30 min (Claude `x-claude-code-session-id`; Codex
    `thread-id`, which is the hooks' `session_id` by source reading of rust-v0.163.0, not seen live;
    a tool call always follows a model call), or
  - the hook env points at the gateway (`ANTHROPIC_BASE_URL`, `GOOGLE_GEMINI_BASE_URL`; Bedrock/Vertex never count).
- `effigentd install-gateway [--agents claude,codex] [--addr] [--remove]`:
  - Claude Code: `env.ANTHROPIC_BASE_URL = …/anthropic/claude-code` in managed-settings.json. A managed
    `env` beats the shell and every other settings file (code.claude.com/docs/en/settings-reference#env).
  - Codex: `openai_base_url = …/codex/codex` in `/etc/codex/managed_config.toml`, managed defaults
    applied over config.toml and `--config` at every start
    (learn.chatgpt.com/docs/enterprise/managed-configuration). On Windows that file is per user: `--codex-file`.
    These are defaults, not requirements: a user can change them mid-run. The enforced form would be
    `model_provider` + `[model_providers.<id>]` (`requires_openai_auth = true`) in `requirements.toml`
    (learn.chatgpt.com/docs/enterprise/sign-in-with-chatgpt-through-a-gateway), not done yet.
    The base URL doesn't end in `/backend-api/codex`, so Codex's `supports_codex_backend_routes()` is false.
    That turns off ChatGPT workspace routing (it could move the base URL off the gateway), per-model
    response headers and experimental context management, by source reading.
  - Never replaces or removes someone else's base URL. Codex's original file is kept once as `.effigent-backup`.
  - hookstate reports `gateway: {state: on|off|elsewhere|other_port, url, file}` for claude and codex.
  - Not run by the installers: it changes where model traffic goes, so an admin opts in.
  - Gemini (`GOOGLE_GEMINI_BASE_URL` is env-only, Gemini-API-key auth only; Google login uses Code Assist)
    and Cursor (calls leave from Cursor's servers) are refused.
- Sessions: hook calls record agent + session → OS user / git email (`cmd/effigentd/gateway.go`). Gateway
  events take them from there; without them, on Linux, the loopback peer's uid (`/proc/net/tcp`).
- Fail-closed by construction: with effigentd stopped, a pointed agent can't reach its model, the same
  posture as the hooks' `onFailure: block`. There is no fail-open switch, because the agent, not effigentd,
  makes the connection. The way back is `install-gateway --remove` (Claude Code reloads managed `env`
  live, per its docs; Codex at its next start), which the uninstallers (`install.sh`, `install.ps1`)
  run. `require_gateway`
  decides whether going around the gateway is a violation.
- Tests: `gateway/gateway_test.go` (fake upstream; unbuffered SSE, refusals, caps, Codex both sign-ins,
  zstd, 426, paths, upstream down), `usage_test.go` + `testdata/` (the providers' documented examples,
  sources in `testdata/README`), `policy/models_test.go`, `hooks/gateway_test.go`,
  `cmd/effigentd/installgateway_test.go`.
  - Live, 2026-10-21: real Claude Code (claude.ai OAuth) through a dev gateway, one haiku call: streamed,
    usage + session recorded; a denied model was refused locally.
  - Not live: Codex, Gemini, the OpenAI/Gemini upstreams.

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
go test ./internal/controlplane/server/ -args -effigent.db=postgres://effigent:effigent@localhost:5433/effigent  # all DB tests (or EFFIGENT_TEST_DATABASE_URL)
# console against a local control plane (dev only): add to the dev command
#   NEXT_PUBLIC_EFFIGENT_API_URL=http://127.0.0.1:8080 NEXT_PUBLIC_EFFIGENT_DEV_ADMIN_TOKEN=devadmin NEXT_PUBLIC_EFFIGENT_DEV_TENANT=org:dev
#   (control plane: EFFIGENT_ADMIN_TENANTS=org:dev EFFIGENT_CONSOLE_ORIGIN=http://localhost:3000)
npm run -w @effigent/dashboard dev                  # console (with the dev bypass vars)
npm run -w @effigent/site build                     # site
```

## 5. Known limits (keep honest here and in the console; since Oct 2026 the marketing site and its docs state capabilities without these caveats, by the founder's copy rules, so check new site claims against this list)

- Kernel blocking is per resolved binary path and file path suffix; argument-level rules alert only.
- Model gateway (2j) limits:
  - Only agents pointed at it are covered (Claude Code and Codex via `install-gateway`).
  - Ways around it:
    - Claude Code with Bedrock/Vertex skips it (SigV4 signing is host-bound, so there's no Bedrock
      route; Vertex isn't routed yet).
    - The Claude desktop app's launch env overrides a managed `env`.
    - Codex's managed defaults can be changed during a run.
    - Codex `model_provider` other than `openai` bypasses `openai_base_url`.
    - Gemini and Cursor can't be pointed at it machine-wide.
  - `require_gateway` is the backstop: a session the gateway hasn't seen is `model_endpoint`.
  - The `<agent>` path segment is the agent's own label (self-asserted, like `effigentd run --agent`).
  - The OS user comes from the hooks' session, else the Linux loopback peer; macOS/Windows get none without hooks.
  - Not live-tested: Codex (both sign-ins, the ChatGPT-backend route, the zstd bodies, the 426 fallback)
    and Gemini. Only Claude Code with a claude.ai login was run through it.
  - No `model_call` token sums in the console or Pricing Leaks yet: the events carry them, Pricing Leaks
    uses only the model. Migration 021 is reserved for a rollup.
  - Fail-closed: a stopped daemon cuts pointed agents off from their model.
  - Rollout: effigentd builds without `models:` refuse a policy that has it (parse error → they stay on
    their current version). Upgrade endpoints, then run `install-gateway`, then publish `models:` /
    `require_gateway`. Publishing `require_gateway` before the gateway is installed denies every tool call
    of the covered agents.
- Network: connects to IPs/CIDRs in `network_deny` / outside `network_allow` are blocked (verified by hand, e7c5125; no automated e2e check yet).
- `domain_deny` (hostnames) is enforced by address: `internal/endpoint/domains` resolves each name every `-dns-refresh` (30s) via the system resolver + `-dns-servers` (1.1.1.1, 8.8.8.8, 9.9.9.9), keeps every address seen in the last 15 min (max 64 per name; a failed lookup never shrinks the set; loopback/link-local answers are dropped), and the engine adds them to `network_deny` at apply time, re-applying only agents whose names changed. While it is in force, a DNS bypass guard blocks agents from DoT (:853 anywhere) and from well-known public resolvers on :53/:443/:853, except the nameservers in effigentd's and the agent's own `resolv.conf` and single addresses listed in `network_allow`. effigentd itself queries the public resolvers every 30s; `-dns-servers ""` limits it to the system resolver. Limits: shared CDN IPs over-block or miss; names are exact (no wildcards, `www.` separate); private DoH, hard-coded IPs, `/etc/hosts` pins and proxies evade it; effigentd resolves from its own vantage point (split-horizon DNS can differ). `network_allow` is the stronger control. e2e section 6.
- macOS / Windows: no kernel enforcement (macOS needs an Endpoint Security entitlement).
  `-sensor hooks`: the agents' pre-tool hooks (`effigentd hook claude|codex|gemini|cursor`)
  ask the daemon before every tool call; `internal/endpoint/hooks.EvaluateClaude` denies
  in denylist/allowlist mode and reports `would_block` in monitor/learn. It checks Bash
  commands (a small shell reader: pipes, `&&`, `$( )`, `sh -c`, sudo/env/xargs wrappers)
  against `exec_deny`/`exec_allow` **by program name** (`/opt/homebrew/bin/curl` matches
  `/usr/bin/curl`), named/redirected files plus directories and globs that would reach
  them against `file_deny`/`file_alert`, and hosts/IPs named in commands or WebFetch
  against `domain_deny` (name + subdomains), `network_deny`, `network_allow` (IPs only).
  Limits: it reads the command, not what runs — interpreters (`python -c`), variables set
  elsewhere, aliases, functions and tools that connect on their own aren't followed; shell
  scripts and package.json scripts are read to depth 2 (2f). Actions are read the same way:
  `psql` fed by a program, SQL built at run time, ORMs, cloud SDK calls from code, `make`
  targets and git aliases are invisible; a protected push inferred from `.git/HEAD` can be
  wrong if the push changes branch mid-line. Agent and MCP
  tools are matched by name: `tool_deny` refuses them (checked first), `tool_approve`
  pauses them. If the daemon is down
  the hook denies. Approvers: the routed group's members or any console admin /
  security_admin (central `approval.users/teams` are not enforced yet), from the console
  in Slack via the workspace's Slack app (identity checked, see 2b), or from the signed
  email buttons; a rule can need two different people, keep the requester out and need a
  ticket. Limits: the requester comes from the machine owner, the hook's OS user (mapped in
  People) and git emails — the last two are what the machine reports, not verified; API keys
  and the admin token can't count toward two-person approval and aren't checked as the
  requester when one approver suffices; the agent's message says only "pending" until the
  quorum (the "1 of 2" wording would be in effigentd).
- Policy change approval: there is no break-glass (an emergency change needs a second admin);
  expiring exceptions are removed without a proposal; a proposal made with an API key can't
  be approved by the key's creator, but any other admin can. Legal hold: anyone with
  `s3:PutObjectLegalHold` on the bucket (AWS side) can lift an S3 hold; the hold covers the
  database and the archive, not copies people downloaded or webhook receivers. Re-archiving a
  day (rare: events backdated across a day) writes a new version of that day's object; the
  download links the newest, older versions stay in the bucket.
- Clerk SSO / SCIM (not built): enterprise SSO (SAML/OIDC) and Directory Sync (SCIM, GA
  2026-04-16; deprovisioning deactivates the user and revokes sessions) are Clerk features
  per organization; tying a connection to an org and group→role mapping need Clerk's Enhanced
  B2B add-on. Nothing in Effigent depends on them; roles still come from org membership.
  Every call is one event (`exec`, or `blocked`/`would_block`/`file_open`, kind `tool`).
- Agents with hooks (`effigentd install-hooks`, run by the macOS pkg and install.ps1;
  `--agents claude,codex,gemini,cursor` (default), `--remove`, `--exclusive`): each agent's calls are
  translated to Claude Code's canonical tools (`internal/endpoint/hooks/agents.go`), so
  one policy (deny + approval lists, `mcp__<server>__<tool>` names) covers all four.
  Hook health (removed, switched off, user-disabled) is reported to the control plane, which
  alerts (2e). A local admin/root can still edit or delete any of these files, or stop
  effigentd: that is **detected, not prevented** (hook state ≤ ~1 min + one heartbeat;
  offline = threshold + ≤ 1 min; a signal's sender isn't known, only how effigentd was run).
  A sleeping or disconnected laptop looks the same as a killed daemon unless effigentd sent
  `daemon_stop`; kill -9 sends nothing (reported as `daemon_unclean_restart` at the next start).
  - Claude Code: managed-settings.json `PreToolUse`, timeout 120, `onFailure: block`.
    `managedSourcesBehavior: "first-wins"` with a remote/MDM managed source makes Claude Code skip
    the file-based managed settings — and our hook — silently; hookstate can't see that (it reads
    only the file and `managed-settings.d/`).
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
    hookstate sees `/hooks disable` in users' `~/.gemini/settings.json` (`disabled_by`), not in a
    project's `.gemini/settings.json`, and can't parse a user file with comments.
  - Cursor (IDE and CLI, agent name `cursor-agent`; docs https://cursor.com/docs/hooks): enterprise
    `hooks.json` (macOS `/Library/Application Support/Cursor/hooks.json`, Linux `/etc/cursor/hooks.json`,
    Windows `%ProgramData%\Cursor\hooks.json`), `version: 1`, events `beforeShellExecution` (→ `Bash`),
    `beforeMCPExecution` (→ `mcp__<server>__<tool>`, arguments arrive as a JSON string),
    `beforeReadFile` (→ `Read`, plus attachments) and `preToolUse` (Write/Delete → `Write`, Grep, List →
    `LS`, WebFetch/Fetch → `WebFetch`, WebSearch, others by name; Shell / Read / `MCP:*` there are
    answered allow without an event, the dedicated events check them), each `timeout: 120`,
    `failClosed: true` (Cursor's default is fail open). Answer `{"permission":"allow"|"deny",
    "user_message","agent_message"}` (Cursor needs a permission in every answer). `effigentd hook cursor`
    strips the file contents Cursor sends (stdin ≤ 64 MB) and a Windows BOM. Limits: Cursor runs every
    source's hooks (team/dashboard, project `.cursor/hooks.json`, user `~/.cursor/hooks.json`) next to
    ours, deny wins; whether our `allow` skips Cursor's own approval prompt is unverified; `preToolUse`
    doesn't name an MCP tool's server (so it's left to `beforeMCPExecution`), `beforeMCPExecution` in the
    CLI is unverified; Tab completions (`beforeTabFileRead`) and edits after the fact (`afterFileEdit`)
    aren't hooked; no documented user switch turns enterprise hooks off (unverified); not yet run
    against a live Cursor build (payloads from the docs).
  - Aider, OpenCode, Goose and the others: detection only (no hook).
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
