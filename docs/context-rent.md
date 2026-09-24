# Context rent — what interactive agents actually spend money on

> Agents are anonymized (A–F): the data is one engineer's real Claude Code sessions across six projects.

Research note, 2026-09-24. Reproducible with `research/context-rent/` (see its README).
Engine: `packages/core/src/rent.ts` (+ `cost.ts` / `transcript.ts` fixes). Tests:
`packages/core/test/rent.test.ts`, `packages/core/test/cost.test.ts`.

## TL;DR

1. **Our dollar figures were 2.3× too high.** Every Opus was priced at the Opus-4.1
   rate ($15/$75 instead of $5/$25) and every cache write at the 5-minute rate
   (1.25× instead of the 1-hour 2×). Advisor-tool usage (a second model inside the
   request) was not counted at all. Fixed and checked against Claude Code's own
   `cost-state` totals: median ratio **0.999** over 247 sessions.
2. **Only 8.6% of spend is the model generating anything.** 54% is re-reading
   context that is already there, 19% is writing it into the cache, and 19% is advisor
   calls. The money is in what the agent *carries*, not in what it *decides*.
3. **New model: context rent.** Everything that enters context pays rent (tokens ×
   read price) on every later request until a reset. This decomposition reproduces
   observed cache-read spend **exactly (100.0%, 38,571 requests)**, so every dollar
   can be attributed to the deposit that caused it.
4. **New counterfactual: a trace-replay simulator.** It replays each session's
   observed deposits under a "compact at T tokens" policy, and reproduces observed
   cost within 1%. For this traffic, compacting at **400k** instead of Claude Code's
   ~1M saves **8–16%** ($721–$1,471 of $9.4k) across every measured re-exploration
   scenario, including a 3× pessimistic one. Compacting at 150k *loses* 29–150%.
   (Superseded per agent by the v4 rule below: never lose in any scenario, then best
   expected savings under p50/p90/stress weights 0.5/0.35/0.15 — a judgment, not a
   measurement. It lands on 200k for agents B, C and E, next to
   their EOQ points.)
5. **Step-level determinism is measured at a ceiling.** A predictor trained on each
   agent's own past sessions predicts next decisions with ≥80% confidence for 2.6%
   of held-out decisions, carrying 1.5% of spend, and 0% once arguments are included.
   It is well calibrated, so this is a ceiling, not a weak model. Compiling
   interactive coding traffic is not where the money is. It is where the money is for
   repetitive batch agents; the D0–D5 engine stays for those.

## Data

All local Claude Code transcripts on one machine: **293 sessions, 38,571 LLM
requests, 2,557 human asks, 9 projects, 2026-08-17 → 2026-09-24, $9,356** (corrected
pricing). They are the same sessions the CLI uploads. Prod reads were not used.

Unit of analysis: the **request** (one API call, deduped by `requestId`). Context size
`ctx_k` = input + cache-write + cache-read tokens of the request's **last** sampling
iteration. Top-level usage *sums* iterations: a two-iteration request reports twice
its real context, which fakes resets and, before this was fixed, made the rent model
explain only 32% of reads.

## What the parser was throwing away

The transcripts carry much more than messages. Now used:

| Signal | Where | Why it matters |
|---|---|---|
| 1h vs 5m cache writes | `usage.cache_creation.ephemeral_1h_input_tokens` | 99% of writes are 1h, priced 2× (not 1.25×) |
| advisor-model usage | `usage.iterations[type=advisor_message]` | **$1,753 (18.7%)**, previously invisible |
| true context size | last `usage.iterations[type=message]` | the rent model is exact only with it |
| thinking tokens | `usage.output_tokens_details.thinking_tokens` | thinking stays in context: 6,151 of 6,278 turns |
| ask provenance | `promptSource`, `origin.kind`, `isCompactSummary` | shell echoes / compaction summaries / task notifications were opening fake episodes |
| `<synthetic>` messages | `message.model` | harness-generated, never billed |

Still available and not yet used: `system:compact_boundary` (pre/post tokens),
`pr-link` + `toolUseResult.gitOperation` (delivered artifacts), `toolDenialKind`
(171 blocked calls), `ai-title` / `system:away_summary` (free LLM summaries),
`system:turn_duration`, subagent transcripts in `<session>/subagents/` (the CLI does
not upload them: ~$92 locally).

