/**
 * Agent graph built from control-plane events (GET /api/v1/events). Pure — no
 * React — so the rules for turning one event into graph nodes and edges live
 * in one place, next to live-map.ts:
 *
 *   machine ──runs──▶ agent ──action──▶ target
 *                      agent ──mcp──▶ MCP server ──action──▶ target   (body.via set)
 *
 * Targets are grouped by kind: commands (program name), files (path), network
 * destinations (ip:port / host), tool calls, and each MCP server's tools. Each
 * group keeps its busiest targets; the rest fold into that group's "+N more"
 * node so no edge dangles. Commands are classified routine / normal / risky
 * (command-risk.ts); routine commands and the agent's own bookkeeping tools
 * (ToolSearch, TodoWrite, Monitor…) fold into one "Routine (N)" node per agent
 * when `showRoutine` is set and are hidden otherwise.
 */
import type { ApiEvent } from './api.ts';
import { baseName, classifyCommand, commandLabel, type CommandRisk } from './command-risk.ts';

export type TargetKind = 'command' | 'file' | 'network' | 'tool' | 'routine' | 'more';
export type LiveNodeKind = 'machine' | 'agent' | 'mcp' | 'target';
export type LiveOutcome = 'allowed' | 'blocked' | 'would_block' | 'flow';

export interface LiveNode {
  id: string;
  kind: LiveNodeKind;
  targetKind?: TargetKind;
  label: string;
  sub: string;
  /** Full value (path, command line, address) for tooltips and search. */
  full: string;
  agent?: string; // agent name (agent nodes)
  endpoint?: string; // endpoint id (machine and agent nodes)
  count: number;
  allowed: number;
  blocked: number;
  wouldBlock: number;
  lastAt: number;
  /** Most recent events first (ApiEvent.id), capped. */
  eventIds: number[];
  /** Command targets: routine / normal / risky (lib/command-risk.ts). */
  risk?: CommandRisk;
  /** "Routine (N)" node: the commands folded into it, busiest first. */
  items?: { label: string; full: string; count: number }[];
  /** Targets: the layout group, "command" | "file" | "network" | "tool" | "routine" | "mcp:<server>". */
  group?: string;
  /** "+N more" nodes: how many targets they stand for. */
  hiddenCount?: number;
}

export interface LiveEdge {
  id: string;
  source: string;
  target: string;
  action: string;
  outcome: LiveOutcome;
  count: number;
  lastAt: number;
}

export interface LiveGraph {
  nodes: LiveNode[];
  edges: LiveEdge[];
  events: number; // events in the window that carried an agent
  targets: number; // distinct targets before the cap
  hiddenTargets: number; // folded into "+N more"
  routineEvents: number; // routine command events (collapsed or shown)
}

export interface LiveGraphOptions {
  since: number; // epoch ms; older events are ignored
  agent?: string | null; // only this agent name
  /** Targets shown per group (commands, files, network, tools, each MCP server); the rest fold into "+N more". */
  maxTargets: number;
  /** Per-group override of maxTargets, e.g. { file: 40 } while the files group is open. */
  groupMax?: Record<string, number>;
  /** Show routine commands (ls, cat, git status…) as one "Routine commands (N)" node per agent; hidden otherwise. */
  showRoutine?: boolean;
}

/** What one event did, once its target is classified. */
export interface Classified {
  kind: Exclude<TargetKind, 'more'>;
  key: string; // stable node key within the kind
  label: string;
  sub: string;
  full: string;
  action: string; // edge label: exec, read, write, open, connect, fetch, call…
  mcp?: string; // MCP server name (from body.via or an mcp__server__tool call)
  /** Commands, and tools (only ever "routine"). */
  risk?: CommandRisk;
  rule?: string; // the risky-list entry that matched
  /** Files: credentials, keys, secrets (SENSITIVE), or reported / matched by a file rule. */
  sensitive?: boolean;
  /** Commands: what kind of work (commandCategory): uploads, databases, cloud, packages, git. */
  category?: CommandCategory;
}

