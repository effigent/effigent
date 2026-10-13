'use client';

import { Fragment, useMemo, useState } from 'react';
import { AGENT_TYPES } from '@/data.ts';
import { Ic } from '@/icons.tsx';
import { useLive } from '@/live.tsx';
import { useStore } from '@/store.tsx';
import { apiErrorText, type ApiEnrollment } from '@/lib/api.ts';
import { ago, dateTime, type EndpointRow } from '@/lib/live-map.ts';
import type { AgentType } from '@/types.ts';
import { AgentCell, Card, CardHead, CodeBlock, Empty, Loading, PageHead, ReadOnlyNote, StatusPill } from '@/components/ui.tsx';

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

/** Compare effigentd versions like 2.0.10 vs 2.0.3 (non-numeric parts sort as 0). */
function cmpVersion(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[.-]/).map((x) => Number(x) || 0);
  const pb = b.replace(/^v/, '').split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

function Enroll() {
  const { api, canWrite, me, refresh } = useLive();
  const [label, setLabel] = useState('');
  const [maxUses, setMaxUses] = useState(1);
  const [ttl, setTtl] = useState(24);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [made, setMade] = useState<ApiEnrollment | null>(null);

  const create = async () => {
    setBusy(true); setErr(null);
    try {
      setMade(await api.send<ApiEnrollment>('POST', '/enrollment-tokens', { label: label.trim(), ttl_hours: ttl, max_uses: maxUses }));
      setLabel('');
      void refresh(); // the audit trail now has an enrollment_token.create entry
    } catch (e) {
      setErr(apiErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHead title="Enroll an endpoint" sub="Create a one-time enrollment token, then run the command on the machine. effigentd swaps it for its own secret and starts pulling signed policy.">
        {me && !canWrite && <ReadOnlyNote what="enroll endpoints" />}
      </CardHead>
      <div style={{ padding: '0 20px 20px' }}>
        <div className="section-label" style={{ margin: '0 0 6px' }}>1 · Install effigentd</div>
        <CodeBlock code="curl -fsSL https://effigent.ai/install.sh | sh" />
        <div className="section-label" style={{ margin: '16px 0 6px' }}>2 · Enroll it into this workspace</div>
        {made ? (
          <>
            <CodeBlock code={made.command} wrap />
            <div className="callout warn" style={{ margin: '10px 0 0' }}>
              <Ic n="key" size={16} />
              <span>
                Copy it now — the token is shown once. Valid for {made.token.max_uses} enrollment{made.token.max_uses === 1 ? '' : 's'} until {dateTime(Date.parse(made.token.expires_at))}.
                {' '}<button className="btn sm" style={{ marginLeft: 6 }} onClick={() => setMade(null)}>Create another</button>
              </span>
            </div>
          </>
        ) : (
          <div className="form-row" style={{ padding: 0 }}>
            <div className="field" style={{ flex: '2 1 200px' }}>
              <label htmlFor="enr-label">Label</label>
              <input id="enr-label" className="input" placeholder="e.g. build agents, Jane's laptop" value={label} disabled={!canWrite} onChange={(e) => setLabel(e.target.value)} />
            </div>
            <div className="field" style={{ flex: '0 1 120px' }}>
              <label htmlFor="enr-uses">Max uses</label>
              <input id="enr-uses" className="input" type="number" min={1} max={1000} value={maxUses} disabled={!canWrite}
                onChange={(e) => setMaxUses(Math.min(1000, Math.max(1, Number(e.target.value) || 1)))} />
            </div>
            <div className="field" style={{ flex: '0 1 140px' }}>
              <label htmlFor="enr-ttl">Expires after</label>
              <select id="enr-ttl" className="select" value={ttl} disabled={!canWrite} onChange={(e) => setTtl(Number(e.target.value))}>
                <option value={1}>1 hour</option><option value={24}>24 hours</option><option value={168}>7 days</option><option value={720}>30 days</option>
              </select>
            </div>
            <button className="btn primary" onClick={create} disabled={!canWrite || busy}><Ic n="key" /> {busy ? 'Creating…' : 'Create token'}</button>
          </div>
        )}
        {err && <div className="callout bad" style={{ margin: '10px 0 0' }}><Ic n="alert" size={16} /><span>{err}</span></div>}
      </div>
    </Card>
  );
}

export function Enforcement({ initialEndpoint }: { initialEndpoint?: string }) {
  const { endpointRows, consoleEvents, latestPolicy, loaded, now, canWrite, api, refresh } = useLive();
  const { dispatch } = useStore();
  const [sel, setSel] = useState<string | null>(initialEndpoint ?? null);
  const [busy, setBusy] = useState<string | null>(null);

  const eps = endpointRows.filter((e) => !e.revoked);
  const revoked = endpointRows.filter((e) => e.revoked);
  const online = eps.filter((e) => e.status === 'online');
  const kernel = eps.filter((e) => e.platform === 'linux');
  const observe = eps.filter((e) => e.platform !== 'linux');
  const current = eps.filter((e) => latestPolicy > 0 && e.policyVersion === latestPolicy).length;
  const newest = eps.reduce((m, e) => (cmpVersion(e.version, m) > 0 ? e.version : m), '0');
  const n = eps.length || 1;

  // Agents seen per endpoint in the fetched event window, newest first.
  const agentsBy = useMemo(() => {
    const m = new Map<string, Map<string, number>>();
    for (const e of consoleEvents) {
      if (!e.agentType || !e.endpoint) continue;
      const per = m.get(e.endpoint) ?? new Map<string, number>();
      if (!per.has(e.agentType)) per.set(e.agentType, e.at ?? 0);
      m.set(e.endpoint, per);
    }
    return m;
  }, [consoleEvents]);

  const revoke = async (e: EndpointRow) => {
    if (!window.confirm(`Revoke ${e.hostname}? It stops receiving policy and its events are refused. It keeps enforcing the last policy it has until re-enrolled.`)) return;
    setBusy(e.id);
    try {
      await api.send('DELETE', `/endpoints/${encodeURIComponent(e.id)}`);
      dispatch({ t: 'toast', text: `Revoked ${e.hostname}` });
      await refresh();
    } catch (err) {
      window.alert(apiErrorText(err));
    } finally {
      setBusy(null);
    }
  };

  const row = (e: EndpointRow) => {
    const agents = [...(agentsBy.get(e.id) ?? new Map<string, number>())];
    return (
      <Fragment key={e.id}>
        <tr className={`clickable ${sel === e.id ? 'sel' : ''} ${e.revoked ? 'revoked' : ''}`} onClick={() => setSel(sel === e.id ? null : e.id)}>
          <td>
            <span className="agent-cell">
              <span className="res-glyph"><Ic n={e.platform === 'linux' ? 'server' : 'laptop'} size={15} /></span>
              <span><span className="cell-main mono-sm" style={{ color: 'var(--txt)' }}>{e.hostname}</span><span className="cell-sub">{e.os} · {e.arch}</span></span>
            </span>
          </td>
          <td className="muted">{e.platform === 'linux' ? 'Kernel (Tetragon)' : 'Agent hooks'}</td>
          <td className="mono-sm" style={{ color: cmpVersion(e.version, newest) < 0 ? 'var(--gold)' : undefined }}>{e.version || '—'}</td>
          <td className="mono-sm" style={{ color: latestPolicy > 0 && e.policyVersion !== latestPolicy && !e.revoked ? 'var(--gold)' : undefined }}>
            {e.policyVersion > 0 ? `v${e.policyVersion}` : 'default'}
          </td>
          <td className="tnum">{agents.length}</td>
          <td><StatusPill status={e.status} /></td>
          <td className="muted" title={dateTime(e.lastSeenAt)}>{ago(e.lastSeenAt, now)}</td>
          <td className="right" onClick={(ev) => ev.stopPropagation()}>
            {!e.revoked && canWrite && (
              <button className="btn sm danger" disabled={busy === e.id} onClick={() => revoke(e)}><Ic n="ban" size={13} /> {busy === e.id ? 'Revoking…' : 'Revoke'}</button>
            )}
          </td>
        </tr>
        {sel === e.id && (
          <tr>
            <td colSpan={8} style={{ background: 'var(--inset)' }}>
              <div className="muted" style={{ fontSize: 12.5, marginBottom: agents.length ? 8 : 0 }}>
                Enrolled {dateTime(e.enrolledAt)} · id <span className="mono-sm">{e.id}</span>
                {e.revoked && ' · revoked'}
              </div>
              {agents.length === 0 ? <span className="muted">No agent events from this endpoint in the recent window.</span> : (
                <div className="chips">
                  {agents.map(([a, at]) => (
                    <span key={a} className="chip" style={{ cursor: 'default' }}><AgentCell type={a} sub={`last event ${ago(at, now)}`} /></span>
                  ))}
                </div>
              )}
            </td>
          </tr>
        )}
      </Fragment>
    );
  };

  return (
    <div className="page">
      <PageHead title="Enforcement" sub="effigentd on every endpoint: what it sees, what it can stop, and whether it has the latest policy." />

      <div className="grid-4">
        <Card className="mini-stat"><div className="k">Endpoints online</div><div className="v">{online.length}/{eps.length}</div><div className="s">{eps.length - online.length} need attention</div></Card>
        <Card className="mini-stat"><div className="k">Kernel-enforced</div><div className="v">{kernel.length}</div><div className="s">Linux · Tetragon BPF LSM, pid-scoped</div></Card>
        <Card className="mini-stat"><div className="k">Agent hooks</div><div className="v">{observe.length}</div><div className="s">macOS / Windows · Claude Code checked before each action</div></Card>
        <Card className="mini-stat"><div className="k">On latest policy</div><div className="v">{current}/{eps.length}</div><div className="s">{latestPolicy > 0 ? `Published v${latestPolicy}` : 'Nothing published yet'}</div></Card>
      </div>

      <Card>
        <CardHead title="Coverage" sub="Share of enrolled endpoints by the strongest layer that can stop an agent action." />
        <div className="coverage">
          <i style={{ width: `${(kernel.filter((e) => e.status === 'online').length / n) * 100}%`, background: 'var(--green)' }} />
          <i style={{ width: `${(observe.filter((e) => e.status === 'online').length / n) * 100}%`, background: 'var(--blue)' }} />
          <i style={{ width: `${((eps.length - online.length) / n) * 100}%`, background: 'var(--red)' }} />
        </div>
        <div className="cov-legend">
          <span><i className="lg-dot" style={{ background: 'var(--green)' }} /> Kernel (exec / file blocked before it happens)</span>
          <span><i className="lg-dot" style={{ background: 'var(--blue)' }} /> Agent hooks (macOS / Windows, Claude Code tool calls)</span>
          <span><i className="lg-dot" style={{ background: 'var(--red)' }} /> Degraded / offline</span>
        </div>
      </Card>

      <Card>
        <CardHead title="Endpoints" sub="Online = heartbeat in the last minute (effigentd syncs every 5s). Click a row for the agents it reported." />
        {!loaded ? <Loading /> : endpointRows.length === 0 ? (
          <Empty icon="laptop" title="No endpoints enrolled yet" sub="Create an enrollment token below and run the command on a machine." />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Endpoint</th><th>Enforcement</th><th>effigentd</th><th>Policy</th><th>Agents</th><th>Status</th><th>Last seen</th><th aria-label="Actions" /></tr></thead>
              <tbody>
                {eps.map(row)}
                {revoked.map(row)}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div id="enroll" style={{ scrollMarginTop: 88 }}><Enroll /></div>

      <div className="grid-2">
        <Card>
          <CardHead title="Agent integrations" sub="How effigentd recognises each built-in agent (policy `agents:` can add more)." />
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Agent</th><th>Detection</th><th>Kernel</th><th>Hooks</th></tr></thead>
              <tbody>
                {INTEGRATIONS.map((i) => (
                  <tr key={i.type}>
                    <td><AgentCell type={i.type} sub={AGENT_TYPES[i.type].vendor} /></td>
                    <td className="mono-sm">{i.detect}</td>
                    <td><span className="badge b-green">Exec · file (Linux)</span></td>
                    <td>{i.hooks ? <span className="badge b-blue" title={i.hooks}>{i.hooks.split(' — ')[0]}</span> : <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card>
          <CardHead title="Hybrid deployment" sub="Decisions are made on the endpoint; the control plane distributes signed policy and collects events." />
          <dl className="kv">
            <dt>Enforcement</dt><dd><span className="dot" style={{ marginRight: 8 }} />Local — effigentd on each endpoint</dd>
            <dt>Control plane</dt><dd>Cloud (this console)</dd>
            <dt>Policy delivery</dt><dd>Signed (ed25519), pinned to this workspace at enrollment; versions never go backwards</dd>
            <dt>Offline behaviour</dt><dd>The cached signed policy keeps enforcing; a tampered cache falls back to the built-in default</dd>
          </dl>
        </Card>
      </div>
    </div>
  );
}
