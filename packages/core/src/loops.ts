/**
 * Loops inside runs — the procedures an agent repeats within one session.
 *
 * Measured on 292 real sessions (docs/context-rent.md, E22–E25):
 *
 *   - Step-by-step, sessions are NOT loop-like: a predictor that also learns from
 *     the current session as it unfolds predicts ~0.1% of next actions at ≥0.8.
 *   - Naive tandem repeats ("edit, edit, edit") are the work itself, not a
 *     procedure — they are excluded.
 *   - The procedural loops that do exist are small: paging through one file in
 *     slices, the same command per item (collection), a failed command re-run
 *     unchanged (retry), and status polling — ~1.4% of spend together.
 *   - The verify rule: after editing, run the check. Counting only requests that
 *     do NOTHING but run a check (chained `edit && tsc` commands cost no extra
 *     request): 1,083 re-checks after an edit, 60% clean — $118 (1.3% of spend)
 *     that only confirmed "no errors", $229 (2.4%) in all. On this traffic the
 *     agent already chains most checks onto its edits; on agents that don't, a
 *     hook takes the decision: run the check after edits, stay silent when clean,
 *     hand errors straight back.
 *
 * Clean vs failed is judged from the OUTPUT (`error TS`, `N failed`, …): agents
 * pipe checks through `| head`, which masks the exit code.
 */

import type { Run } from './types.js';
import { requestsOf, isLegacyParse, type RentRequest } from './rent.js';

export type LoopKind = 'paging' | 'collection' | 'retry' | 'poll';

export interface LoopPattern {
  kind: LoopKind;
  /** Normalized command template, or the file being paged through. */
  template: string;
  /** Occurrences (loops) across the window, and in how many sessions. */
  loops: number;
  sessions: number;
  iterations: number;
  costUsd: number;
  /** What one tool call instead of k LLM requests would save (80% of the extra requests). */
  savingsUsd: number;
}

export interface VerifierStats {
  verifier: string;
  /** Checks run after an edit (the agent's own decision to re-verify). */
  reverifies: number;
  clean: number;
  found: number;
  cleanCostUsd: number;
  reverifyCostUsd: number;
  /** The command the agent used most for this verifier (normalized). */
  topCommand: string;
}

export interface LoopReport {
  patterns: LoopPattern[];
  verify: VerifierStats[];
  totalLoopUsd: number;
}

const VERIFIERS: { name: string; run: RegExp; failed: RegExp }[] = [
  { name: 'tsc', run: /\btsc\b/, failed: /error TS\d+/ },
  { name: 'vitest', run: /\bvitest\b/, failed: /\b\d+ failed\b|\bFAIL\b/ },
  { name: 'jest', run: /\bjest\b/, failed: /\b\d+ failed\b|\bFAIL\b/ },
  { name: 'pytest', run: /\bpytest\b/, failed: /\b\d+ (failed|errors?)\b/ },
  { name: 'eslint', run: /\beslint\b/, failed: /\b\d+ (problems?|errors?)\b|✖/ },
  { name: 'test', run: /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/, failed: /\bfailed\b|\bFAIL\b|\bfailing\b/ },
  { name: 'build', run: /\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b/, failed: /\berror\b|Failed to compile/i },
];
const WAIT = /\bsleep\s+\d|\bgh run (watch|view|list)\b|\bkubectl (get|rollout status)\b|--follow\b|\bcurl\b[^|]*\b(health|status)\b/;

