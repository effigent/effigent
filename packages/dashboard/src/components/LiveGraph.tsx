'use client';

/**
 * The agent graph built from the workspace's real events (lib/live-graph.ts),
 * rendered with the same canvas, nodes and edges as the demo graph.
 */
import Link from 'next/link';
import { useMemo } from 'react';
import { MarkerType } from '@xyflow/react';
import { agentMeta } from '@/data.ts';
import { Ic } from '@/icons.tsx';
import { RANGE_MS, useLive } from '@/live.tsx';
import { useStore, type Range } from '@/store.tsx';
import { ago, type EndpointRow } from '@/lib/live-map.ts';
import { buildLiveGraph, type LiveEdge, type LiveGraph, type LiveNode, type TargetKind } from '@/lib/live-graph.ts';
import type { ConsoleEvent, Outcome as EventOutcome } from '@/types.ts';
import { EDGE_COLOR, GraphCanvas, type GEdge, type GNode, type GNodeData } from './AgentGraph.tsx';
import { Empty, OutcomePill, RiskyTag } from './ui.tsx';

export const RANGE_LABEL: Record<Range, string> = { '1h': 'last hour', '24h': 'last 24 hours', '7d': 'last 7 days', '30d': 'last 30 days' };

export interface LiveGraphData {
  graph: LiveGraph;
  loaded: boolean;
  /** Any agent event in the fetched window at all (ignoring range and filter). */
  anyEvents: boolean;
  enrolled: number;
  endpointById: Map<string, EndpointRow>;
  eventById: Map<number, ConsoleEvent>;
  /** Agent names seen in the range, with how many machines run each. */
  agents: { name: string; machines: number; events: number }[];
  rangeLabel: string;
  now: number;
  showRoutine: boolean;
}

/** The live graph for the current time range (and optionally one agent name). */
export function useLiveGraph({ maxTargets, agent, showRoutine = false }: { maxTargets: number; agent?: string | null; showRoutine?: boolean }): LiveGraphData {
  const { events, consoleEvents, endpointRows, loaded, now } = useLive();
  const { range } = useStore();
  const since = now - RANGE_MS[range];

  const endpointById = useMemo(() => new Map(endpointRows.map((e) => [e.id, e])), [endpointRows]);
  const hostById = useMemo(() => new Map(endpointRows.map((e) => [e.id, e.hostname])), [endpointRows]);
  const graph = useMemo(() => buildLiveGraph(events, hostById, { since, agent, maxTargets, showRoutine }), [events, hostById, since, agent, maxTargets, showRoutine]);
  const eventById = useMemo(() => new Map(consoleEvents.map((e, i) => [events[i]?.id ?? -1, e])), [consoleEvents, events]);
  const agents = useMemo(() => {
    const m = new Map<string, { machines: Set<string>; events: number }>();
    for (const e of events) {
      const name = e.agent || e.body?.agent;
      const at = Date.parse(e.time);
      if (!name || !(at >= since)) continue;
      const a = m.get(name) ?? { machines: new Set<string>(), events: 0 };
      a.machines.add(e.endpoint_id);
      a.events++;
      m.set(name, a);
    }
    return [...m.entries()].map(([name, a]) => ({ name, machines: a.machines.size, events: a.events })).sort((a, b) => b.events - a.events);
  }, [events, since]);

  return {
    graph, loaded, now, endpointById, eventById, agents,
    anyEvents: events.some((e) => e.agent || e.body?.agent),
    enrolled: endpointRows.filter((e) => !e.revoked).length,
    rangeLabel: RANGE_LABEL[range],
    showRoutine,
  };
}

const TARGET_ICON: Record<TargetKind, string> = { command: 'terminal', file: 'file', network: 'globe', tool: 'hook', routine: 'layers', more: 'more' };
const SIZE = { machine: 54, agent: 66, mcp: 50, target: 46 } as const;

