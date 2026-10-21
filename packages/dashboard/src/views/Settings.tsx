'use client';

import { HELP } from '@/lib/help.tsx';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Ic } from '@/icons.tsx';
import { SlackApp } from '@/components/SlackApp.tsx';
import { useLive } from '@/live.tsx';
import { API_BASE, ApiError, apiErrorText, type ApiNotifications, type ApiPolicySettings } from '@/lib/api.ts';
import { Integrations } from '@/components/Integrations.tsx';
import { SpendVendors } from '@/components/SpendVendors.tsx';
import { Storage } from '@/components/Storage.tsx';
import { EventRetention } from '@/components/EventRetention.tsx';
import { PROPOSALS_CHANGED, announcePending } from '@/components/PolicyProposals.tsx';
import { useStore } from '@/store.tsx';
import { Card, CardHead, DemoNote, PageGuide, PageHead, ReadOnlyNote, Switch, ThemeSelect } from '@/components/ui.tsx';
import { useDemoMode } from '@/demo.tsx';

const NOT_STORED = 'These preferences are not stored by the control plane yet — changes here are not saved';

function Row({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="setting-row">
      <div><div className="setting-title">{title}</div><div className="setting-desc">{desc}</div></div>
      {children}
    </div>
  );
}

export function Settings({ dev }: { dev: boolean }) {
  const { me, canWrite, fixture, loaded } = useLive();
  const pendingMe = loaded ? '—' : '…';
  const { demo, setDemo } = useDemoMode();
  const [s, setS] = useState({
    failClosed: true, unknownMode: 'monitor', orphanMcp: true, redact: true,
  });
  const set = <K extends keyof typeof s>(k: K, v: (typeof s)[K]) => setS({ ...s, [k]: v });

  return (
    <div className="page">
      <PageHead info={HELP.settings} title="Settings" sub="Notifications, integrations and workspace options. Each card saves on its own." />
      <PageGuide id="settings" steps={[<><b>Approvals</b>: connect Slack and email so approvers can decide from the message</>, <><b>Integrations</b>: API keys and webhooks for Windmill, Tines or scripts; <b>AI vendors</b> for Pricing Leaks</>, <><b>Workspace</b>: your role, and the control plane you are connected to</>]} />

      <div className="grid-2">
        <div id="approvals" style={{ scrollMarginTop: 88 }}><ApprovalNotifications /></div>
        <div id="integrations" style={{ scrollMarginTop: 88 }}><Integrations /></div>
      </div>
      <div id="ai-vendors" style={{ scrollMarginTop: 88 }}><SpendVendors /></div>

      <div className="grid-2">

        <Card>
          <CardHead title="Enforcement defaults" sub="Applied by effigentd when no policy says otherwise."><DemoNote title={NOT_STORED} label="Not saved yet" /></CardHead>
          <Row title="Fail closed" desc="Start an agent only once the kernel policy for its pid is confirmed live.">
            <Switch on={s.failClosed} onChange={(v) => set('failClosed', v)} label="Fail closed" />
          </Row>
          <Row title="Mode for unrecognised agents" desc="Processes that look like agents but match no detection rule.">
            <select className="select" style={{ width: 130 }} value={s.unknownMode} onChange={(e) => set('unknownMode', e.target.value)} aria-label="Mode for unrecognised agents">
              <option value="monitor">Monitor</option><option value="learn">Learn</option><option value="denylist">Denylist</option>
            </select>
          </Row>
          <Row title="Track orphan MCP servers" desc="An MCP server with no known agent above it becomes its own tracked root.">
            <Switch on={s.orphanMcp} onChange={(v) => set('orphanMcp', v)} label="Track orphan MCP servers" />
          </Row>
          <Row title="Redact tool input on the endpoint" desc="Secrets are stripped before events leave the machine.">
            <Switch on={s.redact} onChange={(v) => set('redact', v)} label="Redact tool input" />
          </Row>
        </Card>

        <Card>
          <CardHead title="Workspace & access" sub="What the control plane decided from your Clerk session — the active organization is the workspace." />
          <Row title="Workspace" desc={me?.tenant.startsWith('user:') ? 'Personal workspace — switch organization in the top bar to manage a team.' : 'Your active Clerk organization.'}>
            <code className="mono-chip" style={{ color: 'var(--txt-2)' }}>{me?.tenant ?? pendingMe}</code>
          </Row>
          <Row title="Your role" desc="Org admins and security admins can publish policy, revoke endpoints and enroll machines; everyone else is view-only.">
            {me ? <span className={`badge ${canWrite ? 'b-green' : 'b-muted'}`}>{me.role || 'member'} · {canWrite ? 'can change' : 'view only'}</span> : <span className="muted">{pendingMe}</span>}
          </Row>
          <Row title="Endpoint enrollment" desc="One-time tokens (expiry + max uses), exchanged by effigentd for its own secret.">
            <Link className="btn sm" href="/enforcement"><Ic n="key" /> Enroll an endpoint</Link>
          </Row>
          <Row title="Control plane" desc="Signed policy distribution and event collection.">
            <code className="mono-chip" style={{ color: 'var(--txt-2)' }}>{fixture ? 'Demo Mode — sample data' : API_BASE}</code>
          </Row>
        </Card>

        <div id="policy-changes" style={{ scrollMarginTop: 88 }}><PolicyChangeApproval /></div>
      </div>

      <div id="storage" style={{ scrollMarginTop: 88 }}><EventRetention /></div>

      <Card>
        <CardHead title="Appearance" sub="How the console looks in this browser." />
        <Row title="Theme" desc="System follows your operating system's light or dark setting. Saved in this browser only.">
          <ThemeSelect />
        </Row>
      </Card>

      <Card>
        <CardHead title="Demo Mode" sub="Show a sample workspace — agents, events, approvals, lists, identity and the agent graph — to see what a full deployment looks like." />
        <Row title="Show sample data" desc="Saved in this browser only. Nothing in Demo Mode reaches the control plane: publishing, enrolling and revoking work on the sample data alone.">
          <Switch on={demo} onChange={setDemo} label="Demo Mode" />
        </Row>
      </Card>

      <Card>
        <CardHead title="Storage" sub="Where this workspace's data lives — Effigent-managed, or a bucket in your own AWS account." />
        <div style={{ padding: '0 20px 20px' }}>
          {demo
            ? <div className="callout" style={{ margin: 0 }}><Ic n="eye" size={16} /><span>Storage settings are hidden in Demo Mode — they would change your real workspace. Turn Demo Mode off to manage storage.</span></div>
            : dev
            ? <div className="callout warn" style={{ margin: 0 }}><Ic n="lock" size={16} /><span>Storage settings call the Clerk-authenticated <code>/api/v1/storage</code> API, which is unavailable while auth is bypassed. Sign in with Clerk to manage storage.</span></div>
            : <Storage />}
        </div>
      </Card>
    </div>
  );
}

