import { describe, it, expect } from 'vitest';
import type { Run, RawStep } from '../src/types.js';
import { buildRunGraph } from '../src/graph.js';
import { bashAction, actionToken } from '../src/actions.js';
import { segmentEpisodes, classifyIntent } from '../src/episodes.js';
import { suggestTools } from '../src/suggest.js';

// ---------------- actions: the semantic alphabet --------------------------------

describe('bashAction', () => {
  it('extracts program:subcommand verbs and strips cd/noise', () => {
    expect(bashAction('cd /Users/x/proj && pnpm test')).toBe('pnpm:test');
    expect(bashAction('git add -A && git commit -m "msg"')).toBe('git:add+git:commit');
    expect(bashAction('gh pr create --title "x" --body "y"')).toBe('gh:pr:create');
    expect(bashAction('npm run build')).toBe('npm:run:build');
    expect(bashAction('FOO=1 sudo docker compose up')).toBe('docker:compose:up');
    expect(bashAction('ls -la /tmp')).toBe('ls');
  });

  it('ignores heredoc bodies (data, not actions)', () => {
    expect(bashAction("python3 - <<'PY'\nimport os; os.system('git push')\nPY")).toBe('python3');
  });

  it('collapses to a bounded alphabet: same workflow, different data → same token', () => {
    const a = bashAction('cd /repo && git commit -m "fix: one thing"');
    const b = bashAction('git commit --message "feat: another"');
    expect(a).toBe(b);
  });
});

describe('actionToken', () => {
  it('maps non-Bash tools to their verb and mcp tools to server:method', () => {
    expect(actionToken({ kind: 'tool_use', name: 'Read', payload: '{"file_path":"/a"}' })).toBe('read');
    expect(actionToken({ kind: 'tool_use', name: 'mcp__claude_ai_Atlassian__getJiraIssue', payload: '{}' }))
      .toBe('claude_ai_atlassian:getjiraissue');
    expect(actionToken({ kind: 'tool_result', name: 'Read', payload: 'x' })).toBe('read✓');
  });
});

// ---------------- episodes ------------------------------------------------------

function step(kind: RawStep['kind'], name: string, payload: string, extra: Partial<RawStep> = {}): RawStep {
  return { kind, name, payload, ...extra };
}

function runOf(steps: RawStep[], runId: string): Run {
  return { runId, agentId: 'test-agent', steps, costUsd: 1, models: [], usageByModel: {} } as Run;
}

describe('segmentEpisodes', () => {
  it('splits at user turns and classifies intent', () => {
    const run = runOf([
      step('model_turn', 'user', 'fix the failing build please'),
      step('tool_use', 'Bash', '{"command":"pnpm build"}'),
      step('tool_result', 'Bash', 'error TS2345', { isError: true }),
      step('model_turn', 'assistant', 'fixing'),
      step('model_turn', 'user', 'now create a PR for that'),
      step('tool_use', 'Bash', '{"command":"git push"}'),
      step('tool_result', 'Bash', 'ok'),
    ], 'r1');
    const eps = segmentEpisodes(buildRunGraph(run));
    expect(eps).toHaveLength(2);
    expect(eps[0].intent).toBe('fix');
    expect(eps[0].errors).toBe(1);
    expect(eps[0].actions).toEqual(['pnpm:build']);
    expect(eps[1].intent).toBe('deliver');
    expect(eps[1].actions).toEqual(['git:push']);
  });

  it('classifyIntent is deterministic and ordered', () => {
    expect(classifyIntent('can you review this PR?')).toBe('review');
    expect(classifyIntent('I want to add a new feature')).toBe('implement');
    expect(classifyIntent('where is the config?')).toBe('explore');
  });
});

// ---------------- suggestions ---------------------------------------------------

