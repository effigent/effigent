'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { AGENTS, AGENT_TYPES, FLOWS, agentMeta, endpointById, envMeta, resourceById, userById } from '@/data.ts';
import { Ic } from '@/icons.tsx';
import { useStore } from '@/store.tsx';
import { useDemoMode } from '@/demo.tsx';
import type { AgentType } from '@/types.ts';
import { AgentGraph, EDGE_COLOR, Legend, visibleFlows } from '@/components/AgentGraph.tsx';
import { FlowList } from '@/components/GraphCard.tsx';
import { RangeSelect } from '@/components/RangeSelect.tsx';
import {
  LiveEdgeList, LiveGraphCanvas, LiveGraphEmpty, nodeIcon, nodeLabel, nodeSub, useLiveGraph, type LiveGraphData,
} from '@/components/LiveGraph.tsx';
import { ago } from '@/lib/live-map.ts';
import {
  AgentCell, AgentGlyph, Card, CardHead, EnvTag, Loading, ModeTag, OutcomePill, PageHead, Seg, StatusPill, UserCell, initials,
} from '@/components/ui.tsx';

type Focus = AgentType | 'all';

function Detail({ id, focus }: { id: string | null; focus: Focus }) {
  const { env, inEnv } = useStore();
  const flows = visibleFlows(focus, env, FLOWS);

  if (!id) {
    const by = (o: string) => flows.filter((f) => f.outcome === o).reduce((n, f) => n + f.count24h, 0);
    return (
      <Card className="detail">
        <CardHead title="Details" sub="Select a node to see who drives it, what it touched and how policy answered." />
        <dl className="kv">
          <dt>Connections</dt><dd>{flows.length}</dd>
          <dt>Allowed (24h)</dt><dd style={{ color: EDGE_COLOR.allowed }}>{by('allowed').toLocaleString()}</dd>
          <dt>Blocked (24h)</dt><dd style={{ color: EDGE_COLOR.blocked }}>{by('blocked').toLocaleString()}</dd>
          <dt>Pending</dt><dd style={{ color: EDGE_COLOR.pending }}>{by('pending')}</dd>
          <dt>Data flows</dt><dd style={{ color: EDGE_COLOR.flow }}>{by('flow').toLocaleString()}</dd>
        </dl>
      </Card>
    );
  }

  const touching = flows.filter((f) => f.from === id || f.to === id);
  const flowRows = (
    <ul className="mini-list">
      {touching.map((f) => {
        const other = f.from === id ? f.to : f.from;
        const name = userById(other)?.name ?? (other in AGENT_TYPES ? AGENT_TYPES[other as AgentType].label : resourceById(other)?.label ?? other);
        return (
          <li key={f.id}>
            <span className="cell-main">{f.from === id ? '→' : '←'} {name}</span>
            <span className="mono-chip" style={{ color: EDGE_COLOR[f.outcome] }}>{f.label} · {f.count24h}</span>
          </li>
        );
      })}
    </ul>
  );

  if (id in AGENT_TYPES) {
    const t = id as AgentType;
    const m = AGENT_TYPES[t];
    const inst = AGENTS.filter((a) => a.type === t && inEnv(a.env));
    return (
      <Card className="detail">
        <div className="detail-hero"><AgentGlyph type={t} size={44} /><div><h3>{m.label}</h3><div className="cell-sub">{m.vendor} · {m.kind}</div></div></div>
        <dl className="kv">
          <dt>Instances</dt><dd>{inst.length} ({inst.filter((a) => a.status === 'active').length} active)</dd>
          <dt>Users</dt><dd>{new Set(inst.map((a) => a.user)).size}</dd>
          <dt>Actions (24h)</dt><dd>{inst.reduce((n, a) => n + a.actions24h, 0).toLocaleString()}</dd>
          <dt>Blocked (24h)</dt><dd style={{ color: 'var(--red)' }}>{inst.reduce((n, a) => n + a.blocked24h, 0)}</dd>
          <dt>MCP servers</dt><dd>{[...new Set(inst.flatMap((a) => a.mcpServers))].join(', ') || '—'}</dd>
        </dl>
        <div className="section-label">Instances</div>
        <ul className="mini-list">
          {inst.map((a) => (
            <li key={a.id}>
              <span className="cell-main">{a.user} <span className="muted">@ {endpointById(a.endpoint)?.hostname}</span></span>
              <span style={{ display: 'flex', gap: 6 }}><ModeTag mode={a.mode} /><StatusPill status={a.status} /></span>
            </li>
          ))}
        </ul>
        <div className="section-label">Connections</div>
        {flowRows}
      </Card>
    );
  }

  const u = userById(id);
  if (u) {
    const inst = AGENTS.filter((a) => a.user === u.id && inEnv(a.env));
    return (
      <Card className="detail">
        <div className="detail-hero"><span className="avatar">{initials(u.name)}</span><div><h3>{u.name}</h3><div className="cell-sub">{u.title} · {u.team}</div></div></div>
        <dl className="kv">
          <dt>Handle</dt><dd>{u.id}</dd>
          <dt>Console role</dt><dd style={{ textTransform: 'capitalize' }}>{u.role}</dd>
          <dt>OS accounts</dt><dd className="mono-sm">{u.osUsers.join(', ')}</dd>
          <dt>Last seen</dt><dd>{u.lastSeen}</dd>
        </dl>
        <div className="section-label">Agents</div>
        <ul className="mini-list">
          {inst.map((a) => (
            <li key={a.id}><AgentCell type={a.type} sub={endpointById(a.endpoint)?.hostname} /><StatusPill status={a.status} /></li>
          ))}
        </ul>
        <div style={{ padding: '0 20px 18px' }}><Link className="view-all" href={`/identity?user=${u.id}`}>Open in Identity & Access <Ic n="arrowRight" size={13} /></Link></div>
      </Card>
    );
  }

  const r = resourceById(id);
  return (
    <Card className="detail">
      <div className="detail-hero"><span className="res-glyph" style={{ width: 44, height: 44 }}><Ic n={r?.icon ?? 'cube'} size={20} /></span><div><h3>{r?.label ?? id}</h3><div className="cell-sub">{r?.sub}</div></div></div>
      <div className="section-label">Who touched it</div>
      {flowRows}
      <div style={{ padding: '0 20px 18px' }}><Link className="view-all" href={`/audit?q=${encodeURIComponent(r?.label ?? id)}`}>Audit trail <Ic n="arrowRight" size={13} /></Link></div>
    </Card>
  );
}