export type CommandCategory = 'uploads' | 'databases' | 'cloud' | 'packages' | 'git';

const CLOUD = new Set(['gcloud', 'gsutil', 'bq', 'aws', 'az', 'kubectl', 'helm', 'terraform', 'tofu', 'pulumi', 'firebase', 'vercel', 'netlify',
  'fly', 'flyctl', 'heroku', 'wrangler', 'eksctl', 'ansible', 'ansible-playbook', 'serverless', 'sls', 'cdk', 'sam', 'doctl', 'railway', 'supabase']);
const GIT = new Set(['git', 'gh', 'glab', 'hub']);
const DATABASES = new Set(['psql', 'mysql', 'mariadb', 'mongo', 'mongosh', 'redis-cli', 'sqlite3', 'clickhouse-client', 'cqlsh', 'pg_dump',
  'pg_restore', 'mysqldump', 'mongodump', 'mongoexport', 'mongoimport']);
const INSTALLS: Record<string, RegExp> = {
  npm: /^(i|install|add|ci)$/, pnpm: /^(i|install|add)$/, yarn: /^(add|install)$/, bun: /^(add|install|i)$/, pip: /^install$/, pip3: /^install$/,
  poetry: /^add$/, uv: /^(add|pip)$/, brew: /^install$/, apt: /^install$/, 'apt-get': /^install$/, gem: /^install$/, cargo: /^(install|add)$/,
  go: /^(install|get)$/, composer: /^(require|install)$/,
};
const WRAPPERS = new Set(['sudo', 'env', 'nohup', 'time', 'nice', 'exec', 'command', 'xargs', 'timeout', 'caffeinate']);

/** Data leaving the machine on purpose: POST/upload flags, copies to remote hosts or buckets. */
function isUpload(prog: string, args: string[]): boolean {
  switch (prog) {
    case 'curl':
      return args.some((a, i) => /^(-d|--data(-\w+)?|-F|--form|-T|--upload-file)$/.test(a) || /^--data(-\w+)?=/.test(a)
        || ((a === '-X' || a === '--request') && /^(POST|PUT|PATCH)$/i.test(args[i + 1] ?? '')));
    case 'wget': return args.some((a) => /^--(post|body)-(data|file)/.test(a));
    case 'scp': case 'sftp': case 'ftp': return true;
    case 'rsync': return args.some((a) => /^[^/-][^\s]*:/.test(a));
    case 'aws': return args[0] === 's3' && /^(cp|mv|sync)$/.test(args[1] ?? '') && /^s3:\/\//.test(args[args.length - 1] ?? '');
    case 'gsutil': return /^(cp|mv|rsync)$/.test(args[0] ?? '') && /^gs:\/\//.test(args[args.length - 1] ?? '');
  }
  return false;
}

/** What kind of work a command line does, by its most telling part:
 *  uploads > databases > cloud > packages > git. */
export function commandCategory(line: string): CommandCategory | undefined {
  const found = new Set<CommandCategory>();
  for (const seg of line.split(/&&|\|\||[;|\n]/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || WRAPPERS.has(words[0]))) words.shift();
    if (!words.length) continue;
    const prog = base(words[0]).replace(/\.exe$/i, '').toLowerCase();
    const args = words.slice(1);
    if (isUpload(prog, args)) return 'uploads';
    if (DATABASES.has(prog)) found.add('databases');
    else if (CLOUD.has(prog)) found.add('cloud');
    else if (INSTALLS[prog]?.test(args[0] ?? '')) found.add('packages');
    else if (GIT.has(prog)) found.add('git');
  }
  return (['databases', 'cloud', 'packages', 'git'] as const).find((c) => found.has(c));
}

