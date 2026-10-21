# What we added (October 2026)

A summary of everything built for the CISO vendor checklist: what each feature does, how it
works, how it was tested, and what a release needs. Point-by-point answers to the checklist are in
`docs/vendor-checklist-answers.md`. The engineering detail is in `CLAUDE.md` (section numbers in brackets).

The work shipped in two rounds:

- **Round 1 is live.**
  - Control plane `f9a7774` is deployed (migrations 012–015).
  - `main` is pushed (console).
  - `effigentd-v0.7.0` is tagged.
- **Round 2 is on branch `feature/vendor-checklist`.** It is not pushed and not deployed: 54
  commits ahead of `origin/main`.
- **One part is still being built:** break-glass, Linux self-protection and gated binaries.

---

## Round 1 (live)

### Actions: what a tool call does [2f]
- **What:** rules about what a call does, not just which program runs:
  - a push to a protected branch, a force push, history rewrites
  - `DROP TABLE` / SQL writes
  - `terraform destroy` and cloud changes
  - package installs
  - credential reads
  - edits to guardrail files (CI workflows, hook configs)
  - `curl | sh`
  - `rm -rf`
- **How:**
  - The hook reads the command line, plus the scripts it runs (two levels deep), heredocs and
    `.sql` files.
  - It works out the target: AWS profile → account, kube context, gcloud project, Azure
    subscription, Terraform workspace, Pulumi stack, DB host, pushed branch.
- **Environments:** the policy's `environments: {prod: {...}}` lets a rule say
  `destructive_sql@prod`, so it fires only on prod targets.
- **Lists:**
  - `actions_deny` / `actions_approve`
  - `command_deny`
  - `file_write_deny` / `file_write_approve`
  - `protected_branches`
  - `package_deny` / `package_approve` / `package_allow` / `package_registries`
  - `mcp_allow`, `model_hosts_allow`
- **Packages:** checked against the OSV feed for malicious and vulnerable versions. One batch query
  per call with a 1-hour cache; if OSV is unreachable the install is allowed and the error is recorded.
- **Redaction on the machine before anything leaves it:** gitleaks, command-line secrets, and optional
  PII / custom patterns from the policy's `redact:` section.
- **Tests:**
  - `hooks/actions_test.go`: about 70 classification cases and 22 decision cases.
  - `test/hooks/approval.sh`: a real hook process, daemon and local control plane.

### Cursor hooks [5]
- **What:** Cursor (IDE and CLI) is enforced like Claude Code, Codex and Gemini CLI.
- **How:**
  - `effigentd install-hooks` writes Cursor's enterprise `hooks.json`: shell, MCP, file-read
    and `preToolUse` events, `failClosed: true`.
  - The calls are mapped to the same canonical tools, so one policy covers all four agents.
- **Status:** built from Cursor's docs; not yet run against a live Cursor.

### Endpoint health: tampering is detected [2e]
- **What:** an alert when a hook is removed or switched off, when a user disables it, or when
  effigentd stops or goes silent.
- **How:**
  - effigentd reports each agent's hook state on its heartbeat: installed, missing, modified,
    unreadable.
  - A stop sends a `daemon_stop` event; a kill -9 shows up as `daemon_unclean_restart` at the next start.
  - The control plane runs an offline detector every minute.
  - Alerts go out as webhooks (`endpoint.hooks_missing`, `endpoint.offline` / `endpoint.online`)
    and email.
- **Limit:** detected, not prevented. Prevention on Linux is part of the work still in progress.

