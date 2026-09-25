// VENDORED from packages/core|server (dashboard can't take workspace deps on Vercel).
/**
 * The compiled plan — what Effigent EMITS for an agent (docs/context-rent.md).
 *
 * A compiler's output is code; ours is harness configuration. Every item is a
 * concrete change to the files Claude Code reads (settings, subagents, skills),
 * priced with the rent model or the trace-replay simulator, and labelled with
 * how much evidence stands behind the price:
 *
 *   measured   — an identity over observed spend (e.g. the advisor line)
 *   simulated  — a counterfactual replay, calibrated against observed cost
 *   structural — a bound that holds IF the agent follows the change
 *                (e.g. delegating exploration); needs a before/after check
 *   needs-ab   — the mechanism is real but its size can only be learned live
 *
 * Why these items and not "compile the decisions": on held-out data, next
 * decisions are ~2% predictable and generated programs ~2% re-written — the
 * money is in the CONTEXT decisions are made in. So the plan moves context
 * (spill exploration, compact earlier, shrink the base) and packages the few
 * recurring programs/intents that do exist as deterministic skills.
 *
 * Generated file contents pass through `redactSensitive` — they are built from
 * recorded commands.
 */

import type { Run } from './types.ts';
import { pricingFor } from './cost.ts';
import { classifyBashCommand } from './taxonomy.ts';
import { redactSensitive } from './redact.ts';
import { computeLaws, type AgentLaws } from './laws.ts';
import { evaluateLoop, type LeverOutcome } from './loop.ts';
import { measurePredictability, type Predictability } from './predictability.ts';
import { detectLoops, TYPECHECK_HOOK_SCRIPT, type LoopReport } from './loops.ts';
import {
  computeRentLedger,
  recommendCompaction,
  requestsOf,
  isLegacyParse,
  type CompactionRecommendation,
  type RentLedger,
} from './rent.ts';

export type Evidence = 'measured' | 'simulated' | 'structural' | 'needs-ab';

export interface PlanFile {
  path: string;
  content: string;
  /** How to apply it (merge vs create). */
  note?: string;
}

export interface PlanItem {
  id: string;
  title: string;
  /** One plain sentence for the summary view (evidence holds the full numbers). */
  summary: string;
  /** One-paragraph evidence statement with the numbers behind it. */
  evidence: string;
  /** Savings over the analysed window, low/high; null = not priced. */
  savingsUsd: { low: number; high: number } | null;
  basis: Evidence;
  files: PlanFile[];
}

// ---- exploration spill ----------------------------------------------------------

export interface SpillEstimate {
  bursts: number;
  burstRequests: number;
  requests: number;
  /** Net savings at the measured live-out share (0.55) and at a full return (1.0). */
  netUsd: { measured: number; fullReturn: number };
}

const MIN_BURST = 3;
/** Share of a burst's findings the main thread uses afterwards — measured median 0.56 (E13b). */
const LIVE_OUT = 0.55;
const SUBAGENT_MODEL = 'claude-sonnet-5';

function readP(model: string): number {
  const p = pricingFor(model);
  return (p.inputPerM * (p.cacheReadMult ?? 0.1)) / 1e6;
}

/**
 * Price moving read-only exploration bursts (≥3 consecutive requests whose calls
 * are all mechanical) into an isolated subagent. The main thread stops paying
 * for those requests — each re-reads the whole main context to make one lookup —
 * and keeps only the findings. The subagent pays its own base (same CLAUDE.md),
 * its own growth, and the summary it generates.
 */