export function nodeIcon(n: LiveNode, endpointById: Map<string, EndpointRow>): string {
  if (n.kind === 'machine') return endpointById.get(n.endpoint ?? '')?.platform === 'linux' ? 'server' : 'laptop';
  if (n.kind === 'agent') return agentMeta(n.agent).icon;
  if (n.kind === 'mcp') return 'plug';
  return TARGET_ICON[n.targetKind ?? 'more'];
}

/** Human name for a node, as used in lists and the detail panel. */
export function nodeLabel(n: LiveNode | undefined): string {
  if (!n) return '—';
  if (n.kind === 'agent') return agentMeta(n.agent).label;
  if (n.kind === 'mcp') return `MCP ${n.label}`;
  return n.label;
}

const KIND_SUB: Record<TargetKind, string> = { command: 'Command', file: 'File', network: 'Network', tool: 'Tool', routine: 'Routine', more: 'Other targets' };

/** Risky command targets get the amber "risky" look unless policy already blocked them (red wins). */
export const isRisky = (n: LiveNode | undefined) => !!n && n.risk === 'risky' && tone(n) !== 'bad';

export function nodeSub(n: LiveNode, endpointById: Map<string, EndpointRow>): string {
  if (n.kind === 'machine') {
    const ep = endpointById.get(n.endpoint ?? '');
    return ep ? `${ep.os}${ep.revoked ? ' · revoked' : ''}` : 'Machine';
  }
  if (n.kind === 'target' && (n.targetKind === 'routine' || n.targetKind === 'more')) return n.sub;
  const times = ` · ${n.count.toLocaleString()}×`;
  if (n.kind === 'target' && n.group?.startsWith('mcp:')) return 'Tool' + times; // the server is the node it hangs off
  if (n.kind === 'target' && (n.targetKind === 'file' || n.targetKind === 'tool')) return n.sub + times;
  if (n.kind === 'target' && n.risk === 'routine') return 'Routine command' + times;
  if (n.kind === 'target') return KIND_SUB[n.targetKind ?? 'more'] + times;
  return n.sub;
}

function tone(n: LiveNode): GNodeData['tone'] {
  if (n.kind === 'machine') return 'user';
  if (n.kind === 'agent') return 'agent';
  if (n.allowed > 0) return 'ok';
  return n.blocked > 0 ? 'bad' : n.wouldBlock > 0 ? 'warn' : 'ok';
}

/** Tree layout: machines → agents → what they touched, in one column grouped
 *  by kind (commands, network, files, tools, routine), followed by each MCP
 *  server with its tools in the next column. Groups never interleave, so an
 *  agent's edges fan out without crossing. */
const DIRECT_ORDER = ['command', 'network', 'file', 'tool', 'routine'];

