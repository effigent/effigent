'use client';

import { useState } from 'react';
import { AGENTS, ENDPOINTS, USERS } from '@/data.ts';
import { Ic } from '@/icons.tsx';
import { useStore } from '@/store.tsx';
import type { ConsoleRole } from '@/types.ts';
import { AgentGlyph, Card, CardHead, DemoNote, PageHead, initials } from '@/components/ui.tsx';

const ROLES: { id: ConsoleRole; label: string; desc: string }[] = [
  { id: 'admin', label: 'Admin', desc: 'Everything, including identity and settings' },
  { id: 'approver', label: 'Approver', desc: 'Decides paused actions; read-only elsewhere' },
  { id: 'member', label: 'Member', desc: 'Sees their own agents and activity' },
  { id: 'viewer', label: 'Viewer', desc: 'Read-only console access' },
];

const PERMS: { label: string; roles: ConsoleRole[] }[] = [
  { label: 'View agents, graph and audit trail', roles: ['admin', 'approver', 'member', 'viewer'] },
  { label: 'Approve / deny paused actions', roles: ['admin', 'approver'] },
  { label: 'Edit policies and allow/deny lists', roles: ['admin'] },
  { label: 'Enroll endpoints / rotate tokens', roles: ['admin'] },
  { label: 'Manage users and roles', roles: ['admin'] },
  { label: 'Export audit evidence', roles: ['admin', 'approver'] },
];

export function Identity({ initialUser }: { initialUser?: string }) {
  const { inEnv, dispatch } = useStore();
  const [roles, setRoles] = useState<Record<string, ConsoleRole>>(() => Object.fromEntries(USERS.map((u) => [u.id, u.role])));
  const [q, setQ] = useState('');
  const users = USERS.filter((u) => `${u.name} ${u.id} ${u.team} ${u.title}`.toLowerCase().includes(q.toLowerCase()));
  const unmapped = ['build', 'ci-runner'];

  return (
    <div className="page">
      <PageHead title="Identity & Access" sub="Who the people behind each agent are, how OS accounts map to them, and what they may do in the console.">
        <DemoNote />
        <input className="input" style={{ width: 240 }} placeholder="Filter people…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter people" />
      </PageHead>

      <div className="grid-4">
        <Card className="mini-stat"><div className="k">People</div><div className="v">{USERS.length}</div><div className="s">{USERS.filter((u) => u.isNew).length} joined this week</div></Card>
        <Card className="mini-stat"><div className="k">Approvers</div><div className="v">{Object.values(roles).filter((r) => r === 'approver' || r === 'admin').length}</div><div className="s">Admins can approve too</div></Card>
        <Card className="mini-stat"><div className="k">MFA enabled</div><div className="v">{USERS.filter((u) => u.mfa).length}/{USERS.length}</div><div className="s">Enforced by your IdP</div></Card>
        <Card className="mini-stat"><div className="k">Unmapped OS accounts</div><div className="v" style={{ color: 'var(--gold)' }}>{unmapped.length}</div><div className="s mono-sm">{unmapped.join(', ')}</div></Card>
      </div>

      <Card>
        <CardHead title="People" sub="Agent actions are attributed to a person via the endpoint's OS account (action.Context.user_id)." />
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Person</th><th>Team</th><th>OS accounts</th><th>Endpoints</th><th>Agents</th><th>MFA</th><th>Last seen</th><th>Console role</th></tr></thead>
            <tbody>
              {users.map((u) => {
                const agents = AGENTS.filter((a) => a.user === u.id && inEnv(a.env));
                const eps = ENDPOINTS.filter((e) => e.owner === u.id);
                return (
                  <tr key={u.id} className={initialUser === u.id ? 'sel' : ''}>
                    <td>
                      <span className="agent-cell">
                        <span className="avatar sm">{initials(u.name)}</span>
                        <span><span className="cell-main">{u.name}{u.isNew && <span className="badge b-blue" style={{ marginLeft: 8, height: 18, fontSize: 10.5 }}>New</span>}</span><span className="cell-sub">{u.id} · {u.title}</span></span>
                      </span>
                    </td>
                    <td>{u.team}</td>
                    <td className="mono-sm">{u.osUsers.join(', ')}</td>
                    <td className="mono-sm">{eps.map((e) => e.hostname).join(', ') || '—'}</td>
                    <td><span style={{ display: 'inline-flex', gap: 4 }}>{agents.map((a) => <AgentGlyph key={a.id} type={a.type} size={22} />)}{agents.length === 0 && <span className="muted">—</span>}</span></td>
                    <td>{u.mfa ? <Ic n="check" size={16} style={{ color: 'var(--green)' }} /> : <span className="badge b-gold">Off</span>}</td>
                    <td className="muted">{u.lastSeen}</td>
                    <td>
                      <select className="select" style={{ height: 32, fontSize: 12.5 }} aria-label={`Role for ${u.name}`} value={roles[u.id]}
                        onChange={(e) => {
                          setRoles({ ...roles, [u.id]: e.target.value as ConsoleRole });
                          dispatch({ t: 'toast', text: `${u.name} is now ${e.target.value}` });
                        }}>
                        {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid-2">
        <Card>
          <CardHead title="Roles & permissions" />
          <div className="tbl-wrap">
            <table className="tbl perm-grid">
              <thead><tr><th>Capability</th>{ROLES.map((r) => <th key={r.id} title={r.desc}>{r.label}</th>)}</tr></thead>
              <tbody>
                {PERMS.map((p) => (
                  <tr key={p.label}>
                    <td>{p.label}</td>
                    {ROLES.map((r) => <td key={r.id}>{p.roles.includes(r.id) ? <Ic n="check" size={16} className="perm-yes" /> : <span className="perm-no">—</span>}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card>
          <CardHead title="Sign-in & directory" sub="Console sign-in and org membership come from Clerk; roles map from your organization." />
          <dl className="kv">
            <dt>Identity provider</dt><dd>Clerk (SSO / SAML via your IdP)</dd>
            <dt>Organization</dt><dd>One Clerk organization = one Effigent workspace</dd>
            <dt>OS → person mapping</dt><dd>Endpoint enrollment binds the device owner; extra OS accounts are mapped here</dd>
            <dt>Unmapped accounts</dt><dd>Actions are recorded as <code>attribution_uncertain</code> and can be routed to approval</dd>
          </dl>
        </Card>
      </div>
    </div>
  );
}