**Residual:** 2% of Claude Code's own total never appears in any transcript. It is
harness-side calls (away-summary recaps, titles, the auto-mode classifier). The gap is
$0.03/session on sessions with no recaps and grows with the recap count.

## Experiments

### E1 — Anatomy of spend

| Component | $ | Share |
|---|---:|---:|
| cache **reads** (re-reading context) | 5,041 | 53.9% |
| advisor tool (uncached, other model) | 1,753 | 18.7% |
| cache **writes**, 1h TTL | 1,734 | 18.5% |
| output (visible) | 552 | 5.9% |
| thinking | 257 | 2.7% |
| cache writes 5m + uncached input | 19 | 0.2% |

75% of spend happens in requests with >200k tokens of context. Cost per request
scales with context at elasticity 0.81 (log-log, r = 0.70, n = 38,563). The median
session peaks at 341k tokens, and p90 at 683k.

### E2 — Context rent: the identity and the attribution

`rent(Δ_k) = Δ_k × Σ_{j≥k+2 in segment} readPrice_j`, plus `base = ctx_0 × Σ readPrice`.
Modelled **$5,043** vs observed cache reads **$5,041** (100.0%). The engine
(`computeRentLedger`) gets 1.006 overall, with per-session p5–p95 of 0.93–1.01.

| Rent paid by | Share of read spend |
|---|---:|
| base context (system prompt + tools + memory; p50 **69k** tokens, p90 131k) | 30.2% |
| assistant text + tool arguments (edit/write bodies) | 24.7% |
| shell (`Bash`) output, mostly `sed -n`/`cat` file reads | 16.9% |
| harness injections (reminders, attachments) | 15.8% |
| thinking (persists in context) | 11.1% |
| `Read`, user asks, everything else | <1.5% |

Cold rewrites (the cache expired, so the whole prefix was re-written): 268 events,
**$879**. 199 of them came after gaps over 1h.

### E3 — Is carried context dead? (No, mostly.)

Of 1,982 task boundaries (a new human ask), **55%** are follow-ups that lean on
the conversation, **33%** are new asks touching files already in context, and only
**12%** are independent. The natural control is the first episode of a session, which
starts with fresh context. It spends **7.9 exploratory calls / 14.9k tokens** (p90 17 /
37k) before its first action. A warm episode spends ~1 call. "/clear between tasks" is
the wrong default here. Resets pay only when the carried context is large and the
remaining session long, which is what E5 prices.

### E4 — The natural experiment: 26 real compactions (25 auto, 1 manual)

Context fell from 671k to 102k on average. The share of exploratory calls in the next
12 requests rose from 0.38 to 0.57: re-acquisition is real and bounded. n = 26 is small;
the simulator therefore prices re-acquisition from E3's larger fresh-start sample (n = 216).

### E5 — Counterfactual: compact at T

The simulator (`simulateCompaction`) replays observed deposits. Calibration at the
observed policy is 100.8%. Savings versus observed, $:

| T | p50 re-acq (15k tok/8 req) | p90 (37k/17) | stress (3×p90, 30k summary) | compactions |
|---:|---:|---:|---:|---:|
| 150k | −2,687 | −4,330 | −13,997 | 3,000 |
| 200k | 2,013 | 1,094 | −1,767 | 455 |
| 300k | 1,904 | 1,670 | 83 | 150 |
| **400k** | **1,471** | **1,334** | **721** | 69 |
| 500k | 1,026 | 962 | 586 | 44 |
| 700k | 543 | 518 | 408 | 9 |

`recommendCompaction` maximizes the **worst-case** savings, which selects 400k. By
project (worst case): agent B saves $433 of $1,596, agent C $143 of $677,
and the agent A sessions, mostly short, only $79 of $6,395.

**Assumption check (E8.1):** after real compactions, the agent keeps adding context at
the same rate, 1,493 vs 1,345 tokens/request (n = 25), excluding the re-acquisition window.

**What the simulator cannot see:** answer quality after an earlier compaction.
This needs an outcome signal (next section) before it is sold as a pure win.

### E6 — Predictive determinism (held-out)

Variable-order Markov with backoff (order ≤ 4, ≥5 observations) over each
request's decision (the set of tool calls it emitted). Each project is split by time:
train on the first 70% of sessions, test on the last 30%, online-updated with
strictly past data only.

