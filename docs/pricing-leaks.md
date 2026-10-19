# Pricing Leaks

Pricing Leaks shows where a workspace's AI coding tools cost more than they should. It joins
what the vendors bill (seats, usage, cost) with what effigentd sees on each machine (which
agents ran, on which days, for whom), and reports four kinds of leak with an estimated monthly
saving in US dollars.

Code: `internal/controlplane/spend` (pure: vendor clients, CSV parsing, identity, detection),
`internal/controlplane/store/spend.go` + `people.go` + `spend_rollup.go`, migrations `009_spend.sql`,
`010_people.sql` and `011_spend_rollup.sql`, `internal/controlplane/server/pricing_leaks.go` + `people.go`
+ `spend_rollup.go`; effigentd's identity fields in
`internal/endpoint/ident`; console `views/PricingLeaks.tsx` (Monitor → Pricing Leaks),
`components/SpendTrend.tsx` + `SpendAlerts.tsx` (on that page), `views/Identity.tsx` (Workspace → People),
`components/SpendVendors.tsx` (Settings → AI vendors).

## Data sources

| Vendor | API (admin key) | What we read | CSV fallback |
|---|---|---|---|
| Cursor | `https://api.cursor.com`, Basic auth (key as user) | `GET /teams/members`, `POST /teams/daily-usage-data` (≤ 30 days per call), `POST /teams/filtered-usage-events` (charged cents) | seats (Email, Name, Role), usage (Date, Email, Cost/Requests) |
| Anthropic | `https://api.anthropic.com`, `x-api-key` + `anthropic-version: 2023-06-01` | `/v1/organizations/users`, `/v1/organizations/usage_report/claude_code` (one day per call; per user or API key, estimated cost in cents), `/v1/organizations/cost_report` (org-wide, daily) | seats, usage |
| GitHub Copilot | `https://api.github.com`, Bearer token, `X-GitHub-Api-Version: 2026-03-10` | `/orgs/{org}/copilot/billing` (plan), `/orgs/{org}/copilot/billing/seats` (login, created, last activity) | seats (Login, Last activity at, Plan) |
| OpenAI | `https://api.openai.com`, Bearer admin key | `/v1/organization/users`, `/v1/organization/costs` (org, daily), `/v1/organization/usage/completions?group_by=user_id` (tokens per user) | seats, usage |

- Copilot and Cursor don't return a seat price: the price table (below) fills it in.
- OpenAI per-person cost is **estimated**: the day's org cost is split by each user's token
  share (`estimated` on the rows and the vendor).
- CSV columns are matched by header name (several spellings: `email`/`user`/`login`,
  `date`/`day`, `cost`/`amount`/`spend`, `cents` in a header means cents), a UTF-8 BOM is
  fine, max 200,000 rows / 20 MB. Where a vendor has both API and CSV rows, API rows win.

## Identity: joining vendors and machines

Vendors key people by email (Copilot by GitHub login, Anthropic API usage by key name).
effigentd (builds from this branch on) puts who is behind each agent event on the event itself:

| Field | From |
|---|---|
| `os_user` | Linux: Tetragon's process uid → user name (`internal/endpoint/ident`, cached 10 min; not for processes in containers). Hooks (macOS/Windows/Linux): the OS user the hook runs as (`X-Effigent-OS-User`, self-asserted by the hook process). |
| `git_email` | `user.email` from the repo config of the agent's working directory (walking up; worktrees and `.git` files followed), else the user's `~/.gitconfig` / `~/.config/git/config`. Read from the files, never by running git; cached per user + directory. |
| `session_id`, `model`, `transcript_path` | The agent's hook payload (Claude Code, Codex, Gemini CLI). `model` only when the agent sends it. |