/** Policy change approval: publishing needs a second admin (on applies at once, off is itself a proposal). */
function PolicyChangeApproval() {
  const { api, canWrite } = useLive();
  const { dispatch } = useStore();
  const [v, setV] = useState<ApiPolicySettings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const load = () => api.get<ApiPolicySettings>('/policy/settings').then(setV)
      .catch((e) => setErr(e instanceof ApiError && e.status === 404 ? 'The control plane does not support policy change approval yet — it needs to be updated.' : apiErrorText(e)));
    void load();
    window.addEventListener(PROPOSALS_CHANGED, load);
    return () => window.removeEventListener(PROPOSALS_CHANGED, load);
  }, [api]);
  const toggle = async (on: boolean) => {
    if (!canWrite || busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.send<{ settings?: ApiPolicySettings }>('PUT', '/policy/settings', { policy_change_approval: on });
      if (!announcePending(r, (text) => dispatch({ t: 'toast', text }))) {
        if (r.settings) setV(r.settings);
        dispatch({ t: 'toast', text: on ? 'Policy changes now need a second admin' : 'Policy change approval is off' });
      }
    } catch (e) { setErr(apiErrorText(e)); } finally { setBusy(false); }
  };
  return (
    <Card>
      <CardHead info={HELP.changeApproval} title="Policy changes" sub="Four eyes on everything that publishes a policy version." />
      <Row title="Require a second admin" desc="Publishing a policy, adding or removing an exception and changing a machine’s owner wait in Policies until another admin or security admin approves. Turning this off needs approval too.">
        {v ? <Switch on={v.policy_change_approval} onChange={toggle} label="Require a second admin" /> : <span className="muted">…</span>}
      </Row>
      {v?.policy_change_approval && <div className="muted" style={{ padding: '0 20px 14px', fontSize: 13 }}>Pending changes: <Link href="/policies" className="view-all">Policies</Link>. API keys can propose, never approve; there is no emergency bypass.</div>}
      {err && <div className="callout bad" style={{ margin: '0 20px 14px' }}><Ic n="alert" size={16} /><span>{err}</span></div>}
      {!canWrite && <div style={{ padding: '0 20px 14px' }}><ReadOnlyNote what="change this" /></div>}
    </Card>
  );
}

