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
| `@ccopt/core` | Pure TS engine: transcript/OTel → `Run` → `RunGraph` (DAG), clustering, cost, taxonomy, **determinism scoring**. No I/O. | library |
| `@ccopt/server` | Fastify API: ingest, agents/keys, insights (LLM), analyze, reports, viewers. **Being retired** (see §6). | Node (Render) |
| `@ccopt/cli` | `effigent` CLI (npm: `effigent`): `login`, `agent add/list`, `run` (wrap ANY agent command), `install claude` (SessionEnd hook) + `install otel/codex/python/node` (key-filled OTel recipes per harness — table-driven, one entry per new harness), `claude-hook`, upload. | Node |
| `@ccopt/dashboard` | Next.js App Router dashboard + its own API routes. The product UI. | Vercel |
| `@ccopt/site` | Marketing site, Next.js **static export** (`output: 'export'`). Pages: `/` (landing), `/developers` (full per-harness install guide), `/security` (redaction + posture). Endpoints are env-driven: `NEXT_PUBLIC_COLLECTOR_URL` / `NEXT_PUBLIC_DASHBOARD_URL` (set as GitHub `prod` environment Variables `COLLECTOR_URL`/`DASHBOARD_URL`, injected in the deploy workflow; unset → explicit `<placeholder>`) — never hardcode domains. | S3 + CloudFront |

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
| `runs` | One session / invocation. | `session_id`, `agent_id` (name), `cost_usd`, `models` (jsonb), `n_steps`, `blob_path`, **`parsed`** (trimmed `Run` jsonb), `graph_blob_path` |
| `reports`, `clusters`, `cluster_runs`, `findings` | Analysis output. | |

Migrations of note: `003` agents + scoped keys, `004` run-graph pointer, `006` Clerk
tenant ref, **`007` `agents.optimized_at`** (the Optimized indicator), `008` tenant
limits, **`009` ownership** (`created_by`/`created_by_label` on `api_keys` + `agents` —
who added/controls an agent; CLI registrations inherit from the registering key; all
reads/writes column-guarded), **`010` `tenants.redaction_rules`** (org custom filters).
Prod ALTERs for 009+010: `scripts/apply-ownership-redaction.mjs` (owner-run).

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

---

## 5. Dashboard (`packages/dashboard/src`)

Next.js App Router. `tsconfig` allows `.ts`/`.tsx` import specifiers; `@/*` → `src/*`.
Reads Neon directly via a pooled `pg` client (`lib/db.ts`).

**API routes** (all Clerk-auth'd, `resolveTenant`, `force-dynamic`):
- `GET /api/v1/agents` — per-agent rollup from `runs`: `n_runs`, `total_cost_usd`,
  `models`, `optimized`, `added_by` (both guarded if their columns are absent).
- `GET/PUT /api/v1/redaction` — workspace redaction rules (PUT is org-admin-only;
  validated by `engine/redact.ts`; ingest caches compiled rules 60s per tenant).
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
  proxies strip content-encoding); scoped key beats the `x-ccopt-agent-id` header.
  ~4.5 MB Vercel body cap — CLI gzips, so almost all sessions fit.
- `POST /v1/traces` — OTLP/HTTP GenAI JSON (uncompressed; 415 with a hint otherwise).
- `POST /api/v1/agents` — CLI registration: tenant key → upsert agent + mint scoped key.
- `GET /api/v1/reports` — key validation (`ccopt login` probes it).
The engine bits these need are **vendored** in `dashboard/src/lib/engine/`
(types/cost/canonicalize/transcript/otel/graph/taxonomy/align/determinism/provenance/
synthesize/replay/embed/drift/redact/jsonb — copies of core with `.js`→`.ts` import specifiers;
re-vendor after core changes:
`for f in …; do { echo "// VENDORED …"; sed "s/\.js';/.ts';/g" packages/core/src/$f.ts; } > packages/dashboard/src/lib/engine/$f.ts; done`).
`lib/agent-auth.ts` holds `authenticateKey` + `persistRun` (redaction + jsonb
sanitizing at the single write choke point; `blob_path='inline'`, no blob store).
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
3. **AI analyst** — an LLM pass over ~30 runs + the determinism signal → prioritized,
   human-readable action items with estimated savings.
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
npm run -w @ccopt/dashboard build        # typecheck + build the dashboard
npm run -w @ccopt/dashboard dev          # local dashboard (needs .env.local)
npm run -w @ccopt/core build             # build the engine (dist/)
```