| Alphabet | conf ≥ 0.7: coverage / precision / spend share | conf ≥ 0.8 |
|---|---|---|
| program family (`git`, `python3`) | 5.8% / 72.9% / 3.0% | 2.6% / 78.2% / 1.5% |
| action token (`git:commit`) | 2.4% / 65.1% / 1.1% | 0.6% / 73.4% / 0.3% |
| exact call (with arguments) | 0% | 0% |

Calibration: stated 0.7 → observed 0.69, and stated 0.8 → observed 0.78. The
predictor knows when it knows. For interactive coding traffic, the share of LLM
decisions a deterministic replacement could take over is a few percent at best.

### E7 — Recurring intents (episode level)

A past ask with Jaccard similarity ≥ 0.6 predicts the exact program of a
held-out episode for 1.5% of episodes (0.1% of spend). The most repeated intent,
"commit, push and deploy", occurs **156 times ($332, 3.5%; $2.13 and 12 requests
each, starting at 227k context)**. It expands to a different program almost every time.
What recurs is the intent, not the steps. That is a skill/script candidate, and its
cost is mostly context rent again.

### E8 — Two policies that are already right

- **Cache TTL:** a 5-minute TTL would cost **$1,098 more** than the 1-hour TTL
  Claude Code uses. 2.2% of inter-request gaps fall in (5m, 1h]. Keep it.
- **Advisor:** 827 calls, mean **185k input tokens, 0 cached**, so ~$2.12 per call.
  This is a harness/API property, not something the user's code controls, but it is
  the largest single line item after context reads, and the product should show it.

### E9–E13 — second round: where else could determinism hide?

| # | Hypothesis | Result |
|---|---|---|
| E9 | The model **re-writes the same code** (near-duplicate MinHash over 21.5k generated programs, held-out) | **No:** 1.9% of future programs matched an earlier session's (0.3% of generated chars). Real repeaters exist (`eas update` ×39/18 sessions, `gcloud logging read` ×15, push-as-account ×10) but are small in dollars. |
| E10 | Harness injections are a big rent slice | **No:** attachments total $416 of rent. The only large one is `instructions` = CLAUDE.md. |
| E11 | Fixed rules can drop dead tool output | **No:** shell output here is mostly code being read; 55% of its lines are used later. Head/tail/error filters remove 12.8% of tokens and lose 13% of later-used lines. Exact de-dup is safe but worth ~$40. |
| E12 | CLAUDE.md is dead weight | **Size is real, deadness is not provable offline.** agent A's CLAUDE.md is 68k tokens (118 bullets, grown over 162 commits by a "document every incident" rule). It costs **$947 of rent (15% of that project)**. Routing bullets to nested files saves 2% (sessions touch 4–5 areas). Lazy loading saves 54% if behavioural liveness is right, and breaks even if the agent needs 2.4× more bullets than it visibly touches. The only way to size it is an A/B. |
| E13 | **Spill exploration to a subagent** (context isolation) | **Yes.** 1,579 read-only bursts (23% of requests) run inside the main context. Isolated, with the same CLAUDE.md base, the subagent's own growth and its generated summary charged, the net is **9–18% of spend** at the measured live-out (median 56% of burst output is used later), and 12% even at a 100% return. The saving is the *call site*: a lookup made from a 400k context pays to re-read 400k. The engine's stricter read-only detector gives 4–8% on the last-40 windows. |

These are structural bounds conditional on the agent actually delegating; confirm with a
before/after window. E5 and E13 are not additive: spilling exploration means fewer
sessions reach the compaction threshold.

### What the harnesses let us write (docs of the locally installed agents)

- **Claude Code** (docs): subagents with isolated context and a per-agent `model`
  (`.claude/agents/*.md`), `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` / `autoCompactWindow`,
  skills with deterministic `` !`cmd` `` injection and `disable-model-invocation`,
  hooks (`PreToolUse` `updatedInput`, `UserPromptSubmit` `additionalContext`),
  `bashOutputMaxChars`, `promptCacheTtl`, `advisorModel`.