export function toFlow(g: LiveGraph, endpointById: Map<string, EndpointRow>, o: { selected?: string | null; compact?: boolean }): { nodes: GNode[]; edges: GEdge[] } {
  const machines = g.nodes.filter((n) => n.kind === 'machine');
  const agents = machines.flatMap((m) => g.nodes.filter((a) => a.kind === 'agent' && a.endpoint === m.endpoint));
  const mcps = g.nodes.filter((n) => n.kind === 'mcp');
  const targets = g.nodes.filter((n) => n.kind === 'target');

  const pos = new Map<string, [number, number]>();
  const col = (ns: LiveNode[], x: number, gap: number) => ns.forEach((n, i) => pos.set(n.id, [x, (i - (ns.length - 1) / 2) * gap]));
  // Agents first (grouped by machine); each machine sits level with its own agents.
  col(agents, 360, 120);
  for (const m of machines) {
    const ys = agents.filter((a) => a.endpoint === m.endpoint).map((a) => pos.get(a.id)![1]);
    pos.set(m.id, [0, ys.length ? ys.reduce((t, y) => t + y, 0) / ys.length : 0]);
  }

  // Group targets; within a group the busiest first and "+N more" last.
  const groups = new Map<string, LiveNode[]>();
  for (const t of targets) {
    const k = t.group ?? t.targetKind ?? 'more';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(t);
  }
  for (const list of groups.values()) list.sort((a, b) => Number(a.targetKind === 'more') - Number(b.targetKind === 'more') || b.count - a.count || a.label.localeCompare(b.label));
  const direct = [...groups.keys()].filter((k) => !k.startsWith('mcp:'))
    .sort((a, b) => (DIRECT_ORDER.indexOf(a) + 1 || 99) - (DIRECT_ORDER.indexOf(b) + 1 || 99));

  const ROW = o.compact ? 54 : 60, GAP = ROW * 0.7, X1 = 700, X2 = 1010;
  let y = 0;
  const placed: [string, number, number][] = [];
  for (const k of direct) {
    for (const t of groups.get(k)!) { placed.push([t.id, X1, y]); y += ROW; }
    y += GAP;
  }
  for (const m of mcps) {
    const tools = groups.get(`mcp:${m.label}`) ?? [];
    const h = Math.max(1, tools.length);
    placed.push([m.id, X1, y + ((h - 1) * ROW) / 2]);
    tools.forEach((t, i) => placed.push([t.id, X2, y + i * ROW]));
    y += h * ROW + GAP;
  }
  const mid = (y - GAP - ROW) / 2;
  for (const [id, x, py] of placed) pos.set(id, [x, py - mid]);

  const sel = o.selected && g.nodes.some((n) => n.id === o.selected) ? o.selected : null;
  const near = new Set<string>();
  if (sel) for (const e of g.edges) if (e.source === sel || e.target === sel) { near.add(e.source); near.add(e.target); }

  const nodes: GNode[] = g.nodes.map((n) => {
    const size = SIZE[n.kind];
    const [cx, cy] = pos.get(n.id) ?? [0, 0];
    const kind = n.kind === 'target' ? 'resource' : n.kind;
    return {
      id: n.id, type: 'circle', position: { x: cx - size / 2, y: cy - size / 2 },
      data: {
        kind, label: n.kind === 'mcp' ? n.label : nodeLabel(n), sub: nodeSub(n, endpointById), icon: nodeIcon(n, endpointById), size,
        tone: tone(n), labelPos: n.kind === 'target' ? 'right' : 'below',
        color: n.kind === 'agent' ? agentMeta(n.agent).color : undefined,
        dim: !!sel && !near.has(n.id), selected: sel === n.id,
        risky: isRisky(n), muted: n.risk === 'routine',
      },
      draggable: !o.compact, selectable: true,
    };
  });

  // Labels on the trunk (machine → agent, agent → MCP server); a target's count is on its node.
  const kindOf = new Map(g.nodes.map((n) => [n.id, n.kind]));
  const trunk = (e: LiveGraph['edges'][number]) => kindOf.get(e.target) === 'agent' || kindOf.get(e.target) === 'mcp';
  const seen = new Map<string, number>();
  const edges: GEdge[] = g.edges.map((e) => {
    const key = [e.source, e.target].sort().join('>');
    const k = seen.get(key) ?? 0;
    seen.set(key, k + 1);
    const curve = k === 0 ? 0.04 : (k % 2 ? -1 : 1) * (0.12 + 0.06 * k);
    const touches = !!sel && (e.source === sel || e.target === sel);
    const color = EDGE_COLOR[e.outcome];
    return {
      id: e.id, source: e.source, target: e.target, type: 'float',
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 15, height: 15 },
      data: {
        outcome: e.outcome, label: `${e.action} · ${e.count.toLocaleString()}`, curve, count: e.count,
        showLabel: touches || (!sel && trunk(e)), dim: !!sel && !touches,
      },
      selectable: false,
    };
  });
  return { nodes, edges };
}

/** Cheap stable fingerprint of the node set: the canvas refits when it changes. */
function signature(g: LiveGraph): string {
  let h = 0;
  for (const n of g.nodes) for (let i = 0; i < n.id.length; i++) h = (h * 31 + n.id.charCodeAt(i)) | 0;
  return `${g.nodes.length}-${h}`;
}

