# Effigent: answers to the vendor checklist (2026-10-21)

Answers to the 28 points in "EFFIGENT: POINTS TO CHECK WITH THE VENDOR", from the v2 code.

**Status** is what the code does after this round of work:
- **Yes**: built and tested.
- **Partly**: part of the ask is covered and the gap is stated.
- **No**: not built.

**Not released yet.** Everything marked *new* is on branch `feature/vendor-checklist` (plus
the endpoint-health and governance branches merged into it). None of it is deployed or tagged.

**Two layers.** Effigent enforces in two places, and the answers say which one applies:
- **Kernel** (Linux, Tetragon/BPF LSM). It matches binaries, file path suffixes and IP addresses.
  The agent can't skip it, but it understands nothing about meaning.
- **Hooks** (Claude Code, Codex, Gemini CLI, and now Cursor). The agent asks effigentd before
  every tool call, and effigentd reads the command or tool input, so it can understand meaning.
  It sees only what the agent says it is about to do: scripts are read (two levels deep), but
  programs that build commands or SQL at run time are not followed.

Hooks run on Linux too, alongside the kernel layer.

Priority items (1, 2, 4, 5, 6, 16, 17, 21) come first.

---

## Priority items

### 1. SQL awareness: **Partly**
**Before this round:** no. `psql*` could be gated as a command and MCP database tools by name.
Nothing read the statements.

**New:** the hook reads the SQL an agent is about to run and classifies each statement as:
- `destructive_sql`: DROP, TRUNCATE, ALTER … DROP, DELETE or UPDATE without WHERE, Redis
  FLUSHALL/FLUSHDB, Mongo `drop()`/`dropDatabase()`/`deleteMany({})`, `bq rm`, database resets
- `sql_write`: any other write
- read: plain `access`

Where it finds the SQL:
- **Inline:** `-c` / `-e` / `--eval` / `-q` flags. Clients covered: psql, pgcli, mysql, mariadb,
  sqlite3, duckdb, mongosh, redis-cli, sqlcmd, clickhouse, cockroach, snowsql, bq, cqlsh.
- **Fed on stdin:** heredocs and here-strings, `< file.sql`, and `echo …` / `cat file` piped in.
- **Files:** `-f file.sql`. An unreadable file counts as a write.
- **Inside other commands:** `docker exec … psql`, shell scripts, and package.json scripts
  (e.g. `npm run db:reset`).
- **Migration tools:** Prisma, Rails/rake, Django, Alembic, Knex, Sequelize, Flyway,
  Liquibase, goose, migrate, dbmate, TypeORM, Supabase, Drizzle, Atlas, sqitch, diesel,
  sqlx, MikroORM. Running migrations is a write; resetting, dropping, rolling back or
  downgrading is destructive.

Policy can deny or require approval on these kinds, and only for prod targets if you want
(see 2): `actions_deny: [destructive_sql@prod]`, `actions_approve: [sql_write@prod]`.

**MCP database tools:** gated by server name (`tool_approve: [mcp__postgres__*]`, `mcp_allow`).
`access@prod` covers every call to a server listed under the prod environment. The SQL inside an
MCP tool's input is not parsed yet.

**Code that connects directly** (an app, an ORM, a script in Python/Node): no SQL visibility.
The kernel sees the connection, not the statement. The control there is the network: on Linux,
`network_deny` / `network_approve` on the prod database's addresses blocks or pauses the connect
in the kernel.

**Limits:** SQL built at run time, `psql` fed by another program's output, stored procedures,
and GUI clients are invisible.

**Where:** `internal/endpoint/hooks/sql.go`, `bashact.go`; tests in `hooks/actions_test.go`.

### 2. Prod vs non-prod: **Yes** (hooks), **Partly** (kernel)
**New:** policy defines environments by their targets:

```yaml
environments:
  prod:
    aws_profiles: ["prod-*"]
    aws_accounts: ["111122223333"]
    kube_contexts: ["prod-*"]
    gcloud_projects: ["*-prod"]
    azure_subscriptions: [Production]
    terraform_workspaces: [prod]
    pulumi_stacks: ["*/prod"]
    hosts: ["*.prod.internal", 10.20.0.0/16]
    mcp_servers: [prod-db]
    match_unknown: true     # a cloud/DB action whose target can't be worked out counts as prod
```

