'use client';

import { Fragment, useState } from 'react';
import { AGENTS, AGENT_TYPES, ENDPOINTS, userById } from '@/data.ts';
import { Ic } from '@/icons.tsx';
import { useStore } from '@/store.tsx';
import type { AgentType } from '@/types.ts';
import { AgentCell, Card, CardHead, DemoNote, EnvTag, PageHead, StatusPill } from '@/components/ui.tsx';

const LATEST_POLICY = 42;
const LATEST_AGENT = '2.0.3';

/** How each agent is recognised (policy/default.yaml) and which layers enforce it. */
const INTEGRATIONS: { type: AgentType; detect: string; hooks: string | null }[] = [
  { type: 'claude-code', detect: 'binary claude · args @anthropic-ai/claude-code', hooks: 'PreToolUse hook — pauses for approval' },
  { type: 'cursor-agent', detect: 'binary cursor-agent', hooks: 'beforeShellExecution hook' },
  { type: 'codex', detect: 'binary codex · args @openai/codex', hooks: null },
  { type: 'gemini-cli', detect: 'binary gemini · args @google/gemini-cli', hooks: null },
  { type: 'aider', detect: 'binary aider', hooks: null },
  { type: 'opencode', detect: 'binary opencode', hooks: null },
  { type: 'goose', detect: 'binary goose', hooks: null },
];

const INSTALL = `# Linux (kernel enforcement via Tetragon) / macOS (Endpoint Security + agent hooks)
curl -fsSL https://<your-control-plane>/install.sh | sudo sh -s -- --enroll <enrollment-token>
effigentd status        # sensor, policy version, tracked agents`;

