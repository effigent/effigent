'use client';

import '@xyflow/react/dist/style.css';
import { useMemo } from 'react';
import {
  Background, BackgroundVariant, BaseEdge, Controls, EdgeLabelRenderer, Handle, MarkerType, Position, ReactFlow,
  useInternalNode, type Edge, type EdgeProps, type Node, type NodeProps,
} from '@xyflow/react';
import { AGENTS, AGENT_TYPES, RESOURCES, resourceById, userById } from '@/data.ts';
import { Ic } from '@/icons.tsx';
import type { AgentType, Env, Flow } from '@/types.ts';

/** Demo flows use the first four; live (event-built) edges add would_block. */
export type Outcome = Flow['outcome'] | 'would_block';
export const EDGE_COLOR: Record<Outcome, string> = {
  allowed: '#34d399',
  blocked: '#fb7185',
  flow: '#5b8bff',
  pending: '#fbbf24',
  would_block: '#fb923c',
};

/** user/agent/resource: the demo graph; machine/mcp: the live graph. */
export type NodeKind = 'user' | 'agent' | 'resource' | 'machine' | 'mcp';
export type GNodeData = {
  kind: NodeKind; label: string; sub: string; icon: string; size: number;
  tone: 'user' | 'agent' | 'ok' | 'bad' | 'warn'; labelPos: 'right' | 'below' | 'left';
  color?: string; dim?: boolean; selected?: boolean;
};
export type GNode = Node<GNodeData, 'circle'>;
export type GEdgeData = { outcome: Outcome; label: string; curve: number; showLabel: boolean; dim?: boolean; count: number };
export type GEdge = Edge<GEdgeData, 'float'>;

const SIZE: Record<NodeKind, number> = { user: 58, agent: 86, resource: 62, machine: 58, mcp: 54 };

function CircleNode({ data }: NodeProps<GNode>) {
  // The node box is the circle plus (for side labels) the label, so fitView
  // keeps labels on screen; edges anchor on the circle via data.size.
  return (
    <div className={`gnode gnode-${data.kind} tone-${data.tone} lp-${data.labelPos} ${data.dim ? 'dim' : ''} ${data.selected ? 'sel' : ''}`}
      style={{ height: data.size, ['--agent' as string]: data.color }}>
      <Handle type="target" position={Position.Left} className="ghandle" isConnectable={false} />
      <Handle type="source" position={Position.Right} className="ghandle" isConnectable={false} />
      <div className="gnode-circle" style={{ width: data.size, height: data.size }}><Ic n={data.icon} size={Math.round(data.size * 0.42)} /></div>
      <div className="gnode-label">
        <div className="gl-main">{data.label}</div>
        <div className="gl-sub">{data.sub}</div>
      </div>
    </div>
  );
}

/** Straight-ish edge between circle rims (no fixed handles), label at the
 *  curve's midpoint, and a dot travelling along live (allowed/flow) edges. */
