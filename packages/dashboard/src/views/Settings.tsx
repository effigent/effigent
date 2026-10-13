'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Ic } from '@/icons.tsx';
import { useLive } from '@/live.tsx';
import { API_BASE } from '@/lib/api.ts';
import { Storage } from '@/components/Storage.tsx';
import { Card, CardHead, DemoNote, PageHead } from '@/components/ui.tsx';

const NOT_STORED = 'These preferences are not stored by the control plane yet — changes here are not saved';

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} />;
}

function Row({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="setting-row">
      <div><div className="setting-title">{title}</div><div className="setting-desc">{desc}</div></div>
      {children}
    </div>
  );
}

export function Settings({ dev }: { dev: boolean }) {
  const { me, canWrite, fixture } = useLive();
  const [s, setS] = useState({
    expiry: '15', twoApprovers: true, slack: true, channel: '#agent-approvals', selfApprove: false,
    failClosed: true, unknownMode: 'monitor', orphanMcp: true, redact: true, retention: '365',
  });
  const set = <K extends keyof typeof s>(k: K, v: (typeof s)[K]) => setS({ ...s, [k]: v });

  return (
    <div className="page">
      <PageHead title="Settings" sub="Workspace defaults for approvals, enforcement, data and endpoint enrollment.">
        <button className="btn primary" disabled title={NOT_STORED}><Ic n="check" /> Save changes</button>
      </PageHead>

      <div className="grid-2">
        <Card>
          <CardHead title="Approvals" sub="How paused actions reach people, and how long agents wait."><DemoNote title={NOT_STORED} /></CardHead>
          <Row title="Request expiry" desc="After this, the paused action is denied and the agent continues.">
            <select className="select" style={{ width: 130 }} value={s.expiry} onChange={(e) => set('expiry', e.target.value)} aria-label="Request expiry">
              <option value="5">5 minutes</option><option value="15">15 minutes</option><option value="30">30 minutes</option><option value="60">1 hour</option>
            </select>
          </Row>
          <Row title="Two approvers for high-risk actions" desc="Production writes, infrastructure changes, database writes.">
            <Switch on={s.twoApprovers} onChange={(v) => set('twoApprovers', v)} label="Two approvers for high-risk actions" />
          </Row>
          <Row title="Allow self-approval" desc="Let the person whose agent asked approve their own request.">
            <Switch on={s.selfApprove} onChange={(v) => set('selfApprove', v)} label="Allow self-approval" />
          </Row>
          <Row title="Notify in Slack" desc="Post requests with Approve / Deny buttons.">
            <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <input className="input mono" style={{ width: 170 }} value={s.channel} disabled={!s.slack} onChange={(e) => set('channel', e.target.value)} aria-label="Slack channel" />
              <Switch on={s.slack} onChange={(v) => set('slack', v)} label="Notify in Slack" />
            </span>
          </Row>
        </Card>

        <Card>
          <CardHead title="Enforcement defaults" sub="Applied by effigentd when no policy says otherwise."><DemoNote title={NOT_STORED} /></CardHead>
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
            <code className="mono-chip" style={{ color: 'var(--txt-2)' }}>{me?.tenant ?? '…'}</code>
          </Row>
          <Row title="Your role" desc="Org admins and security admins can publish policy, revoke endpoints and enroll machines; everyone else is view-only.">
            {me ? <span className={`badge ${canWrite ? 'b-green' : 'b-muted'}`}>{me.role || 'member'} · {canWrite ? 'can change' : 'view only'}</span> : <span className="muted">…</span>}
          </Row>
          <Row title="Endpoint enrollment" desc="One-time tokens (expiry + max uses), exchanged by effigentd for its own secret.">
            <Link className="btn sm" href="/enforcement"><Ic n="key" /> Enroll an endpoint</Link>
          </Row>
          <Row title="Control plane" desc="Signed policy distribution and event collection.">
            <code className="mono-chip" style={{ color: 'var(--txt-2)' }}>{fixture ? 'local fixture (dev)' : API_BASE}</code>
          </Row>
        </Card>

        <Card>
          <CardHead title="Data" sub="Audit trail retention for this workspace."><DemoNote title={NOT_STORED} /></CardHead>
          <Row title="Retention" desc="Events, decisions and policy versions.">
            <select className="select" style={{ width: 130 }} value={s.retention} onChange={(e) => set('retention', e.target.value)} aria-label="Retention">
              <option value="90">90 days</option><option value="365">1 year</option><option value="730">2 years</option>
            </select>
          </Row>
        </Card>
      </div>

      <Card>
        <CardHead title="Storage" sub="Where this workspace's data lives — Effigent-managed, or a bucket in your own AWS account." />
        <div style={{ padding: '0 20px 20px' }}>
          {dev
            ? <div className="callout warn" style={{ margin: 0 }}><Ic n="lock" size={16} /><span>Storage settings call the Clerk-authenticated <code>/api/v1/storage</code> API, which is unavailable while auth is bypassed. Sign in with Clerk to manage storage.</span></div>
            : <Storage />}
        </div>
      </Card>
    </div>
  );
}
