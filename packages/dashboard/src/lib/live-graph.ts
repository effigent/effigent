/**
 * Agent graph built from control-plane events (GET /api/v1/events). Pure — no
 * React — so the rules for turning one event into graph nodes and edges live
 * in one place, next to live-map.ts:
 *
 *   machine ──runs──▶ agent ──action──▶ target
 *                      agent ──mcp──▶ MCP server ──action──▶ target   (body.via set)
 *
 * Targets are grouped by kind: commands (program name), files (path), network
 * destinations (ip:port / host) and tool calls. Only the busiest targets get a
 * node; the rest fold into one "+N more" node so no edge dangles.
 */
import type { ApiEvent } from './api.ts';

export type TargetKind = 'command' | 'file' | 'network' | 'tool' | 'more';
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
}

export interface LiveGraphOptions {
  since: number; // epoch ms; older events are ignored
  agent?: string | null; // only this agent name
  maxTargets: number;
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
}

const EVENT_IDS_CAP = 60;
const TARGET_TYPES = new Set(['exec', 'file_open', 'connect', 'blocked', 'would_block']);

const base = (p: string) => p.replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? p;
const unquote = (s: string) => s.replace(/^["'`]+|["'`]+$/g, '');

function dirLabel(path: string): string {
  const dir = path.replace(/\/+$/, '').split('/').slice(0, -1).join('/');
  if (!dir) return '/';
  const home = dir.replace(/^\/(?:Users|home)\/[^/]+/, '~').replace(/^\/root(?=\/|$)/, '~');
  const parts = home.split('/');
  return parts.length > 4 ? `…/${parts.slice(-3).join('/')}` : home;
}

const WRAPPERS = new Set(['sudo', 'env', 'time', 'nohup', 'exec', 'command', 'nice']);

/** The program a command line runs: "cd app && git status" → "git",
 *  "FOO=1 sudo /usr/bin/curl -s x" → "curl". */
export function programName(cmd: string): string {
  const segs = cmd.split(/&&|\|\||;|\|/).map((s) => s.trim().replace(/^[({\s]+|[)}\s]+$/g, '')).filter(Boolean);
  for (const seg of segs) {
    const toks = seg.split(/\s+/).map(unquote);
    let i = 0;
    while (i < toks.length && (/^[A-Za-z_][\w]*=/.test(toks[i]) || WRAPPERS.has(toks[i]))) i++;
    const t = toks[i];
    if (!t) continue;
    const name = base(t);
    if ((name === 'cd' || name === 'export' || name === 'source') && seg !== segs[segs.length - 1]) continue;
    return name || t;
  }
  return base(cmd.trim().split(/\s+/)[0] ?? cmd) || cmd;
}

const ADDR = /^(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+|[0-9a-f:]+):\d{1,5}$/i;

function hostOf(url: string): string | null {
  try { return new URL(url).host || null; } catch { return null; }
}

function command(value: string, action = 'exec', fallbackBinary?: string): Classified {
  const name = programName(value || fallbackBinary || '?');
  return { kind: 'command', key: name, label: name, sub: 'Command', full: value || fallbackBinary || name, action };
}
function file(path: string, action: string): Classified {
  return { kind: 'file', key: path, label: base(path) || path, sub: dirLabel(path), full: path, action };
}
function network(addr: string, action = 'connect'): Classified {
  return { kind: 'network', key: addr, label: addr, sub: 'Network', full: addr, action };
}

const FILE_READ = new Set(['Read', 'NotebookRead', 'LS']);
const FILE_WRITE = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** A hook-reported tool call ("Bash: git status", "Read: /work/.env", "mcp__github__create_issue"). */
function tool(name: string, value: string): Classified {
  const mcp = name.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/);
  if (mcp) return { kind: 'tool', key: `${mcp[1]}.${mcp[2]}`, label: mcp[2], sub: `${mcp[1]} tool`, full: `${name}${value ? `: ${value}` : ''}`, action: 'call', mcp: mcp[1] };
  if (name === 'Bash' && value) return command(value);
  if (FILE_READ.has(name) && value) return file(value, 'read');
  if (FILE_WRITE.has(name) && value) return file(value, 'write');
  if (name === 'WebFetch' && value) { const h = hostOf(value); if (h) return network(h, 'fetch'); }
  return { kind: 'tool', key: name, label: name, sub: 'Tool', full: value ? `${name}: ${value}` : name, action: name === 'WebSearch' ? 'search' : 'call' };
}

/** What an event touched, or null for lifecycle events (agent start/exit, policy) and events without a target. */
export function classify(e: ApiEvent): Classified | null {
  if (!TARGET_TYPES.has(e.type)) return null;
  const b = e.body ?? {};
  let raw = (b.target ?? '').trim();
  let hint: string | undefined = b.kind; // engine: agent | mcp | tool; hooks: exec | file_open | connect | tool
  const pre = raw.match(/^(exec|connect|open)\s+(.+)$/s);
  if (pre) { hint = pre[1] === 'open' ? 'file_open' : pre[1]; raw = pre[2].trim(); }

  let c: Classified | null = null;
  const t = hint === 'tool' || /^(?:[A-Z][A-Za-z]+|mcp__\S+): /s.test(raw) || /^mcp__\S+$/.test(raw) ? raw.match(/^([A-Za-z][\w.-]*)(?::\s*(.*))?$/s) : null;
  if (t) c = tool(t[1], (t[2] ?? '').trim());
  else if (hint === 'connect' || e.type === 'connect') c = network(hostOf(raw) ?? raw);
  else if (hint === 'file_open' || e.type === 'file_open') c = raw ? file(raw, 'open') : null;
  else if (hint === 'exec' || hint === 'agent' || hint === 'mcp' || e.type === 'exec') c = command(raw, 'exec', b.process?.binary);
  else if (raw) {
    // blocked / would_block without a kind: tell the target apart by shape (and the rule that matched).
    const rule = b.rule ?? '';
    if (/exec_/.test(rule)) c = command(raw);
    else if (/network/.test(rule) || ADDR.test(raw)) c = network(raw);
    else if (/^https?:\/\//.test(raw)) c = network(hostOf(raw) ?? raw, 'fetch');
    else if (/file_/.test(rule) || (/^[/~]/.test(raw) && !/\s/.test(raw))) c = file(raw, 'open');
    else c = command(raw);
  } else if (b.process?.binary) c = command('', 'exec', b.process.binary);
  if (!c) return null;

  const via = b.via?.trim();
  if (via && !c.mcp) c.mcp = via.startsWith('mcp:') ? via.slice(4) : via;
  return c;
}

const outcomeOf = (type: string): LiveOutcome => (type === 'blocked' ? 'blocked' : type === 'would_block' ? 'would_block' : 'allowed');

const KIND_ORDER: Record<TargetKind, number> = { command: 0, file: 1, network: 2, tool: 3, more: 4 };

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

  // Keep the busiest targets; fold the rest into "+N more".
  const tally = new Map<string, number>();
  for (const h of hits) tally.set(h.tid, (tally.get(h.tid) ?? 0) + 1);
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const kept = new Set(ranked.slice(0, Math.max(0, o.maxTargets)).map(([id]) => id));
  const hidden = ranked.length - kept.size;
  const MORE = 't:more';

  for (const h of hits) {
    const show = kept.has(h.tid);
    const tid = show ? h.tid : MORE;
    if (show) touch(tid, () => ({ kind: 'target', targetKind: h.c.kind, label: h.c.label, sub: h.c.sub, full: h.c.full }), h.outcome, h.at, h.ev);
    else touch(tid, () => ({ kind: 'target', targetKind: 'more', label: `+${hidden} more`, sub: hidden === 1 ? 'target' : 'targets', full: '' }), h.outcome, h.at, h.ev);
    const action = show ? h.c.action : 'other';
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
  return { nodes: list, edges: [...edges.values()], events: n, targets: ranked.length, hiddenTargets: hidden };
}
