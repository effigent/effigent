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
 * node; the rest fold into one "+N more" node so no edge dangles. Commands are
 * classified routine / normal / risky (command-risk.ts): routine ones fold into
 * one "Routine commands (N)" node per agent unless `showRoutine` is set, and
 * never count against the target cap.
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
  /** "Routine commands (N)" node: the commands folded into it, busiest first. */
  items?: { label: string; full: string; count: number }[];
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
  maxTargets: number;
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
  /** Commands only. */
  risk?: CommandRisk;
  rule?: string; // the risky-list entry that matched
}

/** Claude Code names MCP tools mcp__<server>__<tool>. */
export function parseMcpTool(name: string): { server: string; tool: string } | null {
  const m = name.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/);
  return m ? { server: m[1], tool: m[2] } : null;
}

const EVENT_IDS_CAP = 60;
const TARGET_TYPES = new Set(['exec', 'file_open', 'connect', 'blocked', 'would_block']);

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
  return { kind: 'command', key: `${risk === 'routine' ? '~' : risk === 'risky' ? '!' : ''}${name}`, label: name, sub: 'Command', full: value || fallbackBinary || name, action, risk, rule };
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
  const mcp = parseMcpTool(name);
  if (mcp) return { kind: 'tool', key: `${mcp.server}.${mcp.tool}`, label: mcp.tool, sub: `${mcp.server} tool`, full: `${name}${value ? `: ${value}` : ''}`, action: 'call', mcp: mcp.server };
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

  const via = b.via?.trim();
  if (via && !c.mcp) c.mcp = via.startsWith('mcp:') ? via.slice(4) : via;
  return c;
}

const outcomeOf = (type: string): LiveOutcome => (type === 'blocked' ? 'blocked' : type === 'would_block' ? 'would_block' : 'allowed');

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

  // Keep the busiest targets; fold the rest into "+N more".
  const tally = new Map<string, number>();
  for (const h of ranked0) tally.set(h.tid, (tally.get(h.tid) ?? 0) + 1);
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const kept = new Set(ranked.slice(0, Math.max(0, o.maxTargets)).map(([id]) => id));
  const hidden = ranked.length - kept.size;
  const MORE = 't:more';

  for (const h of hits) {
    if (h.c.risk === 'routine' && !o.showRoutine) continue;
    const folded = collapse && h.c.risk === 'routine';
    const show = folded || kept.has(h.tid);
    const tid = folded ? ROUTINE(h.agentId) : show ? h.tid : MORE;
    if (folded) {
      const n = routineCount.get(h.agentId) ?? 0;
      const items = [...(routineItems.get(h.agentId)?.values() ?? [])].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
      touch(tid, () => ({ kind: 'target', targetKind: 'routine', label: `Routine commands (${n.toLocaleString()})`, sub: items.slice(0, 3).map((i) => i.label).join(', ') + (items.length > 3 ? '…' : ''), full: items.map((i) => i.label).join(', '), risk: 'routine', items }), h.outcome, h.at, h.ev);
    } else if (show) touch(tid, () => ({ kind: 'target', targetKind: h.c.kind, label: h.c.label, sub: h.c.sub, full: h.c.full, risk: h.c.risk }), h.outcome, h.at, h.ev);
    else touch(tid, () => ({ kind: 'target', targetKind: 'more', label: `+${hidden} more`, sub: hidden === 1 ? 'target' : 'targets', full: '' }), h.outcome, h.at, h.ev);
    const action = folded ? 'exec' : show ? h.c.action : 'other';
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
