'use client';

import { useState, useEffect } from 'react';
import { UserButton, OrganizationSwitcher } from '@clerk/nextjs';
import { Sidebar } from '@/components/Sidebar.tsx';
import { Kpis } from '@/components/Kpis.tsx';
import { ExecutionGraph } from '@/components/ExecutionGraph.tsx';
import { Rail } from '@/components/Rail.tsx';
import { Bottom } from '@/components/Bottom.tsx';
import { Install } from '@/components/Install.tsx';
import { Ic } from '@/icons.tsx';
import { ALL_AGENTS } from '@/data.ts';

export function Dashboard() {
  const [agents, setAgents] = useState<string[]>([]);
  const [agent, setAgent] = useState<string>(ALL_AGENTS);
  const [view, setView] = useState<'dashboard' | 'install'>('dashboard');

  useEffect(() => {
    fetch('/api/v1/agents')
      .then((r) => (r.ok ? r.json() : { agents: [] }))
      .then((d: { agents?: Array<{ agent_id: string }> }) => setAgents((d.agents ?? []).map((a) => a.agent_id)))
      .catch(() => {});
  }, []);

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        {view === 'install' ? (
          <Install onClose={() => setView('dashboard')} />
        ) : (
          <div className="main-inner">
            <header className="head">
              <div>
                <h1>Agent Optimization Overview</h1>
                <div className="sub">
                  {agent === ALL_AGENTS ? "Optimizer continuously improves your agents' performance" : `Showing agent: ${agent}`}
                </div>
              </div>
              <div className="head-actions">
                <label className="agent-filter" title="Filter by agent">
                  <Ic n="route" style={{ width: 14, height: 14, opacity: 0.7 }} />
                  <select value={agent} onChange={(e) => setAgent(e.target.value)}>
                    <option value={ALL_AGENTS}>All agents</option>
                    {agents.map((a) => <option key={a} value={a}>{a}</option>)}
                  </select>
                </label>
                <button className="btn-primary" onClick={() => setView('install')}>
                  <Ic n="spark" style={{ width: 15, height: 15 }} /> Install Optimizer
                </button>
                <OrganizationSwitcher afterCreateOrganizationUrl="/" afterSelectOrganizationUrl="/" />
                <UserButton afterSignOutUrl="/sign-in" />
              </div>
            </header>

            <Kpis agent={agent} />

            <div className="mid">
              <div className="mid-left">
                <ExecutionGraph />
                <Bottom />
              </div>
              <Rail />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
