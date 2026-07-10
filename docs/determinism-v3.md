# Determinism brain v3 — align → score → slice → synthesize → validate

Status: **implemented 2026-07-10** (same day as the design). Core: `align.ts`,
`provenance.ts`, `determinism.ts` (v3 `analyzeDeterminism`), `synthesize.ts`, `replay.ts`;
per-step usage in `types/transcript/otel/graph`; fixes in `segments/cluster/cost`;
tests in `test/determinism-v3.test.ts` (54/54 green). Dashboard: engine vendored into
`lib/engine/`, `/api/v1/insights` rewritten as a thin adapter (window param, stable
opportunity ids, ToolSpecs + replay status in the response). Implementation notes that
extend the design: the template tokenizer is boundary-preserving and splits on
path/query separators with prefix⟨·⟩suffix micro-templates; tool_use templates use a
LOOSE stability gate (0.5) because slot provenance + replay are the safety, while model
turns keep 0.85; slot values are FULL tokens (what upstream outputs actually contain).
Still open from §4: sidechain child runs (P1.10), persistence/accept/dismiss of
opportunities, skill/MCP-file emission, DAG-diff measurement.

The original design follows. It reviewed the v2 brain (`packages/core/src/determinism.ts`
+ its dashboard mirror `dashboard/src/app/api/v1/insights/route.ts`) and specified the v3
algorithm: given the last **X** runs of one agent, decide *how similar the runs are* using
the DAG, find the *deterministic part*, and **synthesize tools** so the agent spends less
on LLM turns and more on plain code.

---

## 1. What the current pipeline actually does

```
Run (steps) ──graph.ts──▶ RunGraph: linear chain + heuristic dataflow edges,
                          label = tool name + 160-char input template,
                          L0 = hash(labels+canonical values), L1 = hash(labels)
        ├─ cluster.ts     group by (agent, exact L1); L2 = char-3gram TF-IDF cosine ≥.82
        ├─ determinism.ts within an exact-L1 group, per-INDEX modal agreement of
        │                 canonicalValue; v2 detectors: memoize / template / route;
        │                 Wilson lower bound as confidence
        ├─ segments.ts    frequent label n-grams (len 3–12) across runs; determinism =
        │                 modal share of whole-segment value hash; separability from
        │                 dataflow boundary crossings
        └─ findings.ts    rule-based $-ranked findings (compile/cache/rightsize/fix/…)
dashboard insights route: lean re-implementation of v2 over last 40 sessions/agent
                          (reads runs.parsed->'steps'; own canon(), own price table)
```

The bones are right: shape clustering, per-node agreement, Wilson weighting, taxonomy,
n-gram segments, dataflow separability. The failure is in the *joints* — five brittle
stages chained by exact equality, so on real (non-seeded) agent history most of the
signal never fires.

---

## 2. Where it breaks (ranked)

### P0 — why the brain under-fires on real data

**P0.1 Exact-L1 gating throws away most of the window.**
`determinism.ts:52–57, 230–243` and `insights/route.ts:155–158` only compare runs whose
label sequences are *byte-identical*. One extra retry, one reordered read, one different
free-text query → new L1 → cluster of size 1 → below `minRuns` → zero signal. Worse,
labels embed up to 160 chars of canonicalized *input content* (`canonicalize.ts:109–135`),
so "same procedure, different data" usually does **not** share L1 — contradicting the
stated intent in `graph.ts`. And since `replace` needs `conf ≥ 0.6` = **≥6 unanimous
runs** (Wilson(5,5)=.57, Wilson(6,6)=.61), you need six byte-identical shapes before the
flagship action can fire. Segments (n-grams) partially compensate but cap the unit at
12 steps and score only whole-segment hash equality.

**P0.2 Core scores determinism on canonicalized values — which erases the variance
being measured.** `graph.ts:58,63` builds `canonicalValue` via `canonicalizeText`, which
maps every number → `<NUM>`, id → `<ID>`, path → `<PATH>`. A result that says
`"processed <NUM> rows"` scores 100% "deterministic" while the actual number swings
wildly. The dashboard mirror *deliberately* keeps digits (`route.ts:51–53`) — the two
"keep in sync" twins disagree about the definition of determinism. Rule: **align on
canonical, score on raw** (whitespace-normalized, full-length hash).