export function Enforcement({ initialEndpoint }: { initialEndpoint?: string }) {
  const { inEnv } = useStore();
  const [sel, setSel] = useState<string | null>(initialEndpoint ?? null);
  const eps = ENDPOINTS.filter((e) => inEnv(e.env));
  const online = eps.filter((e) => e.status === 'online').length;
  const kernel = eps.filter((e) => e.sensor === 'tetragon');
  const hooks = eps.filter((e) => e.sensor === 'eslogger');
  const current = eps.filter((e) => e.policyVersion === LATEST_POLICY).length;
  const n = eps.length || 1;
  const offline = eps.filter((e) => e.status !== 'online').length;

  return (
    <div className="page">
      <PageHead title="Enforcement" sub="effigentd on every endpoint: what it sees, what it can stop, and whether it has the latest policy.">
        <DemoNote />
      </PageHead>

      <div className="grid-4">
        <Card className="mini-stat"><div className="k">Endpoints online</div><div className="v">{online}/{eps.length}</div><div className="s">{offline} need attention</div></Card>
        <Card className="mini-stat"><div className="k">Kernel-enforced</div><div className="v">{kernel.length}</div><div className="s">Linux · Tetragon LSM, pid-scoped</div></Card>
        <Card className="mini-stat"><div className="k">Hook-enforced</div><div className="v">{hooks.length}</div><div className="s">macOS · Endpoint Security + agent hooks</div></Card>
        <Card className="mini-stat"><div className="k">On latest policy</div><div className="v">{current}/{eps.length}</div><div className="s">Bundle v{LATEST_POLICY}</div></Card>
      </div>

      <Card>
        <CardHead title="Coverage" sub="Share of endpoints by the strongest layer that can block an agent action." />
        <div className="coverage">
          <i style={{ width: `${(kernel.filter((e) => e.status === 'online').length / n) * 100}%`, background: 'var(--green)' }} />
          <i style={{ width: `${(hooks.filter((e) => e.status === 'online').length / n) * 100}%`, background: 'var(--blue)' }} />
          <i style={{ width: `${(offline / n) * 100}%`, background: 'var(--red)' }} />
        </div>
        <div className="cov-legend">
          <span><i className="lg-dot" style={{ background: 'var(--green)' }} /> Kernel (exec / file / network blocked before it happens)</span>
          <span><i className="lg-dot" style={{ background: 'var(--blue)' }} /> Agent hooks (tool calls paused or denied)</span>
          <span><i className="lg-dot" style={{ background: 'var(--red)' }} /> Degraded / offline</span>
        </div>
      </Card>

      <Card>
        <CardHead title="Endpoints" sub="Click a row to see the agents effigentd tracks on it." />
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Endpoint</th><th>Owner</th><th>Environment</th><th>Sensor</th><th>effigentd</th><th>Policy</th><th>Agents</th><th>Status</th><th>Heartbeat</th></tr></thead>
            <tbody>
              {eps.map((e) => {
                const agents = AGENTS.filter((a) => a.endpoint === e.id);
                return (
                  <Fragment key={e.id}>
                    <tr className={`clickable ${sel === e.id ? 'sel' : ''}`} onClick={() => setSel(sel === e.id ? null : e.id)}>
                      <td>
                        <span className="agent-cell">
                          <span className="res-glyph"><Ic n={e.platform === 'linux' ? 'server' : 'laptop'} size={15} /></span>
                          <span><span className="cell-main mono-sm" style={{ color: 'var(--txt)' }}>{e.hostname}</span><span className="cell-sub">{e.os}</span></span>
                        </span>
                      </td>
                      <td>{userById(e.owner)?.name}</td>
                      <td><EnvTag env={e.env} /></td>
                      <td className="muted">{e.sensor === 'tetragon' ? 'Tetragon (kernel)' : 'eslogger + hooks'}</td>
                      <td className="mono-sm" style={{ color: e.version === LATEST_AGENT ? undefined : 'var(--gold)' }}>{e.version}</td>
                      <td className="mono-sm" style={{ color: e.policyVersion === LATEST_POLICY ? undefined : 'var(--gold)' }}>v{e.policyVersion}</td>
                      <td className="tnum">{agents.length}</td>
                      <td><StatusPill status={e.status} /></td>
                      <td className="muted">{e.heartbeat}</td>
                    </tr>
                    {sel === e.id && (
                      <tr>
                        <td colSpan={9} style={{ background: 'var(--inset)' }}>
                          {agents.length === 0 ? <span className="muted">No agents seen on this endpoint in the last 24 hours.</span> : (
                            <div className="chips">
                              {agents.map((a) => (
                                <span key={a.id} className="chip" style={{ cursor: 'default' }}>
                                  <AgentCell type={a.type} sub={`${a.user} · pid ${a.pid} · ${a.mode}`} />
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid-2">
        <Card>
          <CardHead title="Agent integrations" sub="How effigentd recognises each agent, and which layers can stop it." />
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Agent</th><th>Detection</th><th>Kernel</th><th>Hooks</th></tr></thead>
              <tbody>
                {INTEGRATIONS.map((i) => (
                  <tr key={i.type}>
                    <td><AgentCell type={i.type} sub={AGENT_TYPES[i.type].vendor} /></td>
                    <td className="mono-sm">{i.detect}</td>
                    <td><span className="badge b-green">Exec · file · net</span></td>
                    <td>{i.hooks ? <span className="badge b-blue" title={i.hooks}>{i.hooks.split(' — ')[0]}</span> : <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card>
          <CardHead title="Hybrid deployment" sub="Decisions are made on the endpoint; the cloud control plane distributes policy and collects the audit trail." />
          <dl className="kv">
            <dt>Enforcement</dt><dd><span className="dot" style={{ marginRight: 8 }} />Local — effigentd on each endpoint</dd>
            <dt>Control plane</dt><dd>Cloud (this console)</dd>
            <dt>Fail mode</dt><dd>Closed — agents start only after the kernel policy for their pid is live (canary check)</dd>
            <dt>Offline behaviour</dt><dd>Last policy keeps enforcing; approvals queue until reconnect</dd>
          </dl>
          <div className="section-label">Install on an endpoint</div>
          <pre className="yaml" style={{ borderRadius: 0, margin: '0 0 0', borderBottomLeftRadius: 'var(--radius)', borderBottomRightRadius: 'var(--radius)' }}>{INSTALL}</pre>
        </Card>
      </div>
    </div>
  );
}
