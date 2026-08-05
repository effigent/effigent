# Effigent — engineering guide

> **Effigent** (product; npm CLI: `effigent`) — a self-optimizing runtime for AI agents. Observe agent executions → normalize them
> into a universal execution **DAG** (intermediate representation) → progressively
> convert repetitive LLM reasoning into **deterministic** execution (synthesized tools,
> grep/AST, knowledge-graph retrieval, model routing, caching) → **validate** each
> optimization before it activates. In one line: **a compiler for AI agents** — it
> compiles at the LLM/tool boundary.

This file is the source of truth for how the repo is laid out and how the pieces fit.
Keep it current when you change architecture, data model, or deployment.

---

## 1. Monorepo layout

npm workspaces (`packages/*`). TypeScript throughout; ESM (`.js` import specifiers in source).

| Package | What it is | Runtime / host |
|---|---|---|
| `@effigent/core` | Pure TS engine: transcript/OTel → `Run` → `RunGraph` (DAG), clustering, cost, taxonomy, **determinism scoring**. No I/O. | library |
| `@effigent/server` | Fastify API: ingest, agents/keys, insights (LLM), analyze, reports, viewers. **Being retired** (see §6). | Node (Render) |
| `@effigent/cli` | `effigent` CLI (npm: `effigent`): `login`, `agent add/list`, `run` (wrap ANY agent command), `install claude` (**one** agent-agnostic SessionEnd hook — see §4.1) + `install otel/codex/python/node` (key-filled OTel recipes per harness — table-driven, one entry per new harness), `claude-hook`, upload. | Node |
| `@effigent/dashboard` | Next.js App Router dashboard + its own API routes. The product UI. | Vercel |
| `@effigent/site` | Marketing site, Next.js **static export** (`output: 'export'`). Pages: `/` (landing), `/docs` (+7 doc pages incl. `/docs/storage` — managed vs customer-S3 residency), `/developers` (full per-harness install guide), `/about`, `/pricing`, `/security` (redaction + posture), `/terms`, `/privacy`. Endpoints are env-driven: `NEXT_PUBLIC_COLLECTOR_URL` / `NEXT_PUBLIC_DASHBOARD_URL` (set as GitHub `prod` environment Variables `COLLECTOR_URL`/`DASHBOARD_URL`, injected in the deploy workflow; unset → explicit `<placeholder>`) — never hardcode domains. | S3 + CloudFront |

The engine (`core`) is deliberately I/O-free so both capture paths (Claude transcripts
and OTLP spans) produce the **same `Run`**, and everything downstream is unchanged.

---

## 2. The core engine (`packages/core/src`)

The data contract everything else depends on.

- **`types.ts`** — `RawStep` (`kind`: `model_turn | tool_use | tool_result | thinking`,
  `name`, `payload`, `isError?`, `toolUseId?`, **`model?`/`tokens?`/`durationMs?`** —
  per-step usage), `TokenUsage` (Anthropic-style: input / output / cacheCreation /
  cacheRead), `Run`, `GraphNode` (incl. **`structLabel`** — content-blind schema label,
  **`valueHash`** — full-value hash of the raw payload, `costUsd` — measured per step),
  `RunGraph`.
- **`transcript.ts`** — `parseTranscript()`: Claude Code JSONL → `Run` (returns null if no
  assistant turn / tool use). Per-request usage is deduped by requestId AND attributed to
  the first step each request emits, so per-step costs sum to the run cost.
- **`otel.ts`** — `otelToRuns()` + `normalizeGenAiUsage()`: OTLP GenAI spans → `Run[]`
  with per-step model/tokens/duration. Anthropic usage maps 1:1; OpenAI
  (`prompt_tokens` includes cached) is normalized to the uncached remainder.
- **`graph.ts`** — `buildRunGraph()`: `Run` → `RunGraph` with fingerprints
  **L0** (structure + labels + canonical I/O), **L1** (structure + labels = *shape*),
  a canonical `labelSequence`, per-node `structLabel`/`valueHash`/`costUsd`, and
  heuristic dataflow edges.