export function estimateExplorationSpill(runs: Run[]): SpillEstimate {
  let bursts = 0, burstRequests = 0, requests = 0;
  const net = { measured: 0, fullReturn: 0 };
  for (const run of runs) {
    const R = requestsOf(run);
    requests += R.length;
    const readOnly = R.map((r) => r.tools.length > 0 && r.tools.every((t) => t.readOnly));
    const suffix = new Array<number>(R.length + 1).fill(0);
    for (let k = R.length - 1; k >= 0; k--) suffix[k] = suffix[k + 1] + readP(R[k].model);
    const nextReset = new Array<number>(R.length).fill(R.length);
    for (let k = R.length - 2; k >= 0; k--) nextReset[k] = R[k + 1].context < 0.6 * R[k].context ? k + 1 : nextReset[k + 1];
    const sp = pricingFor(SUBAGENT_MODEL);
    let k = 0;
    while (k < R.length) {
      let e = k;
      while (e < R.length && readOnly[e]) e++;
      if (e - k >= MIN_BURST && e < R.length) {
        bursts++;
        burstRequests += e - k;
        const dep = Math.max(0, R[e].context - R[k].context);
        const end = nextReset[k];
        const carryAfter = suffix[Math.min(e + 1, end)] - suffix[end];
        let burstMain = 0;
        for (let j = k; j < e; j++) burstMain += R[j].costUsd;
        const p = pricingFor(R[k].model);
        let subBase = 0;
        let ctx = R[0].context;
        for (let j = k; j < e; j++) {
          const d = Math.max(0, R[j + 1].context - R[j].context);
          subBase += (ctx * sp.inputPerM * (sp.cacheReadMult ?? 0.1) + d * sp.inputPerM * 2 + R[j].output * sp.outputPerM) / 1e6;
          ctx += d;
        }
        for (const [key, rho] of [['measured', LIVE_OUT], ['fullReturn', 1]] as const) {
          const call = R[k].context * readP(R[k].model) + (dep * rho * p.inputPerM * 2) / 1e6 + (600 * p.outputPerM) / 1e6;
          const sub = subBase + (dep * rho * sp.outputPerM) / 1e6;
          net[key] += burstMain + dep * (1 - rho) * carryAfter - call - sub;
        }
      }
      k = Math.max(e, k + 1);
    }
  }
  return { bursts, burstRequests, requests, netUsd: net };
}

// ---- recurring programs -----------------------------------------------------------

export interface RecurringCommand {
  template: string;
  /** Most recent concrete instance (redacted). */
  example: string;
  occurrences: number;
  runs: number;
  readOnly: boolean;
  /** Varying literal slots across occurrences. */
  slots: number;
}

/**
 * Parameter slots: SHORT quoted literals (≤40 chars — a message, a branch, a
 * filter value), hex ids, and bare numbers that are not file-descriptor
 * redirections (`2>&1`) or flag values. A long quoted literal is CODE (a whole
 * `python3 -c` script, a remote ssh command) and must stay literal — slotting
 * it made unrelated commands look like "the same command 79×".
 */
