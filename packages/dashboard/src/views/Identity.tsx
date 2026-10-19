'use client';

import { HELP } from '@/lib/help.tsx';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ic } from '@/icons.tsx';
import { useLive } from '@/live.tsx';
import { useStore } from '@/store.tsx';
import { ApiError, apiErrorText, type ApiIdentityKind, type ApiPeople, type ApiPerson, type ApiSighting, type ApiSuggestion } from '@/lib/api.ts';
import { AgentGlyph, Card, CardHead, Empty, Loading, PageGuide, PageHead, ReadOnlyNote, initials } from '@/components/ui.tsx';

const KIND_LABEL: Record<ApiIdentityKind | 'person', string> = {
  os_user: 'OS user', git_email: 'Git email', host: 'Machine', github: 'GitHub', email: 'Other email', api_key: 'API key', person: 'Person',
};
const KIND_HINT: Record<ApiIdentityKind, string> = {
  os_user: 'dana, or dana@build-7 for one machine', git_email: 'dana@personal.dev', host: 'dana-mbp', github: 'dana-k', email: 'dana@old-domain.com', api_key: 'ci-nightly',
};
const VIA_LABEL: Record<string, string> = { os_user: 'OS user', git_email: 'git email', owner: 'machine owner', host: 'machine' };
const CONF_BADGE: Record<string, string> = { high: 'b-green', medium: 'b-gold', low: 'b-muted' };
const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 60 * 36 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};
const SUB = 'Who is behind each agent: the OS users, git emails, machines and vendor accounts each person goes by. Pricing Leaks and attribution use it.';

/** People: the workspace's people mapping (GET /people), with what effigentd
 *  saw on each machine and suggested matches to accept. */