- **Gemini CLI 0.20.2** (installed source): `model.compressionThreshold` (default 0.5),
  `.toml` custom commands with `!{cmd}` / `@{file}` injection, `tools.discoveryCommand` /
  `tools.callCommand` for deterministic tools. No user-defined subagents (built-in
  `codebase_investigator` only). Hooks are off by default and SessionEnd never fires.
  Transcripts are in `~/.gemini/tmp/<hash>/chats/*.json`, with `tokens.input` *including*
  cached tokens. Token OTel arrives as **logs**, not spans.
- **cursor-agent 2025.11.06**: rules and MCP only. No arg or shell injection, no hooks or
  subagents in the installed build, and no local token data.

### The compiled plan (`packages/core/src/plan.ts`)

`analyzeAgent(agentId, runs)` returns the spend anatomy, the rent decomposition (with its
identity), the compaction recommendation, the spill estimate, recurring commands, and
**`plan[]`**: priced changes, each carrying the file it would write and an evidence
label (`measured` / `simulated` / `structural` = if adopted / `needs-ab`):

- `.claude/agents/scout.md` + one CLAUDE.md line (E13)
- `.claude/settings.json` `env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (E5)
- the advisor spend line (measured; the choice is the user's)
- CLAUDE.md size (needs-ab)
- skills for recurring commands. They are read-only with no slots → `!` injection;
  otherwise manual-invocation only. Short literals only become slots, since a long
  quoted literal is code. IPs are masked and redaction applied.
- a `ship` skill for the recurring commit/push/deploy intent (E7b)

Wired into `GET /api/v1/insights` as `analysis` (cost re-priced per run with
`runCostUsd`, so it does not depend on the prod backfill), rendered in Insights'
"What the money paid for" + "Compiled plan". Sessions show the **context skyline**
(`contextSkylineSvg`): context per request stacked by content, with compactions and the
compact-at-T replay. Local rendering: `research/context-rent/render-page.mjs`.

### E14–E17 — third round: what the requests were for, and the law

- **E14, cost by reason.** act 44% · explore 22% · verify 17% · respond 7% · deliver 4% ·
  wait/poll 4% · recover 2% · **delegate: 11 of 38,564 requests**. The agent almost never
  isolates work.
- **E15, are the routine requests deterministic?** Mostly no. Verification commands are
  not concentrated (agent A: 4,776 verifies, 3,765 templates, top-3 share 4%). After an
  edit burst, P(verify within 3 requests) is 0.26–0.75. Poll streaks have a median of 1.
- **E16, what makes a session expensive.** 72–88% of the variance of log(session cost) is
  explained by **length** (requests), 20–40% by mean context, and price is negative
  (caching gets cheaper per token in long sessions). The expensive sessions are 5–25× the
  median length.
- **E17, the law and the inventory view.** Context grows linearly with requests, so
  cost(N) ≈ p·(B·N + d·N²/2) + w·(B + d·N). Fit R² is 0.92–0.98 per agent (0.71 on the
  9-session agent F). Compaction is an inventory problem: carried tokens cost holding
  (rent), and a compaction is a fixed reorder cost K. EOQ gives L* = √(2K/(p·d)) and
  T* = B + summary + d·L*. On every agent **T* matches the trace-replay simulator's
  optimum** (agent C 150k/150k, agent B 162k/150k, agent D 201k/250k).
  agent A sits higher (270k) because its 133k base makes every compaction cost $2.68.

## Data audit (2026-09-24): what we collect, what we added, what we skipped

Measured across 314 local sessions: which transcript signals exist, and whether
collecting them would change a decision.

| Signal | In sessions | Decision it feeds | Verdict |
|---|---|---|---|
| git commit / push / PR (`toolUseResult.gitOperation`) | 59% | cost per delivery; the loop's quality guard | **added** → `Run.events` |
| denied tool calls (`toolDenialKind`) | 18% blocked, 11% user-rejected | friction in the quality guard ($81 measured) | **added** |
| compaction events (trigger, pre/post tokens) | 4% | exact reset detection | **added** |
| subagent transcripts (`<session>/subagents/`) | 124 files, 35 MB | the scout's OWN cost — without it the loop would overstate scout savings | **added**: CLI uploads them with the session, parser prices them as `subagents` |
| true tool-result size past the 20k (parser) / 8k (ingest) cut | 15% of sessions | rent attribution | **added** `fullChars`; big-session upload keeps every request |
| session title | 92% | explaining expensive sessions | **added** (redacted at ingest) |
| file history (re-reads of unchanged files) | 99% | memoize re-reads | **skipped**: E20 — 1.2% of reads, $3 total |
| richer state for prediction (ask, position) | — | determinism | **skipped**: E18 — adds nothing; only "last call failed" helps (15% of uncertainty explained, max) |
| turn duration, effort level, queued asks | 51–92% | no decision uses them yet | not yet |
| thinking text | 6% (redacted elsewhere) | — | not available |

### E18 — determinism, measured properly

Determinism is now **held-out predictability** (`predictability.ts`). An agent's own
earlier sessions train a Witten–Bell model over (last two decisions, did the last call
fail); it is scored on later sessions. On these agents: at ≥0.8 confidence 1–5% of next
steps (by reason) are predictable, 89–100% right, carrying 1–8% of spend; exact actions
~0%. History explains 15–18% of the next-step uncertainty. Calibrated after two fixes:
Witten–Bell instead of additive smoothing (additive collapsed unseen actions to ~0), and
a prior strength of 5 (a context seen 3× was claiming 75%). Flagged `reliable: false`
when fewer than 6 later sessions exist or the confident predictions miss. Synthetic
checks: a scripted agent scores >90%, a random one <5%.

## The insight engine (v4): how decisions are made

The earlier miners failed for one reason: they looked for recurring *shapes* (step
labels) and attached verdicts by threshold. A shape has no dollars and no lever. v4
mines recurring **causes of cost**:

1. **IR at the request level** (`rent.requestsOf`). Per request: model, true context,
   new tokens, output, cache state, tools with full command, error flag and subagent.
   Per run: title, instruction-file sizes, legacy flag.
2. **Identities first.** The rent decomposition (100% of reads) and the spend anatomy.
   Every number shown is one of these, or a fit reported with its R².
3. **Laws per agent** (`laws.ts`): the reason mix (`requestReason`); the session law +
   EOQ threshold; the variance drivers; an explanation for each expensive session
   (requests× · context× · price× vs the median, plus its dominant reason).
4. **Decisions** (`plan.ts`). Each is cause × lever × $ × evidence label. Compaction
   takes the EOQ point as a candidate, then the simulator chooses the threshold with the
   best expected savings that loses money in **no** scenario. Profile routing: the
   determinism lattice and shape miners apply only to **repetitive** agents (≥50% of runs
   cluster). Interactive agents get context economics only.
5. **The loop** (`loop.ts`) makes a recommendation a hypothesis. Adoption is detected
   from the transcripts with signals *specific* to the proposed change (calls to the
   `scout` subagent; resets near the recommended T; CLAUDE.md −25%). Before/after windows
   are compared on the lever's metric with a quality guard (errors per request,
   interruptions): confirmed / no-effect / regressed / pending. It is observational, so
   the verdict reports its sample sizes. Generic signals were tried first and produced
   confident wrong verdicts; that is why the detectors are specific.
6. **AI on top, reasoning first.** The analyst gets the measured analysis as its
   evidence and an explicit reasoning budget (OpenRouter `reasoning.max_tokens`), and is
   told not to re-derive numbers.

## The algorithm

**Context Rent Analysis** (`computeRentLedger`) — per run:
1. Group steps into requests. `ctx_k` comes from the last sampling iteration.
2. Segment at resets (`ctx` drops more than 40%).
3. `base = ctx_segStart × Σ readPrice` over the segment. For each deposit
   `Δ_k > 0`: `rent = Δ_k × Σ_{j ≥ k+2} readPrice_j`.
4. Attribute each Δ: thinking and visible output exactly from usage; tool results and
   user text by measured characters (chars/3.2); the unexplained remainder is labelled harness.
5. Mark cold rewrites (writes > 50% of previous context), penalty = write − read price.
6. Identity check: `(base + Σ rent) / observed cache-read spend` — reported as `calibration`.

**Trace-replay policy simulation** (`simulateCompaction`, `recommendCompaction`):
replay the observed deposits on a simulated context. Charge each policy-induced
compaction its read-everything call, the summary, a rewritten prefix, and a
measured re-exploration burst. Sweep T and pick the maximin over the p50 / p90 /
stress re-acquisition scenarios. When no threshold wins in every scenario, return
`threshold: null`.

Why it is trustworthy: both halves carry an identity check against observed spend
(100.0% and 100.8%), both use only measured prices, and the one behavioural
assumption was tested on the natural experiment the data contains.

The analogy is deliberate: this is **liveness analysis for context**. A value that
stays in a register past its last use costs pressure; a token that stays in context
costs rent on every call.

## What this changes in the product

- Insights "Where the spend goes" should show the rent ledger: base, deposits by
  kind and tool, cold rewrites, advisor. The current heuristic dead-context detector
  (`ledger.ts`, token overlap on truncated text) should be replaced by it.
- A per-agent **"Compact at T"** recommendation, with its worst-case savings and the
  calibration shown next to it.
- "Deterministic savings" should state the held-out predictability (E6) rather than
  motif glue costs, and recurring intents (E7) should be framed as skill candidates.
- **Order matters: backfill first, wire second.** The dashboard reads `costUsd` from
  `runs.cost_usd`; until `scripts/recompute-run-costs.mjs --apply` has run, wiring the rent
  ledger would let `sideModelUsd` and the simulator baseline absorb the stale 2.3× value.
- `runs.cost_usd` in prod was written with the old prices and must be recomputed.
  Old blobs carry no 1h split; assuming 1h for all writes is justified (99% of
  measured writes).

## Limitations

One machine, one user, interactive coding traffic. The E6/E7 ceilings will differ on
repetitive batch agents, which is exactly where the D0–D5 engine applies. Rent
attribution below the request level splits a measured Δ by characters; the split is
approximate, the total is exact. The simulator does not model quality, or any change
in behaviour beyond re-acquisition. Compaction n = 26.

## The summary layer (what a person reads first)

`summary.ts` decides what is worth saying and says it in dollars per month (window spend
× 30 / window days, window ≥ 7 days). Findings appear only when material (≥3% of spend or
a ≥1.5× shift). Two findings were added from the data:

- **Spend concentration.** The top 10% of sessions carry 40–73% of each agent's spend.
- **Breaks.** A return to a 150k+ session after the 1-hour cache expired re-writes the
  whole context. Agent A: 105 returns, $379 paid, ≈$79 avoidable by compacting first.
  Agent B: $248 paid, ≈$143 avoidable.
- **Context creep.** Agent A's CLAUDE.md grew 16 KB → 249 KB in five weeks (its own
  "document every incident" rule). The base context rose 63k → 143k tokens, +$0.04 on
  every request. Detected from base-context growth between the older and newer half of the
  window, with instruction-file sizes as the named cause.

The trend compares the older and newer half of the sessions rather than single weeks.
Weekly cost per request swings with the session mix: single-week comparisons produced a
"+94%" on agent C that the halves do not support.

## Loops inside runs (E22–E25)

Do agents repeat procedures inside one session, and can those loops become tools?

- **E22, naive tandem repeats.** 9.6% of spend sits in repeated decision blocks, almost
  all of it several edits in a row: the work itself, not a procedure. Excluded.
- **E23, procedural loops detected on the commands.** Paging through one file in slices,
  the same command per item, a failed command re-run unchanged, and status polling. Total
  $130 (1.4% of spend); a script per loop would save ≈$59.
- **E24, the verify rule.** "After editing, run the check." A first count said 2,820
  re-checks, 73% clean, $539. Most of those were one command that edits *and* checks
  (`python3 - <<PY … PY && npx tsc`), which costs no extra request. Counting only
  check-only requests: **1,083 re-checks after an edit, 60% clean — $118 (1.3%) that only
  confirmed "no errors", $229 (2.4%) in all.** On this traffic the agent already chains
  most checks onto its edits. Clean vs failed is read from the output (`error TS`, `N
  failed`), because `| head` masks the exit code.
- **E25, within-session predictability.** A predictor that also learns from the current
  session as it unfolds predicts ~0.1% of next actions at ≥0.8, the same as history alone.
  Sessions are not loop-like step by step.

Conclusion: intra-run loops are real but small for interactive coding agents. The engine
(`loops.ts`) detects all five kinds for every agent. When clean check-only re-verifies are
material (≥3% of spend) it generates the tool: a PostToolUse hook that type-checks after
TypeScript edits, is silent when clean and returns errors with exit 2 (tested on a real
project), plus its settings.json entry and a CLAUDE.md line. No new data was needed:
command text, result heads and error flags suffice.