const LIT = /(["'`])(?:\\.|(?!\1)[^\\\n]){0,40}\1|\b0x[0-9a-f]+\b|\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b|(?<![\w>&.-])\d+(?:\.\d+)?(?![\w>&.])/gi;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;

function scrub(cmd: string, cwd?: string): string {
  let c = redactSensitive(cmd).replace(IPV4, '<host>');
  if (cwd) c = c.split(cwd).join('${CLAUDE_PROJECT_DIR}');
  return c;
}

function stripCd(cmd: string, cwd?: string): string {
  let c = cmd.trim();
  if (cwd) c = c.replace(new RegExp(`^cd\\s+["']?${cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*(&&|;)\\s*`), '');
  return c;
}

/**
 * Commands the agent retypes across sessions: same program once literals are
 * slotted. Exact-template grouping (not fuzzy) keeps this explainable — the
 * fuzzy MinHash variant in research/ found the same top clusters.
 */
export function mineRecurringCommands(runs: Run[], opts: { minRuns?: number; minOccurrences?: number; top?: number } = {}): RecurringCommand[] {
  const groups = new Map<string, { runs: Set<string>; n: number; last: string; cwd?: string; values: Set<string> }>();
  for (const run of runs) {
    for (const s of run.steps) {
      if (s.kind !== 'tool_use' || s.name !== 'Bash') continue;
      let cmd = '';
      try { cmd = String((JSON.parse(s.payload) as { command?: string }).command ?? ''); } catch { continue; }
      cmd = stripCd(cmd, run.cwd);
      if (cmd.length < 40 || cmd.includes('<<') || /\b(python3?|node)\s+-[ce]\b/.test(cmd)) continue; // inline scripts are code, not commands
      const template = cmd.replace(LIT, '⟨·⟩').replace(/\s+/g, ' ');
      const g = groups.get(template) ?? { runs: new Set<string>(), n: 0, last: '', values: new Set<string>() };
      g.runs.add(run.runId);
      g.n++;
      g.last = cmd;
      g.cwd = run.cwd;
      g.values.add(cmd);
      groups.set(template, g);
    }
  }
  return [...groups.entries()]
    .filter(([, g]) => g.runs.size >= (opts.minRuns ?? 3) && g.n >= (opts.minOccurrences ?? 4))
    // a template that is mostly slots (`sed -n ⟨·⟩ ⟨·⟩`) is a primitive, not a program
    .filter(([template]) => template.replace(/⟨·⟩/g, '').replace(/\s+/g, '').length >= 25)
    .map(([template, g]) => ({
      template: scrub(template, g.cwd),
      example: scrub(g.last, g.cwd),
      occurrences: g.n,
      runs: g.runs.size,
      readOnly: classifyBashCommand(g.last) !== 'side_effect',
      slots: g.values.size > 1 ? (template.match(/⟨·⟩/g) ?? []).length : 0,
    }))
    .sort((a, b) => b.occurrences * b.template.length - a.occurrences * a.template.length)
    .slice(0, opts.top ?? 5);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'command';
}

function commandSkill(c: RecurringCommand, taken: Set<string>): PlanFile {
  const core = c.example.replace(/^(cd\s+\S+\s*(&&|;)\s*)+/, '');
  const words = core.split(/\s+/).filter((w) => /^[a-z][\w:-]*$/i.test(w)).slice(0, 3);
  let name = slug(words.join(' '));
  for (let i = 2; taken.has(name); i++) name = `${slug(words.join(' ')).slice(0, 36)}-${i}`;
  taken.add(name);
  const body = c.readOnly && c.slots === 0
    ? [
        `Current output, captured deterministically when the skill loads:`,
        '',
        '```',
        `!\`${c.example}\``,
        '```',
        '',
        'Answer from this output. Do not re-run the command unless asked.',
      ]
    : [
        'Run exactly this command (recorded across sessions; only the ⟨·⟩ slots vary):',
        '',
        '```',
        c.template,
        '```',
        '',
        `Last concrete run: \`${c.example}\``,
        '',
        'Fill the slots from $ARGUMENTS. Do not explore alternatives first.',
      ];
  return {
    path: `.claude/skills/${name}/SKILL.md`,
    note: `create · seen ${c.occurrences}× across ${c.runs} sessions${c.readOnly ? '' : ' · side effect — manual invocation only'}`,
    content: [
      '---',
      `name: ${name}`,
      `description: ${c.readOnly ? 'Deterministic' : 'Recorded'} project command (${words.join(' ')}), extracted by Effigent from ${c.occurrences} runs in ${c.runs} sessions.`,
      ...(c.readOnly ? [] : ['disable-model-invocation: true']),
      '---',
      '',
      ...body,
      '',
    ].join('\n'),
  };
}

// ---- the recurring "ship" intent ------------------------------------------------

const SHIP_ASK = /^\s*(please\s+)?(commit|push|deploy)\b[\w\s,&]{0,50}$/i;

function shipStats(runs: Run[]): { episodes: number; runs: number; costUsd: number; requests: number } {
  let episodes = 0, cost = 0, reqs = 0;
  const inRuns = new Set<string>();
  for (const run of runs) {
    const R = requestsOf(run);
    // request index at which each user turn arrived
    let reqIdx = -1;
    const askAt: { k: number; text: string }[] = [];
    for (const s of run.steps) {
      if (s.tokens && s.model) reqIdx++;
      else if (s.kind === 'model_turn' && s.name === 'user') askAt.push({ k: reqIdx + 1, text: s.payload });
    }
    askAt.forEach((a, i) => {
      if (!SHIP_ASK.test(a.text)) return;
      const end = askAt[i + 1]?.k ?? R.length;
      episodes++;
      inRuns.add(run.runId);
      for (let k = a.k; k < end && k < R.length; k++) { cost += R[k].costUsd; reqs++; }
    });
  }
  return { episodes, runs: inRuns.size, costUsd: cost, requests: reqs };
}

// ---- the plan ------------------------------------------------------------------------

export interface AgentAnalysis {
  agentId: string;
  runs: number;
  /** Runs in the window parsed by the old parser — excluded from every context figure. */
  legacyRuns: number;
  costUsd: number;
  spend: RentLedger['spend'];
  rent: { baseUsd: number; byKind: RentLedger['rent']['byKind']; byTool: Record<string, number> };
  calibration: number;
  coldRewrites: RentLedger['coldRewrites'];
  instructionsTokens: number;
  compaction: CompactionRecommendation;
  spill: SpillEstimate;
  recurring: RecurringCommand[];
  /** The per-agent laws: reason mix, session law + EOQ, cost drivers, expensive sessions. */
  laws: AgentLaws;
  /** Levers detected as adopted in this window, with before/after verdicts. */
  loop: LeverOutcome[];
  /**
   * Determinism, measured on later sessions: how predictable the agent's decisions
   * are from its own history — by reason (what a request was for) and by action.
   */
  determinism: { reason: Predictability | null; action: Predictability | null };
  /** Procedural loops inside runs, and the verify-after-edit rule (loops.ts). */
  loops: LoopReport;
  plan: PlanItem[];
}

const usd = (v: number) => `$${v.toFixed(v < 10 ? 2 : 0)}`;

export function analyzeAgent(agentId: string, allRuns: Run[]): AgentAnalysis {
  // Context analysis only on runs with a true per-request context (see isLegacyParse);
  // command/intent mining works on any parse.
  const runs = allRuns.filter((r) => !isLegacyParse(r));
  const legacyRuns = allRuns.length - runs.length;
  const ledgers = runs.map((r) => computeRentLedger(r));
  const sum = (f: (l: RentLedger) => number) => ledgers.reduce((s, l) => s + f(l), 0);
  const spend = {
    outputUsd: sum((l) => l.spend.outputUsd),
    thinkingUsd: sum((l) => l.spend.thinkingUsd),
    cacheReadUsd: sum((l) => l.spend.cacheReadUsd),
    cacheWriteUsd: sum((l) => l.spend.cacheWriteUsd),
    uncachedUsd: sum((l) => l.spend.uncachedUsd),
    sideModelUsd: sum((l) => l.spend.sideModelUsd),
    subagentUsd: sum((l) => l.spend.subagentUsd),
  };
  const byKind = { thinking: 0, output: 0, tool_result: 0, user: 0, harness: 0 };
  const byTool: Record<string, number> = {};
  for (const l of ledgers) {
    for (const k of Object.keys(byKind) as (keyof typeof byKind)[]) byKind[k] += l.rent.byKind[k];
    for (const [t, v] of Object.entries(l.rent.byTool)) byTool[t] = (byTool[t] ?? 0) + v;
  }
  const baseUsd = sum((l) => l.rent.baseUsd);
  const rentTotal = baseUsd + Object.values(byKind).reduce((s, v) => s + v, 0);
  const costUsd = runs.reduce((s, r) => s + r.costUsd, 0);
  const laws = computeLaws(allRuns);
  // The EOQ threshold is a candidate; the simulator must still confirm it in the worst case.
  const compaction = recommendCompaction(runs, laws.law ? [laws.law.eoqThreshold] : []);
  const spill = estimateExplorationSpill(runs);
  const recurring = mineRecurringCommands(allRuns);
  const ship = shipStats(allRuns);

  // instruction files: the largest CLAUDE.md set seen, priced as base rent share
  const instrChars = Math.max(0, ...runs.map((r) => (r.instructions ?? []).reduce((s, f) => s + f.chars, 0)));
  const instructionsTokens = Math.round(instrChars / 3.6);
  const reqsTotal = ledgers.reduce((s, l) => s + l.requests, 0);
  let instrRent = 0;
  for (const run of runs) {
    const t = (run.instructions ?? []).reduce((s, f) => s + f.chars, 0) / 3.6;
    if (!t) continue;
    for (const r of requestsOf(run)) instrRent += t * readP(r.model);
  }

  const plan: PlanItem[] = [];

  if (legacyRuns > 0 && runs.length === 0) {
    plan.push({
      id: 'recapture',
      title: 'Re-upload these sessions to unlock context analysis',
      summary: 'These sessions were captured before context size was recorded. Run `effigent sync --force --days 90` on the agent’s machine.',
      evidence: `All ${legacyRuns} sessions in this window were captured before the 2026-09 parser, which did not record each request's true context size — so rent, compaction and exploration figures would be noise and are withheld. Run \`effigent sync --force --days 90\` on the machine that ran the agent to re-upload them with the current CLI (raw transcripts are not kept server-side; the server replaces its copy).`,
      savingsUsd: null,
      basis: 'measured',
      files: [],
    });
  }

  if (spill.bursts >= 3 && spill.netUsd.fullReturn > 0) {
    plan.push({
      id: 'spill-exploration',
      title: 'Run exploration in an isolated scout subagent',
      summary: `${Math.round((100 * spill.burstRequests) / Math.max(1, spill.requests))}% of requests are lookups made from the full conversation; a scout subagent makes them from a small one and hands back only the findings.`,
      evidence: `${spill.burstRequests} of ${spill.requests} requests (${Math.round((100 * spill.burstRequests) / Math.max(1, spill.requests))}%) are read-only exploration bursts (${spill.bursts} bursts of ≥${MIN_BURST}) issued from the main context — each lookup re-reads the whole conversation. In a subagent the same lookups read a small context and only the findings come back. Net ${usd(spill.netUsd.fullReturn)}–${usd(spill.netUsd.measured)} (returning 100% vs the measured 55% of findings), after paying the subagent. Holds if the agent actually delegates — verify with a before/after window.`,
      savingsUsd: { low: spill.netUsd.fullReturn, high: spill.netUsd.measured },
      basis: 'structural',
      files: [
        {
          path: '.claude/agents/scout.md',
          note: 'create',
          content: [
            '---',
            'name: scout',
            'description: Read-only codebase and log exploration. Use PROACTIVELY whenever answering needs 3+ reads/greps/log queries — it returns only the findings, keeping the main conversation small.',
            'tools: Read, Grep, Glob, Bash',
            `model: ${SUBAGENT_MODEL.includes('sonnet') ? 'sonnet' : 'inherit'}`,
            '---',
            '',
            'You investigate and report; you never edit files, commit, deploy or run mutating commands.',
            '',
            'Return only what the caller needs to act: file:line references, the minimal excerpts that',
            'answer the question, and one line on anything surprising. No narration of your search.',
            '',
          ].join('\n'),
        },
        {
          path: 'CLAUDE.md',
          note: 'append one line',
          content: '- Delegate any investigation that needs 3+ reads, greps or log queries to the `scout` subagent; act on its findings instead of reading the files yourself.\n',
        },
      ],
    });
  }

  // Where the harness compacts ON ITS OWN today. Claude Code's automatic window varies by
  // model, version and server-side experiment (observed: ~500k on some 1M-context sessions,
  // none up to 650k+ on others), so it is measured, never assumed — from the requests (the
  // context just before each drop): compact_boundary's own preTokens read ~2× the request
  // context on real sessions. When the harness already compacts MOST sessions that reach
  // T, recommending T is recommending nothing, and loop.ts would read the harness as an
  // adoption; when only some, the replay above already prices the ones that still exceed T.
  const T0 = compaction.threshold ?? 0;
  const resetsOf = (r: Run) => { const R = requestsOf(r); const at: number[] = []; for (let k = 1; k < R.length; k++) if (R[k].context < 0.6 * R[k - 1].context) at.push(R[k - 1].context); return at; };
  const autoCompacted = (r: Run) => (r.events ?? []).some((e) => e.kind === 'compact' && e.detail === 'auto');
  const autoAt = allRuns.filter(autoCompacted).flatMap(resetsOf).sort((a, b) => a - b);
  const nativeAt = autoAt.length >= 3 ? autoAt[autoAt.length >> 1] : null;
  const reachT = T0 ? runs.filter((r) => requestsOf(r).some((x) => x.context >= 0.8 * T0)) : [];
  const compactedNearT = reachT.filter((r) => autoCompacted(r) && resetsOf(r).some((c) => c >= 0.8 * T0 && c <= 1.25 * T0));
  const harnessCompactsThere = reachT.length >= 3 && compactedNearT.length >= 0.5 * reachT.length;
  if (runs.length > 0 && compaction.threshold && !harnessCompactsThere) {
    const window = Math.max(...ledgers.map((l) => l.peakContext)) > 200_000 ? 1_000_000 : 200_000;
    const pct = Math.max(10, Math.min(95, Math.round((100 * compaction.threshold) / window)));
    // Claude Code's CLAUDE_CODE_AUTO_COMPACT_WINDOW takes tokens (100k–1M) and is capped at
    // the model's window; CLAUDE_AUTOCOMPACT_PCT_OVERRIDE is a share of whatever window the
    // model has, so "20" is 200k on a 1M model but 40k on a 200k one.
    const absolute = compaction.threshold >= 100_000 && compaction.threshold <= 1_000_000;
    const low = compaction.savingsUsd[0]?.usd ?? 0;
    const high = compaction.savingsUsd[compaction.savingsUsd.length - 1]?.usd ?? 0;
    plan.push({
      id: 'compact-earlier',
      title: nativeAt && nativeAt > 1.1 * compaction.threshold
        ? `Compact at ${Math.round(compaction.threshold / 1000)}k tokens instead of ~${Math.round(nativeAt / 1000)}k, where it compacts now`
        : nativeAt
          ? `Compact every long session at ${Math.round(compaction.threshold / 1000)}k tokens (today ${compactedNearT.length} of ${reachT.length} compact there on their own)`
          : `Compact at ${Math.round(compaction.threshold / 1000)}k tokens instead of the ~${window >= 1_000_000 ? '1M' : `${window / 1000}k`} default`,
      summary: laws.law
        ? `${Math.round(100 * laws.law.aboveThresholdShare)}% of re-reading happens above ${Math.round(laws.law.eoqThreshold / 1000)}k tokens. Replaying every session, compacting at ${Math.round(compaction.threshold / 1000)}k saved money in all re-exploration scenarios measured.`
        : `Replaying every session, compacting at ${Math.round(compaction.threshold / 1000)}k saved money in all re-exploration scenarios measured.`,
      evidence: `${laws.law ? `Session cost here follows cost ≈ p·(B·N + d·N²/2) (fit R² ${laws.law.fitR2.toFixed(2)}; base ${Math.round(laws.law.baseTokens / 1000)}k, +${laws.law.depositPerRequest} tokens/request), so long sessions are priced quadratically; ${Math.round(100 * laws.law.aboveThresholdShare)}% of re-reading happens above the economic compaction point (EOQ: ${Math.round(laws.law.eoqThreshold / 1000)}k, one compaction ≈ ${usd(laws.law.compactionCostUsd)}). ` : ''}Trace-replay of ${runs.length} sessions (simulator reproduces observed cost at ${(100 * compaction.calibratedUsd / Math.max(1e-9, compaction.observedUsd)).toFixed(1)}%) picks ${Math.round(compaction.threshold / 1000)}k: the threshold with the best expected savings that still saves money in every measured re-exploration scenario (${usd(low)} worst case, ${usd(high)} typical)${laws.law && Math.abs(laws.law.eoqThreshold - compaction.threshold) > 50_000 ? `. It sits above the EOQ point because compacting at ${Math.round(laws.law.eoqThreshold / 1000)}k loses money if re-exploration is at the costly end` : ''}. Not additive with the scout item (fewer sessions reach the threshold once exploration moves out). The simulator cannot see answer quality after compaction.`,
      savingsUsd: { low, high },
      basis: 'simulated',
      files: [
        {
          path: '.claude/settings.json',
          note: absolute
            ? 'merge into "env" · an absolute window, capped at the model\'s own — a teammate on a smaller-context model is unaffected; use .claude/settings.local.json to keep it personal'
            : `merge into "env" · a percentage of a ${window / 1000}k-token window (the absolute CLAUDE_CODE_AUTO_COMPACT_WINDOW accepts 100k–1M only); on a different window set it to ${Math.round(compaction.threshold / 1000)}k ÷ window`,
          content: JSON.stringify({ env: absolute ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(Math.round(compaction.threshold / 1000) * 1000) } : { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(pct) } }, null, 2) + '\n',
        },
      ],
    });
  }

  // The verify rule: the agent re-runs its checker after edits; most runs come back clean.
  const loops = detectLoops(allRuns);
  const tsc = loops.verify.find((v) => v.verifier === 'tsc');
  if (tsc && tsc.reverifies >= 10 && tsc.cleanCostUsd >= 0.03 * costUsd) {
    const cleanShare = tsc.clean / Math.max(1, tsc.reverifies);
    plan.push({
      id: 'verify-hook',
      title: 'Type-check automatically after edits instead of asking the model to',
      summary: `${Math.round(cleanShare * 100)}% of the ${tsc.reverifies} type checks the agent ran after an edit came back clean — each one a full-context request just to decide to run it. A hook runs the check and speaks only when there are errors.`,
      evidence: `After an edit the agent re-ran tsc ${tsc.reverifies} times (usually \`${tsc.topCommand.slice(0, 60)}\`). ${tsc.clean} came back with no errors (${usd(tsc.cleanCostUsd)} of requests that confirmed nothing); ${tsc.found} found errors. Clean vs failed is read from the output, because \`| head\` hides the exit code. A PostToolUse hook runs the check after every TypeScript edit, stays silent when clean and hands errors straight back, so the model no longer spends a request deciding to verify. Holds if the agent follows the CLAUDE.md line — confirm with a before/after window.`,
      savingsUsd: { low: tsc.cleanCostUsd * 0.5, high: tsc.reverifyCostUsd * 0.9 },
      basis: 'structural',
      files: [
        { path: '.claude/hooks/typecheck-after-edit.sh', note: 'create, then chmod +x', content: TYPECHECK_HOOK_SCRIPT },
        {
          path: '.claude/settings.json',
          note: 'merge into "hooks" · the check runs after every TS edit; on a large project add --incremental to tsconfig',
          content: JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/typecheck-after-edit.sh', timeout: 120 }] }] } }, null, 2) + '\n',
        },
        { path: 'CLAUDE.md', note: 'append one line', content: '- Type checking runs automatically after every TypeScript edit (a hook) and shows you any errors. Do not run tsc yourself unless asked.\n' },
      ],
    });
  }

  if (runs.length > 0 && spend.sideModelUsd > 0.05 * costUsd) {
    plan.push({
      id: 'advisor-cost',
      title: 'Advisor calls are an uncached second model',
      summary: `${Math.round((100 * spend.sideModelUsd) / Math.max(1e-9, costUsd))}% of spend went to advisor calls, which re-send the transcript to a second model without caching.`,
      evidence: `${usd(spend.sideModelUsd)} (${Math.round((100 * spend.sideModelUsd) / Math.max(1e-9, costUsd))}% of spend) is usage outside the main requests — on Claude Code, advisor-tool iterations, which re-send the transcript to the advisor model with no cache reads. Whether the second opinion is worth it is your call; the setting is \`advisorModel\`.`,
      savingsUsd: null,
      basis: 'measured',
      files: [],
    });
  }

  if (instructionsTokens > 20_000) {
    plan.push({
      id: 'shrink-instructions',
      title: `CLAUDE.md is ${Math.round(instructionsTokens / 1000)}k tokens, re-read on every request`,
      summary: `Re-reading CLAUDE.md on every request cost ${usd(instrRent)} (${Math.round((100 * instrRent) / Math.max(1e-9, costUsd))}% of spend). Keep an index in it and move rarely needed sections out, then compare a week before and after.`,
      evidence: `Instruction files are part of the base context: ${usd(instrRent)} of rent over ${reqsTotal} requests (${Math.round((100 * instrRent) / Math.max(1e-9, costUsd))}% of spend). Moving rarely-needed sections behind an index (or a UserPromptSubmit hook that injects only matching entries) removes most of it — but which entries the agent silently relies on is only learnable live: run it as an A/B on a window of sessions.`,
      savingsUsd: null,
      basis: 'needs-ab',
      files: [],
    });
  }

  const skillNames = new Set<string>();
  for (const c of recurring.slice(0, 3)) {
    plan.push({
      id: `command-${slug(c.template).slice(0, 24)}`,
      title: `Package a recurring command as a skill (${c.occurrences}× in ${c.runs} sessions)`,
      summary: `The agent retyped \`${c.template.slice(0, 60)}${c.template.length > 60 ? '…' : ''}\` ${c.occurrences} times; a skill runs it the same way every time.`,
      evidence: `The agent retyped this command ${c.occurrences} times across ${c.runs} sessions${c.slots ? `, varying only ${c.slots} literal slot(s)` : ', identically'}. ${c.readOnly && !c.slots ? 'It is read-only, so the skill runs it deterministically at load (`!` injection) — no model tool call.' : 'It has side effects, so the skill is manual-invocation only.'} Small in dollars; it removes rediscovery.`,
      savingsUsd: null,
      basis: 'measured',
      files: [commandSkill(c, skillNames)],
    });
  }

  if (ship.episodes >= 5 && ship.runs >= 3) {
    plan.push({
      id: 'ship-skill',
      title: `"Commit, push and deploy" is a recurring intent (${ship.episodes}×)`,
      summary: `${ship.episodes} asks to commit, push or deploy took ${(ship.requests / ship.episodes).toFixed(1)} requests each, with a different improvised sequence almost every time; a ship skill makes it about two.`,
      evidence: `${ship.episodes} episodes across ${ship.runs} sessions asked to commit/push/deploy — ${usd(ship.costUsd)} total, ${(ship.requests / ship.episodes).toFixed(1)} requests each, and the agent improvised a different command sequence almost every time. A skill that injects the repo state deterministically and fixes the procedure turns ~${Math.round(ship.requests / ship.episodes)} requests into ~2. Edit the deploy step to your project's real command.`,
      savingsUsd: { low: ship.costUsd * 0.5, high: ship.costUsd * (1 - 2 / Math.max(2, ship.requests / ship.episodes)) },
      basis: 'structural',
      files: [
        {
          path: '.claude/skills/ship/SKILL.md',
          note: 'create — then replace the deploy line with the project command',
          content: [
            '---',
            'name: ship',
            'description: Commit, push and deploy the current work in one pass.',
            'disable-model-invocation: true',
            '---',
            '',
            'Repo state (captured deterministically):',
            '',
            '```',
            '!`git status --short`',
            '!`git diff --stat HEAD`',
            '!`git log --oneline -5`',
            '```',
            '',
            '1. Write one commit message from the diff above; commit everything listed.',
            '2. `git push`.',
            '3. Deploy: `<your deploy command>`.',
            '4. Report the pushed commit and the deploy result in two lines. Do not re-inspect the repo.',
            '',
          ].join('\n'),
        },
      ],
    });
  }

  return {
    agentId,
    runs: runs.length,
    legacyRuns,
    costUsd,
    spend,
    rent: { baseUsd, byKind, byTool },
    calibration: spend.cacheReadUsd > 0 ? rentTotal / spend.cacheReadUsd : 1,
    coldRewrites: { count: sum((l) => l.coldRewrites.count), penaltyUsd: sum((l) => l.coldRewrites.penaltyUsd) },
    instructionsTokens,
    compaction,
    spill,
    recurring,
    laws,
    // no compaction fingerprint to look for when the harness itself compacts at T
    loop: evaluateLoop(allRuns, { threshold: harnessCompactsThere ? undefined : compaction.threshold ?? undefined }),
    determinism: { reason: measurePredictability(allRuns, 'reason'), action: measurePredictability(allRuns, 'action') },
    loops,
    plan,
  };
}