function FloatEdge({ id, source, target, markerEnd, data }: EdgeProps<GEdge>) {
  const s = useInternalNode(source);
  const t = useInternalNode(target);
  if (!s || !t || !data) return null;
  const sd = s.data as GNodeData, td = t.data as GNodeData;
  const sp = s.internals.positionAbsolute, tp = t.internals.positionAbsolute;
  const sc = { x: sp.x + sd.size / 2, y: sp.y + sd.size / 2 };
  const tc = { x: tp.x + td.size / 2, y: tp.y + td.size / 2 };
  const dx = tc.x - sc.x, dy = tc.y - sc.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  // A right-labelled source heading right leaves from the end of its label
  // (as in the design) instead of striking through it.
  const fromLabel = sd.labelPos === 'right' && dx > 0 && Math.abs(dy) < dx * 1.4;
  const p0 = fromLabel
    ? { x: sp.x + (s.measured.width ?? sd.size) + 8, y: sc.y }
    : { x: sc.x + ux * (sd.size / 2 + 5), y: sc.y + uy * (sd.size / 2 + 5) };
  const p2 = { x: tc.x - ux * (td.size / 2 + 9), y: tc.y - uy * (td.size / 2 + 9) };
  const c = { x: (p0.x + p2.x) / 2 - uy * data.curve * len, y: (p0.y + p2.y) / 2 + ux * data.curve * len };
  const d = `M ${p0.x},${p0.y} Q ${c.x},${c.y} ${p2.x},${p2.y}`;
  const lx = 0.25 * p0.x + 0.5 * c.x + 0.25 * p2.x;
  const ly = 0.25 * p0.y + 0.5 * c.y + 0.25 * p2.y;
  const color = EDGE_COLOR[data.outcome];
  const dashed = data.outcome === 'blocked' || data.outcome === 'pending' || data.outcome === 'would_block';
  const live = !data.dim && (data.outcome === 'allowed' || data.outcome === 'flow');
  return (
    <>
      <BaseEdge id={id} path={d} markerEnd={markerEnd}
        className={`gedge ${dashed ? 'dashed' : ''} ${data.dim ? 'dim' : ''}`}
        style={{ stroke: color, strokeWidth: 1.7, strokeDasharray: dashed ? '6 5' : undefined }} />
      {live && (
        <circle r={2.6} fill={color} opacity={0.9}>
          <animateMotion dur={`${Math.max(1.6, len / 140)}s`} repeatCount="indefinite" path={d} />
        </circle>
      )}
      {data.showLabel && !data.dim && (
        <EdgeLabelRenderer>
          <div className="glabel" style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)`, color }}>
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { circle: CircleNode };
const edgeTypes = { float: FloatEdge };

/** Hand-placed centres for the overview's Claude Code graph (matches the design). */
const HERO: Record<string, [number, number]> = {
  'claude-code': [0, 0],
  'jane.doe': [-420, -95], 'alex.wang': [-440, 30], 'sarah.lee': [-415, 155],
  github: [70, -160], terminal: [290, 0], slack: [480, -130], network: [490, 140], postgres: [235, 225],
};

export interface GraphOptions {
  focus: AgentType | 'all';
  env: Env | null;
  hero?: boolean; // overview layout: hand-placed, resources limited to HERO
  selected?: string | null;
}

/** Flows visible under an environment filter (users/agent types present in that env). */
export function visibleFlows(focus: AgentType | 'all', env: Env | null, flows: Flow[]): Flow[] {
  const inEnvTypes = new Set(AGENTS.filter((a) => !env || a.env === env).map((a) => a.type));
  const inEnvUsers = new Set(AGENTS.filter((a) => !env || a.env === env).map((a) => `${a.user}|${a.type}`));
  return flows.filter((f) => {
    if (focus !== 'all' && f.agentType !== focus) return false;
    if (!inEnvTypes.has(f.agentType)) return false;
    if (userById(f.from)) return inEnvUsers.has(`${f.from}|${f.agentType}`);
    return true;
  });
}

export function buildGraph(flows: Flow[], o: GraphOptions): { nodes: GNode[]; edges: GEdge[] } {
  let fl = visibleFlows(o.focus, o.env, flows);
  if (o.hero) fl = fl.filter((f) => HERO[f.from] && HERO[f.to]);

  const users: string[] = [];
  const agents: AgentType[] = [];
  const resources: string[] = [];
  const add = <T,>(arr: T[], v: T) => { if (!arr.includes(v)) arr.push(v); };
  for (const f of fl) {
    for (const id of [f.from, f.to]) {
      if (userById(id)) add(users, id);
      else if (id in AGENT_TYPES) add(agents, id as AgentType);
      else if (resourceById(id)) add(resources, id);
    }
  }
  resources.sort((a, b) => RESOURCES.findIndex((r) => r.id === a) - RESOURCES.findIndex((r) => r.id === b));

  // Neighbourhood of the selected node (for dimming the rest).
  const sel = o.selected ?? null;
  const near = new Set<string>();
  if (sel) for (const f of fl) if (f.from === sel || f.to === sel) { near.add(f.from); near.add(f.to); }
  const dimNode = (id: string) => !!sel && !near.has(id);

  const pos = new Map<string, [number, number]>();
  if (o.hero) {
    for (const id of [...users, ...agents, ...resources]) pos.set(id, HERO[id]);
  } else if (o.focus !== 'all') {
    pos.set(o.focus, [0, 0]);
    users.forEach((u, i) => {
      const y = (i - (users.length - 1) / 2) * 125;
      pos.set(u, [-380 + Math.abs(y) * 0.12, y]);
    });
    const n = resources.length;
    resources.forEach((r, i) => {
      const a = n === 1 ? 0 : (-70 + (140 * i) / (n - 1)) * (Math.PI / 180);
      const rad = i % 2 === 0 ? 290 : 450;
      pos.set(r, [Math.cos(a) * rad * 1.05 + 40, Math.sin(a) * rad * 0.72]);
    });
  } else {
    const col = (ids: string[], x: number, gap: number) =>
      ids.forEach((id, i) => pos.set(id, [x, (i - (ids.length - 1) / 2) * gap]));
    col(users, 0, 92);
    col(agents, 430, 150);
    col(resources, 880, 118);
  }

  const node = (id: string, kind: NodeKind, d: Omit<GNodeData, 'kind' | 'size' | 'dim' | 'selected'>): GNode => {
    const size = SIZE[kind];
    const [cx, cy] = pos.get(id) ?? [0, 0];
    return {
      id, type: 'circle', position: { x: cx - size / 2, y: cy - size / 2 },
      data: { ...d, kind, size, dim: dimNode(id), selected: sel === id },
      draggable: !o.hero, selectable: !o.hero,
    };
  };

  const nodes: GNode[] = [
    ...users.map((u) => {
      const usr = userById(u)!;
      return node(u, 'user', { label: u, sub: usr.title, icon: 'user', tone: 'user', labelPos: 'right' });
    }),
    ...agents.map((t) => node(t, 'agent', {
      label: AGENT_TYPES[t].label, sub: AGENT_TYPES[t].kind, icon: AGENT_TYPES[t].icon, tone: 'agent', labelPos: 'below', color: AGENT_TYPES[t].color,
    })),
    ...resources.map((r) => {
      const res = resourceById(r)!;
      const into = fl.filter((f) => f.to === r);
      const tone = into.some((f) => f.outcome === 'blocked') && !into.some((f) => f.outcome === 'allowed') ? 'bad'
        : into.some((f) => f.outcome === 'pending') && !into.some((f) => f.outcome === 'allowed') ? 'warn' : 'ok';
      return node(r, 'resource', { label: res.label, sub: res.sub, icon: res.icon, tone, labelPos: 'right' });
    }),
  ];

  // Parallel flows between the same pair fan out with opposite curvature.
  const seen = new Map<string, number>();
  const edges: GEdge[] = fl.map((f) => {
    const key = [f.from, f.to].sort().join('>');
    const k = seen.get(key) ?? 0;
    seen.set(key, k + 1);
    const base = o.hero ? (f.from in HERO && userById(f.from) ? -0.08 : 0.06) : 0.05;
    const curve = k === 0 ? base : (k % 2 ? -1 : 1) * (0.12 + 0.06 * k);
    const touchesSel = !!sel && (f.from === sel || f.to === sel);
    const color = EDGE_COLOR[f.outcome];
    return {
      id: f.id, source: f.from, target: f.to, type: 'float',
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 15, height: 15 },
      data: {
        outcome: f.outcome, label: f.label, curve, count: f.count24h,
        showLabel: o.focus !== 'all' || touchesSel,
        dim: !!sel && !touchesSel,
      },
      selectable: false,
    };
  });

  return { nodes, edges };
}

export function AgentGraph({
  flows, focus, env, hero, selected, onSelect, height, background,
}: GraphOptions & { flows: Flow[]; onSelect?: (id: string | null) => void; height: number | string; background?: boolean }) {
  const { nodes, edges } = useMemo(() => buildGraph(flows, { focus, env, hero, selected }), [flows, focus, env, hero, selected]);
  return (
    <GraphCanvas key={`${focus}-${env ?? 'all'}-${hero ? 'h' : 'f'}`} nodes={nodes} edges={edges} interactive={!hero}
      fitPadding={hero ? 0.06 : 0.14} selected={selected} onSelect={onSelect} height={height} background={background} />
  );
}

/** The React Flow canvas both graphs render into (demo flows and live events). */
export function GraphCanvas({
  nodes, edges, interactive, fitPadding = 0.14, minZoom = 0.3, selected, onSelect, height, background,
}: {
  nodes: GNode[]; edges: GEdge[]; interactive: boolean; fitPadding?: number; minZoom?: number;
  selected?: string | null; onSelect?: (id: string | null) => void; height: number | string; background?: boolean;
}) {
  return (
    <div className="graph-canvas" style={{ height }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        colorMode="dark"
        fitView
        fitViewOptions={{ padding: fitPadding, maxZoom: 1.15 }}
        minZoom={minZoom}
        maxZoom={2}
        nodesConnectable={false}
        nodesDraggable={interactive}
        elementsSelectable={interactive}
        panOnDrag={interactive}
        zoomOnScroll={false}
        zoomOnPinch={interactive}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        onNodeClick={(_: React.MouseEvent, n: Node) => onSelect?.(selected === n.id ? null : n.id)}
        onPaneClick={() => onSelect?.(null)}
      >
        {background && <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="rgba(138,168,255,0.10)" />}
        {interactive && <Controls showInteractive={false} position="bottom-right" />}
      </ReactFlow>
    </div>
  );
}

export function Legend({ live }: { live?: boolean }) {
  if (live) {
    return (
      <div className="legend">
        <span><i className="lg-dot" style={{ background: EDGE_COLOR.allowed }} /> Allowed</span>
        <span><i className="lg-dash" style={{ color: EDGE_COLOR.blocked }} /> Blocked</span>
        <span><i className="lg-dash" style={{ color: EDGE_COLOR.would_block }} /> Would block</span>
        <span><i className="lg-line" style={{ background: EDGE_COLOR.flow }} /> Machine → agent</span>
      </div>
    );
  }
  return (
    <div className="legend">
      <span><i className="lg-dot" style={{ background: EDGE_COLOR.allowed }} /> Allowed</span>
      <span><i className="lg-dot" style={{ background: EDGE_COLOR.blocked }} /> Blocked</span>
      <span><i className="lg-line" style={{ background: EDGE_COLOR.flow }} /> Data Flow</span>
      <span><i className="lg-dash" style={{ color: EDGE_COLOR.pending }} /> Pending Approval</span>
    </div>
  );
}