export function LiveGraphCanvas({ data, selected, onSelect, height, compact, interactive = true, background }: {
  data: LiveGraphData; selected?: string | null; onSelect?: (id: string | null) => void; height: number | string;
  compact?: boolean; interactive?: boolean; background?: boolean;
}) {
  const { graph, endpointById } = data;
  const { nodes, edges } = useMemo(() => toFlow(graph, endpointById, { selected, compact }), [graph, endpointById, selected, compact]);
  return (
    <GraphCanvas key={signature(graph)} nodes={nodes} edges={edges} interactive={interactive} fitPadding={compact ? 0.08 : 0.12} minZoom={0.15}
      selected={selected} onSelect={onSelect} height={height} background={background} />
  );
}

/** No graph to draw: say why, and how to get one. */
export function LiveGraphEmpty({ data, filtered }: { data: LiveGraphData; filtered?: boolean }) {
  if (filtered) return <Empty icon="graph" title="No activity for this selection" sub={`This agent reported nothing in the ${data.rangeLabel}.`} />;
  if (data.anyEvents) {
    return <Empty icon="graph" title={`No agent activity in the ${data.rangeLabel}`} sub="Pick a longer time range — the graph is built from the latest events your machines reported." />;
  }
  return (
    <div className="empty coming-soon">
      <Ic n="graph" size={22} />
      <div className="empty-title">No agent activity yet</div>
      <div className="empty-sub">
        The graph fills in once an enrolled machine runs an agent — Claude Code, Codex, Cursor and others are recognised automatically,
        and every command, file, connection and MCP server they touch shows up here.
        {data.enrolled > 0 ? ` ${data.enrolled} machine${data.enrolled === 1 ? ' is' : 's are'} enrolled; start an agent on one to see it.` : ''}
      </div>
      <Link className="btn sm" href="/enforcement#enroll"><Ic n="laptop" size={14} /> Enforcement → Enroll a machine</Link>
    </div>
  );
}

const RESULT: Record<LiveEdge['outcome'], EventOutcome> = { allowed: 'allowed', blocked: 'blocked', would_block: 'would_block', flow: 'system' };

/** Table form of the graph: every agent → target connection, busiest first. */
export function LiveEdgeList({ data }: { data: LiveGraphData }) {
  const byId = useMemo(() => new Map(data.graph.nodes.map((n) => [n.id, n])), [data.graph]);
  const rows = useMemo(() => data.graph.edges.filter((e) => e.outcome !== 'flow').sort((a, b) => b.count - a.count || b.lastAt - a.lastAt), [data.graph]);
  const cell = (n: LiveNode | undefined) => n && (
    <span className="agent-cell">
      <span className="res-glyph"><Ic n={nodeIcon(n, data.endpointById)} size={15} /></span>
      <span style={{ minWidth: 0 }}><span className="cell-main">{nodeLabel(n)}{isRisky(n) && <> <RiskyTag /></>}</span><span className="cell-sub">{nodeSub(n, data.endpointById)}</span></span>
    </span>
  );
  if (rows.length === 0) return <Empty icon="graph" title="No connections in this range" sub="Agents ran, but reported no commands, files or connections." />;
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr><th>From</th><th>Action</th><th>To</th><th>Result</th><th className="num">Events</th><th>Last seen</th></tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id}>
              <td>{cell(byId.get(e.source))}</td>
              <td><span className="mono-chip" style={{ color: EDGE_COLOR[e.outcome] }}>{e.action}</span></td>
              <td title={byId.get(e.target)?.full}>{cell(byId.get(e.target))}</td>
              <td><OutcomePill outcome={RESULT[e.outcome]} /></td>
              <td className="num tnum">{e.count.toLocaleString()}</td>
              <td className="muted">{ago(e.lastAt, data.now)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