const SUB = 'Every agent on your endpoints, who drives it, and what it touches — with the outcome your policies produced.';

/** The graph built from the workspace's events, or the sample workspace in Demo Mode. */
export function GraphView({ initialAgent, initialView, initialNode }: { initialAgent?: string; initialView?: string; initialNode?: string }) {
  const { demo } = useDemoMode();
  if (demo) return <SampleGraph initialAgent={initialAgent} initialView={initialView} />;
  return <LiveGraphView initialAgent={initialAgent} initialView={initialView} initialNode={initialNode} />;
}

const MAX_TARGETS = 25;
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—');

function LiveDetail({ data, id }: { data: LiveGraphData; id: string | null }) {
  const { graph, endpointById, eventById, now } = data;
  const node = id ? graph.nodes.find((n) => n.id === id) : undefined;

  if (!node) {
    const sum = (k: 'allowed' | 'blocked' | 'wouldBlock') => graph.nodes.filter((n) => n.kind === 'agent').reduce((t, n) => t + n[k], 0);
    const count = (k: string) => graph.nodes.filter((n) => n.kind === k).length;
    return (
      <Card className="detail">
        <CardHead title="Details" sub={`Built from the ${graph.events.toLocaleString()} agent events in the ${data.rangeLabel}. Select a node to see its recent events.`} />
        <dl className="kv">
          <dt>Machines</dt><dd>{count('machine')}</dd>
          <dt>Agents</dt><dd>{count('agent')}</dd>
          <dt>MCP servers</dt><dd>{count('mcp')}</dd>
          <dt>Targets</dt><dd>{graph.targets}{graph.hiddenTargets ? ` (top ${graph.targets - graph.hiddenTargets} shown)` : ''}</dd>
          <dt>Allowed</dt><dd style={{ color: EDGE_COLOR.allowed }}>{sum('allowed').toLocaleString()}</dd>
          <dt>Blocked</dt><dd style={{ color: EDGE_COLOR.blocked }}>{sum('blocked').toLocaleString()}</dd>
          <dt>Would block</dt><dd style={{ color: EDGE_COLOR.would_block }}>{sum('wouldBlock').toLocaleString()}</dd>
        </dl>
      </Card>
    );
  }

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const touching = graph.edges.filter((e) => e.source === node.id || e.target === node.id).sort((a, b) => b.count - a.count);
  const recent = node.eventIds.map((i) => eventById.get(i)).filter((e) => !!e).slice(0, 15);
  const ep = node.endpoint ? endpointById.get(node.endpoint) : undefined;
  const auditQ = node.kind === 'agent' ? `${agentMeta(node.agent).label} ${ep?.hostname ?? ''}`.trim()
    : node.kind === 'machine' ? node.label
    : node.kind === 'mcp' ? node.full
    : node.targetKind === 'more' ? '' : node.targetKind === 'command' ? node.label : node.full;
  const hero = node.kind === 'agent'
    ? <AgentGlyph type={node.agent ?? ''} size={44} />
    : <span className="res-glyph" style={{ width: 44, height: 44 }}><Ic n={nodeIcon(node, endpointById)} size={20} /></span>;

  return (
    <Card className="detail">
      <div className="detail-hero">{hero}<div style={{ minWidth: 0 }}><h3 style={{ overflowWrap: 'anywhere' }}>{nodeLabel(node)}</h3><div className="cell-sub">{nodeSub(node, endpointById)}</div></div></div>
      <dl className="kv">
        {node.kind === 'target' && node.targetKind !== 'more' && node.full !== node.label && <><dt>Target</dt><dd className="mono-sm">{node.full}</dd></>}
        {node.kind === 'machine' && ep && <><dt>Status</dt><dd><StatusPill status={ep.status} /></dd><dt>effigentd</dt><dd>{ep.version || '—'} · policy v{ep.policyVersion}</dd></>}
        {node.kind === 'agent' && <><dt>Machine</dt><dd className="mono-sm">{ep?.hostname ?? node.sub}</dd></>}
        <dt>Events</dt><dd>{node.count.toLocaleString()}</dd>
        <dt>Blocked</dt><dd style={{ color: node.blocked ? EDGE_COLOR.blocked : undefined }}>{node.blocked} <span className="muted">({pct(node.blocked, node.count)})</span></dd>
        <dt>Would block</dt><dd style={{ color: node.wouldBlock ? EDGE_COLOR.would_block : undefined }}>{node.wouldBlock}</dd>
        <dt>Last event</dt><dd>{ago(node.lastAt, now)}</dd>
      </dl>
      <div className="section-label">Connections</div>
      <ul className="mini-list">
        {touching.slice(0, 12).map((e) => {
          const out = e.source === node.id;
          return (
            <li key={e.id}>
              <span className="cell-main" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={byId.get(out ? e.target : e.source)?.full}>
                {out ? '→' : '←'} {nodeLabel(byId.get(out ? e.target : e.source))}
                {byId.get(out ? e.target : e.source)?.kind === 'agent' && <span className="muted"> @ {byId.get(out ? e.target : e.source)?.sub}</span>}
              </span>
              <span className="mono-chip" style={{ color: EDGE_COLOR[e.outcome], flex: 'none' }}>{e.action} · {e.count}</span>
            </li>
          );
        })}
        {touching.length > 12 && <li className="muted">+{touching.length - 12} more</li>}
      </ul>
      <div className="section-label">Recent events</div>
      <ul className="mini-list">
        {recent.map((e) => (
          <li key={e.id}>
            <span style={{ minWidth: 0 }}>
              <span className="cell-main mono-sm" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.target ?? e.summary}>{e.summary}</span>
              <span className="cell-sub">{e.time} · {e.ago}{node.kind !== 'agent' && e.agentType ? ` · ${agentMeta(e.agentType).label}` : ''}{node.kind !== 'machine' && e.endpointName ? ` @ ${e.endpointName}` : ''}</span>
            </span>
            <OutcomePill outcome={e.outcome} />
          </li>
        ))}
      </ul>
      <div style={{ padding: '0 20px 18px', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {auditQ && <Link className="view-all" href={`/audit?q=${encodeURIComponent(auditQ)}`}>Audit trail <Ic n="arrowRight" size={13} /></Link>}
        {node.endpoint && <Link className="view-all" href={`/enforcement?endpoint=${encodeURIComponent(node.endpoint)}`}>Machine in Enforcement <Ic n="arrowRight" size={13} /></Link>}
      </div>
    </Card>
  );
}

function LiveGraphView({ initialAgent, initialView, initialNode }: { initialAgent?: string; initialView?: string; initialNode?: string }) {
  const router = useRouter();
  const [agent, setAgent] = useState<string | null>(initialAgent || null);
  const [view, setView] = useState<'graph' | 'list'>(initialView === 'list' ? 'list' : 'graph');
  const [selected, setSelected] = useState<string | null>(initialNode || null);
  const data = useLiveGraph({ maxTargets: MAX_TARGETS, agent });
  const { graph, loaded, agents } = data;

  const sync = (a: string | null, v: 'graph' | 'list') => {
    const qs = new URLSearchParams();
    if (a) qs.set('agent', a);
    if (v === 'list') qs.set('view', 'list');
    router.replace(`/graph${qs.size ? `?${qs}` : ''}`, { scroll: false });
  };
  const pick = (a: string | null) => { setAgent(a); setSelected(null); sync(a, view); };
  const empty = graph.nodes.length === 0;

  return (
    <div className="page">
      <PageHead title="Agent Graph" sub={SUB}>
        <RangeSelect />
        <Seg value={view} onChange={(v) => { setView(v); sync(agent, v); }} options={[{ id: 'graph', label: 'Graph' }, { id: 'list', label: 'List' }]} />
      </PageHead>

      {(agents.length > 1 || agent) && (
        <div className="chips">
          <button className={`chip ${!agent ? 'on' : ''}`} onClick={() => pick(null)}>All agents <span className="n">{agents.reduce((n, a) => n + a.machines, 0)}</span></button>
          {agents.map((a) => (
            <button key={a.name} className={`chip ${agent === a.name ? 'on' : ''}`} onClick={() => pick(a.name)}>
              <AgentGlyph type={a.name} size={20} /> {agentMeta(a.name).label} <span className="n">{a.machines}</span>
            </button>
          ))}
        </div>
      )}

      {!loaded ? (
        <Card><Loading /></Card>
      ) : empty ? (
        <Card><LiveGraphEmpty data={data} filtered={!!agent && data.anyEvents} /></Card>
      ) : view === 'graph' ? (
        <div className="graph-layout">
          <Card className="graph-card">
            <CardHead
              title={<>{agent ? agentMeta(agent).label : 'All agents'} <span className="live-chip"><span className="dot" /> Live</span></>}
              sub={`Machines → agents → MCP servers → what they touched, from the ${data.rangeLabel}.${graph.hiddenTargets ? ` Busiest ${MAX_TARGETS} targets shown; the rest are under "+${graph.hiddenTargets} more".` : ''} Click a node for its recent events.`}
            />
            <LiveGraphCanvas data={data} selected={selected} onSelect={setSelected} height={640} background />
            <Legend live />
          </Card>
          <LiveDetail data={data} id={selected} />
        </div>
      ) : (
        <Card>
          <CardHead title="Connections" sub={`Every agent → target connection in the ${data.rangeLabel}, busiest first.`} />
          <LiveEdgeList data={data} />
        </Card>
      )}
    </div>
  );
}

function SampleGraph({ initialAgent, initialView }: { initialAgent?: string; initialView?: string }) {
  const { env, inEnv, dispatch } = useStore();
  const router = useRouter();
  const [focus, setFocus] = useState<Focus>(initialAgent && initialAgent in AGENT_TYPES ? (initialAgent as AgentType) : 'all');
  const [view, setView] = useState<'graph' | 'list'>(initialView === 'list' ? 'list' : 'graph');
  const [tab, setTab] = useState<'agents' | 'connections'>('agents');
  const [selected, setSelected] = useState<string | null>(null);

  const types = useMemo(() => {
    const m = new Map<AgentType, number>();
    for (const a of AGENTS) if (inEnv(a.env)) m.set(a.type, (m.get(a.type) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [inEnv]);

  const sync = (f: Focus, v: 'graph' | 'list') => {
    const qs = new URLSearchParams();
    if (f !== 'all') qs.set('agent', f);
    if (v === 'list') qs.set('view', 'list');
    router.replace(`/graph${qs.size ? `?${qs}` : ''}`, { scroll: false });
  };
  const pick = (f: Focus) => { setFocus(f); setSelected(null); sync(f, view); };
  const agents = AGENTS.filter((a) => inEnv(a.env) && (focus === 'all' || a.type === focus));
  const flows = visibleFlows(focus, env, FLOWS);

  return (
    <div className="page">
      <PageHead title="Agent Graph" sub={SUB}>
        {env && <button className="chip on" onClick={() => dispatch({ t: 'env', env: null })} title="Show all environments"><span className="env-dot" style={{ background: envMeta(env).color }} /> {envMeta(env).label} only <Ic n="x" size={12} /></button>}
        <Seg value={view} onChange={(v) => { setView(v); sync(focus, v); }} options={[{ id: 'graph', label: 'Graph' }, { id: 'list', label: 'List' }]} />
      </PageHead>

      <div className="chips">
        <button className={`chip ${focus === 'all' ? 'on' : ''}`} onClick={() => pick('all')}>All agents <span className="n">{types.reduce((n, [, c]) => n + c, 0)}</span></button>
        {types.map(([t, n]) => (
          <button key={t} className={`chip ${focus === t ? 'on' : ''}`} onClick={() => pick(t)}>
            <AgentGlyph type={t} size={20} /> {AGENT_TYPES[t].label} <span className="n">{n}</span>
          </button>
        ))}
      </div>

      {view === 'graph' ? (
        <div className="graph-layout">
          <Card className="graph-card">
            <CardHead
              title={<>{focus === 'all' ? 'All agents' : AGENT_TYPES[focus].label} <span className="live-chip"><span className="dot" /> Live</span></>}
              sub={focus === 'all' ? 'Users → agents → resources. Click a node to trace its connections; drag to rearrange.' : 'Users on the left, everything the agent touched on the right.'}
            />
            {flows.length === 0
              ? <div className="graph-empty">No activity for this selection.</div>
              : <AgentGraph flows={FLOWS} focus={focus} env={env} selected={selected} onSelect={setSelected} height={640} background />}
            <Legend />
          </Card>
          <Detail id={selected} focus={focus} />
        </div>
      ) : (
        <Card>
          <div className="tabs">
            <button className={tab === 'agents' ? 'on' : ''} onClick={() => setTab('agents')}>Agents <span className="n">{agents.length}</span></button>
            <button className={tab === 'connections' ? 'on' : ''} onClick={() => setTab('connections')}>Connections <span className="n">{flows.length}</span></button>
          </div>
          {tab === 'agents' ? (
            <div className="tbl-wrap" style={{ paddingTop: 6 }}>
              <table className="tbl">
                <thead>
                  <tr><th>Agent</th><th>User</th><th>Endpoint</th><th>Environment</th><th>Mode</th><th>Status</th><th className="num">Sessions</th><th className="num">Actions</th><th className="num">Blocked</th><th>Last seen</th></tr>
                </thead>
                <tbody>
                  {agents.map((a) => (
                    <tr key={a.id}>
                      <td><AgentCell type={a.type} sub={`pid ${a.pid}${a.isNew ? ' · new' : ''}`} /></td>
                      <td><UserCell id={a.user} /></td>
                      <td><Link href={`/enforcement?endpoint=${a.endpoint}`} className="mono-sm">{endpointById(a.endpoint)?.hostname}</Link></td>
                      <td><EnvTag env={a.env} /></td>
                      <td><ModeTag mode={a.mode} /></td>
                      <td><StatusPill status={a.status} /></td>
                      <td className="num tnum">{a.sessions24h}</td>
                      <td className="num tnum">{a.actions24h}</td>
                      <td className="num tnum" style={{ color: a.blocked24h ? 'var(--red)' : undefined }}>{a.blocked24h}</td>
                      <td className="muted">{a.lastSeen}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ paddingTop: 6 }}><FlowList flows={flows} /></div>
          )}
        </Card>
      )}
    </div>
  );
}
