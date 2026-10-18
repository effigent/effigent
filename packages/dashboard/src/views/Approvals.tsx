'use client';

import { HELP } from '@/lib/help.tsx';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ACTION_CLASS_LABEL, AGENT_TYPES, endpointById, envMeta, userById } from '@/data.ts';
import { Ic } from '@/icons.tsx';
import { useStore } from '@/store.tsx';
import type { Action, AgentType, Approval, ApprovalState } from '@/types.ts';
import { useLive } from '@/live.tsx';
import { apiErrorText, type ApiApproval } from '@/lib/api.ts';
import { ago } from '@/lib/live-map.ts';
import { AgentGlyph, ApprovalPill, Card, CardHead, Empty, EnvTag, Loading, PageGuide, PageHead, ReadOnlyNote, RiskTag, InfoTip } from '@/components/ui.tsx';
import { useDemoMode } from '@/demo.tsx';

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

const SUB = 'Risky actions pause on the endpoint and wait here for a human decision.';

/** Live requests from the control plane, or the sample workspace in Demo Mode. */
export function Approvals({ initialId }: { initialId?: string }) {
  const { demo } = useDemoMode();
  if (demo) return <ApprovalQueue initialId={initialId} />;
  return <LiveApprovalQueue initialId={initialId} />;
}

const RULE_LABEL: Record<string, string> = {
  exec_approve: 'Program needs approval (exec_approve)',
  command_approve: 'Command needs approval (command_approve)',
  tool_approve: 'Tool needs approval (tool_approve)',
  file_approve: 'File needs approval (file_approve)',
  domain_approve: 'Site needs approval (domain_approve)',
  network_approve: 'Address needs approval (network_approve)',
};

/** cp approval state -> the console's pill. "used" = approved and run. */
function pillState(a: ApiApproval): ApprovalState {
  switch (a.state) {
    case 'pending': return 'approval_pending';
    case 'approved': case 'used': return 'approved';
    case 'denied': return 'approval_denied';
    default: return 'expired';
  }
}