/** Build a run with one "deliver" episode containing the canonical PR workflow. */
function prRun(runId: string, branch: string, title: string): Run {
  return runOf([
    step('model_turn', 'user', 'looks good, create a pr for that'),
    step('model_turn', 'assistant', 'creating the branch'),
    step('tool_use', 'Bash', JSON.stringify({ command: `git checkout -b ${branch}` })),
    step('tool_result', 'Bash', `Switched to branch ${branch}`),
    step('model_turn', 'assistant', 'committing'),
    step('tool_use', 'Bash', JSON.stringify({ command: `git add -A && git commit -m "${title}"` })),
    step('tool_result', 'Bash', '1 file changed'),
    step('tool_use', 'Bash', JSON.stringify({ command: `git push -u origin ${branch}` })),
    step('tool_result', 'Bash', 'pushed'),
    step('tool_use', 'Bash', JSON.stringify({ command: `gh pr create --title "${title}"` })),
    step('tool_result', 'Bash', 'https://github.com/x/y/pull/1'),
  ], runId);
}

/** A run of unrelated one-off work — must contribute nothing. */
function noiseRun(runId: string, i: number): Run {
  return runOf([
    step('model_turn', 'user', `why is module ${i} broken?`),
    step('tool_use', 'Read', JSON.stringify({ file_path: `/src/m${i}.ts` })),
    step('tool_result', 'Read', `content of ${i}`),
    step('tool_use', 'Grep', JSON.stringify({ pattern: `sym${i}` })),
    step('tool_result', 'Grep', 'no matches'),
  ], runId);
}

describe('suggestTools', () => {
  it('finds the recurring PR workflow across runs and proposes params for the varying slots', () => {
    const graphs = [
      ...Array.from({ length: 6 }, (_, i) => prRun(`pr${i}`, `feat/branch-${i}`, `feat: change ${i}`)),
      ...Array.from({ length: 4 }, (_, i) => noiseRun(`n${i}`, i)),
    ].map(buildRunGraph);
    const suggestions = suggestTools(graphs);
    expect(suggestions.length).toBeGreaterThanOrEqual(1);
    const pr = suggestions[0];
    expect(pr.actions.join('→')).toContain('git:checkout');
    expect(pr.actions.join('→')).toContain('gh:pr:create');
    expect(pr.support).toBe(6);
    expect(pr.occurrences).toBe(6);
    expect(pr.intents[0]).toBe('deliver');
    // branch and title vary per run → proposed parameters; the template keeps
    // the constant parts ("feat/") and the params carry only the true slots.
    expect(pr.params.length).toBeGreaterThanOrEqual(1);
    expect(pr.params.flatMap((p) => p.examples).join(' ')).toMatch(/branch-\d/);
    expect(pr.steps[0].argTemplate).toContain('⟨·⟩');
    // maximality: the full 4-step motif wins, not its 3-step sub-motifs
    expect(pr.actions.length).toBe(4);
  });

  it('suggests NOTHING when work never repeats (the honest-empty case)', () => {
    const graphs = Array.from({ length: 8 }, (_, i) => noiseRun(`x${i}`, i)).map(buildRunGraph);
    // every noise episode has identical read→grep shape but distinct args… and only
    // 2 distinct actions with length 2 < MIN_LEN → below motif length; nothing to say.
    expect(suggestTools(graphs)).toHaveLength(0);
  });

  it('refuses primitive churn — read/edit loops recur but have no tool boundary', () => {
    const churn = (runId: string, i: number) => runOf([
      step('model_turn', 'user', `implement feature ${i}`),
      step('tool_use', 'Read', JSON.stringify({ file_path: `/src/f${i}.ts` })),
      step('tool_result', 'Read', `content ${i}`),
      step('tool_use', 'Edit', JSON.stringify({ file_path: `/src/f${i}.ts`, old_string: 'a', new_string: 'b' })),
      step('tool_result', 'Edit', 'ok'),
      step('tool_use', 'Edit', JSON.stringify({ file_path: `/src/f${i}.ts`, old_string: 'c', new_string: 'd' })),
      step('tool_result', 'Edit', 'ok'),
    ], runId);
    const graphs = Array.from({ length: 8 }, (_, i) => churn(`c${i}`, i)).map(buildRunGraph);
    expect(suggestTools(graphs)).toHaveLength(0);
  });

  it('refuses motifs concentrated in too few runs (support gate)', () => {
    const graphs = [
      prRun('a', 'b1', 't1'), prRun('b', 'b2', 't2'), // only 2 runs
      ...Array.from({ length: 6 }, (_, i) => noiseRun(`n${i}`, i)),
    ].map(buildRunGraph);
    expect(suggestTools(graphs)).toHaveLength(0);
  });
});