The control plane keeps a daily rollup of them, `cp.agent_activity_daily` (machine, agent,
OS user, git email, model → events, first/last seen), upserted in the same transaction as each
ingested batch (`cp.events` stays append-only; replayed batches aren't counted twice) and
backfilled for 35 days by migration 010.

Each value becomes a **person key**: the work email when known, else `kind:value`
(`github:dana-k`, `host:build-7`, `key:ci-nightly`), so unrelated values never merge by accident.
Each day of agent activity goes to a person by, in order (`spend.Directory.ObsPerson`):

1. a mapped OS user: `os_user:dana@build-7` (that machine) before `os_user:dana` (any machine);
2. the git email, if it is mapped (`git_email:` / `email:`) or is a known work email (someone in
   People, a vendor seat email, a machine owner);
3. the machine's owner (Machines, `PATCH /api/v1/endpoints/{id}`);
4. a mapped hostname (`host:dana-mbp`);
5. a single mapped OS user seen on the machine's approval requests (older effigentd builds);
6. otherwise the machine itself (`host:<name>`), listed as `unattributed`.

So a shared machine splits by OS user / git email, and the owner only gets what can't be told
apart. Every leak based on effigentd's activity says how its person was matched
(`attribution`: `os_user`, `git_email`, `owner`, `host`); a leak resting on a machine-level match
(owner, host) assumes one person per machine, so it is at most medium confidence and says so.

**People** (`cp.people`, `cp.person_identities`, Workspace → People): per work email, the
identities the person goes by — `os_user`, `git_email`, `host`, `github`, `email`, `api_key`.
One identity belongs to one person (a second claim is a 409). A host mapping attributes activity
only: it doesn't change the machine's owner, which central policies compile against.

**Suggestions** (`spend.Suggest`, computed on `GET /people`, never applied on their own):
- an unmapped OS user whose git email is a known person (high when the person is in People);
  shared logins (`root`, `ubuntu`, `runner`, …) or a login that is several people become
  `user@host`;
- an OS user named like exactly one known email's local part (`dana.k` ~ `danak`);
- a personal git email used on a machine that is clearly one person's (medium), or named like
  one person (low);
- a machine with no owner where every identified run is one person's but some aren't identified;
- vendor seat emails not in People yet; Copilot logins that look like a person's email (low).

## Detection (`spend.Analyze`, 30-day window)

| Leak | Rule | Monthly saving |
|---|---|---|
| `unused_seat` | A paid seat with no use in the window: the vendor reports no activity (or last activity before the window) **and** effigentd saw none of the vendor's agents for that person. Seats younger than 14 days are skipped. High confidence when both sources agree and effigentd covers the person. | the seat price |
| `duplicate_tool` | The person used one tool on ≥ 5 days and a paid seat of another on ≤ max(2, 20 % of that) days. Not reported for seats already flagged unused. | the unused seat's price |
| `shadow_spend` | effigentd saw a vendor's agent for a person who has no seat or usage on that vendor's connected company account. Gemini CLI is always reported (low confidence; no company plan to connect); open-source agents (aider, opencode, goose, cline, continue) only when the person isn't on a connected Anthropic or OpenAI account. | none; `at_risk_cents` = the personal plan price (likely expensed) |
| `runaway_cost` | A person over 3× the vendor's median cost (≥ 3 people with cost) and ≥ $50 over it; or a spike: a day in the last 3 at ≥ 5× the 7-day mean and ≥ $20 above it; also at org level from the cost report. | spend above 3× the median, scaled to 30 days; or the spike's excess |

Constants are at the top of `internal/controlplane/spend/detect.go`. Every leak carries its
evidence lines (vendor side and effigentd side) and a confidence.

## Prices

`spend.DefaultPrices` (US cents per month), overridable per workspace on the page
(`cp.spend_settings.config.prices`):

- Seat: `cursor` 4000 (Teams), `copilot` / `copilot/business` 1900, `copilot/enterprise` 3900,
  `anthropic` / `openai` 0 (API members cost only their usage).
- Personal (sizes shadow spend): `cursor`, `anthropic`, `openai` 2000, `copilot` 1000,
  `google`, `byok` 0.

A seat's own price (from the vendor or a CSV `price` column) wins over `vendor/plan`, which
wins over `vendor`.

## Storage and secrets (migration 009)

- `cp.spend_connectors` (tenant, vendor): `secret_enc` = the admin key sealed with AES-256-GCM
  under `EFFIGENT_SECRETS_KEY` (AAD = tenant + `spend_<vendor>_key`), `secret_hint` = last 4
  characters, `settings` (Copilot `org`), sync status / last error / counts. The key is never
  returned by any API or written to the audit trail. Without `EFFIGENT_SECRETS_KEY` keys
  can't be stored (503) and CSV import is the way in.
- `cp.spend_seats`, `cp.spend_usage`: rows per (vendor, source `api`|`csv`, identity[, day]).
  A sync replaces that vendor's API seats and its API usage in the window; deleting a
  connector deletes its API rows; CSV rows stay until cleared.
- `cp.spend_settings`: price overrides (the people list that 009 kept here moved to `cp.people`
  in migration 010).

## Sync (the vendor poller)

- Each connector has `next_poll_at` and `failures` (migration 010). Every minute each control
  plane instance lists due connectors and polls each one under a session advisory lock on
  `hashtext('cp.spend.poll:' || tenant || '/' || vendor)` (the `RetentionLock` pattern), and only
  if it is still due once the lock is held, so instances share the work and never poll a vendor
  twice at once.
- A poll pulls the last 30 days with a 10-minute timeout and writes everything in one
  transaction; success sets `next_poll_at = now + Server.SpendSyncEvery` (default 24 h), a
  failure retries after 15 min, doubling, capped at that interval.
- Saving a key and `POST /api/v1/pricing-leaks/sync` poll at once under the same lock; a vendor
  whose lock is held is reported in `already_running`.
- Vendor errors are stored on the connector (`last_error`, the key scrubbed from it) with a
  hint on 401/403/429.

## History, Spend over time and alerts (migration 011)

- **Trigger.** Every spend write (sync, CSV import/clear, connector delete, settings) bumps
  `cp.spend_rollups.changed_at` for the tenant. `runSpendRollups` ticks every minute (first pass
  after one tick) and rolls up tenants whose data changed since the last rollup or that weren't
  rolled up for `Server.SpendRollupEvery` (default 1 h), under a per-tenant session advisory lock
  (`cp.spend.rollup:<tenant>`). A failure is stored in `last_error` and retried after `SpendRollupEvery` or when the data
  changes.
- **Rollup.** The report is the page's own (`Server.spendReport`). One transaction replaces
  today's rows in `cp.spend_report_daily` (per vendor: seats, active seats, seat/usage/monthly
  cents, estimated, connected) and `cp.spend_leaks_daily` (per leak type + vendor: count, savings,
  at risk), upserts every current leak into the log `cp.spend_leaks` (first/last seen, evidence,
  confidence, savings) and marks absent ones resolved. A resolved leak that reappears gets a new
  `first_seen_at` and is announced again (a new episode).