function untilText(ms: number): string {
  if (ms <= 0) return 'expired';
  const m = Math.ceil(ms / 60_000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function agentType(a: ApiApproval): AgentType {
  return (a.agent in AGENT_TYPES ? a.agent : 'claude-code') as AgentType;
}

function LiveDetail({ a, now }: { a: ApiApproval; now: number }) {
  const { api, canWrite, refresh } = useLive();
  const { viewer, dispatch } = useStore();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pending = a.state === 'pending' && Date.parse(a.expires_at) > now;
  // routed requests: the group's members decide, admins may step in (older control planes: admins)
  const mayDecide = a.can_decide ?? canWrite;
  const override = !!a.decide_is_override;
  const left = Date.parse(a.expires_at) - now;
  const label = AGENT_TYPES[agentType(a)]?.label ?? a.agent;

  const decide = async (decision: 'approve' | 'deny') => {
    setBusy(true); setErr(null);
    try {
      await api.send('POST', `/approvals/${encodeURIComponent(a.id)}/decision`, { decision, note: note.trim(), name: viewer.name });
      dispatch({ t: 'toast', text: `${decision === 'approve' ? 'Approved' : 'Denied'} — ${a.summary.slice(0, 80)}` });
      await refresh();
    } catch (e) {
      setErr(apiErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const sent = Object.entries(a.notified ?? {});
  return (
    <Card className="detail">
      <div className="detail-hero">
        <AgentGlyph type={agentType(a)} size={44} />
        <div style={{ minWidth: 0 }}>
          <h3>{a.reason || a.summary}</h3>
          <div className="cell-sub">{label} on {a.hostname} · requested {ago(Date.parse(a.requested_at), now)}</div>
        </div>
      </div>
      <div className="section-label">Exact action</div>
      <div className="code-line">{a.summary}</div>
      <dl className="kv">
        <dt>Machine</dt><dd><Link href={`/enforcement?endpoint=${a.endpoint_id}`} className="mono-sm">{a.hostname}</Link>{a.os_user && <span className="muted"> · user {a.os_user}</span>}</dd>
        <dt>Agent</dt><dd>{label}{a.tool && <span className="muted"> · tool <span className="mono-sm">{a.tool}</span></span>}</dd>
        {a.cwd && <><dt>Working dir</dt><dd className="mono-sm">{a.cwd}</dd></>}
        <dt>Session</dt><dd className="mono-sm">{a.session_id || '—'}</dd>
        <dt>Rule</dt><dd>{RULE_LABEL[a.rule] ?? a.rule} · <Link href="/policies" className="view-all">policy</Link></dd>
        <dt>Decided by <InfoTip label="How requests are routed">{HELP.decidedBy}</InfoTip></dt><dd>{a.group_name ? <><b>{a.group_name}</b> <span className="muted">· routed by <Link href="/team" className="view-all">Team &amp; Approvers</Link></span></> : <span className="muted">Workspace admins (no routing rule matched)</span>}</dd>
        <dt>Status</dt><dd><ApprovalPill state={pillState(a)} />
          {a.state !== 'pending' && a.decided_at && <span className="muted"> by {a.decided_by_name || a.decided_by} · {ago(Date.parse(a.decided_at), now)}</span>}
          {a.state === 'used' && a.used_at && <span className="muted"> · ran {ago(Date.parse(a.used_at), now)}</span>}
          {a.state === 'approved' && <span className="muted"> · waiting for the agent to run it</span>}
        </dd>
        {sent.length > 0 && <><dt>Notified</dt><dd>{sent.map(([ch, r]) => <span key={ch} className={`badge ${r === 'sent' ? 'b-green' : ch === 'none' ? 'b-muted' : 'b-red'}`} title={r} style={{ marginRight: 6 }}>{ch === 'none' ? 'console only' : `${ch}: ${r === 'sent' ? 'sent' : 'failed'}`}</span>)}</dd></>}
      </dl>
      <div className="callout" style={{ marginTop: 0 }}>
        <Ic n="lock" size={16} />
        <span>
          Approving lets this exact action run once. It binds to fingerprint <code>{a.fingerprint.slice(0, 16)}…</code> — a different command, file, session or user asks again.
        </span>
      </div>
      {a.note && !pending && <div className="callout" style={{ background: 'var(--panel-3)', borderColor: 'var(--border)' }}><Ic n="chat" size={16} /><span>{a.note}</span></div>}
      {err && <div className="callout bad"><Ic n="alert" size={16} /><span>{err}</span></div>}
      {pending ? (
        <>
          <div className="field" style={{ padding: '14px 20px 0' }}>
            <label htmlFor="appr-note">Note (shown to the agent and kept in the audit trail)</label>
            <textarea id="appr-note" className="textarea" rows={2} value={note} disabled={!mayDecide} onChange={(e) => setNote(e.target.value)} placeholder="Why you approved or denied" />
          </div>
          {override && <div className="callout warn" style={{ margin: '12px 20px 0' }}><Ic n="alert" size={16} /><span>This request is for <b>{a.group_name}</b>. You can step in as a workspace admin; the decision is recorded as an admin override.</span></div>}
          <div className="decide-bar">
            <button className="btn-approve" disabled={!mayDecide || busy} onClick={() => decide('approve')}><Ic n="check" size={15} /> {override ? 'Approve as admin' : 'Approve once'}</button>
            <button className="btn-deny" disabled={!mayDecide || busy} onClick={() => decide('deny')}><Ic n="x" size={15} /> {override ? 'Deny as admin' : 'Deny'}</button>
            <InfoTip align="right" label="What approving does">{HELP.approveOnce}</InfoTip>
          </div>
          {!mayDecide && <div className="muted" style={{ padding: '0 20px 8px', fontSize: 13 }}>{a.group_name ? <>Waiting for <b>{a.group_name}</b> — only its members (or a workspace admin) can decide.</> : <ReadOnlyNote what="approve or deny requests" />}</div>}
          <div className={`expires wrap ${left < 5 * 60_000 ? 'soon' : ''}`} style={{ padding: '0 20px 18px' }}><Ic n="clock" size={13} /> Expires in {untilText(left)}. Until then the agent is told the action is waiting; a retry after approval runs it.</div>
        </>
      ) : <div style={{ height: 18 }} />}
    </Card>
  );
}

function LiveApprovalQueue({ initialId }: { initialId?: string }) {
  const { approvals, now, loaded, refreshApprovals } = useLive();
  const [tick, setTick] = useState(() => Date.now());
  // Pending requests matter by the second: poll them faster than the console's 15s refresh while this page is open.
  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) { void refreshApprovals(); setTick(Date.now()); } }, 5_000);
    return () => clearInterval(id);
  }, [refreshApprovals]);
  const t = Math.max(now, tick);
  const isPending = (a: ApiApproval) => a.state === 'pending' && Date.parse(a.expires_at) > t;
  const [tab, setTab] = useState<'pending' | 'history'>(() => {
    const a = approvals.find((x) => x.id === initialId);
    return a && a.state !== 'pending' ? 'history' : 'pending';
  });
  const [sel, setSel] = useState<string | null>(initialId ?? null);
  const pending = approvals.filter(isPending);
  const history = approvals.filter((a) => !isPending(a));
  const rows = tab === 'pending' ? pending : history;
  const current = approvals.find((a) => a.id === sel) ?? rows[0] ?? null;

  return (
    <div className="page">
      <PageHead info={HELP.approvals} title="Approvals" sub={SUB}>
        <Link className="btn sm" href="/settings#approvals"><Ic n="bell" /> Slack & email</Link>
      </PageHead>
      <PageGuide id="approvals" steps={[<>Add approval rules in <Link href="/policies" className="view-all">Policies</Link> (e.g. <code>git push*</code>)</>, <>When an agent hits one it pauses, and approvers get Slack or email</>, <>Approve once or deny — here, or from the message</>]} />
      {!loaded ? <Card><Loading /></Card> : approvals.length === 0 ? (
        <Card>
          <Empty icon="shield" title="No approval requests yet"
            sub="Nothing has asked yet. Add an approval rule — e.g. ask before any git push, or before GitHub MCP tools — and agents pause here until someone decides." />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', padding: '0 0 24px' }}>
            <Link className="btn primary sm" href="/policies"><Ic n="plus" /> Add an approval rule</Link>
            <Link className="btn sm" href="/settings#approvals"><Ic n="bell" /> Connect Slack & email</Link>
          </div>
        </Card>
      ) : (
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
                <AgentGlyph type={agentType(a)} size={34} />
                <div className="appr-main">
                  <div className="appr-title mono-sm">{a.summary}</div>
                  <div className="appr-meta">{AGENT_TYPES[agentType(a)]?.label ?? a.agent} <i className="sep">•</i> {a.os_user || '—'} <i className="sep">•</i> {a.hostname} <i className="sep">•</i> {ago(Date.parse(a.requested_at), t)}</div>
                </div>
                {isPending(a)
                  ? <span className={`expires ${Date.parse(a.expires_at) - t < 5 * 60_000 ? 'soon' : ''}`}><Ic n="clock" size={13} /> {untilText(Date.parse(a.expires_at) - t)}</span>
                  : <ApprovalPill state={pillState(a)} />}
              </div>
            ))}
          </Card>
          {current ? <LiveDetail key={current.id} a={current} now={t} /> : (
            <Card className="detail"><CardHead title="Nothing selected" sub="Pick a request to review the exact action." /></Card>
          )}
        </div>
      )}
    </div>
  );
}

function ApprovalQueue({ initialId }: { initialId?: string }) {
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
      <PageHead info={HELP.approvals} title="Approvals" sub={SUB}>
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