const stripNav = (c: string) => c.replace(/^(\s*(cd|export)\s+[^&;\n]+(&&|;)\s*)+/, '').trim();
const template = (c: string) => c
  .replace(/(["'])(?:\\.|(?!\1)[^\\\n]){0,40}\1/g, '⟨s⟩')
  .replace(/\b[0-9a-f]{7,}\b/gi, '⟨h⟩')
  .replace(/(?<![\w>&])\d+(?![\w>&])/g, '⟨n⟩')
  .replace(/\s+/g, ' ')
  .slice(0, 140);
const isEdit = (t: RentRequest['tools'][number]) =>
  ['Edit', 'Write', 'MultiEdit'].includes(t.name) || /\bsed\s+-i\b|python3? - <</.test(t.command ?? '');
function pageTarget(t: RentRequest['tools'][number]): string | null {
  if (t.name === 'Read' && t.filePath) return t.filePath;
  const m = stripNav(t.command ?? '').match(/^(?:sed -n\s+['"]?\d+,\d+p['"]?|head -n?\s*\d+|tail -n?\s*\+?\d+)\s+(\S+)/);
  return m ? m[1] : null;
}

interface Call { req: number; t: RentRequest['tools'][number]; cmd: string; tpl: string }

export function detectLoops(allRuns: Run[]): LoopReport {
  const runs = allRuns.filter((r) => !isLegacyParse(r));
  const pat = new Map<string, LoopPattern & { sessionIds: Set<string> }>();
  const verify = new Map<string, VerifierStats & { commands: Map<string, number> }>();
  let totalLoopUsd = 0;

  const record = (kind: LoopKind, key: string, runId: string, R: RentRequest[], reqs: number[], iterations: number) => {
    const uniq = [...new Set(reqs)];
    const cost = uniq.reduce((s, i) => s + R[i].costUsd, 0);
    const extra = cost - cost / Math.max(1, uniq.length);
    const p = pat.get(`${kind}|${key}`) ?? { kind, template: key, loops: 0, sessions: 0, iterations: 0, costUsd: 0, savingsUsd: 0, sessionIds: new Set<string>() };
    p.loops++; p.iterations += iterations; p.costUsd += cost; p.savingsUsd += extra * 0.8; p.sessionIds.add(runId);
    pat.set(`${kind}|${key}`, p);
    totalLoopUsd += cost;
  };

  for (const run of runs) {
    const R = requestsOf(run);
    const calls: Call[] = [];
    R.forEach((r, i) => r.tools.forEach((t) => {
      const cmd = stripNav(t.command ?? '');
      calls.push({ req: i, t, cmd, tpl: t.command != null ? template(cmd) : `${t.name}:${t.filePath ?? ''}` });
    }));
    const used = new Set<number>();
    const near = (a: number, b: number, gap: number) => calls[b].req - calls[a].req <= gap;

    // paging: ≥3 reads of the same file close together
    for (let a = 0; a < calls.length; a++) {
      const f = pageTarget(calls[a].t);
      if (!f || used.has(a)) continue;
      const seq = [a];
      for (let b = a + 1; b < calls.length && near(seq[seq.length - 1], b, 2); b++) if (pageTarget(calls[b].t) === f) seq.push(b);
      if (seq.length >= 3) { seq.forEach((x) => used.add(x)); record('paging', f.split('/').slice(-2).join('/'), run.runId, R, seq.map((x) => calls[x].req), seq.length); }
    }
    // retry: a failed command re-run unchanged
    for (let a = 0; a < calls.length; a++) {
      if (used.has(a) || !calls[a].t.isError || !calls[a].cmd) continue;
      const seq = [a];
      for (let b = a + 1; b < calls.length && near(seq[seq.length - 1], b, 2); b++) if (calls[b].cmd === calls[a].cmd) { seq.push(b); if (!calls[b].t.isError) break; }
      if (seq.length >= 2) { seq.forEach((x) => used.add(x)); record('retry', calls[a].tpl, run.runId, R, seq.map((x) => calls[x].req), seq.length); }
    }
    // poll: a wait-like command repeated ≥3 times close together
    const byTpl = new Map<string, number[]>();
    calls.forEach((c, x) => { if (c.t.command != null && !used.has(x)) (byTpl.get(c.tpl) ?? byTpl.set(c.tpl, []).get(c.tpl)!).push(x); });
    for (const [tpl, xs] of byTpl) {
      if (!WAIT.test(calls[xs[0]].cmd)) continue;
      let seq = [xs[0]];
      const flush = () => { if (seq.length >= 3) { seq.forEach((x) => used.add(x)); record('poll', tpl, run.runId, R, seq.map((x) => calls[x].req), seq.length); } };
      for (let j = 1; j < xs.length; j++) { if (near(seq[seq.length - 1], xs[j], 3)) seq.push(xs[j]); else { flush(); seq = [xs[j]]; } }
      flush();
    }
    // collection: ≥3 consecutive commands sharing a template with different arguments, no errors, not edits
    for (let a = 0; a < calls.length; a++) {
      const c = calls[a];
      if (used.has(a) || c.t.command == null || isEdit(c.t) || c.t.isError) continue;
      const seq = [a];
      for (let b = a + 1; b < calls.length && near(seq[seq.length - 1], b, 2); b++) {
        if (used.has(b)) break;
        if (calls[b].tpl === c.tpl && !calls[b].t.isError) seq.push(b); else if (calls[b].t.command != null) break;
      }
      if (seq.length >= 3 && new Set(seq.map((x) => calls[x].cmd)).size >= Math.ceil(seq.length * 0.7)) {
        seq.forEach((x) => used.add(x)); record('collection', c.tpl, run.runId, R, seq.map((x) => calls[x].req), seq.length);
      }
    }
    // the verify rule: checks re-run after an edit, and whether they found anything
    // Only CHECK-ONLY requests count: a command that edits and then type-checks in one call
    // (`python3 - <<PY … PY && npx tsc`) costs no extra request, so a hook would save nothing
    // there. Counting those inflated this 4.6× on real traffic (2,820 → 1,083 re-checks).
    const editedSince = new Set<string>();
    for (const r of R) {
      const hasEdit = r.tools.some(isEdit);
      const ran = new Set<string>();
      for (const t of r.tools) { const v = VERIFIERS.find((x) => x.run.test(t.command ?? '')); if (v) ran.add(v.name); }
      if (hasEdit) {
        for (const v of VERIFIERS) if (!ran.has(v.name)) editedSince.add(v.name); // a chained check covers its own edit
        for (const v of ran) editedSince.delete(v);
        continue;
      }
      const counted = new Set<string>();
      for (const t of r.tools) {
        const cmd = t.command ?? '';
        const v = VERIFIERS.find((x) => x.run.test(cmd));
        if (!v || counted.has(v.name)) continue;
        counted.add(v.name);
        if (!editedSince.has(v.name)) continue;
        const st = verify.get(v.name) ?? { verifier: v.name, reverifies: 0, clean: 0, found: 0, cleanCostUsd: 0, reverifyCostUsd: 0, topCommand: '', commands: new Map<string, number>() };
        st.reverifies++; st.reverifyCostUsd += r.costUsd;
        const out = t.resultHead ?? '';
        if (v.failed.test(out) || t.isError) st.found++;
        else if (out.trim().length < 400) { st.clean++; st.cleanCostUsd += r.costUsd; }
        const tc = template(stripNav(cmd));
        st.commands.set(tc, (st.commands.get(tc) ?? 0) + 1);
        verify.set(v.name, st);
      }
      for (const v of ran) editedSince.delete(v);
    }
  }

  const patterns = [...pat.values()]
    .map(({ sessionIds, ...p }) => ({ ...p, sessions: sessionIds.size }))
    .sort((a, b) => b.costUsd - a.costUsd);
  const verifyOut = [...verify.values()]
    .map(({ commands, ...v }) => ({ ...v, topCommand: [...commands.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '' }))
    .sort((a, b) => b.cleanCostUsd - a.cleanCostUsd);
  return { patterns, verify: verifyOut, totalLoopUsd };
}

/**
 * The hook that takes the verify decision away from the model: after an edit to a
 * TypeScript file, type-check the nearest tsconfig project; silent when clean,
 * errors go back to Claude (exit 2 on PostToolUse shows stderr to the model).
 */
export const TYPECHECK_HOOK_SCRIPT = `#!/usr/bin/env bash
# Effigent: type-check after every TypeScript edit. Silent when clean; errors go back to Claude.
# Generated from your sessions: most re-checks after an edit came back clean, and each one
# cost a full-context request just to decide to run it.
file=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.tool_input?.file_path??"")}catch{}})')
case "$file" in *.ts|*.tsx|*.mts|*.cts) ;; *) exit 0 ;; esac
dir=$(dirname "$file")
while [ "$dir" != "/" ] && [ ! -f "$dir/tsconfig.json" ]; do dir=$(dirname "$dir"); done
[ -f "$dir/tsconfig.json" ] || exit 0
out=$(cd "$dir" && npx --no-install tsc --noEmit --pretty false 2>&1 | head -40)
if printf '%s' "$out" | grep -q "error TS"; then
  printf 'Type errors after editing %s (project %s):\\n%s\\n' "$file" "$dir" "$out" >&2
  exit 2
fi
exit 0
`;