/** Paths that hold credentials or secrets: their own "Sensitive Data Access" group. */
const SENSITIVE = [
  /(^|\/)\.env(\.[\w-]+)?$/i, /\/\.ssh\//, /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/, /\/\.aws\/(credentials|config)$/,
  /\/\.kube\/config$/, /\/\.docker\/config\.json$/, /\/\.(netrc|npmrc|pypirc|git-credentials|pgpass)$/, /\/\.config\/gcloud\//,
  /\/\.gnupg\//, /\.(pem|key|p12|pfx|jks|keystore)$/i, /(^|\/)secrets?\.(ya?ml|json|toml)$/i, /\.tfstate(\.backup)?$/,
  /\/Library\/Keychains\//, /(^|\/)credentials(\.json)?$/i,
];
export const isSensitivePath = (p: string) => SENSITIVE.some((re) => re.test(p));

/** Claude Code names MCP tools mcp__<server>__<tool>. */
export function parseMcpTool(name: string): { server: string; tool: string } | null {
  const m = name.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/);
  return m ? { server: m[1], tool: m[2] } : null;
}

const EVENT_IDS_CAP = 60;
const TARGET_TYPES = new Set(['exec', 'file_open', 'connect', 'blocked', 'would_block', 'approval_pending', 'approved', 'approval_denied']);

const base = baseName;

function dirLabel(path: string): string {
  const dir = path.replace(/\/+$/, '').split('/').slice(0, -1).join('/');
  if (!dir) return '/';
  const home = dir.replace(/^\/(?:Users|home)\/[^/]+/, '~').replace(/^\/root(?=\/|$)/, '~');
  const parts = home.split('/');
  return parts.length > 4 ? `…/${parts.slice(-3).join('/')}` : home;
}


const ADDR = /^(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+|[0-9a-f:]+):\d{1,5}$/i;

function hostOf(url: string): string | null {
  try { return new URL(url).host || null; } catch { return null; }
}

function command(value: string, action = 'exec', fallbackBinary?: string): Classified {
  const line = value || fallbackBinary || '?';
  const { risk, rule } = classifyCommand(line);
  // A risky command is named after what made it risky ("ls && curl x" → curl).
  const name = risk === 'risky' && rule ? rule : commandLabel(line);
  const category = commandCategory(line);
  // the category is part of the key: `curl -d @dump` (upload) and `curl https://…` are different nodes
  return { kind: 'command', key: `${category ? `${category}:` : ''}${risk === 'routine' ? '~' : risk === 'risky' ? '!' : ''}${name}`, label: name, sub: 'Command',
    full: value || fallbackBinary || name, action, risk, rule, category };
}
function file(path: string, action: string): Classified {
  return { kind: 'file', key: path, label: base(path) || path, sub: dirLabel(path), full: path, action, sensitive: isSensitivePath(path) };
}
function network(addr: string, action = 'connect'): Classified {
  return { kind: 'network', key: addr, label: addr, sub: 'Network', full: addr, action };
}

const FILE_READ = new Set(['Read', 'NotebookRead', 'LS']);
/** Built-in tools that touch something worth a node of its own; the rest
 *  (ToolSearch, TodoWrite, Monitor, TaskStop…) are the agent's bookkeeping. */
const NOTABLE_TOOLS = new Set(['WebSearch', 'Task', 'Agent']);
const FILE_WRITE = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** A hook-reported tool call ("Bash: git status", "Read: /work/.env", "mcp__github__create_issue"). */
function tool(name: string, value: string): Classified {
  const mcp = parseMcpTool(name);
  if (mcp) return { kind: 'tool', key: `${mcp.server}.${mcp.tool}`, label: mcp.tool, sub: `${mcp.server} tool`, full: `${name}${value ? `: ${value}` : ''}`, action: 'call', mcp: mcp.server };
  if (name === 'Bash' && value) return command(value);
  if (FILE_READ.has(name) && value) return file(value, 'read');
  if (FILE_WRITE.has(name) && value) return file(value, 'write');
  if (name === 'WebFetch' && value) { const h = hostOf(value); if (h) return network(h, 'fetch'); }
  return { kind: 'tool', key: name, label: name, sub: 'Tool', full: value ? `${name}: ${value}` : name, action: name === 'WebSearch' ? 'search' : 'call',
    ...(NOTABLE_TOOLS.has(name) ? {} : { risk: 'routine' as const }) };
}