export function Identity({ initialUser }: { initialUser?: string }) {
  const { api, canWrite } = useLive();
  const { dispatch } = useStore();
  const [data, setData] = useState<ApiPeople | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState(initialUser ?? '');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const ro = !canWrite;

  const load = useCallback(() => api.get<ApiPeople>('/people')
    .then((d) => { setData(d); setErr(null); })
    .catch((e) => setErr(e instanceof ApiError && e.status === 404 ? 'The control plane does not support People yet — it needs to be updated.' : apiErrorText(e))), [api]);
  useEffect(() => { void load(); }, [load]);

  const run = async (f: () => Promise<unknown>, done?: string) => {
    try { await f(); if (done) dispatch({ t: 'toast', text: done }); await load(); } catch (e) { setErr(apiErrorText(e)); }
  };
  const map = (kind: ApiIdentityKind | 'person', value: string, email: string, name = '', source: 'manual' | 'suggestion' = 'manual') =>
    run(() => api.send('POST', '/people/identities', { kind, value, email, name, source }),
      kind === 'person' ? `Added ${email}` : `${KIND_LABEL[kind]} ${value} → ${email}`);

  const needle = q.trim().toLowerCase();
  const people = useMemo(() => (data?.people ?? []).filter((p) => !needle
    || `${p.email} ${p.name} ${p.identities.map((i) => i.value).join(' ')}`.toLowerCase().includes(needle)), [data, needle]);
  const suggestions = (data?.suggestions ?? []).filter((s) => !hidden.has(`${s.kind}:${s.value}`));
  const sightings = useMemo(() => (data?.sightings ?? []).filter((s) => !needle
    || `${s.hostname} ${s.os_user} ${s.git_email} ${s.person} ${s.agents.join(' ')}`.toLowerCase().includes(needle)), [data, needle]);
  const matched = (data?.sightings ?? []).filter((s) => s.person);
  const personal = matched.filter((s) => s.via === 'os_user' || s.via === 'git_email').length;

  return (
    <div className="page">
      <PageHead info={HELP.spendPeople} title="People" sub={SUB}>
        <input className="input" style={{ width: 240 }} placeholder="Filter people, users, machines…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter people" />
        {ro && <ReadOnlyNote what="map people" />}
      </PageHead>
      <PageGuide id="people" steps={[
        <>Accept the <b>suggestions</b>: OS users that commit as a known email, vendor seats not listed yet</>,
        <>Map what’s left by hand: an OS user, git email, machine, GitHub login or API key → a work email</>,
        <>See the result on <Link href="/pricing-leaks" className="view-all">Pricing Leaks</Link>: each leak says how the person was matched</>,
      ]} />
      {err && <div className="callout bad"><Ic n="alert" size={16} /><span>{err}</span></div>}

      {!data ? (!err && <Loading />) : (
        <>
          <div className="grid-4">
            <Card className="mini-stat"><div className="k">People</div><div className="v">{data.people.length}</div><div className="s">{data.people.reduce((n, p) => n + p.identities.length, 0)} identities mapped</div></Card>
            <Card className="mini-stat"><div className="k">Matched to a person</div><div className="v">{matched.length}/{data.sightings.length}</div><div className="s">OS users seen in {data.window_days} days · {personal} by their own identity</div></Card>
            <Card className="mini-stat"><div className="k">Suggestions</div><div className="v" style={{ color: suggestions.length ? 'var(--gold)' : undefined }}>{suggestions.length}</div><div className="s">waiting for review</div></Card>
            <Card className="mini-stat"><div className="k">Unattributed machines</div><div className="v" style={{ color: data.unattributed.length ? 'var(--gold)' : undefined }}>{data.unattributed.length}</div><div className="s mono-sm">{data.unattributed.slice(0, 3).join(', ') || 'none'}</div></Card>
          </div>

          {suggestions.length > 0 && (
            <Card>
              <CardHead title="Suggested matches" sub="From what effigentd and your vendors saw. Nothing is mapped until you accept it." />
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead><tr><th>Map</th><th>To</th><th>Why</th><th>Confidence</th><th /></tr></thead>
                  <tbody>
                    {suggestions.map((s) => <SuggestionRow key={`${s.kind}:${s.value}`} s={s} ro={ro}
                      onAccept={() => map(s.kind, s.value, s.email, s.name ?? '', 'suggestion')}
                      onHide={() => setHidden(new Set(hidden).add(`${s.kind}:${s.value}`))} />)}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <Card>
            <CardHead title="People" sub="Each person by work email, and every identity they go by. A machine mapping only attributes activity; the machine’s owner (Machines) stays what central policies use." />
            {!ro && <AddPerson onAdd={(email, name) => map('person', email, email, name)} />}
            {people.length === 0 ? (
              <Empty icon="users" title={needle ? 'No one matches the filter' : 'No people yet'} sub={needle ? undefined : 'Accept a suggestion or add someone by work email. Vendor seats and machine owners already count as people for Pricing Leaks.'} />
            ) : (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead><tr><th>Person</th><th>Identities</th><th>Machines seen</th><th /></tr></thead>
                  <tbody>{people.map((p) => <PersonRow key={p.email} p={p} ro={ro} sightings={data.sightings.filter((s) => s.person === p.email)} kinds={data.kinds}
                    onAdd={(kind, value) => map(kind, value, p.email)}
                    onRemove={(kind, value) => run(() => api.send('DELETE', `/people/identities?kind=${encodeURIComponent(kind)}&value=${encodeURIComponent(value)}`), `Unmapped ${KIND_LABEL[kind]} ${value}`)}
                    onRename={(name) => run(() => api.send('PUT', `/people/${encodeURIComponent(p.email)}`, { name, identities: p.identities.map((i) => ({ kind: i.kind, value: i.value, source: i.source })) }), 'Saved')}
                    onDelete={() => { if (confirm(`Remove ${p.email} and the ${p.identities.length} identities mapped to them?`)) void run(() => api.send('DELETE', `/people/${encodeURIComponent(p.email)}`), `Removed ${p.email}`); }} />)}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card>
            <CardHead info={HELP.peopleSightings} title="Seen by effigentd" sub={`Who ran agents on each machine in the last ${data.window_days} days, and who they count as.`} />
            {sightings.length === 0 ? (
              <Empty icon="laptop" title="Nothing seen yet" sub="Agent activity from enrolled machines shows up here, with the OS user and git email behind it." />
            ) : (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead><tr><th>Machine</th><th>OS user</th><th>Git email</th><th>Agents</th><th className="num">Events</th><th>Last seen</th><th>Counts as</th></tr></thead>
                  <tbody>{sightings.map((s) => <SightingRow key={`${s.endpoint_id}|${s.os_user}|${s.git_email}`} s={s} people={data.people} ro={ro} onMap={map} />)}</tbody>
                </table>
              </div>
            )}
          </Card>

          <div className="callout" style={{ margin: 0 }}><Ic n="lock" size={16} /><span>
            Console sign-in and roles come from Clerk: org admins and security admins can change things; everyone else is view-only. Who approves what is on <Link href="/team" style={{ textDecoration: 'underline' }}>Team &amp; Approvers</Link>.
          </span></div>
        </>
      )}
    </div>
  );
}

function SuggestionRow({ s, ro, onAccept, onHide }: { s: ApiSuggestion; ro: boolean; onAccept: () => void; onHide: () => void }) {
  return (
    <tr>
      <td>{s.kind === 'person' ? <span className="badge b-blue">Add person</span> : <><span className="muted" style={{ fontSize: 12 }}>{KIND_LABEL[s.kind]}</span> <code className="mono-sm">{s.value}</code></>}</td>
      <td><div className="cell-main">{s.name || s.email}</div>{s.name && <div className="mono-sm">{s.email}</div>}</td>
      <td className="muted" style={{ fontSize: 13, whiteSpace: 'normal' }}>{s.reason}</td>
      <td><span className={`badge ${CONF_BADGE[s.confidence] ?? 'b-muted'}`}>{s.confidence}</span></td>
      <td className="num" style={{ whiteSpace: 'nowrap' }}>
        {!ro && <button className="btn primary sm" onClick={onAccept}><Ic n="check" size={14} /> Accept</button>}{' '}
        <button className="btn sm" onClick={onHide} title="Hide until the page reloads">Dismiss</button>
      </td>
    </tr>
  );
}

function AddPerson({ onAdd }: { onAdd: (email: string, name: string) => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const ok = /^[^\s@]+@[^\s@]+$/.test(email.trim());
  return (
    <div style={{ padding: '0 20px 12px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <input className="input mono" style={{ flex: '2 1 200px' }} placeholder="work email" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Work email" />
      <input className="input" style={{ flex: '1 1 140px' }} placeholder="name (optional)" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
      <button className="btn sm" disabled={!ok} onClick={() => { onAdd(email.trim().toLowerCase(), name.trim()); setEmail(''); setName(''); }}><Ic n="plus" size={14} /> Add person</button>
    </div>
  );
}

function PersonRow({ p, ro, sightings, kinds, onAdd, onRemove, onRename, onDelete }: {
  p: ApiPerson; ro: boolean; sightings: ApiSighting[]; kinds: ApiIdentityKind[];
  onAdd: (kind: ApiIdentityKind, value: string) => void; onRemove: (kind: ApiIdentityKind, value: string) => void; onRename: (name: string) => void; onDelete: () => void;
}) {
  const [kind, setKind] = useState<ApiIdentityKind>('os_user');
  const [value, setValue] = useState('');
  const [name, setName] = useState(p.name);
  const hosts = [...new Set(sightings.map((s) => s.hostname))];
  const agents = [...new Set(sightings.flatMap((s) => s.agents))];
  return (
    <tr>
      <td style={{ verticalAlign: 'top', minWidth: 210 }}>
        <span className="agent-cell">
          <span className="avatar sm">{initials(p.name || p.email)}</span>
          <span style={{ minWidth: 0 }}>
            {ro ? <span className="cell-main">{p.name || p.email}</span>
              : <input className="input" style={{ height: 28, fontSize: 13, width: 170 }} value={name} placeholder="name" aria-label={`Name of ${p.email}`}
                  onChange={(e) => setName(e.target.value)} onBlur={() => { if (name.trim() !== p.name) onRename(name.trim()); }} />}
            <span className="cell-sub mono-sm">{p.email}</span>
          </span>
        </span>
      </td>
      <td style={{ verticalAlign: 'top' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: ro ? 0 : 8 }}>
          {p.identities.length === 0 && <span className="muted" style={{ fontSize: 13 }}>Only their work email</span>}
          {p.identities.map((i) => (
            <span key={`${i.kind}:${i.value}`} className="mono-chip" title={`${KIND_LABEL[i.kind]}${i.source === 'suggestion' ? ' · accepted suggestion' : ''}${i.created_by ? ` · by ${i.created_by}` : ''}`}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span className="muted" style={{ fontSize: 11 }}>{KIND_LABEL[i.kind]}</span> {i.value}
              {!ro && <button style={{ background: 'none', border: 0, padding: 0, display: 'inline-flex', cursor: 'pointer', color: 'var(--txt-3)' }} aria-label={`Unmap ${i.value}`} title="Unmap" onClick={() => onRemove(i.kind, i.value)}><Ic n="x" size={12} /></button>}
            </span>
          ))}
        </div>
        {!ro && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <select className="select" style={{ height: 30, fontSize: 12.5, width: 120 }} value={kind} onChange={(e) => setKind(e.target.value as ApiIdentityKind)} aria-label="Identity kind">
              {kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
            <input className="input mono" style={{ height: 30, fontSize: 12.5, flex: '1 1 160px' }} placeholder={KIND_HINT[kind]} value={value} onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) { onAdd(kind, value.trim()); setValue(''); } }} aria-label="Identity value" />
            <button className="btn sm" disabled={!value.trim()} onClick={() => { onAdd(kind, value.trim()); setValue(''); }}><Ic n="plus" size={13} /> Map</button>
          </div>
        )}
      </td>
      <td style={{ verticalAlign: 'top' }}>
        <div className="mono-sm">{hosts.join(', ') || <span className="muted">—</span>}</div>
        {agents.length > 0 && <span style={{ display: 'inline-flex', gap: 4, marginTop: 6 }}>{agents.map((a) => <AgentGlyph key={a} type={a} size={20} tip={a} />)}</span>}
      </td>
      <td style={{ verticalAlign: 'top' }} className="num">{!ro && <button className="btn sm" title="Remove person" onClick={onDelete}><Ic n="trash" size={14} /></button>}</td>
    </tr>
  );
}

const GENERIC = new Set(['root', 'admin', 'administrator', 'ubuntu', 'ec2-user', 'user', 'dev', 'developer', 'node', 'runner', 'ci', 'build', 'jenkins', 'vagrant', 'docker', 'app']);

function SightingRow({ s, people, ro, onMap }: { s: ApiSighting; people: ApiPerson[]; ro: boolean; onMap: (kind: ApiIdentityKind, value: string, email: string) => void }) {
  const [to, setTo] = useState('');
  // what to map: the OS user (on this machine only if it's a shared login), else the git email, else the machine
  const target: [ApiIdentityKind, string] = s.os_user ? ['os_user', GENERIC.has(s.os_user) ? `${s.os_user}@${s.hostname.toLowerCase()}` : s.os_user]
    : s.git_email ? ['git_email', s.git_email] : ['host', s.hostname.toLowerCase()];
  return (
    <tr>
      <td className="mono-sm">{s.hostname}</td>
      <td className="mono-sm">{s.os_user || <span className="muted">—</span>}</td>
      <td className="mono-sm">{s.git_email || <span className="muted">—</span>}</td>
      <td><span style={{ display: 'inline-flex', gap: 4 }}>{s.agents.map((a) => <AgentGlyph key={a} type={a} size={20} tip={a} />)}</span></td>
      <td className="num tnum">{s.events.toLocaleString('en-US')}</td>
      <td className="muted">{ago(s.last_seen)}</td>
      <td style={{ minWidth: 200 }}>
        {s.person ? <><div className="cell-main">{people.find((p) => p.email === s.person)?.name || s.person}</div><div className="muted" style={{ fontSize: 12 }}>by {VIA_LABEL[s.via ?? ''] ?? s.via}</div></>
          : ro || people.length === 0 ? <span className="badge b-gold">not matched</span>
          : (
            <span style={{ display: 'flex', gap: 6 }}>
              <select className="select" style={{ height: 30, fontSize: 12.5, flex: 1 }} value={to} onChange={(e) => setTo(e.target.value)} aria-label={`Map ${target[1]} to a person`}>
                <option value="">Map {KIND_LABEL[target[0]].toLowerCase()} {target[1]} to…</option>
                {people.map((p) => <option key={p.email} value={p.email}>{p.name ? `${p.name} (${p.email})` : p.email}</option>)}
              </select>
              <button className="btn sm" disabled={!to} onClick={() => onMap(target[0], target[1], to)}>Map</button>
            </span>
          )}
      </td>
    </tr>
  );
}
