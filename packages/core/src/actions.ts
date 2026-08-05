/**
 * The semantic action alphabet — the missing middle zoom level of the run IR.
 *
 * The engine has two granularities today and both fail on real traffic:
 *   - structLabel (tool + arg SCHEMA) is too coarse: on a measured dev agent
 *     ~70% of tool calls are Bash and every one of them shares the single label
 *     `tool:Bash(command:s,description:s)` — git commit, pnpm test and cat all
 *     look identical, so alignment/segment/subtree miners see no structure;
 *   - valueHash (full raw payload) is too fine: across 40 real runs, 3,900
 *     calls produced 2 exact repeats — nothing ever matches.
 *
 * The action token sits between them: WHAT the call does, not its exact data.
 * `cd repo && pnpm test` → `pnpm:test`; `git add -A && git commit -m "…"` →
 * `git:add+git:commit`; `Read {file_path}` → `read`. A per-agent alphabet of
 * tens of tokens instead of thousands — small enough that cross-run repetition
 * becomes visible, semantic enough that a mined motif reads as a workflow.
 *
 * Canonicalization is rule-based and FIXED (no per-agent tuning): program
 * names are facts of the shell, not parameters to fit.
 */

import type { GraphNode, RawStep } from './types.js';

/** Programs whose first subcommand is part of the verb (git commit ≠ git push). */
const SUBCOMMAND_PROGRAMS = new Set([
  'git', 'gh', 'npm', 'pnpm', 'yarn', 'bun', 'docker', 'kubectl', 'aws', 'terraform',
  'cargo', 'go', 'prisma', 'vercel', 'helm', 'brew', 'pip', 'pip3', 'poetry', 'make',
]);
/** Programs where the verb is program + TWO subcommands (gh pr create). */
const DEEP_PROGRAMS = new Set(['gh', 'aws', 'docker', 'kubectl']);
/** npm/pnpm/yarn run <script>: the script name IS the verb. */
const RUNNER_PROGRAMS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(['sudo', 'time', 'command', 'exec', 'nohup', 'env']);
const NOISE_PROGRAMS = new Set(['cd', 'true', 'echo', 'set', 'export', 'source', 'unset', 'trap', 'sleep', 'pwd']);

/** Verb of one pipeline stage: `git commit -m "x"` → `git:commit`. */
function stageVerb(stage: string): string | null {
  const words = stage.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && (ENV_ASSIGN.test(words[i]) || WRAPPERS.has(words[i]))) i++;
  if (i >= words.length) return null;
  // Normalize the program: strip paths (./scripts/run.sh → run.sh).
  const program = words[i].split('/').pop()!.toLowerCase();
  if (!/^[a-z0-9_.-]+$/.test(program)) return null;
  // Navigation / shell plumbing, not actions.
  if (NOISE_PROGRAMS.has(program)) return null;

  const parts = [program];
  const takeSub = (idx: number): string | null => {
    const w = words[idx];
    return w && /^[a-z0-9_:-]+$/i.test(w) && !w.startsWith('-') ? w.toLowerCase() : null;
  };
  if (SUBCOMMAND_PROGRAMS.has(program)) {
    const s1 = takeSub(i + 1);
    if (s1) {
      parts.push(s1);
      if (DEEP_PROGRAMS.has(program) || (RUNNER_PROGRAMS.has(program) && s1 === 'run')) {
        const s2 = takeSub(i + 2);
        if (s2) parts.push(s2);
      }
    }
  }
  return parts.join(':');
}

/**
 * Action token for a Bash command: stage verbs joined with '+', navigation and
 * shell plumbing stripped, capped at 3 stages. Everything from the first
 * heredoc marker on is data, not actions; newlines separate statements exactly
 * like `;` (measured: most agent commands put `cd repo` on line 1 and the real
 * command on line 2 — reading only the first line made a quarter of all calls
 * collapse into one opaque `bash` token).
 */
export function bashAction(command: string): string {
  const script = command.split(/<</)[0];
  const stages = script
    .split('\n')
    .slice(0, 8)
    .flatMap((line) => line.split(/&&|;|\|\|?/))
    .map(stageVerb)
    .filter((v): v is string => v !== null);
  const uniq: string[] = [];
  for (const s of stages) if (uniq[uniq.length - 1] !== s) uniq.push(s);
  return uniq.length === 0 ? 'bash' : `${uniq.slice(0, 3).join('+')}`;
}

/**
 * Action token for any step. tool_use / tool_result get a semantic verb;
 * model turns and thinking keep their kind (they are the glue between actions).
 */
export function actionToken(step: Pick<RawStep, 'kind' | 'name' | 'payload'> | Pick<GraphNode, 'kind' | 'structLabel' | 'raw'>): string {
  const kind = step.kind;
  if (kind === 'model_turn' || kind === 'thinking') return kind === 'thinking' ? 'think' : 'say';

  // Accept either RawStep (name+payload) or GraphNode (structLabel+raw).
  const name = 'name' in step
    ? step.name
    : step.structLabel.startsWith('tool:')
      ? step.structLabel.slice(5).split('(')[0]
      : step.structLabel.startsWith('result:')
        ? step.structLabel.slice(7).split(':')[0]
        : step.structLabel;
  const raw = 'payload' in step ? step.payload : step.raw;

  let verb: string;
  const lower = name.toLowerCase();
  if (lower === 'bash') {
    let command = '';
    try { command = String((JSON.parse(raw) as { command?: string }).command ?? ''); } catch { command = raw; }
    verb = bashAction(command);
  } else if (lower.startsWith('mcp__')) {
    // mcp__server__method → server:method
    const parts = name.split('__').filter(Boolean);
    verb = parts.slice(1).join(':').toLowerCase();
  } else {
    verb = lower;
  }
  return kind === 'tool_result' ? `${verb}✓` : verb;
}