### Approvals: two people, no self-approval, tickets [2b]
- **What:** per approval route:
  - `approvals_required: 2`
  - `exclude_requester` (the person whose machine asked can't approve)
  - `require_ticket` (a Jira key or a link)
- **How:**
  - Every vote (console, email link, Slack) goes through one function.
  - The request is approved only once the quorum is reached; an admin override counts as one vote.
  - The requester is resolved from the machine owner, People mappings and git emails.

### Policy change approval [2b]
- **What:** an opt-in setting that makes every policy publish, exception or owner change a
  proposal that another admin must approve.
- **How:** the change is validated and dry-run compiled, then filed in `cp.policy_proposals`. When
  it's approved it is applied exactly like the direct call. A proposal written against an older
  version is superseded.

### Retention and legal hold [2c]
- **What:** retention per workspace (90–3650 days), and a legal hold that stops all deletion.
- **How:**
  - The database refuses deletes for a held tenant (trigger).
  - Retention skips held tenants.
  - Every archived object under the tenant gets an S3 Object Lock legal hold.
- **Still to do:** run `deploy/aws/set-event-archive.sh` in CloudShell; it adds the S3
  legal-hold permissions.

---

## Round 2 (on the branch, not deployed)

### Hook signals [2f]
- **SQL in MCP database tools:** `execute_sql`, Supabase / Neon / Postgres servers and others are
  classified like `psql`. That makes `destructive_sql@prod` work through MCP too.
- **Session rules:** rules on the order of calls in one session, not prompt-injection detection.
  - `exfil_sequence`: a credential read, then a network call to a new host.
  - `untrusted_then_risky`: outside content (WebFetch, an unlisted MCP server), then a risky action.
- **MCP server pinning:** `mcp_pins: {server: sha256}`.
  - The fingerprint covers the server's command, args, URL and the names of its env vars.
  - A changed config is `mcp_changed`.
  - Each session start lists the fingerprints, so they can be copied into pins.
- **Outcomes:** post-tool hooks send each call's result (ok / error / timeout, exit code,
  duration). The tool's output is dropped before anything is sent.
- **Tests:** `approval.sh` grew from 42 to 53 checks, covering exfil_sequence, a changed pinned
  `.mcp.json` and a failure outcome.

### Inventory, posture report, new behaviour [2h]
- **Inventory:**
  - Every agent on every machine, with its coverage (enforced / hooks off / detection only /
    unmanaged).
  - Every MCP server: tools, machines, people, allowlist.
  - People who pay for AI tools but have no managed machine, from Pricing Leaks.
- **New behaviour:** a baseline per machine and agent of the binaries, hosts, MCP servers and
  action kinds it uses.
  - Anything new is a signal and a webhook (`anomaly.first_seen`).
  - The first 7 days are warm-up; signals are capped per day.
  - It's novelty detection: it says what's new, not why.
- **Posture report:** `/report?days=7|30|90` covers machines, agents per person and team,
  enforcement, approvals, exceptions, proposals, first-seen counts and Pricing Leaks. Weekly or
  monthly email.
- **How:** everything is rolled up at ingest, never by scanning `cp.events`.
  - Migrations 016 and 017.
  - 016 backfills 35 days once, so it's slow the first time.
- **Fix found while merging:** the inventory rollups counted `tool_result` events. Now excluded
  in the ingest path and in the backfill.

### Model gateway [2j]
- **What:**
  - choose which models each agent may use (`models: allow / deny / max_tokens`)
  - record the tokens of every model call
  - `require_gateway` treats going around the gateway as a violation
- **How:**
  - A plain-HTTP listener on `127.0.0.1:7779`. `effigentd install-gateway` points Claude Code
    (managed `ANTHROPIC_BASE_URL`) and Codex (`openai_base_url`) at it. No TLS interception.
  - Responses are streamed back unbuffered.
  - A refused model gets a 400, which Claude Code shows as "Blocked by Effigent".
  - Prompts and bodies never reach events.
- **Fail-closed:** with effigentd stopped, a pointed agent can't reach its model.
  `install-gateway --remove` undoes it, and the uninstallers run it.
- **Verified:** real Claude Code through the gateway, one call: streamed, usage recorded, a denied
  model refused. Codex and Gemini were not run live.
- **Limits:**
  - Bedrock / Vertex aren't routed.
  - Gemini and Cursor can't be pointed at it machine-wide.
  - Codex's managed defaults can be changed by the user.

### Cloud agents and containers [2i]
- **Cloud environments:**
  - Created in the console (Machines → Add cloud environment), which returns an `efc_` token once.
  - The vendor's setup step runs `curl -fsSL https://effigent.ai/cloud-setup.sh | sh`.
  - The repo's hooks call `.effigent/cloud-hook.sh`, which runs `effigentd hook <agent> --remote`.
  - Remote mode decides inside the hook process: the signed policy (cached 60s), approvals and
    events, with no daemon. No policy means deny.
- **Vendors:**
  - Claude Code on the web: `.claude/settings.json`
  - GitHub Copilot coding agent: `.github/hooks/*.json` + `copilot-setup-steps.yml`
  - Cursor background agents: `.cursor/hooks.json`
  - Codex cloud and Devin are not covered.