- **`cost.ts`** — `usageCostUsd(model, usage)`: regex-priced per model tier (unknown model
  falls back to the sonnet tier — never zero, so a mis-guess only mildly mis-estimates).
- **`taxonomy.ts`** — classifies tool names (unknown tools degrade to `side_effect`).
- **`redact.ts`** — sensitive-data redaction, applied in the server's `persistParsedRun`
  (the single choke point both capture paths flow through) BEFORE storage/analysis:
  provider/platform API keys, AWS creds, JWTs/bearer tokens, DB connection strings, PEM
  blocks, emails, card-like numbers → typed `[REDACTED:<TYPE>]` placeholders. Plus
  **org-defined custom rules** (migration 010, `tenants.redaction_rules` jsonb):
  `compileRedactionRules` (strict validation — ≤20 rules, ≤200-char patterns, safe
  names; invalid entries reported, never thrown) + `applyRedactionRules`, applied AFTER
  the built-ins; managed via `GET/PUT /api/v1/redaction` (org-admin gated) and the
  dashboard's **Privacy** view. The dashboard's `NEXT_PUBLIC_COLLECTOR_URL` env var
  drives install-snippet endpoints (same rule as the site: no hardcoded domains).
- **`determinism.ts` + `align.ts` + `provenance.ts`** — **the brain (v3;
  docs/determinism-v3.md).** `align.ts`: pairwise run similarity = 0.7·sequence edit
  similarity over structLabels + 0.3·dataflow-topology Jaccard (the DAG's answer to
  "are these runs pretty much the same?"), complete-link clustering, and
  Needleman-Wunsch alignment of every run to the cluster medoid → COLUMNS.
  `analyzeDeterminism(graphs)` scores each column on full-value hashes of RAW payloads
  (canonicalization would erase the variance being measured) and lands it on the
  lattice: **D0** constant → replace/compile · **D1** derivable (template + every slot
  provenance-traced by `provenance.ts` to an upstream output / the prompt) → compile ·
  **D2** pure (memoize evidence or mechanical taxonomy) · **D3** parameterized template ·
  **D4** routable/cacheable · **D5** keep. Confidence = Wilson lower bound at the
  winning detector's HONEST sample size; every action is confidence-gated. v1
  `scoreDeterminism` (exact-L1, canonical values) is kept for compatibility.