**P0.3 Confidence n is mis-scaled for memoize/template/route.**
`determinism.ts:278–281`, `route.ts:202`: `wilsonLower(round(score/100 × runCount), runCount)`.
The memoize evidence base is the pairs inside multi-sample input groups (`total`), not
`runCount`; template evidence is the modal-length runs. Example: 30 runs, 15 memoize
pairs, all agree → reported Wilson(30,30)=**0.89** vs honest Wilson(15,15)=**0.80**.
Overstated exactly where the sample is thinnest.

**P0.4 Only `replace` is confidence-gated.** memoize/template/route/cache fire with no
`conf` floor: two runs with one differing token ⇒ action=`template` ("synthesize a
parameterized tool") at ~35% confidence. Gate every action (e.g. `conf ≥ 0.5`).

**P0.5 Segment maximality has a false-containment bug.** `segments.ts:103–112` checks
`key(other.labels).includes(key(c.labels))` on `'␞'`-joined strings; a match can start
mid-label. `["foo bar","baz"]` → `"foo bar␞baz"` contains `"bar␞baz"` =
`["bar","baz"]`, which is *not* a label subsequence — the shorter, genuinely-supported
segment is wrongly dropped as non-maximal. Fix: compare padded `␞x␞y␞` strings or do an
array subsequence check.

**P0.6 Agreement is compared on truncated prefixes.** Ingest trims payloads to 8,000
chars (`agent-auth.ts:43`), core compares 4,000-char `canonicalValue` prefixes, the
dashboard 300-char `canon()` prefixes. Long outputs that differ at char 301 "agree".
Compare a hash of the full stored value; keep prefixes for display only.

### P1 — signal the data already carries but the brain never uses

**P1.7 Per-step usage is parsed and discarded.** Claude transcripts carry per-assistant-
message `usage` + `model` (dedup by requestId — `transcript.ts:158–168`) but it's
aggregated into `usageByModel`; `RawStep` has no `model/tokens/durationMs`. OTLP and seed
data already have per-step tokens. Consequences: segment cost attribution is a
payload-size heuristic (`segments.ts:26–34`), and in the insights route a deterministic
*tool_use* has `estUsd = 0` (tool calls carry no tokens) so the highest-value
opportunities sort to the bottom (`route.ts:204, 222`). Add the fields, attribute a
tool call's cost to the model turn that emitted it. (Also: `route.ts:40–43`'s private
price table is stale — no fable/opus-4-8 entries → 8× underpricing — while `core/cost.ts`
is current; one more sync casualty.)

**P1.8 Dataflow edges are built and never used by the brain.** `graph.ts:91–105` computes
them; only segment separability reads them. The single biggest algorithmic upgrade
available: **slot provenance** — for each volatile slot found by `templateInfo`, search
prior nodes' outputs for the slot's value per run; if ≥90% of runs agree on
(source node, extraction), the slot is *derivable* and the step's input is mechanically
computable without an LLM. That converts "there's a hole ⟨·⟩" into "here is where the
value comes from" — i.e. an executable recipe, which is the input tool synthesis needs.

**P1.9 Taxonomy is never consulted by determinism.** A `mechanical` step (Read/Grep/
read-only bash) is deterministic-by-construction given repo state — it needs no
statistical purity proof; the only question is whether its *arguments* are derivable
(P1.8). Conversely a `side_effect` column must never auto-compile without guards. The
lattice below folds taxonomy in as a prior.

**P1.10 Subagent sidechains are invisible.** `transcript.ts:110` skips
`isSidechain` lines; Task-heavy agents hide their most repetitive loops inside
sidechains. Parse them as child runs linked to the parent.

### P2 — hygiene

- **P2.11** `cluster.ts:132` multiplies within-cluster output consistency by
  *family* modal-path share — an agent with 3 legitimate procedures can never reach the
  0.9 compile gate (`findings.ts:33`). Separate "procedure stability" from "task-mix
  routing entropy".
