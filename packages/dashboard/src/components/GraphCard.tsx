'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AGENT_TYPES, FLOWS, resourceById, userById } from '@/data.ts';
import { Ic } from '@/icons.tsx';
import type { AgentType, Env, Flow } from '@/types.ts';
import { AgentGraph, EDGE_COLOR, Legend, visibleFlows } from './AgentGraph.tsx';
import { AgentCell, Card, CardHead, Loading, Seg, UserCell } from './ui.tsx';
import { useDemoMode } from '@/demo.tsx';
import { LiveEdgeList, LiveGraphCanvas, LiveGraphEmpty, useLiveGraph } from './LiveGraph.tsx';

function nodeName(id: string) {
  if (userById(id)) return <UserCell id={id} />;
  if (id in AGENT_TYPES) return <AgentCell type={id as AgentType} />;
  const r = resourceById(id);
  return (
    <span className="agent-cell">
      <span className="res-glyph"><Ic n={r?.icon ?? 'cube'} size={15} /></span>
      <span><span className="cell-main">{r?.label ?? id}</span><span className="cell-sub">{r?.sub}</span></span>
    </span>
  );
}

const OUTCOME_LABEL: Record<Flow['outcome'], string> = { allowed: 'Allowed', blocked: 'Blocked', flow: 'Data flow', pending: 'Pending' };
const OUTCOME_CLS: Record<Flow['outcome'], string> = { allowed: 'b-green', blocked: 'b-red', flow: 'b-blue', pending: 'b-gold' };

export function FlowList({ flows }: { flows: Flow[] }) {
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr><th>From</th><th>Action</th><th>To</th><th>Result</th><th className="num">24h</th><th>Last seen</th></tr>
        </thead>
        <tbody>
          {flows.map((f) => (
            <tr key={f.id}>
              <td>{nodeName(f.from)}</td>
              <td><span className="mono-chip" style={{ color: EDGE_COLOR[f.outcome] }}>{f.label}</span></td>
              <td>{nodeName(f.to)}</td>
              <td><span className={`badge ${OUTCOME_CLS[f.outcome]}`}>{OUTCOME_LABEL[f.outcome]}</span></td>
              <td className="num tnum">{f.count24h.toLocaleString()}</td>
              <td className="muted">{f.lastSeen}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Esc leaves fullscreen. */
function useFullscreen(): [boolean, (f: (v: boolean) => boolean) => void] {
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!full) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && setFull(false);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [full]);
  return [full, setFull];
}

/** Overview card: the agent graph with a Graph/List toggle and a fullscreen
 *  mode (Esc closes) — built from the workspace's events, or the hero Claude
 *  Code sample graph in Demo Mode. */
export function GraphCard({ env }: { env: Env | null }) {
  const { demo } = useDemoMode();
  if (!demo) return <LiveGraphCard />;
  return <SampleGraphCard env={env} />;
}

function LiveGraphCard() {
  const router = useRouter();
  const [view, setView] = useState<'graph' | 'list'>('graph');
  const [full, setFull] = useFullscreen();
  const [selected, setSelected] = useState<string | null>(null);
  const data = useLiveGraph({ maxTargets: full ? 25 : 12 });
  const empty = data.graph.nodes.length === 0;
  return (
    <Card className={`graph-card ${full ? 'fullscreen' : ''}`}>
      <CardHead title="Agent Graph" sub="Machines → agents → the commands, files, networks and MCP servers they touched." href={full ? undefined : '/graph'}>
        {!empty && <Seg value={view} onChange={setView} options={[{ id: 'graph', label: 'Graph' }, { id: 'list', label: 'List' }]} />}
        {!empty && (
          <button className="icon-btn" onClick={() => setFull((f) => !f)} aria-label={full ? 'Exit full screen' : 'Full screen'} title={full ? 'Exit full screen (Esc)' : 'Full screen'}>
            <Ic n={full ? 'collapse' : 'expand'} size={16} />
          </button>
        )}
      </CardHead>
      {!data.loaded ? <Loading /> : empty ? <LiveGraphEmpty data={data} /> : view === 'graph' ? (
        <LiveGraphCanvas data={data} compact={!full} interactive={full} background={full}
          height={full ? 'calc(100vh - 170px)' : 440}
          selected={full ? selected : null}
          onSelect={full ? setSelected : (id) => { if (id) router.push(`/graph?node=${encodeURIComponent(id)}`); }} />
      ) : (
        <LiveEdgeList data={data} />
      )}
      {!empty && data.loaded && <Legend live />}
    </Card>
  );
}

function SampleGraphCard({ env }: { env: Env | null }) {
  const [view, setView] = useState<'graph' | 'list'>('graph');
  const [full, setFull] = useFullscreen();

  const flows = visibleFlows('claude-code', env, FLOWS);
  return (
    <Card className={`graph-card ${full ? 'fullscreen' : ''}`}>
      <CardHead
        title="Agent Graph"
        sub="See how your AI agents connect, what they access, and where data flows."
      >
        <Seg value={view} onChange={setView} options={[{ id: 'graph', label: 'Graph' }, { id: 'list', label: 'List' }]} />
        <button className="icon-btn" onClick={() => setFull((f) => !f)} aria-label={full ? 'Exit full screen' : 'Full screen'} title={full ? 'Exit full screen (Esc)' : 'Full screen'}>
          <Ic n={full ? 'collapse' : 'expand'} size={16} />
        </button>
      </CardHead>
      {flows.length === 0 ? (
        <div className="graph-empty">No Claude Code activity in this environment.</div>
      ) : view === 'graph' ? (
        <AgentGraph flows={FLOWS} focus="claude-code" env={env} hero={!full} height={full ? 'calc(100vh - 170px)' : 440} background={full} />
      ) : (
        <FlowList flows={flows} />
      )}
      <Legend />
    </Card>
  );
}
