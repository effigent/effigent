'use client';
import { useEffect, useMemo, useState } from 'react';
import ReactFlow, { Background, BackgroundVariant, Controls, MiniMap, type Edge, type Node } from 'reactflow';
import 'reactflow/dist/style.css';
import { ALL_AGENTS } from '../data.ts';

interface KEntry { id: string; kind: string; tool: string; key: string; value: string; support: number; confidence: number; estUsdPerRun: number }
interface KNode { id: string; type: 'fact' | 'entity'; label: string; kind?: string; factId?: string; entityType?: string; degree: number }
interface KEdge { from: string; to: string; rel: 'about' | 'lists' | 'mentions' }
interface Knowledge { agentId: string; runCount: number; entries: KEntry[]; nodes: KNode[]; edges: KEdge[] }
interface AgentInsight { agentId: string; knowledge?: Knowledge | null }

const KIND_COLOR: Record<string, string> = {
  file: '#37d3e6', listing: '#5b9dff', search: '#ecb94a', fetch: '#9b7bff', value: '#35d29a',
};
const ENTITY_COLOR = '#9b7bff';
const colorOf = (n: KNode) => (n.type === 'entity' ? ENTITY_COLOR : KIND_COLOR[n.kind ?? ''] ?? '#66667a');

function layout(nodes: KNode[], edges: KEdge[]): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  const entities = nodes.filter((n) => n.type === 'entity');
  const facts = nodes.filter((n) => n.type === 'fact');
  const subjectOf = new Map<string, string>();
  for (const e of edges) if (e.rel === 'about') subjectOf.set(e.from, e.to);
  const R = Math.max(300, entities.length * 95);
  entities.forEach((n, i) => {
    const a = (2 * Math.PI * i) / Math.max(1, entities.length) - Math.PI / 2;
    pos.set(n.id, { x: R * Math.cos(a), y: R * Math.sin(a) });
  });
  const around = new Map<string, number>();
  facts.forEach((n, i) => {
    const sub = subjectOf.get(n.id);
    const base = sub ? pos.get(sub) : undefined;
    if (base) {
      const k = around.get(sub!) ?? 0;
      around.set(sub!, k + 1);
      const a = (2 * Math.PI * k) / 5 + 0.6;
      pos.set(n.id, { x: base.x + 155 * Math.cos(a), y: base.y + 155 * Math.sin(a) });
    } else {
      pos.set(n.id, { x: (i % 6) * 150 - 375, y: Math.floor(i / 6) * 100 });
    }
  });
  return pos;
}

const nodeLabel = (n: KNode) => {
  const color = colorOf(n);
  if (n.type === 'entity') {
    return (
      <span className="kgn kgn-entity">
        <span className="kgn-type" style={{ color }}>{n.entityType}</span>
        {n.label}
      </span>
    );
  }
  return (
    <span className="kgn kgn-fact">
      <span className="kgn-dot" style={{ background: color }} />
      {n.label}
    </span>
  );
};

