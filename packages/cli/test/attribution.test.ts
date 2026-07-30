import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentFromRules, gitRepoName, isExcludedCwd } from '../src/store.js';

// Isolated temp tree: two separately-named repos, each with a `src/` subdir,
// plus a plain dir outside any repo.
const root = mkdtempSync(join(tmpdir(), 'effigent-attr-'));
const mk = (...p: string[]) => {
  const d = join(root, ...p);
  mkdirSync(d, { recursive: true });
  return d;
};
mk('apollo', '.git');
const apolloSrc = mk('apollo', 'src');
mk('billing', '.git');
const billingSrc = mk('billing', 'src');
const plain = mk('scratch', 'notes');

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('gitRepoName — project-scoped attribution', () => {
  it('names a repo by its top-level directory', () => {
    expect(gitRepoName(join(root, 'apollo'))).toBe('apollo');
    expect(gitRepoName(join(root, 'billing'))).toBe('billing');
  });

  it('resolves a subdirectory to its repo, not the subdir leaf', () => {
    // This is the fix: cwd-leaf naming would call this "src".
    expect(gitRepoName(apolloSrc)).toBe('apollo');
  });

  it('does NOT merge different repos that share a subdir name', () => {
    // Both cwds have leaf "src"; leaf-based naming collapsed them into one
    // agent (the day-one bug). Repo-scoped naming keeps them distinct.
    expect(gitRepoName(apolloSrc)).not.toBe(gitRepoName(billingSrc));
    expect(gitRepoName(billingSrc)).toBe('billing');
  });

  it('returns undefined outside any git repo (stays unattributed/private)', () => {
    expect(gitRepoName(plain)).toBeUndefined();
    expect(gitRepoName(undefined)).toBeUndefined();
  });
});

describe('agentFromRules — explicit cwd rules still win', () => {
  const rules = [
    { pattern: '/apollo(/|$)', agent: 'apollo-agent' },
    { pattern: '/billing(/|$)', agent: 'billing-agent' },
  ];
  it('matches the first anchored rule', () => {
    expect(agentFromRules('/work/apollo/src', rules)).toBe('apollo-agent');
    expect(agentFromRules('/work/billing', rules)).toBe('billing-agent');
  });
  it('returns undefined when nothing matches', () => {
    expect(agentFromRules('/work/other', rules)).toBeUndefined();
    expect(agentFromRules(undefined, rules)).toBeUndefined();
  });
  it('skips invalid regex without throwing', () => {
    expect(agentFromRules('/x', [{ pattern: '(', agent: 'bad' }])).toBeUndefined();
  });
});

describe('isExcludedCwd — the hard veto', () => {
  const rules = [{ pattern: '/hayde(/|$)', note: 'client work' }, { pattern: '/razgaz(/|$)' }];

  it('excludes a matching project and its subdirectories', () => {
    expect(isExcludedCwd('/work/hayde', rules)).toBe(true);
    expect(isExcludedCwd('/work/hayde/packages/api', rules)).toBe(true);
    expect(isExcludedCwd('/work/razgaz', rules)).toBe(true);
  });

  it('leaves unrelated projects capturable', () => {
    expect(isExcludedCwd('/work/apollo', rules)).toBe(false);
    // Substring-but-not-segment: `/haydex` must not inherit `/hayde`'s exclusion,
    // otherwise anchoring is meaningless.
    expect(isExcludedCwd('/work/haydex', rules)).toBe(false);
  });

  it('treats an unknown cwd as NOT excluded', () => {
    // Exclusion requires a positive match: a failed cwd sniff must not silently
    // suppress capture (that would look like exclusion working when it isn't).
    expect(isExcludedCwd(undefined, rules)).toBe(false);
  });

  it('is a no-op when no rules are configured', () => {
    expect(isExcludedCwd('/work/hayde', undefined)).toBe(false);
    expect(isExcludedCwd('/work/hayde', [])).toBe(false);
  });

  it('skips invalid regex without excluding everything', () => {
    // A typo must not take capture down, and must not accidentally veto all runs.
    expect(isExcludedCwd('/work/apollo', [{ pattern: '(' }])).toBe(false);
  });

  it('still excludes via a later rule when an earlier one is invalid', () => {
    expect(isExcludedCwd('/work/hayde', [{ pattern: '(' }, { pattern: '/hayde' }])).toBe(true);
  });
});
