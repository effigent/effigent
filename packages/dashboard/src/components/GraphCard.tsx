'use client';

import { useEffect, useState } from 'react';
import { AGENT_TYPES, FLOWS, resourceById, userById } from '@/data.ts';
import { Ic } from '@/icons.tsx';
import type { AgentType, Env, Flow } from '@/types.ts';
import { AgentGraph, EDGE_COLOR, Legend, visibleFlows } from './AgentGraph.tsx';
import { AgentCell, Card, CardHead, Seg, UserCell } from './ui.tsx';

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

/** Overview card: the hero Claude Code graph with a Graph/List toggle and a
 *  fullscreen mode (Esc closes). */
export function GraphCard({ env }: { env: Env | null }) {
  const [view, setView] = useState<'graph' | 'list'>('graph');
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!full) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && setFull(false);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [full]);

  const flows = visibleFlows('claude-code', env, FLOWS);
  return (
    <Card className={`graph-card ${full ? 'fullscreen' : ''}`}>
      <CardHead
        title={<>Live Agent Graph <span className="live-chip"><span className="dot" /> Live</span></>}
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
