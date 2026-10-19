# Pricing Leaks

Pricing Leaks shows where a workspace's AI coding tools cost more than they should. It joins
what the vendors bill (seats, usage, cost) with what effigentd sees on each machine (which
agents ran, on which days, for whom), and reports four kinds of leak with an estimated monthly
saving in US dollars.

Code: `internal/controlplane/spend` (pure: vendor clients, CSV parsing, identity, detection),
`internal/controlplane/store/spend.go` + `people.go`, migrations `009_spend.sql` and `010_people.sql`,
`internal/controlplane/server/pricing_leaks.go` + `people.go`; effigentd's identity fields in
`internal/endpoint/ident`; console `views/PricingLeaks.tsx` (Monitor → Pricing Leaks),
`views/Identity.tsx` (Workspace → People), `components/SpendVendors.tsx` (Settings → AI vendors).

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

## API (`/api/v1/pricing-leaks`, console users; writes need admin / security_admin)

| Method | Path | |
|---|---|---|
| GET | `/pricing-leaks` | `{report, connectors, settings, default_prices, secrets_available}` |
| GET | `/pricing-leaks/connectors` | `{connectors, secrets_available}` (Settings → AI vendors) |
| PUT | `/pricing-leaks/connectors/{vendor}` | `{key, org?}` → `{vendor, configured, key_hint, sync_started}` |
| DELETE | `/pricing-leaks/connectors/{vendor}` | removes key and synced data |
| POST | `/pricing-leaks/sync` | 202 `{started, already_running}` |
| POST | `/pricing-leaks/import` | `{vendor, kind: "seats"\|"usage", csv}` → counts + warnings |
| DELETE | `/pricing-leaks/import/{vendor}` | clears that vendor's CSV rows |
| PUT | `/pricing-leaks/settings` | `{prices: {seat, personal}}` |
| GET | `/people` | `{people: [{email, name, identities}], suggestions, sightings (resolved: person, via), unattributed, kinds, window_days}` |
| PUT | `/people/{email}` | `{name, identities: [{kind, value}]}` replaces the person's identities; 409 if one is someone else's |
| DELETE | `/people/{email}` | removes the person and their identities |
| POST | `/people/identities` | `{kind, value, email, name?, source?}` maps one identity (creates the person); `kind: "person"` adds the person only |
| DELETE | `/people/identities?kind=&value=` | unmaps one identity |

Audit: `pricing_leaks.connector.update|delete`, `pricing_leaks.sync`, `pricing_leaks.import`,
`pricing_leaks.import.delete`, `pricing_leaks.settings.update`, `people.create|update|delete`,
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
  not resolved (the container's users aren't the host's). The People page and Settings card were
  checked with the dashboard typecheck + build and Demo Mode fixtures, not in a browser.

## Deploy order

Control plane (migrations 009 + 010) → console → effigentd release (older effigentd keeps
working; its events just carry no `os_user` / `git_email`, so attribution falls back to the
machine).
