/**
 * How much a command an agent ran matters to a security team. Used by the
 * Agent Graph (lib/live-graph.ts), Audit and Overview so harmless commands
 * (ls, cat, git status) don't bury the ones worth a look (curl, rm, sudo…).
 *
 *   routine — read-only housekeeping; hidden / collapsed by default
 *   risky   — deletes, permissions, privilege, network transfer, processes,
 *             containers, publishing and installing packages; highlighted
 *   normal  — everything else
 *
 * Edit the two lists below to change the classification. An entry is a
 * program name ("curl") or a program plus subcommand ("git push"). Extra
 * words after the subcommand ("git remote -v") must match the rest of the
 * command exactly. Pure — no React.
 */

export const ROUTINE_COMMANDS: readonly string[] = [
  'ls', 'cat', 'pwd', 'cd', 'echo', 'printf', 'grep', 'rg', 'find', 'head', 'tail', 'wc', 'which', 'type', 'file',
  'stat', 'du', 'df', 'date', 'whoami', 'env', 'tree', 'less', 'sort', 'uniq', 'diff',
  'git status', 'git log', 'git diff', 'git show', 'git branch', 'git rev-parse', 'git remote -v',
];

export const RISKY_COMMANDS: readonly string[] = [
  'rm', 'rmdir', 'chmod', 'chown', 'sudo', 'su', 'curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'socat',
  'telnet', 'dd', 'mkfs', 'kill', 'pkill', 'killall', 'crontab', 'launchctl', 'systemctl', 'docker', 'kubectl',
  'git push', 'npm publish', 'npm install', 'npm i', 'pip install', 'pip3 install',
];

/** A routine program stops being routine when one of these flags appears (find -delete is not housekeeping). */
export const ROUTINE_UNLESS: Readonly<Record<string, readonly string[]>> = {
  find: ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls'],
};

export type CommandRisk = 'routine' | 'normal' | 'risky';

/** Prefixes that run another program: the classifier looks past them (and `sudo`/`su` still count as risky). */
const WRAPPERS = new Set(['sudo', 'env', 'time', 'nohup', 'exec', 'command', 'nice', 'xargs']);
/** git options that take a value, so `git -C dir push` still reads as "push". */
const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);

export const baseName = (p: string) => p.replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? p;
const unquote = (s: string) => s.replace(/^["'`]+|["'`]+$/g, '');

export interface CommandSegment {
  /** Program name without its directory ("/usr/bin/curl" → "curl"). */
  program: string;
  /** First non-option argument: "git -C app push origin" → "push". */
  sub: string | null;
  /** Arguments after `sub`. */
  rest: string[];
  /** All arguments after the program. */
  args: string[];
  /** Wrappers skipped in front of the program (sudo, env, xargs…). */
  wrappers: string[];
  /** Writes output to a file (`> path`, `>> path`; /dev/null and fd dups don't count). */
  redirects: boolean;
}

/** Split a shell command line into the simple commands it runs (&&, ||, ;, |, &, newlines, $( ) and backticks). */
export function commandSegments(cmd: string): CommandSegment[] {
  const out: CommandSegment[] = [];
  for (const raw of cmd.split(/&&|\|\||;|\||\n|&(?![>\d])|\$\(|`/)) {
    const seg = raw.trim().replace(/^[({\s]+|[)}\s]+$/g, '');
    if (!seg) continue;
    const redirects = /\d?>>?\s*(?!\s*&|\s*\/dev\/null\b)\S/.test(seg.replace(/\d?>&\d/g, ''));
    const toks = seg.split(/\s+/).map(unquote).filter(Boolean);
    const wrappers: string[] = [];
    let i = 0;
    while (i < toks.length) {
      if (/^[A-Za-z_]\w*=/.test(toks[i])) { i++; continue; }
      if (WRAPPERS.has(baseName(toks[i]))) {
        wrappers.push(baseName(toks[i]));
        i++;
        while (i < toks.length && toks[i].startsWith('-')) i++;
        continue;
      }
      break;
    }
    const t = toks[i];
    if (!t) {
      if (wrappers.length) out.push({ program: wrappers[wrappers.length - 1], sub: null, rest: [], args: [], wrappers: wrappers.slice(0, -1), redirects });
      continue;
    }
    const program = baseName(t) || t;
    const args = toks.slice(i + 1);
    let j = 0;
    while (j < args.length && args[j].startsWith('-')) j += program === 'git' && GIT_VALUE_OPTS.has(args[j]) ? 2 : 1;
    out.push({ program, sub: args[j] ?? null, rest: args.slice(j + 1), args, wrappers, redirects });
  }
  return out;
}

/** The program a command line runs: "cd app && git status" → "git",
 *  "FOO=1 sudo /usr/bin/curl -s x" → "curl". */
export function programName(cmd: string): string {
  const segs = commandSegments(cmd);
  for (let k = 0; k < segs.length; k++) {
    const p = segs[k].program;
    if ((p === 'cd' || p === 'export' || p === 'source') && k !== segs.length - 1) continue;
    return p;
  }
  return baseName(cmd.trim().split(/\s+/)[0] ?? cmd) || cmd;
}

interface Rule { entry: string; program: string; sub: string | null; extra: string[] }
const compile = (list: readonly string[]): Rule[] => list.map((entry) => {
  const [program, sub, ...extra] = entry.trim().split(/\s+/);
  return { entry, program, sub: sub ?? null, extra };
});
const ROUTINE = compile(ROUTINE_COMMANDS);
const RISKY = compile(RISKY_COMMANDS);
/** Programs whose subcommand decides the class (git, npm, pip…): their graph node is "git push", not "git". */
const BY_SUBCOMMAND = new Set([...ROUTINE, ...RISKY].filter((r) => r.sub).map((r) => r.program));

function match(rules: Rule[], s: CommandSegment): Rule | undefined {
  return rules.find((r) => {
    if (r.program !== s.program) return false;
    if (!r.sub) return true;
    if (r.sub !== s.sub) return false;
    return r.extra.length === 0 || (r.extra.length === s.rest.length && r.extra.every((x, i) => x === s.rest[i]));
  });
}

export interface CommandClass {
  risk: CommandRisk;
  /** The list entry that made it risky ("curl", "git push", "sudo"). */
  rule?: string;
}

/** Classify a full command line. Risky if any part is risky; routine only if every part is. */
export function classifyCommand(cmd: string): CommandClass {
  const segs = commandSegments(cmd);
  if (segs.length === 0) return { risk: 'normal' };
  let routine = true;
  for (const s of segs) {
    for (const w of s.wrappers) {
      const r = RISKY.find((x) => !x.sub && x.program === w);
      if (r) return { risk: 'risky', rule: r.entry };
    }
    const risky = match(RISKY, s);
    if (risky) return { risk: 'risky', rule: risky.entry };
    if (routine) {
      const unless = ROUTINE_UNLESS[s.program];
      routine = !!match(ROUTINE, s) && !s.redirects && !(unless && s.args.some((a) => unless.includes(a)));
    }
  }
  return { risk: routine ? 'routine' : 'normal' };
}

/** Short name for a command in lists and graph nodes: the program, plus the
 *  subcommand for programs classified by subcommand ("git push", "npm install"). */
export function commandLabel(cmd: string): string {
  const prog = programName(cmd);
  const seg = commandSegments(cmd).find((s) => s.program === prog);
  return seg?.sub && BY_SUBCOMMAND.has(prog) ? `${prog} ${seg.sub}` : prog;
}