- **`embed.ts` + `drift.ts`** — **run embeddings + agent-change detection.**
  `embedRunGraph` hashes the DAG into a 256-dim vector (SEQ block: structLabel
  n-grams · FLOW block: dataflow edge pairs; blocks weighted √0.7/√0.3 so cosine
  mirrors align.ts's similarity weighting). Deterministic, local, no embedding
  API. `detectDrift` splits a window into baseline + newest-k probe, measures
  probe distance to the baseline centroid in z-scores → `changed` +
  `changedAt` (the "agent was modified" signal; on drift, validated tools
  should be re-shadowed). Surfaced as `drift` per agent in `/api/v1/insights`
  and a "⚠ behavior changed" badge in the Insights view.
- **`ledger.ts`** — **the waste ledger.** Per-run spend decomposition into
  addressable waste classes, all within-run and deterministic (never empty, no
  clustering precondition): dead context (large tool_results carried past their
  last content reference, priced at the run's measured cache-blended input
  rate), cache misses (input re-billed at full price that a stable prefix would
  have served at 0.1× — an upper bound; compaction cold-starts are invisible),
  error-recovery tails, and redundant read-only calls (same question AND same
  answer within one run). Conservative by construction — unsure ⇒ claim
  nothing; slices are independent estimates, never a partition (don't sum
  them). Verified on 65 runs across 3 unrelated agents + ground-truth unit
  tests; sensitivity documented in the file header. Surfaced as `ledger` per
  agent in `/api/v1/insights` and the Insights view's "Where the spend goes"
  strip.
- **`actions.ts` + `episodes.ts` + `suggest.ts`** — **the semantic run IR + tool
  suggester.** The missing middle zoom level: structLabels collapse ~70% of a
  dev agent's calls into one opaque Bash label while raw values almost never
  repeat, so nothing mined at either level. `actions.ts` canonicalizes every
  call to an action token (`git:add+git:commit`, `pnpm:test`, `gh:pr:create` —
  Bash commands parsed across newlines/`&&`/pipes, heredoc bodies dropped, cd/
  export noise stripped); `episodes.ts` splits runs at user turns into the
  comparable unit (ask + deterministic intent + action string + cost + errors);
  `suggest.ts` mines recurring action n-grams across episodes (vocabulary floor:
  rare tokens collapse to program family; specificity gate: motifs made only of
  read/edit primitives are the inner coding loop, never suggested; Wilson
  confidence; overlap + dominance dedupe) and emits ranked **ToolSuggestions** —
  analysis only, NOT activation: name, per-step arg templates (columnTemplate
  slots → proposed typed params), support/occurrences, measured cost, LLM-glue
  count, intents, example asks. Validated on real traffic: the create-PR macro
  (`git:commit → git:push → gh:pr:create`) emerges from apollo's 40 runs with
  a `deliver` intent; heterogeneous traffic yields an honest zero. Surfaced as
  `suggestions` in `/api/v1/insights` + the Insights "Suggested tools" panel.
- **`brief.ts`** — **the run brief (session understanding).** Deterministic
  compact digest of one run: episode storyline (ask → intent → action summary →
  cost → errors → interrupted), outcome signals (final assistant tail, detected
  artifact URLs like PRs), bounded error previews. Feeds two consumers: the
  dashboard's Session storyline card, and `renderBriefText()` — the ~3KB
  LLM-readable block behind the AI layers. **AI on runs (posture):** unlike
  `/api/v1/explain` (structure-only), the digest/analyst endpoints DO send
  redacted run content (the brief) to the model via OpenRouter —
  `GET /api/v1/sessions/[id]/digest[?ai=1]` (typed JSON: title/tldr/outcome/
  chapters/friction, module-cached) and `GET /api/v1/insights/analyst?agent=`
  (agent story over the last 12 runs' briefs + ledger + suggestions; 10-min
  cache). Models via `EFFIGENT_DIGEST_MODEL`/`EFFIGENT_ANALYST_MODEL`/
  `EFFIGENT_EXPLAIN_MODEL` (default anthropic/claude-sonnet-4.5). Validated
  E2E on real runs: digest correctly reconstructed a session's PR + scope
  churn; analyst found the migration ritual / PR finalization / edit-churn
  patterns.
- **`knowledge.ts`** — **the knowledge graph.** Mines stable exploration lookups
  (mechanical/cacheable calls whose question AND answer agree across runs) into typed
  facts — file / search / listing / fetch / value — with support, Wilson confidence and
  measured cost. `worthIt` gates emission on real coverage of the agent's exploration
  traffic ("will this actually reduce greps?"). Surfaced per agent in insights and the
  live Knowledge Graph view; injected via `effigent optimize`.
- **`synthesize.ts` + `replay.ts`** — **tool synthesis (the former "W4").**
  `synthesizeTools(analyses)` slices maximal compilable column spans (clean/moderate
  dataflow boundaries; side-effect steps flagged `guarded`) and emits deterministic
  **ToolSpecs**: typed params (prompt/caller), body of recorded calls with `${param}` /
  `${derive(cN.method)}` substitutions, output expectations, and measured savings
  including the context-carriage tax. `replayToolSpec` validates a spec offline against
  the recorded runs (recompute derivations → must reproduce recorded args) →
  `ready` (≥95% pass over ≥10 runs) or `shadow`.

---

## 3. Data model (Postgres / Neon)

Migrations in `packages/server/migrations/` run on server boot in lexical order. **No
tracking table** — every statement must be idempotent (`if not exists`, `on conflict`).

| Table | Purpose | Notable columns |
|---|---|---|
| `tenants` | A workspace. One per Clerk org / personal user. | `clerk_ref` (`org:<id>` / `user:<id>`, partial-unique) |
| `api_keys` | `cck_` capture/tenant keys (sha256-hashed). | `role` (`owner`/`member`), `agent_id` (scoped keys) |
| `agents` | Registered agents. | `name` (unique per tenant), `harness`, **`optimized_at`** |
| `runs` | One session / invocation. | `session_id`, `agent_id` (name), `cost_usd`, `models` (jsonb), `n_steps`, **`blob_path`** (`s3://<org-bucket>/…` — S3-only residency; legacy rows `'inline'`), `parsed` (jsonb — **null** for S3 rows; legacy inline only), `graph_blob_path` |
| `reports`, `clusters`, `cluster_runs`, `findings` | Analysis output. | |

Migrations of note: `003` agents + scoped keys, `004` run-graph pointer, `006` Clerk
tenant ref, **`007` `agents.optimized_at`** (the Optimized indicator), `008` tenant
limits, **`009` ownership** (`created_by`/`created_by_label` on `api_keys` + `agents` —
who added/controls an agent; CLI registrations inherit from the registering key; all
reads/writes column-guarded), **`010` `tenants.redaction_rules`** (org custom filters),
`011` `agent_tools` (injected-tool registry), **`012` `tenants.storage_*`** (per-org
S3 storage config — bucket/region/prefix/kms/role_arn/external_id; role_arn set ⇒ BYO
cross-account bucket, null ⇒ Effigent-account bucket).
Prod ALTERs: `scripts/apply-ownership-redaction.mjs` (009+010) and
`scripts/apply-org-storage.mjs` (012); per-org buckets via `scripts/provision-org-bucket.mjs` (owner-run).

`runs.agent_id` stores the agent **name** (keeps the engine/queries stable); `agents.id`
binds credentials only.

---

## 4. Auth & tenancy

- **Agents** authenticate with `cck_<hex>` keys (hashed). Scoped keys are `role='member'`
  and bound to one `agent_id`.
- **Dashboard users** authenticate with **Clerk** (`@clerk/nextjs` v6, `clerkMiddleware`).
- A **Clerk Organization is a tenant**; a user with no active org gets a personal tenant.
  `resolveTenant({ userId, orgId })` (in `dashboard/src/lib/tenant.ts`) find-or-creates by
  `clerk_ref` and mints a default owner key.

Secrets live in `.env.local` (gitignored) and in Vercel — **never commit them**. The Clerk
secret key stays server-only (no `NEXT_PUBLIC_` prefix).

### 4.1 Agent attribution — why the capture hook takes no `--agent`

Both ingest paths resolve the agent as **`auth.agentName ?? agentIdHeader`**
(`ingest/route.ts`), and `auth.agentName` comes from a *scoped* key. A scoped key
therefore **pins** attribution server-side and the header is ignored. That makes
per-project separation unreachable for any hook that uploads with one agent's scoped
key — every session lands under that agent no matter what the CLI resolved.

So capture on a dev machine is **one agent-agnostic hook**, and the agent is decided
per session, in the CLI, from the transcript's `cwd`:

- `install claude` writes exactly **one** `SessionEnd` hook (`claude-hook`, no
  `--agent`) and **replaces** any it previously wrote. Hook groups carry no matcher,
  so they all fire on every session — two of them meant every session uploaded twice
  under two different agent names. Install is replace-then-add, never append.
- `claude-hook` calls `classifySession()` (`cli/src/store.ts`, one cwd sniff):
  `excludeRules` veto → explicit tag → `agentRules` → git repo name →
  `UNATTRIBUTED_AGENT`.
- A project with no scoped key yet is **auto-registered on first sight** (shared
  `registerAgent()`), so `auth.agentName` ends up equal to the resolved name and
  attribution stays credential-derived rather than header-asserted. The tenant key is
  used only for that one minting call.
- **`excludeRules`** is a hard veto: it is checked even when `--agent` pins, and
  unlike the attribution default it is **not** overridable by `sync --all`. An
  unknown cwd is *not* excluded — exclusion requires a positive match, so a failed
  sniff can never silently suppress capture.
- `--agent` remains, as an explicit pin for CI/single-purpose machines.

Because `runs.agent_id` stores the agent **name** (§3) and `agents` rows bind
credentials only, none of this needs a schema change.

---

## 5. Dashboard (`packages/dashboard/src`)

Next.js App Router. `tsconfig` allows `.ts`/`.tsx` import specifiers; `@/*` → `src/*`.
Reads Neon directly via a pooled `pg` client (`lib/db.ts`).

**API routes** (all Clerk-auth'd, `resolveTenant`, `force-dynamic`):
- `GET /api/v1/agents` — per-agent rollup from `runs`: `n_runs`, `total_cost_usd`,
  `models`, `optimized`, `added_by` (both guarded if their columns are absent).
- `GET/PUT /api/v1/redaction` — workspace redaction rules (PUT is org-admin-only;
  validated by `engine/redact.ts`; ingest caches compiled rules 60s per tenant).
- `GET /api/v1/optimize?agent=&mark=1` — **the activation bundle** (Bearer keys, public
  in middleware): replay-validated ToolSpecs + knowledge graph + drift for the agent's
  last 40 runs; `mark=1` stamps `optimized_at` when something activatable exists.
  Consumed by `effigent optimize <agent>`, which writes `~/.effigent/bundles/<agent>/`
  and installs a generated Claude Code skill (facts + recipes + runnable scripts for
  fully-constant read-only bash units) under `~/.claude/skills/effigent-<agent>/`.
  **POC: tool INJECTION is OFF by default** (`EFFIGENT_ENABLE_INJECTION=1` to
  re-enable; dashboard UI uses `NEXT_PUBLIC_ENABLE_INJECTION`). When off:
  `install claude` wires only the SessionEnd upload hook (no SessionStart
  auto-inject), `effigent optimize` is insights-only (writes nothing), the server
  does not stamp `optimized_at`, and the "Injected tools" control is hidden.
  Capture + read-only insights (Insights, Tool Synthesis) are always on.
- `GET /api/v1/sessions[?agent=]` — the tenant's runs, newest first.
- `GET /api/v1/sessions/[id]` — one run (with `parsed`) for the DAG deep-dive.
- `GET /api/v1/insights[?agent=&window=]` — **the determinism brain (v3)**: a thin
  adapter over the REAL engine (vendored in `lib/engine/` — no hand-mirroring anymore).
  Per agent, over the last `window` (default 40, 5–100) sessions: alignment clustering →
  lattice scoring → merged opportunities with **stable ids** (hash of
  agent+action+structLabel+template, so accept/dismiss can attach across windows) →
  synthesized ToolSpecs with replay validation (`tools[]` in the response:
  params, arg previews, savings incl. context-carriage, `replay.status` ready/shadow).

**Views** (`Dashboard.tsx` drives `view` state; sidebar in `data.ts` `nav`):
- **Overview** — KPI tiles, per-agent **Execution Graph** (original vs optimized), and
  the demo analytics rail/bottom.
- **Sessions** — one-stop shop: totals strip (agents / sessions / spend), per-agent totals
  cards, **session-id search**, and a table where each row opens the…
- **…DAG deep-dive** (`SessionDetail.tsx`) — sticky run context, per-model **usage table**,
  and a scrollable numbered **trace** (tool-call→result grouping, per-node model/tokens/
  duration, click-to-expand payloads).
- **Insights** (`Insights.tsx`) — the determinism brain's output: per-agent
  optimization opportunities (replace/cache) scored over the real runs. **Live.**
- **Storage** (`Storage.tsx`) — per-org run storage: managed (Effigent-account
  bucket) vs customer S3 (BYO via CloudFormation/Terraform), switch modes,
  access probe. **Live** (see §6).
- **Tool Synthesis** / **Knowledge Graph** (per-agent) — currently demo-backed.
- **Install** — how to put Optimizer on an agent (see §6 for real vs aspirational).

**What is real vs demo, today:**
- **Real (DB-driven):** agent list, totals, sessions, DAG deep-dive, per-model usage,
  the Optimized indicator (`optimized_at`).
- **Demo (in `data.ts`, not yet wired to the engine):** KPI tile values, Execution Graph
  flows (per-agent but hand-authored), Tool Synthesis, Knowledge Graph counts, the rail
  analytics. **Demo panels render ONLY for the demo workspace** (`NEXT_PUBLIC_DEMO_ORG_ID`,
  fallback = the Test Organization Clerk org id, checked via `useOrganization()` in
  `Dashboard.tsx`) with a "Sample data" badge; every other tenant gets `OverviewLive`
  (real totals + connect-an-agent empty state) and honest empty states for Tools/KG.

Styling: `theme.css` (design tokens as CSS vars, dark theme).

---

## 6. Deployment & the collector (honest status)

**Target architecture:** dashboard (Vercel + Clerk) + Neon + R2, no Render.

- **Site** → S3 + CloudFront, auto-deployed by `.github/workflows/deploy-frontend.yml`
  on push (uses the `prod` GitHub Environment + AWS secrets).
- **Dashboard** → Vercel, auto-deploys on push to `main`.

**✅ The dashboard IS the collector** (Render is retired, not in use). Machine endpoints
live as Next.js routes, Bearer-authenticated with `cck_` keys (public in `middleware.ts`;
auth inside the handlers):
- `POST /api/v1/ingest` — gzipped/plain Claude JSONL (gzip sniffed by magic bytes since
  proxies strip content-encoding); scoped key beats the `x-effigent-agent-id` header.
  ~4.5 MB Vercel body cap — CLI gzips, so almost all sessions fit.
- `POST /v1/traces` — OTLP/HTTP GenAI JSON (uncompressed; 415 with a hint otherwise).
- `POST /api/v1/agents` — CLI registration: tenant key → upsert agent + mint scoped key.
- `GET /api/v1/reports` — key validation (`effigent login` probes it).
The engine bits these need are **vendored** in `dashboard/src/lib/engine/`
(types/cost/canonicalize/transcript/otel/graph/taxonomy/align/determinism/provenance/
synthesize/replay/embed/drift/knowledge/ledger/actions/episodes/suggest/brief/redact/jsonb — copies of core with `.js`→`.ts` import specifiers;
re-vendor after core changes:
`for f in …; do { echo "// VENDORED …"; sed "s/\.js';/.ts';/g" packages/core/src/$f.ts; } > packages/dashboard/src/lib/engine/$f.ts; done`).
`lib/agent-auth.ts` holds `authenticateKey` + `persistRun` (redaction + jsonb
sanitizing at the single write choke point). **Per-org S3 storage (S3-only
residency):** `persistRun` writes the redacted run blob to the org's OWN bucket
via `lib/storage.ts` (`putRunBlob`; BYO cross-account buckets via STS AssumeRole),
storing only the `s3://` `blob_path` + metadata in Neon (`parsed` null). Reads
(`sessions/[id]`, `insights`, `optimize`) fetch blobs with `loadRun` (parallel;
legacy `parsed` rows still work). No bucket configured ⇒ ingest returns **409**
(the onboarding gate). Org-admin `GET/PUT /api/v1/storage` manages both modes:
PUT with bucket/roleArn sets BYO config (write→read probe; externalId defaults to
the server-generated one), PUT `{mode:'managed'}` clears BYO and (re)provisions an
Effigent-account bucket. GET also returns `effigentAccountId`
(`EFFIGENT_AWS_ACCOUNT_ID` env) + `suggestedExternalId` (HMAC of tenant id with
`EFFIGENT_EXTERNAL_ID_SECRET` — deterministic, no DB column; see
`lib/byo-template.ts`). `GET /api/v1/storage/template` serves the BYO
CloudFormation template pre-filled with both (one `aws cloudformation deploy`,
no typed parameters); raw copies for partners live in
`infra/aws/effigent-byo-storage.yaml` + `infra/aws/terraform/` (keep in sync with
`lib/byo-template.ts`). The dashboard **Storage** view (Workspace nav) is the UI
for all of it: mode cards, provision/switch, template download, BYO form, live
probe. See `docs/onboarding.md`.
The CLI is published to npm as **`effigent`** (bin: `effigent`; config `~/.effigent`; keys minted `eff_`, legacy `cck_` accepted) (single-file esbuild CJS bundle, core
inlined — no workspace dep). `packages/server` remains as reference/self-host only.

---

## 7. Seed / demo data

The prod dashboard reads prod Neon, which was wiped. To make the demo look populated:

- **`scripts/seed-prod.mjs`** — inserts synthetic sessions for a tenant. 6 agents
  (`invoice-reconciliation`, `repo-explorer`, `support-triage`, `ci-fixer`, `docs-writer`,
  `data-pipeline`), deep runs (10–16 steps) with real tool inputs+outputs, per-step
  model/tokens/ms, and model routing (multi-model runs). Rows are prefixed `seed-`.
  ```
  PROD_DATABASE_URL="postgres://…?sslmode=require" node scripts/seed-prod.mjs --list
  PROD_DATABASE_URL=…  node scripts/seed-prod.mjs --ref <clerk_ref-substr>
  # cleanup:  delete from runs where session_id like 'seed-%';
  ```
- **`scripts/mark-optimized.mjs`** — applies `agents.optimized_at` (migration 007),
  ensures an `agents` row per agent, and marks agents optimized so the indicator shows.
  ```
  PROD_DATABASE_URL=…  node scripts/mark-optimized.mjs --agent invoice-reconciliation
  ```

The org tenant (`org:org_…`) is created lazily on first dashboard load; scripts target it
by `--ref`.

---

## 8. Roadmap — the brain

The "brain" turns observed runs into activated optimizations. Sequenced:

1. **Determinism analysis** — ✅ **shipped, v3** (alignment clustering + D0–D5 lattice +
   provenance; `core/determinism.ts` + `align.ts` + `provenance.ts`, vendored into the
   dashboard's `GET /api/v1/insights` + the **Insights** view).
2. **Tool synthesis + replay validation** — ✅ **shipped at the engine level**
   (`core/synthesize.ts` + `core/replay.ts`; surfaced as `tools[]` in the insights
   response). NOT yet shipped: the delivery vehicle — emitting an actual skill/MCP tool
   file + PR, persistence of specs, accept/dismiss state on stable ids.
3. **AI analyst** — ✅ **shipped, v1** (`core/brief.ts` + the digest/analyst
   endpoints, see §2): per-session AI digest (title/tldr/outcome/chapters/
   friction) + per-agent story over the last 12 runs' briefs + measurements.
   Not yet: persistence of digests (module cache only), batch digest of the
   sessions list, estimated-savings line items.
4. **DAG diff** — compare runs before vs after `optimized_at` to prove the compiled
   columns disappeared and $/run dropped (the real "original vs optimized" for the
   Execution Graph; also closes the loop on replay-validated tools).
5. **The gateway** — the injection vehicle (proxy `base_url` / sidecar / Lambda) that
   actually *enforces* an optimization at the LLM/tool boundary.

---

## 9. Conventions

- **Migrations are idempotent** and run on boot; never assume a tracking table.
- **Never commit secrets.** `.env.local`, `.env*.local`, `.next/`, `out/` are gitignored.
- **Prod DB writes:** data seeds are fine; **schema changes (ALTER)** are gated in
  auto-mode — run them explicitly (the `mark-optimized` script, or `!`-prefixed).
- **`parsed` is free-form jsonb** — the dashboard reads it directly (no `core` dep on
  Vercel). Seed data may carry richer per-step fields (`model`, `tokens`, `ms`) that the
  OTLP capture path also provides.
- Commit messages end with the `Co-Authored-By` trailer; branch before committing on `main`
  only when asked.

## 10. Common commands

```
npm install                              # bootstrap workspaces
npm run -w @effigent/dashboard build        # typecheck + build the dashboard
npm run -w @effigent/dashboard dev          # local dashboard (needs .env.local)
npm run -w @effigent/core build             # build the engine (dist/)
```