- **History limits.** Seats are replaced on every sync, so seat history starts at the first
  rollup. Daily vendor cost comes straight from `cp.spend_usage` (30 days back from the first
  sync) and machine activity from `cp.agent_activity_daily`.
- **Spend over time** — `GET /pricing-leaks/metrics?days=N` (7–365, default 90):
  `{days, from, to, usage, activity, report, leaks}`. `usage` (`spend.DailyUsage`): per day and
  vendor, cost (an organisation-level row wins for the day), requests, tokens, people, estimated.
  `activity` (`spend.DailyActivity`): per day and billed vendor (`spend.AgentVendor`), events,
  machines, agents. Console: stacked daily cost bars per vendor and machines-per-vendor lines,
  30/90/180 days, table view, rolled-up leak history.
- **Alerts.** Runaway cost only (`spend.AlertTypes`). After each rollup, `ClaimSpendAlerts`
  claims open leaks never announced, or announced over `spend.AlertRepeat` (7 days) ago, with
  one `update … set notified_at = now() … returning`, so several control plane instances announce
  each once. Channels: webhook event `pricing_leaks.runaway_cost` (`{leak, review_url}`, opt-in per
  webhook), email to each of `settings.alerts.emails` (else the notification settings' emails),
  Slack where `EFFIGENT_SLACK=1` and Slack is connected. The result per channel is stored in
  `notify_result` and the audit entry `pricing_leaks.alert` (actor via `system`). With alerts off
  (`settings.alerts.runaway_cost: false`) the leak is still claimed and recorded `{"alerts":"off"}`
  and nothing is sent, so turning alerts back on doesn't replay old leaks. `review_url` =
  `EFFIGENT_CONSOLE_ORIGIN/pricing-leaks?leak=<id>`, which highlights the leak. Not real time:
  vendor data arrives with the daily sync (`SpendSyncEvery`), so a runaway cost is flagged after
  the next sync, within a day (a CSV import is rolled up within a minute).
- `GET /pricing-leaks/alerts?limit=` → `{alerts (the runaway cost log, open and resolved, with
  notified_at / notify_result), runaway_cost, emails, default_emails, email_available, webhook_event}`.

## API (`/api/v1/pricing-leaks`, console users; writes need admin / security_admin)

| Method | Path | |
|---|---|---|
| GET | `/pricing-leaks` | `{report, connectors, settings, default_prices, secrets_available, first_seen (leak id → time), email_available}` |
| GET | `/pricing-leaks/metrics` | `?days=7…365` → Spend over time (above) |
| GET | `/pricing-leaks/alerts` | the runaway cost alert log + alert settings (above) |
| GET | `/pricing-leaks/connectors` | `{connectors, secrets_available}` (Settings → AI vendors) |
| PUT | `/pricing-leaks/connectors/{vendor}` | `{key, org?}` → `{vendor, configured, key_hint, sync_started}` |
| DELETE | `/pricing-leaks/connectors/{vendor}` | removes key and synced data |
| POST | `/pricing-leaks/sync` | 202 `{started, already_running}` |
| POST | `/pricing-leaks/import` | `{vendor, kind: "seats"\|"usage", csv}` → counts + warnings |
| DELETE | `/pricing-leaks/import/{vendor}` | clears that vendor's CSV rows |
| PUT | `/pricing-leaks/settings` | `{prices?: {seat, personal}, alerts?: {runaway_cost, emails}}`; an omitted part is kept |
| GET | `/people` | `{people: [{email, name, identities}], suggestions, sightings (resolved: person, via), unattributed, kinds, window_days}` |
| PUT | `/people/{email}` | `{name, identities: [{kind, value}]}` replaces the person's identities; 409 if one is someone else's |
| DELETE | `/people/{email}` | removes the person and their identities |
| POST | `/people/identities` | `{kind, value, email, name?, source?}` maps one identity (creates the person); `kind: "person"` adds the person only |
| DELETE | `/people/identities?kind=&value=` | unmaps one identity |

Audit: `pricing_leaks.connector.update|delete`, `pricing_leaks.sync`, `pricing_leaks.import`,
`pricing_leaks.import.delete`, `pricing_leaks.settings.update`, `pricing_leaks.alert` (system), `people.create|update|delete`,
`people.identity.add|delete` (before/after identity lists).

## Verification status

- Detection, CSV parsing and every vendor client are unit-tested against `httptest` fakes built
  from the vendors' documented response shapes; the server test runs the whole flow against
  Postgres (`go test ./internal/controlplane/server/ -run PricingLeaks -args -effigent.db=postgres://…`).
- Not yet run against the live vendor APIs. The OpenAI response shapes were written from
  memory (their docs page didn't load), so verify the first real sync, especially the
  `costs` and `usage/completions` field names. Also unverified: Copilot's API version header,
  Cursor's `isChargeable` / charged-cents fields, vendor CSV header spellings.
- Identity: `os_user` from hooks is what the hook process reports (a user could set it);
  Claude Code's PreToolUse payload may not include `model`; Tetragon uids inside containers are
  not resolved (the container's users aren't the host's). The People page, Settings card, Spend
  over time chart and Alerts card were checked with the dashboard typecheck + build and Demo Mode
  fixtures, not in a browser.
- Rollup and alerts: `TestPricingLeaksRollupAndAlerts` (Postgres) covers due-ness, one webhook
  per episode, no repeat, resolve → reappear, alerts off, metrics shape and audit. Email delivery
  of alerts is not exercised by a test (no SMTP in tests; the result is `off: …`).

## Deploy order

Control plane (migrations 009, 010, 011) → console → effigentd release (older effigentd keeps
working; its events just carry no `os_user` / `git_email`, so attribution falls back to the
machine).
