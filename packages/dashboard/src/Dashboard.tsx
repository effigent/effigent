'use client';

import { useState, useEffect, useMemo } from 'react';
import { UserButton, OrganizationSwitcher } from '@clerk/nextjs';
import { Sidebar } from '@/components/Sidebar.tsx';
import { Kpis } from '@/components/Kpis.tsx';
import { ExecutionGraph } from '@/components/ExecutionGraph.tsx';
import { Rail } from '@/components/Rail.tsx';
import { Bottom } from '@/components/Bottom.tsx';
import { Install } from '@/components/Install.tsx';
import { Sessions } from '@/components/Sessions.tsx';
import { SessionDetail } from '@/components/SessionDetail.tsx';
import { ToolSynthesis } from '@/components/ToolSynthesis.tsx';
import { KnowledgeGraph } from '@/components/KnowledgeGraph.tsx';
import { Ic } from '@/icons.tsx';
import { ALL_AGENTS } from '@/data.ts';

type View = 'overview' | 'sessions' | 'tools' | 'kg' | 'install' | 'session-detail';
interface AgentInfo { agent_id: string; optimized: boolean }

const clerkAppearance = {
  elements: {
    rootBox: { display: 'flex', alignItems: 'center' },
    organizationSwitcherTrigger: {
      padding: '6px 10px',
      borderRadius: '10px',
      border: '1px solid var(--border)',
      backgroundColor: 'var(--panel-2)',
      color: 'var(--txt)',
      maxWidth: '210px',
    },
    organizationSwitcherTriggerIcon: { color: 'var(--txt-3)' },
    organizationPreviewMainIdentifier: { color: 'var(--txt)', fontWeight: 600 },
    userButtonAvatarBox: { width: '32px', height: '32px' },
  },
};

export function Dashboard() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agent, setAgent] = useState<string>(ALL_AGENTS);
  const [view, setView] = useState<View>('overview');
  const [session, setSession] = useState<{ id: string; optimized: boolean } | null>(null);

  useEffect(() => {
    fetch('/api/v1/agents')
      .then((r) => (r.ok ? r.json() : { agents: [] }))
      .then((d: { agents?: AgentInfo[] }) => setAgents(d.agents ?? []))
      .catch(() => {});
  }, []);

  const optimizedAgents = useMemo(() => new Set(agents.filter((a) => a.optimized).map((a) => a.agent_id)), [agents]);
  const selectedOptimized = agent !== ALL_AGENTS && optimizedAgents.has(agent);

  const openSession = (id: string, optimized: boolean) => {
    setSession({ id, optimized });
    setView('session-detail');
  };

  // Sidebar highlight: detail + install fold back onto their parent tab.
  const sidebarActive = view === 'install' ? 'overview' : view === 'session-detail' ? 'sessions' : view;

  const heads: Record<string, { title: string; sub: string }> = {
    overview: { title: 'Agent Optimization Overview', sub: agent === ALL_AGENTS ? "Optimizer continuously improves your agents' performance" : `Showing agent: ${agent}` },
    sessions: { title: 'Sessions', sub: 'Every run captured for this workspace' },
    tools: { title: 'Tool Synthesis', sub: 'Deterministic tools generated for your agents' },
    kg: { title: 'Knowledge Graph', sub: 'What Optimizer knows about your agents’ world' },
  };
  const head = heads[view] ?? heads.overview;
  const showToolbar = view === 'overview' || view === 'sessions' || view === 'kg';

  return (
    <div className="app">
      <Sidebar active={sidebarActive} onSelect={(k) => setView(k as View)} />
      <main className="main">
        {view === 'install' ? (
          <Install onClose={() => setView('overview')} />
        ) : (
          <div className="main-inner">
            <header className="head">
              <div className="head-row">
                <div>
                  <h1>{head.title}</h1>
                  <div className="sub">{head.sub}</div>
                </div>
                <div className="head-actions">
                  <OrganizationSwitcher appearance={clerkAppearance} afterCreateOrganizationUrl="/" afterSelectOrganizationUrl="/" hidePersonal={false} />
                  <UserButton appearance={clerkAppearance} afterSignOutUrl="/sign-in" />
                </div>
              </div>

              {showToolbar && (
                <div className="toolbar">
                  <label className="agent-filter" title="Filter by agent">
                    <Ic n="route" style={{ width: 15, height: 15, opacity: 0.75 }} />
                    <span className="agent-filter-label">Agent</span>
                    <select value={agent} onChange={(e) => setAgent(e.target.value)}>
                      <option value={ALL_AGENTS}>All agents</option>
                      {agents.map((a) => (
                        <option key={a.agent_id} value={a.agent_id}>
                          {a.agent_id}{a.optimized ? '  ✓ optimized' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  {selectedOptimized && (
                    <span className="opt-badge lg"><Ic n="spark" style={{ width: 12, height: 12 }} /> Optimized</span>
                  )}
                  <button className="btn-primary" onClick={() => setView('install')}>
                    <Ic n="spark" style={{ width: 15, height: 15 }} /> Install Optimizer
                  </button>
                </div>
              )}
            </header>

            <div className="view-body">
              {view === 'sessions' && <Sessions agent={agent} optimizedAgents={optimizedAgents} onOpen={openSession} />}
              {view === 'session-detail' && session && (
                <SessionDetail sessionId={session.id} optimized={session.optimized} onBack={() => setView('sessions')} />
              )}
              {view === 'tools' && <ToolSynthesis />}
              {view === 'kg' && <KnowledgeGraph agent={agent} />}
              {view === 'overview' && (
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
          </div>
        )}
      </main>
    </div>
  );
}