/** Where approval requests go: a Slack incoming webhook and/or email
 *  recipients, stored by the control plane (the webhook URL is write-only). */
function ApprovalNotifications() {
  const { api, canWrite, fixture } = useLive();
  const [n, setN] = useState<ApiNotifications | null>(null);
  const [hook, setHook] = useState('');
  const [emails, setEmails] = useState('');
  const [tmpl, setTmpl] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    api.get<ApiNotifications>('/notifications')
      .then((v) => { if (live) { setN(v); setEmails(v.emails.join(', ')); setTmpl(v.ticket_url_template ?? ''); } })
      .catch((e) => {
        if (!live) return;
        setMsg({ ok: false, text: e instanceof ApiError && e.status === 404
          ? 'The control plane does not support approvals yet — it needs to be updated.' : apiErrorText(e) });
      });
    return () => { live = false; };
  }, [api]);

  const list = emails.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean);
  const slack = !!n?.slack_enabled;
  const save = async (body: { slack_webhook?: string; emails?: string[]; ticket_url_template?: string }, done: string) => {
    setBusy(true); setMsg(null);
    try {
      const v = await api.send<ApiNotifications>('PUT', '/notifications', body);
      setN(v); setEmails(v.emails.join(', ')); setHook(''); setTmpl(v.ticket_url_template ?? '');
      setMsg({ ok: true, text: done });
    } catch (e) {
      setMsg({ ok: false, text: apiErrorText(e) });
    } finally {
      setBusy(false);
    }
  };
  const test = async (sample?: 'approval') => {
    setBusy(true); setMsg(null);
    try {
      const r = await api.send<Record<string, string>>('POST', '/notifications/test', sample ? { sample } : {});
      const parts = Object.entries(r).map(([ch, res]) => `${ch === 'slack' ? 'Slack' : 'Email'}: ${res}`);
      setMsg({ ok: Object.values(r).every((v) => v.startsWith('sent')), text: parts.length ? parts.join(' · ') : slack ? 'Nothing to test yet — connect Slack or add an email first.' : 'Nothing to test yet — add an email first.' });
    } catch (e) {
      setMsg({ ok: false, text: apiErrorText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHead info={HELP.notifications} title="Approvals" sub={slack
        ? 'When an agent pauses for approval, the request is posted to Slack and email. Approvers decide in Slack (with the Effigent app), from the email, or in the console — every decision records who made it.'
        : 'When an agent pauses for approval, each approver below gets an email with Approve / Deny buttons, or decides in the console. Every decision records who made it.'} />
      {n && slack && <SlackApp n={n} onChange={setN} />}
      {slack && <>
      <Row title={n?.slack_app?.connected ? 'Slack webhook (not used while the app is connected)' : 'Slack webhook'}
        desc="Simpler: an incoming webhook posts each request to one channel. Its buttons open the console to decide, since a webhook can’t tell who clicked.">
        {n?.slack_webhook_set
          ? <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className="badge b-green">Connected {n.slack_webhook_hint}</span>
              <button className="btn sm" disabled={!canWrite || busy} onClick={() => save({ slack_webhook: '' }, 'Slack disconnected.')}>Remove</button>
            </span>
          : <span className="muted">Not connected</span>}
      </Row>
      <div style={{ padding: '0 20px 14px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input className="input mono" style={{ flex: '1 1 260px' }} placeholder="https://hooks.slack.com/services/…" value={hook} disabled={!canWrite}
          onChange={(e) => setHook(e.target.value)} aria-label="Slack incoming webhook URL" />
        <button className="btn sm" disabled={!canWrite || busy || !hook.trim()} onClick={() => save({ slack_webhook: hook.trim() }, 'Slack connected.')}>
          {n?.slack_webhook_set ? 'Replace' : 'Connect'}
        </button>
        <a className="view-all" style={{ alignSelf: 'center' }} href="https://api.slack.com/messaging/webhooks" target="_blank" rel="noreferrer">How to get a webhook</a>
      </div>
      </>}
      <Row title="Email" desc="Each request is emailed to these addresses (comma-separated).">
        {n && !n.email_available && <span className="badge b-gold" title="The control plane needs EFFIGENT_SMTP_URL and EFFIGENT_EMAIL_FROM">Email not set up on the server</span>}
      </Row>
      <div style={{ padding: '0 20px 14px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input className="input" style={{ flex: '1 1 260px' }} placeholder="security@yourcompany.com, lead@yourcompany.com" value={emails} disabled={!canWrite}
          onChange={(e) => setEmails(e.target.value)} aria-label="Approver emails" />
        <button className="btn sm" disabled={!canWrite || busy || (n !== null && list.join(',') === n.emails.join(','))} onClick={() => save({ emails: list }, 'Email recipients saved.')}>Save</button>
      </div>
      <Row title="Ticket links" desc="Approvers can attach a ticket when they approve (a rule in Team & Approvers can require one). With a template, keys like SEC-123 link to your tracker.">
        <span />
      </Row>
      <div style={{ padding: '0 20px 14px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input className="input mono" style={{ flex: '1 1 260px' }} placeholder="https://acme.atlassian.net/browse/{key}" value={tmpl} disabled={!canWrite}
          onChange={(e) => setTmpl(e.target.value)} aria-label="Ticket link template" />
        <button className="btn sm" disabled={!canWrite || busy || n === null || tmpl.trim() === (n.ticket_url_template ?? '')}
          onClick={() => save({ ticket_url_template: tmpl.trim() }, tmpl.trim() ? 'Ticket links saved.' : 'Ticket links removed.')}>Save</button>
      </div>
      <Row title="Send a test" desc={fixture ? 'Demo Mode: nothing is actually sent.' : slack ? 'Posts a sample request to Slack and email, so you can see where they land.' : 'Emails a sample request, so you can see what approvers get.'}>
        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button className="btn sm" disabled={!canWrite || busy} onClick={() => test()}><Ic n="bell" /> Send test</button>
          <button className="btn sm" disabled={!canWrite || busy} onClick={() => test('approval')} title="The exact message approvers get, for a sample paused action">Send sample approval request</button>
        </span>
      </Row>
      {msg && <div className={`callout ${msg.ok ? '' : 'bad'}`} style={{ margin: '0 20px 14px' }}><Ic n={msg.ok ? 'checkCircle' : 'alert'} size={16} /><span>{msg.text}</span></div>}
      {!canWrite && <div style={{ padding: '0 20px 14px' }}><ReadOnlyNote what="change approval notifications" /></div>}
      <div className="muted" style={{ padding: '0 20px 18px', fontSize: 13 }}>
        What needs approval, how long a request stays open and how long the agent waits are set in the <Link href="/policies" className="view-all">policy</Link>: <code>command_approve</code>, <code>tool_approve</code>, <code>exec_approve</code>, … and <code>approvals: {'{'} ttl_minutes, wait_seconds {'}'}</code>.
      </div>
    </Card>
  );
}
