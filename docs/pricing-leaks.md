# Pricing Leaks

Pricing Leaks shows where a workspace's AI coding tools cost more than they should. It joins
what the vendors bill (seats, usage, cost) with what effigentd sees on each machine (which
agents ran, on which days, for whom), and reports four kinds of leak with an estimated monthly
saving in US dollars.

Code: `internal/controlplane/spend` (pure: vendor clients, CSV parsing, identity, detection),
`internal/controlplane/store/spend.go` + migration `009_spend.sql`, `internal/controlplane/server/pricing_leaks.go`,
console `packages/dashboard/src/views/PricingLeaks.tsx`.

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

Vendors key people by email (Copilot by GitHub login, Anthropic API usage by key name);
effigentd knows machines. Each value becomes a **person key**: the work email when known,
else `kind:value` (`github:dana-k`, `host:build-7`, `key:ci-nightly`), so unrelated values
never merge by accident.

- A machine's person is its `owner` (set in Machines, `PATCH /api/v1/endpoints/{id}`), else a
  People alias matching its hostname, else a People alias matching its only OS user (OS
  users come from approval requests). Several matching OS users → no guess.
- The **People directory** (`cp.spend_settings.config.people`, edited on the page) lists per
  work email the other names the person goes by: hostnames, OS users, `github:login`, API key
  names, personal emails. A `kind:` prefix is optional. The first person to claim an alias wins.
- Machines that can't be tied to a person are listed as `unattributed`; their agents still
  count, as `host:<name>`.

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
- `cp.spend_settings`: the People directory and price overrides.

## Sync

- Saving a key starts a sync at once; `POST /api/v1/pricing-leaks/sync` syncs every configured
  vendor. A sync is claimed atomically (`sync_status = running`, stale after 30 min), pulls the
  last 30 days with a 10-minute timeout and writes everything in one transaction.
- The control plane checks hourly and syncs each connector whose last sync is older than
  `Server.SpendSyncEvery` (default 24 h).
- Vendor errors are stored on the connector (`last_error`, the key scrubbed from it) with a
  hint on 401/403/429.

## API (`/api/v1/pricing-leaks`, console users; writes need admin / security_admin)

| Method | Path | |
|---|---|---|
| GET | `/pricing-leaks` | `{report, connectors, settings, default_prices, secrets_available}` |
| PUT | `/pricing-leaks/connectors/{vendor}` | `{key, org?}` → `{vendor, configured, key_hint, sync_started}` |
| DELETE | `/pricing-leaks/connectors/{vendor}` | removes key and synced data |
| POST | `/pricing-leaks/sync` | 202 `{started, already_running}` |
| POST | `/pricing-leaks/import` | `{vendor, kind: "seats"\|"usage", csv}` → counts + warnings |
| DELETE | `/pricing-leaks/import/{vendor}` | clears that vendor's CSV rows |
| PUT | `/pricing-leaks/settings` | `{people: [{email, name, aliases}], prices: {seat, personal}}` |

Audit: `pricing_leaks.connector.update|delete`, `pricing_leaks.sync`, `pricing_leaks.import`,
`pricing_leaks.import.delete`, `pricing_leaks.settings.update`.

## Verification status

- Detection, CSV parsing and every vendor client are unit-tested against `httptest` fakes built
  from the vendors' documented response shapes; the server test runs the whole flow against
  Postgres (`go test ./internal/controlplane/server/ -run PricingLeaks -args -effigent.db=postgres://…`).
- Not yet run against the live vendor APIs. The OpenAI response shapes were written from
  memory (their docs page didn't load), so verify the first real sync, especially the
  `costs` and `usage/completions` field names.