- **P2.12** `volatileSlots` (`cluster.ts:69–94`) uses whole-raw-value inequality — one
  timestamp anywhere marks the slot volatile; no token-level diff, no provenance.
- **P2.13** Core vs dashboard drift is already semantic (canon digits, label coarseness,
  window, prices). Stop hand-mirroring: vendor `determinism.ts` into
  `dashboard/src/lib/engine/` like the other six files, or build-step-copy it.
- **P2.14** `determinism.ts` and the insights route have **zero tests** (engine.test.ts
  covers every other module). The brain is the least-tested component.
- **P2.15** Opportunity identity is positional (`route.ts:206` key `action|label|index`)
  — ids shift across windows; merged entries keep the first cluster's confidence
  (`route.ts:208`). No persistence/accept/dismiss/measure loop.
- **P2.16** `WINDOW=40` hardcoded; no recency weighting — an agent whose code changed
  last week is scored against stale behavior.

---

## 3. The v3 algorithm

**Input:** last X runs (default 40, param) of one agent, as `RunGraph`s with per-step
`model/tokens/durationMs` (P1.7) and dataflow edges.
**Output:** per-agent opportunity list + synthesized **ToolSpecs** + replay validation
reports.

### Stage 0 — two label granularities
- `structLabel` = kind + tool name + input **schema** (sorted keys + value types only).
  Content-blind: used for alignment/clustering. (The dashboard's `label()` is already
  close to this; core's `toolLabel` is not.)
- `value` = full raw payload, whitespace-normalized, hashed full-length. Content-aware:
  used for scoring. `canonicalValue` remains for display/templates.

### Stage 1 — run similarity from sequence + DAG ("are the runs pretty much the same?")
For each pair of runs (X≤40 ⇒ ≤780 pairs, banded DP is trivial):
```
seqSim(a,b)  = 1 − levenshtein(structLabels(a), structLabels(b)) / max(len)
flowSim(a,b) = Jaccard( multiset{(structLabel_from → structLabel_to) : dataflow edges} )
sim          = 0.7·seqSim + 0.3·flowSim
```
`flowSim` is order-insensitive — it forgives benign reorderings (read A,B vs B,A) that
`seqSim` punishes; `seqSim` catches procedure identity. Cluster by complete-link
agglomeration at `sim ≥ 0.75` (tunable). Keep exact-L0 subgroups inside clusters for the
duplicate-run finding. **This replaces L2 char-3gram cosine** (which ignores order) and
answers the "same or not" question with a number per pair.

### Stage 2 — column alignment (the core upgrade)
Within a cluster, pick the **medoid** run (max Σ sim). Align every run to the medoid
with Needleman-Wunsch over `structLabel`s (match +2 / mismatch −1 / gap −1) — center-star
MSA, O(runs × len²). Result: **columns** = "the same step across runs", tolerant of
insertions/deletions. Columns with support < 50% are *optional steps* (retries, recovery
branches) → feed the `fix` findings. Per-column determinism now runs on aligned columns
instead of same-index positions of byte-identical shapes — this is what makes the brain
fire on real history, where exact repeats are rare but 90%-similar runs are the norm.

### Stage 3 — per-column determinism lattice (replaces flat score bands)
Evaluate per column, in order; confidence = Wilson lower bound **on the honest n of the
winning detector** (fixes P0.3); every action gated on `conf ≥ 0.5` (fixes P0.4):

| Level | Test | Action |
|---|---|---|
| **D0 constant** | full-value hash identical across runs (raw-normalized, not `<NUM>`-blind) | replace with constant / precompute |
| **D1 derivable** | template stable ≥0.85 AND every slot **provenance-traced**: same (source column, extraction) explains the slot value in ≥90% of runs | compile — argument is computable by code |
| **D2 pure** | memoize detector (same input ⇒ same output; n = pairs in multi-groups) **or** taxonomy = mechanical/cacheable | memoize / execute outside the LLM |
| **D3 parameterized** | template stable ≥0.85, ≥1 slot underived | parameterized tool; slot stays an argument |
| **D4 routable** | model_turn with structural stability ≥0.55 or stable output template | route to a smaller model |
| **D5 volatile** | otherwise | keep the LLM |

Provenance search (D1), cheap version: for each run, substring-search the slot's raw
value in the ≤12 preceding columns' outputs; majority-vote the (column, method) across
runs. Methods: exact substring, JSON field, line k, regex group.

### Stage 4 — SLICE: compile units
Scan the aligned column sequence for **maximal contiguous runs of columns at ≤D3** with
support ≥ threshold; require boundary cleanliness with the existing dataflow-crossing
counting (`segments.ts` separability). No 12-step cap — alignment makes long units
natural. Keep n-gram mining only for cross-cluster shared preludes (`precompute`), or
replace it with alignment across cluster medoids.

Savings model (now measurable with per-step tokens):
```
saving(unit) = Σ generation cost of the unit's model turns
             + context-carriage tax: tokens of intermediate tool_results
               × (turns remaining after the unit) × effective input price
             − residual cost of the summary the tool returns
```
The carriage term is the big one the current flat 80%/85% estimates miss: a compiled
tool runs its 5 greps *outside* the loop and returns one value, so the intermediate
outputs stop being re-read (even cache reads are 10% of input price, every turn).

### Stage 5 — SYNTHESIZE: create the tool (the deferred W4)
For every compile unit emit a deterministic **ToolSpec** (no LLM needed for the spec):
```jsonc
{
  "name": "…", "agentId": "…",
  "signature": { "params": [ /* underived slots + boundary inputs, types inferred, 3 examples each */ ] },
  "body": [ /* per column: tool, argTemplate (constants + ${param} + ${derive(col_j, method)}),
               expectedOutputTemplate, class */ ],
  "postcondition": "final column's output template",
  "evidence": { "runs": 34, "support": 0.85, "minColumnConf": 0.72, "exampleRunIds": [] },
  "guards": { "sideEffectColumns": "exact-template match + dry-run first" }
}
```
Two codegen paths:
- **Mechanical path (no LLM):** all columns mechanical/cacheable → template-instantiate a
  runnable script directly (each step is a recorded call with substitutions).
- **LLM path:** moderate/entangled units → ship the ToolSpec packet to the existing
  insights LLM layer to write idiomatic code; validation gates activation either way.

Delivery per harness: Claude Code → a generated skill/MCP tool + one CLAUDE.md line
("for procedure Y call tool X"); SDK agents → function stub + registration snippet;
the future gateway enforces at the boundary. MVP = a PR containing the tool.

### Stage 6 — VALIDATE by replay, then measure
- **Offline replay (no live execution):** for each held-out run, execute the ToolSpec's
  argument derivations against recorded prior outputs; check derived args == recorded
  args and recorded outputs match `expectedOutputTemplate`. Activate at ≥95% pass over
  ≥10 runs; keep shadow-scoring incoming runs.
- **Stable opportunity ids:** `hash(agent, unit's structLabels, action)` — dedupes across
  windows, enables persist/accept/dismiss (fixes P2.15).
- **Post-activation:** DAG-diff runs before vs after `optimized_at` — the unit's columns
  must disappear and $/run must drop; that is the honest "original vs optimized" graph.

---

## 4. Implementation order

1. **P1.7 per-step usage** (types + transcript + OTLP + seed parity) — unlocks honest $
   everywhere. Small, self-contained.
2. **P0.2/P0.6 score-on-raw + full-value hashes**; **P0.3/P0.4 honest Wilson n + gates**
   — pure fixes inside determinism.ts + route.ts, add the missing tests (P2.14) as
   fixtures first.
3. **Stage 0–2 alignment clustering** in core (`align.ts`), switch `analyzeDeterminism`
   to aligned columns; vendor into the dashboard (P2.13 — stop hand-mirroring).
4. **Stage 3 lattice + slot provenance** (`provenance.ts`) — the synthesis prerequisite.
5. **Stage 4–5 compile units + ToolSpec emission**, Insights UI renders the spec (Tool
   Synthesis view goes real).
6. **Stage 6 replay validator** + stable ids + persistence; wire `optimized_at` DAG diff.

P0.5 (segment containment) and P2.11/12 are independent one-liners/small fixes — do them
opportunistically in step 2.