- **Containers:**
  - effigentd serves the hook API on `/var/run/effigent/hook.sock`. The Helm `hookSocket.enabled`
    value is on by default.
  - The caller is identified by the kernel (peer credentials, cgroup → container / pod), not by
    the request.
  - Files are read inside the container's file system.
  - Result: approvals and command / tool / MCP rules now apply to agents in pods.
- **Verified:**
  - `test/hooks/remote.sh` 32/32
  - `test/hooks/cloudsetup.sh` 10/10
  - `test/containers/hooksock.sh` on kind, without Tetragon
  - Not yet run inside any vendor's live environment.
- **Limit:** the token is readable by the agent. It can fetch that environment's policy and post
  events, but can't decide approvals.

### Self-hosted control plane [2k, `docs/self-hosting.md`]
- **What:** the control plane and console on the customer's own infrastructure:
  - Helm chart `deploy/helm/effigent-cp`, or Docker compose with Caddy (`deploy/selfhost`)
  - sign-in with their OIDC provider (Okta, Entra ID, Keycloak …) instead of Clerk
  - a private CA for effigentd (`enroll --ca-file`)
  - an S3-compatible archive
- **How:**
  - OIDC tokens are checked against the issuer's keys (RS/PS/ES only).
  - Roles come from groups or listed admin emails, and only verified emails are used.
  - The console uses code + PKCE with a sealed HTTP-only session cookie.
  - The chart generates its keys once and keeps them across upgrades.
- **Verified:** kind with Dex standing in for the IdP (19 checks): sign-in, roles, publishing a
  policy, effigentd enrolling with a private CA and syncing, the signing key surviving an upgrade.
  Not tried with a real Okta / Entra / Keycloak.
- **Limits:**
  - One workspace per install.
  - No SCIM: members are whoever signed in within 30 days.
  - The installer doesn't pass `--ca-file` yet.
- **Release:**
  - Run `release-selfhost.yml` by hand.
  - Make `ghcr.io/effigent/effigent-cp` and `effigent-console` public.
  - Never run it at the same time as `release-effigentd.yml` (both write `charts/index.yaml`).

### Website
- **New docs pages:**
  - `/docs/actions`
  - `/docs/cloud-agents`
  - `/docs/model-gateway`
  - `/docs/inventory`
  - `/docs/self-hosting`
- **Updated pages:** approvals, Kubernetes, enforcement, agent setup, security.
- **Home page:** new coverage rows (protected push, SQL, cloud change, package install, model
  call), a "Beyond the command" section, Cursor in the hooks, and a "Cloud agents" install tab.
- **Copy rules:** the site states capabilities without caveats, by the founder's copy rules. The
  caveats live here and in `CLAUDE.md` §5.

---

## Still being built
- **Break-glass during an outage** (checklist Q18).
- **Linux self-protection** of effigentd and its hooks (Q20).
- **Gated binaries** for subcommand control without hooks (Q3).

Migration 018 is reserved for this work. Its posture-report section plugs into
`RegisterReportSection("break_glass")`.

## Release order for round 2
1. **Control plane:** `AWS_PROFILE=effigent deploy/aws/deploy-cp.sh`. Migrations 016, 017, 019,
   020, plus 018 once the kernel work is merged. 016's backfill makes the first start slow.
2. **effigentd tag** (`effigentd-v*`). Needed for remote mode, `cloud-setup`, the hook socket,
   `install-gateway`, the post-tool hooks and `--ca-file`.
3. **`release-selfhost.yml`** (manual), then make both ghcr packages public.
4. **Push `main`.** This deploys the console and the website. The site advertises features from
   steps 1–3, so it must not go live first.
5. **Endpoints:** rerun `install-hooks` (adds the post-tool hooks). Run `install-gateway` only where
   an admin opts in.
6. **Publish policies that use the new keys** (`mcp_pins`, `models:`, the new action kinds) only
   after the endpoints are upgraded. Older effigentd builds refuse them and stay on their current
   version.

## Open items for you
- **The GitHub repo `effigent/effigent` is public** and contains a document marked "Confidential,
  under NDA" (`docs/security/`). Decide before the next push. Everything in `docs/`, including this
  file, becomes public on push.
- Run `deploy/aws/set-event-archive.sh` in CloudShell (legal-hold permissions, from round 1).
- Check that the `effigentd-v0.7.0` release workflow finished.
- **Repository hygiene:**
  - `main` has no branch protection.
  - Dependabot is off.
  - There's no CI on push / PR.
  - `deploy-cp.sh` builds the working tree, uncommitted changes included.