/** What an event touched, or null for lifecycle events (agent start/exit, policy) and events without a target. */
export function classify(e: ApiEvent): Classified | null {
  if (!TARGET_TYPES.has(e.type)) return null;
  const b = e.body ?? {};
  let raw = (b.target ?? '').trim();
  let hint: string | undefined = b.kind; // engine: agent | mcp | tool; hooks: exec | file_open | connect | tool
  const pre = raw.match(/^(exec|connect|open)\s+(.+)$/s);
  if (pre) { hint = pre[1] === 'open' ? 'file_open' : pre[1]; raw = pre[2].trim(); }

  // Kernel exec events carry the binary in `target` and the arguments in process.args:
  // classify the whole command line, so `git push` and `git status` are told apart.
  const args = b.process?.args?.trim();
  const line = args && raw && raw === b.process?.binary ? `${raw} ${args}` : raw;

  let c: Classified | null = null;
  const t = hint === 'tool' || /^(?:[A-Z][A-Za-z]+|mcp__\S+): /s.test(raw) || /^mcp__\S+$/.test(raw) ? raw.match(/^([A-Za-z][\w.-]*)(?::\s*(.*))?$/s) : null;
  if (t) c = tool(t[1], (t[2] ?? '').trim());
  else if (hint === 'connect' || e.type === 'connect') c = network(hostOf(raw) ?? raw);
  else if (hint === 'file_open' || e.type === 'file_open') c = raw ? file(raw, 'open') : null;
  else if (hint === 'exec' || hint === 'agent' || hint === 'mcp' || e.type === 'exec') c = command(line, 'exec', b.process?.binary);
  else if (raw) {
    // blocked / would_block without a kind: tell the target apart by shape (and the rule that matched).
    const rule = b.rule ?? '';
    if (/exec_/.test(rule)) c = command(line);
    else if (/network/.test(rule) || ADDR.test(raw)) c = network(raw);
    else if (/^https?:\/\//.test(raw)) c = network(hostOf(raw) ?? raw, 'fetch');
    else if (/file_/.test(rule) || (/^[/~]/.test(raw) && !/\s/.test(raw))) c = file(raw, 'open');
    else c = command(line);
  } else if (b.process?.binary) c = command(args ? `${b.process.binary} ${args}` : '', 'exec', b.process.binary);
  if (!c) return null;
  // effigentd reports sensitive files itself (file_open = a file_alert / file rule match)
  if (c.kind === 'file' && (e.type === 'file_open' || /^file_(alert|deny|approve)$/.test(b.rule ?? ''))) c.sensitive = true;

  const via = b.via?.trim();
  if (via && !c.mcp) c.mcp = via.startsWith('mcp:') ? via.slice(4) : via;
  return c;
}

// A request waiting for or denied approval did not run: it shows as blocked.
const outcomeOf = (type: string): LiveOutcome =>
  (type === 'blocked' || type === 'approval_pending' || type === 'approval_denied' ? 'blocked' : type === 'would_block' ? 'would_block' : 'allowed');

const KIND_ORDER: Record<TargetKind, number> = { command: 0, file: 1, network: 2, tool: 3, routine: 4, more: 5 };

export function buildLiveGraph(events: ApiEvent[], hostById: Map<string, string>, o: LiveGraphOptions): LiveGraph {
  const nodes = new Map<string, LiveNode>();
  const edges = new Map<string, LiveEdge>();
  const hits: { tid: string; c: Classified; agentId: string; outcome: LiveOutcome; at: number; ev: number }[] = [];
  let n = 0;

  const touch = (id: string, init: () => Omit<LiveNode, 'id' | 'count' | 'allowed' | 'blocked' | 'wouldBlock' | 'lastAt' | 'eventIds'>, outcome: LiveOutcome | null, at: number, ev: number) => {
    let node = nodes.get(id);
    if (!node) { node = { id, ...init(), count: 0, allowed: 0, blocked: 0, wouldBlock: 0, lastAt: 0, eventIds: [] }; nodes.set(id, node); }
    node.count++;
    if (outcome === 'blocked') node.blocked++;
    else if (outcome === 'would_block') node.wouldBlock++;
    else if (outcome === 'allowed') node.allowed++;
    node.lastAt = Math.max(node.lastAt, at);
    if (node.eventIds.length < EVENT_IDS_CAP) node.eventIds.push(ev);
    return node;
  };
  const link = (source: string, target: string, action: string, outcome: LiveOutcome, at: number) => {
    const id = `${source}>${target}|${action}|${outcome}`;
    const ed = edges.get(id);
    if (ed) { ed.count++; ed.lastAt = Math.max(ed.lastAt, at); }
    else edges.set(id, { id, source, target, action, outcome, count: 1, lastAt: at });
  };

  for (const e of events) {
    const at = Date.parse(e.time);
    if (!Number.isFinite(at) || at < o.since) continue;
    const agent = e.agent || e.body?.agent;
    if (!agent) continue; // effigentd's own events (policy loads) have no agent
    if (o.agent && agent !== o.agent) continue;
    n++;
    const host = hostById.get(e.endpoint_id) ?? e.endpoint_id.slice(0, 8);
    const c = classify(e);
    const outcome: LiveOutcome | null = c ? outcomeOf(e.type) : null;

    const mid = `m:${e.endpoint_id}`;
    const aid = `a:${e.endpoint_id}:${agent}`;
    touch(mid, () => ({ kind: 'machine', label: host, sub: 'Machine', full: host, endpoint: e.endpoint_id }), outcome, at, e.id);
    touch(aid, () => ({ kind: 'agent', label: agent, sub: host, full: `${agent} @ ${host}`, agent, endpoint: e.endpoint_id }), outcome, at, e.id);
    link(mid, aid, 'runs', 'flow', at);
    if (!c || !outcome) continue;
    hits.push({ tid: `t:${c.kind}:${c.key}`, c, agentId: aid, outcome, at, ev: e.id });
  }

  // Routine commands (ls, grep, sed, mkdir…) are what every agent does all day:
  // hidden from the graph unless "Show routine" is on, and then folded into one
  // node per agent. They never compete for the target cap. Audit keeps them all.
  const routineHits = hits.filter((h) => h.c.risk === 'routine');
  const collapse = true;
  const ROUTINE = (agentId: string) => `t:routine:${agentId}`;
  const routineCount = new Map<string, number>();
  const routineItems = new Map<string, Map<string, { label: string; full: string; count: number }>>();
  if (collapse) {
    for (const h of routineHits) {
      routineCount.set(h.agentId, (routineCount.get(h.agentId) ?? 0) + 1);
      const m = routineItems.get(h.agentId) ?? new Map<string, { label: string; full: string; count: number }>();
      const it = m.get(h.c.label) ?? { label: h.c.label, full: h.c.full, count: 0 };
      it.count++;
      m.set(h.c.label, it);
      routineItems.set(h.agentId, m);
    }
  }
  const ranked0 = collapse ? hits.filter((h) => h.c.risk !== 'routine') : hits;

  // Each group keeps its busiest targets; the rest fold into its "+N more".
  // Layout groups. MCP tools always stay under their server (a blocked one
  // shows red there, and so does the MCP group); anything else policy stopped
  // (blocked, would block, waiting for or denied approval) is under "blocked";
  // then sensitive files, commands by category (uploads, databases, cloud,
  // packages, git), risky commands, and the rest by kind.
  const stopped = new Set(hits.filter((h) => h.outcome === 'blocked' || h.outcome === 'would_block').map((h) => h.tid));
  const groupOf = (c: Classified, tid: string) => (c.mcp ? `mcp:${c.mcp}` : stopped.has(tid) ? 'blocked'
    : c.kind === 'file' && c.sensitive ? 'sensitive' : c.kind === 'command' && c.category ? c.category
    : c.kind === 'command' && c.risk === 'risky' ? 'risky' : c.kind);
  const tally = new Map<string, { n: number; group: string }>();
  for (const h of ranked0) {
    const t = tally.get(h.tid) ?? { n: 0, group: groupOf(h.c, h.tid) };
    t.n++;
    tally.set(h.tid, t);
  }
  const ranked = [...tally.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]));
  const kept = new Set<string>();
  const hiddenBy = new Map<string, number>();
  const shownBy = new Map<string, number>();
  for (const [id, { group }] of ranked) {
    const shown = shownBy.get(group) ?? 0;
    if (shown < Math.max(0, o.groupMax?.[group] ?? o.maxTargets)) { kept.add(id); shownBy.set(group, shown + 1); }
    else hiddenBy.set(group, (hiddenBy.get(group) ?? 0) + 1);
  }
  const hidden = ranked.length - kept.size;
  const MORE = (group: string) => `t:more:${group}`;
  const GROUP_NOUN: Record<string, [string, string]> = { command: ['command', 'commands'], risky: ['risky command', 'risky commands'], file: ['file', 'files'],
    sensitive: ['sensitive file', 'sensitive files'], network: ['destination', 'destinations'], tool: ['tool', 'tools'], blocked: ['action', 'actions'],
    uploads: ['upload', 'uploads'], databases: ['database command', 'database commands'], cloud: ['cloud command', 'cloud commands'],
    packages: ['install', 'installs'], git: ['git command', 'git commands'] };

  for (const h of hits) {
    if (h.c.risk === 'routine' && !o.showRoutine) continue;
    const folded = collapse && h.c.risk === 'routine';
    const show = folded || kept.has(h.tid);
    const group = folded ? 'routine' : groupOf(h.c, h.tid);
    const tid = folded ? ROUTINE(h.agentId) : show ? h.tid : MORE(group);
    if (folded) {
      const n = routineCount.get(h.agentId) ?? 0;
      const items = [...(routineItems.get(h.agentId)?.values() ?? [])].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
      touch(tid, () => ({ kind: 'target', targetKind: 'routine', label: `Routine (${n.toLocaleString()})`, sub: items.slice(0, 3).map((i) => i.label).join(', ') + (items.length > 3 ? '…' : ''), full: items.map((i) => i.label).join(', '), risk: 'routine', items, group }), h.outcome, h.at, h.ev);
    } else if (show) touch(tid, () => ({ kind: 'target', targetKind: h.c.kind, label: h.c.label, sub: h.c.sub, full: h.c.full, risk: h.c.risk, group }), h.outcome, h.at, h.ev);
    else {
      const k = hiddenBy.get(group) ?? 0;
      const [one, many] = h.c.mcp ? ['tool', 'tools'] : GROUP_NOUN[group] ?? ['target', 'targets'];
      touch(tid, () => ({ kind: 'target', targetKind: 'more', label: `+${k} more`, sub: k === 1 ? one : many, full: '', group, hiddenCount: k }), h.outcome, h.at, h.ev);
    }
    const action = folded ? 'exec' : h.c.action; // "+N more" keeps what was done (read, write, exec…)
    if (h.c.mcp) {
      const sid = `s:${h.c.mcp}`;
      const name = h.c.mcp;
      touch(sid, () => ({ kind: 'mcp', label: name, sub: 'MCP server', full: `mcp:${name}` }), h.outcome, h.at, h.ev);
      link(h.agentId, sid, 'mcp', h.outcome, h.at);
      link(sid, tid, action, h.outcome, h.at);
    } else {
      link(h.agentId, tid, action, h.outcome, h.at);
    }
  }

  const order = (x: LiveNode) => (x.kind === 'target' ? KIND_ORDER[x.targetKind ?? 'more'] : 0);
  const list = [...nodes.values()].sort((a, b) => order(a) - order(b) || b.count - a.count || a.label.localeCompare(b.label));
  return { nodes: list, edges: [...edges.values()], events: n, targets: ranked.length, hiddenTargets: hidden, routineEvents: routineHits.length };
}
