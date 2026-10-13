'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ACTION_CLASS_LABEL, AGENT_TYPES, endpointById, envMeta, userById } from '@/data.ts';
import { Ic } from '@/icons.tsx';
import { useStore } from '@/store.tsx';
import type { Action, Approval } from '@/types.ts';
import { AgentGlyph, ApprovalPill, Card, CardHead, DemoNote, Empty, EnvTag, PageHead, RiskTag } from '@/components/ui.tsx';

export function actionText(a: Action): string {
  if (a.command) return a.command;
  if (a.mcpServer) return `${a.mcpServer}.${a.mcpTool ?? '*'}${a.host ? `  →  ${a.host}:${a.port ?? ''}` : ''}`;
  if (a.url) return `GET ${a.url}`;
  if (a.paths?.length) return `${a.tool ?? 'write'} ${a.paths.join(' ')}`;
  if (a.host) return `${a.host}:${a.port ?? ''}`;
  return a.tool ?? a.class;
}

const soon = (s: string) => /^\d+ min$/.test(s) && parseInt(s, 10) <= 4;

function DetailPanel({ a }: { a: Approval }) {
  const { decide, policies } = useStore();
  const [note, setNote] = useState('');
  const pol = policies.find((p) => p.id === a.policyId);
  const rule = pol?.rules.find((r) => r.id === a.ruleId);
  const ep = endpointById(a.endpoint);
  const pending = a.state === 'approval_pending';

  return (
    <Card className="detail">
      <div className="detail-hero">
        <AgentGlyph type={a.agentType} size={44} />
        <div style={{ minWidth: 0 }}>
          <h3>{a.title}</h3>
          <div className="cell-sub">{AGENT_TYPES[a.agentType].label} · requested {a.requestedAgo}</div>
        </div>
      </div>
      <div className="section-label">Exact action ({ACTION_CLASS_LABEL[a.action.class]})</div>
      <div className="code-line">{actionText(a.action)}</div>
      <dl className="kv">
        <dt>Requested by</dt><dd>{userById(a.user)?.name ?? a.user} <span className="muted">({a.user})</span></dd>
        <dt>Endpoint</dt><dd><Link href={`/enforcement?endpoint=${a.endpoint}`} className="mono-sm">{ep?.hostname}</Link> <span className="muted">· {ep?.os}</span></dd>
        <dt>Environment</dt><dd><EnvTag env={a.env} /></dd>
        <dt>Session</dt><dd className="mono-sm">{a.sessionId}</dd>
        {a.action.tool && <><dt>Agent tool</dt><dd className="mono-sm">{a.action.tool}</dd></>}
        {a.action.cwd && <><dt>Working dir</dt><dd className="mono-sm">{a.action.cwd}</dd></>}
        <dt>Risk</dt><dd><RiskTag risk={a.risk} /></dd>
        <dt>Policy</dt><dd>{pol ? <Link href={`/policies/${pol.id}`} className="view-all">{pol.name}</Link> : a.policyId}{rule && <span className="muted"> · {rule.match}</span>}</dd>
        <dt>Status</dt><dd><ApprovalPill state={a.state} />{!pending && a.decidedBy && <span className="muted"> by {a.decidedBy} · {a.decidedAgo}</span>}</dd>
      </dl>
      <div className="callout" style={{ marginTop: 0 }}>
        <Ic n="lock" size={16} />
        <span>
          {a.reason}. The decision binds to fingerprint <code>{a.fingerprint}</code> — change the command, target, arguments, session or identity and the agent must ask again.
        </span>
      </div>
      {a.note && !pending && <div className="callout" style={{ background: 'var(--panel-3)', borderColor: 'var(--border)' }}><Ic n="chat" size={16} /><span>{a.note}</span></div>}
      {pending ? (
        <>
          <div className="field" style={{ padding: '14px 20px 0' }}>
            <label htmlFor="appr-note">Note for the audit trail (optional)</label>
            <textarea id="appr-note" className="textarea" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why you approved or denied" />
          </div>
          <div className="decide-bar">
            <button className="btn-approve" onClick={() => decide(a.id, 'approved', note)}><Ic n="check" size={15} /> Approve once</button>
            <button className="btn-deny" onClick={() => decide(a.id, 'approval_denied', note)}><Ic n="x" size={15} /> Deny</button>
          </div>
          <div className={`expires wrap ${soon(a.expiresIn) ? 'soon' : ''}`} style={{ padding: '0 20px 18px' }}><Ic n="clock" size={13} /> Expires in {a.expiresIn} — the agent stays paused until then, then the action is denied.</div>
        </>
      ) : <div style={{ height: 18 }} />}
    </Card>
  );
}

export function Approvals({ initialId }: { initialId?: string }) {
  const { approvals, inEnv, env } = useStore();
  const [tab, setTab] = useState<'pending' | 'history'>(() => {
    const a = approvals.find((x) => x.id === initialId);
    return a && a.state !== 'approval_pending' ? 'history' : 'pending';
  });
  const [sel, setSel] = useState<string | null>(initialId ?? null);
  const pending = approvals.filter((a) => a.state === 'approval_pending' && inEnv(a.env));
  const history = approvals.filter((a) => a.state !== 'approval_pending' && inEnv(a.env));
  const rows = tab === 'pending' ? pending : history;
  const current = approvals.find((a) => a.id === sel) ?? rows[0] ?? null;

  return (
    <div className="page">
      <PageHead title="Approvals" sub="Risky actions pause on the endpoint and wait here for a human decision.">
        <DemoNote />
        {env && <span className="muted">Showing {envMeta(env).label} only</span>}
      </PageHead>

      <div className="appr-layout">
        <Card>
          <div className="tabs">
            <button className={tab === 'pending' ? 'on' : ''} onClick={() => { setTab('pending'); setSel(null); }}>Pending <span className="n">{pending.length}</span></button>
            <button className={tab === 'history' ? 'on' : ''} onClick={() => { setTab('history'); setSel(null); }}>History <span className="n">{history.length}</span></button>
          </div>
          {rows.length === 0 ? (
            <Empty title={tab === 'pending' ? 'All caught up' : 'No decisions yet'} sub={tab === 'pending' ? 'Nothing is waiting for an approver right now.' : undefined} />
          ) : rows.map((a) => (
            <div key={a.id} className={`appr-item ${current?.id === a.id ? 'sel' : ''}`} onClick={() => setSel(a.id)} role="button" tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && setSel(a.id)}>
              <AgentGlyph type={a.agentType} size={34} />
              <div className="appr-main">
                <div className="appr-title">{a.title} <RiskTag risk={a.risk} /></div>
                <div className="appr-meta">{AGENT_TYPES[a.agentType].label} <i className="sep">•</i> {a.user} <i className="sep">•</i> {endpointById(a.endpoint)?.hostname} <i className="sep">•</i> {a.requestedAgo}</div>
              </div>
              {a.state === 'approval_pending'
                ? <span className={`expires ${soon(a.expiresIn) ? 'soon' : ''}`}><Ic n="clock" size={13} /> {a.expiresIn}</span>
                : <ApprovalPill state={a.state} />}
            </div>
          ))}
        </Card>
        {current ? <DetailPanel key={current.id} a={current} /> : (
          <Card className="detail"><CardHead title="Nothing selected" sub="Pick a request to review the exact action." /></Card>
        )}
      </div>
    </div>
  );
}