export function KnowledgeGraphExplorer({ agent }: { agent: string }) {
  const [data, setData] = useState<Knowledge[]>([]);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState<string | null>(null);
  const [selId, setSelId] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    const q = agent && agent !== ALL_AGENTS ? `?agent=${encodeURIComponent(agent)}` : '';
    fetch(`/api/v1/insights${q}`)
      .then((r) => (r.ok ? r.json() : { insights: [] }))
      .then((d: { insights?: AgentInsight[] }) => {
        const kgs = (d.insights ?? [])
          .map((a) => a.knowledge)
          .filter((k): k is Knowledge => !!k && (k.nodes?.length ?? 0) > 0);
        setData(kgs);
        setPicked(kgs[0]?.agentId ?? null);
        setSelId(null);
      })
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, [agent]);

  const kg = useMemo(() => data.find((k) => k.agentId === picked) ?? data[0], [data, picked]);
  const nodeById = useMemo(() => new Map((kg?.nodes ?? []).map((n) => [n.id, n])), [kg]);
  const entryByFact = useMemo(() => new Map((kg?.entries ?? []).map((e) => [e.id, e])), [kg]);
  const positions = useMemo(() => (kg ? layout(kg.nodes, kg.edges) : new Map()), [kg]);

  const sel = selId ? nodeById.get(selId) : undefined;
  const neighbors = useMemo(() => {
    if (!kg || !selId) return null;
    const set = new Set<string>([selId]);
    for (const e of kg.edges) {
      if (e.from === selId) set.add(e.to);
      if (e.to === selId) set.add(e.from);
    }
    return set;
  }, [kg, selId]);

  const { nodes, edges } = useMemo(() => {
    if (!kg) return { nodes: [] as Node[], edges: [] as Edge[] };
    const nodes: Node[] = kg.nodes.map((n) => {
      const color = colorOf(n);
      const isEntity = n.type === 'entity';
      const dim = neighbors ? !neighbors.has(n.id) : false;
      const isSel = n.id === selId;
      return {
        id: n.id,
        position: positions.get(n.id) ?? { x: 0, y: 0 },
        data: { label: nodeLabel(n) },
        className: `kg-node ${isEntity ? 'is-entity' : 'is-fact'}${isSel ? ' is-sel' : ''}`,
        style: {
          '--kg-c': color,
          opacity: dim ? 0.2 : 1,
        } as React.CSSProperties,
      };
    });
    const edges: Edge[] = kg.edges.map((e, i) => {
      const incident = selId ? e.from === selId || e.to === selId : false;
      const muted = neighbors ? !incident : false;
      const c = e.rel === 'about' ? '#3a3a4a' : ENTITY_COLOR;
      return {
        id: `e${i}`,
        source: e.from,
        target: e.to,
        type: 'smoothstep',
        label: !neighbors || incident ? e.rel : undefined,
        animated: e.rel !== 'about' && (!neighbors || incident),
        style: { stroke: incident ? '#c9b8ff' : c, strokeWidth: incident ? 2 : 1, opacity: muted ? 0.07 : 0.9 },
        labelStyle: { fill: 'var(--txt-3)', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.06em' },
        labelBgStyle: { fill: 'var(--panel)', fillOpacity: 0.9 },
        labelBgPadding: [4, 2],
      };
    });
    return { nodes, edges };
  }, [kg, positions, neighbors, selId]);

  if (loading) return <div className="dag-empty">Building the knowledge graph…</div>;
  if (!kg) {
    return (
      <div className="dag-empty">
        No knowledge graph yet — it appears once an agent repeats stable lookups across runs
        (globs, greps, file reads) with the same answers.
      </div>
    );
  }

  const selEntry = sel?.factId ? entryByFact.get(sel.factId) : undefined;
  const connected = sel
    ? kg.edges
        .filter((e) => e.from === sel.id || e.to === sel.id)
        .map((e) => ({ node: nodeById.get(e.from === sel.id ? e.to : e.from), rel: e.rel }))
        .filter((c): c is { node: KNode; rel: KEdge['rel'] } => !!c.node)
    : [];

  return (
    <div className="page-stack">
      <div className="kg-explorer-bar">
        <span className="panel-sub">
          <b>{kg.nodes.filter((n) => n.type === 'entity').length}</b> concepts ·{' '}
          <b>{kg.nodes.filter((n) => n.type === 'fact').length}</b> facts ·{' '}
          <b>{kg.edges.length}</b> connections · mined from {kg.runCount} runs
          <span className="kg-hint"> — click a node to focus its connections</span>
        </span>
        {data.length > 1 && (
          <select className="kg-agent-select" value={picked ?? ''} onChange={(e) => { setPicked(e.target.value); setSelId(null); }}>
            {data.map((k) => <option key={k.agentId} value={k.agentId}>{k.agentId}</option>)}
          </select>
        )}
      </div>

      <div className="kg-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.2}
          nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_, n) => setSelId(n.id)}
          onPaneClick={() => setSelId(null)}
        >
          <Background variant={BackgroundVariant.Dots} color="#26263a" gap={20} size={1} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeColor={(n) => (nodeById.get(n.id)?.type === 'entity' ? ENTITY_COLOR : '#3a3a4a')} maskColor="rgba(6,6,12,0.72)" style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8 }} />
        </ReactFlow>

        {sel && (
          <div className="kg-detail">
            <div className="kg-detail-head">
              <span className="kg-detail-badge" style={{ '--kg-c': colorOf(sel) } as React.CSSProperties}>
                {sel.type === 'entity' ? sel.entityType : sel.kind}
              </span>
              <button className="kg-detail-x" onClick={() => setSelId(null)} aria-label="close">×</button>
            </div>
            <div className="kg-detail-title mono-name">{sel.label}</div>
            {selEntry ? (
              <>
                <div className="panel-sub" style={{ margin: '6px 0 10px' }}>
                  {selEntry.support}× · confidence {selEntry.confidence}/100 · ~${selEntry.estUsdPerRun}/run to re-derive
                </div>
                <pre className="kg-detail-val">{selEntry.value.slice(0, 1400)}</pre>
              </>
            ) : (
              <div className="panel-sub" style={{ margin: '6px 0 10px' }}>
                {sel.type === 'entity' ? `Concept · ${sel.degree} connection${sel.degree === 1 ? '' : 's'}` : 'Fact node'}
              </div>
            )}
            {connected.length > 0 && (
              <div className="kg-detail-conns">
                <div className="kg-detail-conns-h">Connected</div>
                {connected.map((c, i) => (
                  <button key={i} className="kg-chip" onClick={() => setSelId(c.node.id)}>
                    <span className="kg-chip-rel">{c.rel}</span>
                    <span className="kg-chip-dot" style={{ background: colorOf(c.node) }} />
                    {c.node.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
