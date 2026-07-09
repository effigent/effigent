'use client';

import { useState, useEffect } from 'react';
import { UserButton, OrganizationSwitcher } from '@clerk/nextjs';
import { Sidebar } from '@/components/Sidebar.tsx';
import { Kpis } from '@/components/Kpis.tsx';
import { ExecutionGraph } from '@/components/ExecutionGraph.tsx';
import { Rail } from '@/components/Rail.tsx';
import { Bottom } from '@/components/Bottom.tsx';
import { Install } from '@/components/Install.tsx';
import { Sessions } from '@/components/Sessions.tsx';
import { Ic } from '@/icons.tsx';
import { ALL_AGENTS } from '@/data.ts';

type View = 'overview' | 'sessions' | 'install';

export function Dashboard() {
  const [agents, setAgents] = useState<string[]>([]);
  const [agent, setAgent] = useState<string>(ALL_AGENTS);
  const [view, setView] = useState<View>('overview');

  useEffect(() => {
    fetch('/api/v1/agents')
      .then((r) => (r.ok ? r.json() : { agents: [] }))
      .then((d: { agents?: Array<{ agent_id: string }> }) => setAgents((d.agents ?? []).map((a) => a.agent_id)))
      .catch(() => {});
  }, []);

  const title = view === 'sessions' ? 'Sessions' : 'Agent Optimization Overview';
  const sub =
    view === 'sessions'
      ? 'Every run captured for this workspace'
      : agent === ALL_AGENTS
        ? "Optimizer continuously improves your agents' performance"
        : `Showing agent: ${agent}`;

  return (
    <div className="app">
      <Sidebar active={view === 'install' ? 'overview' : view} onSelect={(k) => setView(k as View)} />
      <main className="main">
        {view === 'install' ? (
          <Install onClose={() => setView('overview')} />
        ) : (
          <div className="main-inner">
            <header className="head">
              <div className="head-row">
                <div>
                  <h1>{title}</h1>
                  <div className="sub">{sub}</div>
                </div>
                <div className="head-actions">
                  <OrganizationSwitcher afterCreateOrganizationUrl="/" afterSelectOrganizationUrl="/" hidePersonal={false} />
                  <UserButton afterSignOutUrl="/sign-in" />
                </div>
              </div>

              <div className="toolbar">
                <label className="agent-filter" title="Filter by agent">
                  <Ic n="route" style={{ width: 15, height: 15, opacity: 0.75 }} />
                  <span className="agent-filter-label">Agent</span>
                  <select value={agent} onChange={(e) => setAgent(e.target.value)}>
                    <option value={ALL_AGENTS}>All agents</option>
                    {agents.map((a) => <option key={a} value={a}>{a}</option>)}
                  </select>
                </label>
                <button className="btn-primary" onClick={() => setView('install')}>
                  <Ic n="spark" style={{ width: 15, height: 15 }} /> Install Optimizer
                </button>
              </div>
            </header>

            {view === 'sessions' ? (
              <Sessions agent={agent} />
            ) : (
              <>
                <Kpis agent={agent} />
                <div className="mid">
                  <div className="mid-left">
                    <ExecutionGraph />
                    <Bottom />
                  </div>
                  <Rail />
                </div>
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