Any action can then be scoped to prod: `actions_approve: [cloud_change@prod, access@prod]`,
`actions_deny: [cloud_destroy@prod]`.

How effigentd works out each target:
- **AWS:** `--profile`, `AWS_PROFILE` (on the command or in the agent's environment), or the
  default profile. The account comes from `~/.aws/config` (`sso_account_id` or `role_arn`,
  following `source_profile`).
- **Kubernetes:** `--context`, or the kubeconfig's `current-context`.
- **gcloud:** `--project`, `CLOUDSDK_CORE_PROJECT`, or the active configuration.
- **Azure:** `--subscription`, or the default subscription in `azureProfile.json`.
- **Terraform:** the workspace, from `.terraform/environment` or `TF_WORKSPACE`.
- **Databases:** the host, from flags, connection URLs or `PGHOST`, `MYSQL_HOST` etc.

Tested end to end: an agent whose environment has `AWS_PROFILE=prod-admin` is refused
`aws s3 rb`, and the same command with no prod profile runs.

**Kernel:** prod hostnames and addresses via `domain_deny` / `network_deny` / `network_approve`
(which becomes a deny there). The kernel has no notion of an AWS account.

**Limits:** these come from the CLI's own configuration as effigentd reads it. Credentials
exported as raw keys (`AWS_ACCESS_KEY_ID`) don't name an account; they are recorded as
`aws_auth: access keys in the environment`, and `match_unknown` makes them count as prod.
SDK calls from code aren't seen.

**Where:** `hooks/cloud.go`, `hooks/actions.go` (`envsOf`), `policy.Environment`.

### 4. Package control: **Yes** (hooks), with an OSV feed
**New:**
- `package_deny` / `package_approve` / `package_allow` by ecosystem, name and version:
  `npm:event-stream`, `pypi:colourama`, `npm:colors@1.4.1`, `npm:@acme/*`.
- With `package_allow` set, any other package is `package_unlisted`.
- `package_registries`: allowed registry URLs. Anything else is `package_registry`:
  `--registry`, `NPM_CONFIG_REGISTRY`, `-i` / `--index-url`, git / URL / tarball specs, and
  git dependencies in package.json. Every `--extra-index-url` counts, because an extra index is
  how dependency confusion works.
- `package_scripts`: npm/yarn installs without `--ignore-scripts`. pnpm ≥ 10 and bun already
  block dependency scripts by default.
- `package_install`: any install by name.

Package managers covered:
- npm, pnpm, yarn, bun, npx, bunx, `npm create`
- pip, `python -m pip`, uv, uvx, pipx, poetry, pdm, rye
- cargo, `go get` / `go install`, gem, brew
- Requirements files and package.json + package-lock.json are read for manifest restores
  (`npm ci`, `pip install -r`).

**Malware / SCA feed:** OSV, which includes the OpenSSF malicious-packages feed.
- `package_malicious`: a MAL- advisory. For an unpinned install it counts only when the
  advisory covers every version, so a popular package with a few hijacked versions isn't
  blocked wholesale.
- `package_vulnerable`: known vulnerabilities in a pinned version.
- Lookups happen only when a policy names these kinds: one batch call, a 4-second budget, a
  1-hour cache.
- If OSV can't be reached, the install goes ahead (fail open) and the event records `osv_error`.
- The response format was checked against the live API.

**Limits:**
- Transitive dependencies are checked only when the lockfile lists them.
- Unpinned installs aren't checked for vulnerabilities, because the version isn't known
  before the install.
- brew has no OSV coverage.
- On Linux the kernel can't tell packages apart. A private-registry-only rule is strongest
  combined with `network_allow` / `domain_deny` for public registries.

**Where:** `hooks/packages.go`, `internal/endpoint/osv`.

### 5. Git controls: **Yes** for branch-aware rules, **No** for content
**New:** pushes are read refspec by refspec:
- `protected_push`: a push to a branch in `protected_branches` (default main, master, trunk,
  prod, production, release*). Covers `HEAD:main`, a bare `git push` (branch read from
  `.git/HEAD`), `--all` and `--mirror`, and `gh pr merge` (noting `--admin`).
- `force_push`: `-f`, `--force-with-lease`, `+refspec`, `--mirror`, in any position.
- `branch_delete`: `--delete`, `:branch`, `branch -D`.
- `history_rewrite`: `reset --hard`, `clean -f`, `filter-branch` / `filter-repo`,
  `stash drop` / `stash clear`.
- `hook_bypass`: `--no-verify`, `HUSKY=0`, `-c core.hooksPath`.

These are also found inside scripts and npm scripts. Example policy:
`actions_deny: [force_push]`, `actions_approve: [protected_push]`.

**What was pushed:** only metadata. Effigent doesn't collect diffs.

**Limits:**
- git aliases and git run from other programs aren't followed.
- The branch for a bare push is read from `.git/HEAD`, so the push's upstream configuration
  isn't consulted.
- Server-side branch protection remains the backstop.

**Where:** `hooks/git.go`.

### 6. Cursor: **Yes** (hooks, from the endpoint-health branch)
**New:**
- `install-hooks` registers effigentd in Cursor's enterprise `hooks.json` for
  `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile` and `preToolUse`, with
  `failClosed` and a 120-second timeout. This covers both the Cursor IDE and the CLI.
- Cursor's calls are mapped onto the same canonical tools, so one policy covers Cursor too:
  deny lists, approval lists and all the new action kinds.

**Not verified yet:** this has not been run against a real Cursor install. Payloads come from
Cursor's docs. Open questions:
- whether our "allow" also skips Cursor's own approval prompt
- whether `beforeMCPExecution` fires in the CLI
- whether users can switch enterprise hooks off

**Limits:**
- Tab completions aren't hooked.
- Cursor background agents (cloud) are out of reach. See 10.

**Where:** `internal/endpoint/hooks` (`ParseCursor`), `cmd/effigentd/installhooks.go`.

### 16. Requester vs approver: **Yes** (from the governance branch)
**New:**
- **Who counts as the requester:** the machine's owner, plus whoever the request's OS user,
  hostname or git email maps to.
- **Self-approval is refused by default, admins included.** A refused attempt is audited as
  `approval.self_approval_refused`. A routing rule can explicitly allow it.
- **Two approvers:** a routing rule (e.g. one matching prod) can require two different people.
  - Any single deny denies the request.
  - An admin override counts as one vote.
  - API keys and the admin token never count toward a two-person quorum.
  - One person can't vote twice through two channels (console, email, Slack).
  - The agent sees "1 of 2" until quorum.

**Where:** `internal/controlplane/server` (`castVote`), migration 012.

### 17. Policy change control: **Yes**, opt-in (from the governance branch)
**New:**
- **Turn it on:** `policy_change_approval` (off by default). Once on, every change that would
  publish a policy becomes a proposal: a policy publish, creating or removing an exception, or
  changing a machine's owner or teams.
- **Approving:** another admin or security admin must approve. The author can't approve their
  own proposal, nor can the person who created the API key it came from. API keys never approve.
- **Turning it off** is itself a proposal.
- **Exceptions:** expiring exceptions are still removed automatically, because that only
  tightens policy.
- **Audit** records propose, approve, reject, withdraw and supersede.

**Where:** migration 013, `/api/v1/policy/proposals`.

### 21. Guardrail files: **Yes** (hooks), **Partly** (kernel)
**New:**
- **`guardrail_edit`** is any write to:
  - CI config: `.github/workflows/` and `actions/`, GitLab, CircleCI, Buildkite, Jenkins, Azure,
    Bitbucket, Travis
  - `CODEOWNERS`, `.husky/`, `.git/hooks/`, `.git/config`, `.pre-commit-config`
  - agent settings and their hook files: Claude Code, Codex, Gemini, Cursor, `.mcp.json`
  - shell startup files, `.npmrc`, `pip.conf`
  - cron, launchd, systemd
  - effigentd's own state directory

  It also covers `crontab`, `launchctl load` and `systemctl enable`.
- **`file_write_deny` / `file_write_approve`:** writes only (reads stay allowed). An entry ending
  in `/` covers a whole directory tree: `file_write_deny: [/.github/workflows/, /CODEOWNERS]`.
  Writes are recognised from the Write/Edit tools, redirects, and tee, cp, mv, `sed -i`,
  `curl -o`, `dd of=` and similar.

**Kernel (Linux):** `file_deny` still blocks named files by suffix, for reads and writes alike.
The kernel has no write-only or directory rules.

**Limits:**
- A program the agent runs that writes these files itself (e.g. a Python script) isn't seen
  by the hook.

**Where:** `hooks/bashact.go` (`guardedPath`, `writeTargets`), `policy.IsDirEntry`.

---

## The other points

### 3. Subcommand control on Linux without hooks: **No**
The kernel matches the resolved binary, so `aws s3 ls` and `aws ec2 terminate-instances` are
the same to it. With hooks (on Linux too), it works:
- `cloud_change` / `cloud_destroy` / `access` per CLI verb (aws, gcloud, az, kubectl, oc, helm,
  terraform, tofu, terragrunt, pulumi, eksctl)
- `command_deny` / `command_approve` with `*` anywhere in the pattern

For agents without hooks (e.g. Aider), the kernel can only allow or deny the whole binary.

### 7. Fail-open hooks: **Yes**, detected and alerted (endpoint-health branch)
**New:** effigentd reads each agent's hook configuration back every minute and reports one
state per agent: installed, missing, modified or unreadable. "Modified" includes:
- the hook switched off
- `failClosed` / `onFailure` dropped
- Codex's `features.hooks` pin removed
- the effigentd binary gone
- a Gemini user who ran `/hooks disable`

When a hook goes missing or off on a machine where that agent is installed, the control plane
alerts once per change (webhook `endpoint.hooks_missing`, email, audit), and the console marks
the machine.

A Linux machine that never had hooks doesn't alert.

**Limits:**
- Codex and Gemini still fail open on a crash or timeout while the hook is installed. This
  alert detects removal; it doesn't stop the agent.
- Not detected: Claude Code's `managedSourcesBehavior: first-wins` with an MDM or remote
  source (it skips our file silently), and a Gemini hook disabled in a project's own
  `.gemini/settings.json`.

### 8. Discovery: **Partly**
**Today:**
- Agents detected on enrolled machines, including unknown MCP servers (`track_orphan_mcp`).
- Claude Cowork VMs reported as "not under policy".
- Agent processes on Linux tracked from their exec.
- The console's Agent Graph shows them.
- **New:** `mcp_unlisted` flags calls to servers outside `mcp_allow`.

**Gaps:**
- Machines that should be enrolled but aren't: Effigent only knows enrolled machines.
  Compare against your MDM / asset inventory.
- No MCP inventory page yet.

### 9. Server-side bots: **Partly**
A Windmill integration (resource type, scripts, Slack/Teams approval flow) is in
`integrations/windmill/`. It was tested against Windmill CE locally, but the Slack/Teams buttons
weren't exercised. Windmill workers running an agent can be enrolled like any Linux host.
Effigent doesn't inspect a workflow's definition.

### 10. Cloud-hosted agents: **No**
Not covered: Claude Code on the web, Codex cloud, Copilot coding agent and Cursor background
agents run on the vendor's infrastructure. Effigent covers endpoints, CI runners and Kubernetes
nodes you control (Helm chart, Docker image).

### 11. Containers and remote environments: **Partly**
- **Docker hosts and Kubernetes nodes:** kernel enforcement covers agents in containers, via the
  DaemonSet / compose. One policy per node, and paths are the container's.
- **Hooks don't work inside containers:** they can't reach the node's daemon, so approvals and
  command/tool rules don't apply there.
- **Devcontainers and remote SSH / cloud dev boxes:** covered when effigentd runs on that Linux
  host.
- **WSL:** not verified.
- **Claude Cowork's VM:** not enforceable; reported as "not under policy".

### 12. Cloud identity: **Yes** for which identity, **No** for an identity layer
**New:** each cloud and database action carries the identity it used: AWS profile and account,
region, kube context and namespace, gcloud project, Azure subscription, Terraform workspace,
Pulumi stack, database host. At session start, effigentd also records the agent's
identity-related environment: profile names, model hosts, and which keys are set (never their
values).

Effigent doesn't issue short-lived credentials.

### 13. Event outcomes: **Partly**
- **Recorded today:** blocked (with the rule), would_block, approval pending, approved, denied.
- **Not recorded:** a network failure or a target-side denial (exit codes, HTTP status).
  Recording them needs the agents' post-tool hooks. Planned, not built.

### 14. Reporting: **Partly**
- **Console today:** Overview, an audit trail with filters, approvals history, exceptions, and
  Pricing Leaks (spend by vendor and person).
- **Not built:** a posture report for non-technical readers (usage by team, blocks, approvals
  and exceptions over time).

### 15. Credential paths and env secrets: **Yes** (new)
**Default alerts** now also cover:
- `.pgpass`, `.my.cnf`, `.vault-token`
- `gh/hosts.yml`, the Terraform credentials file
- Azure MSAL and access-token caches
- `id_dsa`
- the AWS SSO and CLI caches and gcloud's legacy credentials (directory trees, hooks only)

**`credential_read`** recognises:
- **Files:** AWS/Azure/gcloud/kube/docker/npm/pypi/netrc/git-credentials/gh/Terraform/Vault/1Password
  files, the macOS and GNOME keychains, `/etc/shadow`, `/proc/*/environ`, `.env*` (not
  `.example` / `.template`), `*.pem` / `.key` / `.p12`, and SSH private keys.
- **Commands that print secrets:** `gh auth token`, `aws configure get` / `export-credentials` /
  `secretsmanager get-secret-value`, `gcloud auth print-access-token`, `az account get-access-token`,
  `security find-*-password`, vault, op, doppler, bw, pass, and `kubectl get secret -o`.
- **Reading the whole environment:** `env`, `printenv`, `export -p`.
- **Secret variables on the command line:** `$GITHUB_TOKEN`-style.

**Secrets in environment variables:** the hook forwards which key variables are set
(`ANTHROPIC_API_KEY: set`), never their values. Redaction now strips `NAME_TOKEN=…`-style values
from everything sent (see 28).

### 18. Break-glass during an outage: **No**
When the control plane is unreachable, a call that needs approval is denied, and deny rules keep
working from the cached signed policy.

A break-glass option (signed offline codes that only lift approval lists, audited when the
machine reconnects) is designed but not built.

### 19. Console access, SSO, SCIM, tickets: **Partly**
- **SSO:** login is Clerk, which supports SAML/OIDC enterprise connections (Entra, Okta) per
  organisation. SSO enforcement and SCIM deprovisioning are Clerk organisation settings. We
  haven't set them up for a customer yet, so they need confirming on Clerk's plan.
- **Ticket links (new, governance branch):** a routing rule can require a ticket reference
  (e.g. `SEC-123` or a link) before approving, with a tenant link template for Jira and others.
  Email and Slack then offer only Deny and send approvers to the console.

### 20. Local admin tampering: **Partly** (detect, not prevent)
**New (endpoint-health branch):**
- **A stopped daemon:** SIGTERM, a service stop or a shutdown emits `daemon_stop` before
  teardown. It names who stopped it: a signal, the service manager, or the OS user at a
  terminal.
- **kill -9, a crash or power loss:** leaves a run marker, so the next start emits
  `daemon_unclean_restart`.
- **Offline detection:** a machine that goes silent is marked offline after the tenant's
  threshold (default 5 minutes; settable from 2 minutes to 7 days), with an email and an opt-in
  webhook. Detection takes the threshold plus up to one minute. The alert says whether the
  machine stopped cleanly or went silent. Coming back online is audited without an email,
  because laptops sleep.
- **What a stop event can't say:** a signal doesn't name who sent it, so `daemon_stop` records
  how effigentd was run (systemd, launchd, Windows service, terminal) and, for a terminal run,
  the OS user.

**Hooks fail closed** (Claude Code, Cursor) when the daemon is down, so stopping it stops those
agents instead of freeing them.

Root can still stop or remove it. Preventing that needs OS-level protection, such as macOS
Endpoint Security or MDM-locked services.

### 22. MCP governance: **Partly**
- **New:** `mcp_allow` (server names, `*` wildcards). A call to another server is
  `mcp_unlisted`: deny or require approval. This covers remote servers when the agent names them.
- **Already there:** `tool_deny` / `tool_approve` by tool name.
- **Not built:** detecting a change to a server's tool list after approval.

### 23. Model and provider control: **Partly**
**New:**
- `model_hosts_allow` checks where each agent is pointed. The host comes from
  `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, Bedrock (`CLAUDE_CODE_USE_BEDROCK` + region), Vertex,
  or the Gemini base URL; with none set, it's the vendor's default host. Any other host is
  `model_endpoint`.
- `model_api_key` flags an agent running with a direct API key (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `GEMINI_API_KEY`) instead of the company login or gateway.
- Both can deny or require approval.
- WebFetch and commands to non-approved AI hosts can be blocked with `domain_deny`.

**Limits:**
- No model traffic proxy. Effigent sees configuration, not the bytes sent.
- Which model is used is recorded when the agent reports it.
- An agent that changes its own environment mid-session isn't re-read.

### 24. Prompt injection and anomalies: **No**
Not detected. What exists is deterministic:
- `remote_script` (`curl | sh`, `bash <(curl …)`)
- `credential_read`
- `guardrail_edit`
- `fs_destroy`
- deny/approve on all of them

Anomaly detection over sequences is on the roadmap, not built.

### 25. EDR / eBPF coexistence, footprint, MDM: **Partly**
- **Linux:** uses Tetragon's BPF LSM. Several BPF LSM programs can coexist, and we have no
  reports of conflicts with Falcon or Wiz sensors, but we haven't tested next to them. A pilot
  machine with your sensor is the honest next step.
- **macOS:** effigentd ships as an MDM-deployable pkg.
- **Windows:** effigentd ships as an install.ps1 installer.
- **Footprint:** not yet measured on a fleet.

### 26. Employee monitoring and privacy: **Partly**
- **New masking:** policy `redact:` adds workspace patterns (customer ids, internal hostnames)
  and an optional PII set (email, phone, card numbers, IBAN). It runs on the machine before
  anything leaves it, on top of the secret rules. Applies to commands, paths, messages, approval
  summaries and reasons.
- **DPA:** template not written yet.
- **Works-council / employee-monitoring guidance (EU, Israel):** not written yet.
- **Data minimisation:** what's collected per user is listed in
  `docs/security/architecture-and-data-flow.md`.

### 27. Retention and legal hold: **Partly**
- **Online retention:** configurable (`EFFIGENT_EVENT_RETENTION_DAYS`, minimum 90).
- **Archive:** daily gzip archives in S3 with Object Lock (governance mode, 365 days).
  Customers can bring their own bucket.
- **Legal hold:** on the governance branch, in progress (migration 015). Status is in the merge
  notes.

### 28. SOC 2, self-hosting, redaction: **Partly**
- **SOC 2:** in progress. No report yet; until then we answer questionnaires (SIG Lite, CAIQ)
  directly.
- **Self-hosted:** the control plane is one Go binary on Postgres, with a published Docker image
  for effigentd. Running the control plane in your own infrastructure is on the roadmap, not
  offered.
- **Redaction (new):** gitleaks, plus rules for what gitleaks misses on command lines:
  - `NAME_TOKEN=` / `DB_PASSWORD=` assignments
  - `--password` / `--token` flags
  - `mysql -p…`
  - `user:pass@` in URLs
  - bearer and basic tokens
  - private-key blocks

  Heredoc bodies are part of the command text, so they're covered. Plus the workspace masks
  from 26.

---

## Verification and rollout

**Unit tests:**
- `internal/endpoint/hooks/actions_test.go`: about 70 classification cases and 22 decision
  cases, with a fake OSV.
- `osv_test.go`, `redact_test.go`, `compile/actions_test.go`.

**End to end:** `test/hooks/approval.sh` passes 42 of 42 checks. It drives a real hook process,
a hooks-mode daemon and a local control plane through: force-push deny, `curl | sh` deny,
workflow write deny, DROP TABLE approval, a prod AWS profile from the agent's environment,
events carrying actions and the agent environment, and no key values in events.

**Rollout:**
- Older effigentd builds refuse a policy that uses any of the new keys and stay on their current
  version, so upgrade endpoints before publishing one.
- The new lists live in the base policy. Central per-user / per-team `require_approval` rules
  don't compile to them yet.
- Policy exceptions don't cover the new lists yet; the API says so.
