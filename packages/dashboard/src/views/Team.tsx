'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { agentMeta } from '@/data.ts';
import { Ic } from '@/icons.tsx';
import { useLive } from '@/live.tsx';
import { useStore } from '@/store.tsx';
import { ApiError, apiErrorText } from '@/lib/api.ts';
import { ClerkMembers, type Member } from '@/components/WorkspaceMembers.tsx';
import { Card, CardHead, Loading, PageGuide, PageHead, ReadOnlyNote } from '@/components/ui.tsx';

interface Group { id: string; name: string; description?: string; members: { user_id: string; email: string; name?: string }[] }
interface Route { id: string; name: string; kinds: string[]; patterns: string[]; machines: string[]; agents: string[]; group_id: string }
interface Routing { groups: Group[]; routes: Route[]; default_group: string; updated_by?: string; updated_at?: string }
interface TestResult { route_name: string; group_name: string; default: boolean }

const KINDS = [
  { id: '', label: 'Any request' },
  { id: 'command', label: 'Commands' },
  { id: 'website', label: 'Websites & IPs' },
  { id: 'tool', label: 'Agent tools & MCP' },
  { id: 'file', label: 'Files' },
];
const KIND_RULE: Record<string, string> = { command: 'command_approve', website: 'domain_approve', tool: 'tool_approve', file: 'file_approve', '': 'command_approve' };

const SAMPLE_MEMBERS: Member[] = [
  { user_id: 'user_demo_ciso', email: 'maya@acme.example', name: 'Maya Cohen (CISO)', role: 'security_admin' },
  { user_id: 'user_demo_ops', email: 'omer@acme.example', name: 'Omer Levi', role: 'member' },
  { user_id: 'user_demo_sre', email: 'noa@acme.example', name: 'Noa Peretz', role: 'member' },
  { user_id: 'user_demo_dev', email: 'dana@acme.example', name: 'Dana Katz', role: 'admin' },
];

const tmpId = (p: string) => `${p}${Math.random().toString(36).slice(2, 10)}`;
const list = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);

/** Who decides what: approver groups (workspace members) and the rules that route each request to one. */
export function Team({ dev }: { dev: boolean }) {
  const { api, canWrite, fixture, me, endpointRows } = useLive();
  const { dispatch } = useStore();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [isOrg, setIsOrg] = useState(true);
  const [invite, setInvite] = useState<(() => void) | null>(null);
  const [saved, setSaved] = useState<Routing | null>(null);
  const [draft, setDraft] = useState<Routing | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tryText, setTryText] = useState('aws s3 rm s3://prod-backups --recursive');
  const [tryKind, setTryKind] = useState('command');
  const [tryResult, setTryResult] = useState<TestResult | null>(null);
  const [rev, setRev] = useState(0); // remounts the free-text boxes after Save / Discard

  // members: Clerk in production; a fixed list under the dev bypass and in Demo Mode
  useEffect(() => {
    if (fixture) { setMembers(SAMPLE_MEMBERS); setIsOrg(true); }
    else if (dev) { setMembers([{ user_id: me?.user_id ?? 'admin', email: 'jane@localhost', name: 'Jane Doe (dev)', role: 'admin' }]); setIsOrg(false); }
  }, [dev, fixture, me?.user_id]);
  const onMembers = useCallback((m: Member[], org: boolean) => { setMembers(m); setIsOrg(org); }, []);
  const onInvite = useCallback((open: (() => void) | null) => setInvite(() => open), []);

  useEffect(() => {
    api.get<Routing>('/approval-routing')
      .then((r) => { setSaved(r); setDraft(r); })
      .catch((e) => setErr(e instanceof ApiError && e.status === 404 ? 'The control plane does not support approval routing yet — it needs to be updated.' : apiErrorText(e)));
  }, [api]);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(saved), [draft, saved]);
  const edit = (f: (d: Routing) => Routing) => setDraft((d) => (d ? f(structuredClone(d)) : d));
  const groupName = (id: string) => draft?.groups.find((g) => g.id === id)?.name ?? '—';

  const save = async () => {
    if (!draft) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.send<Routing>('PUT', '/approval-routing', draft);
      setSaved(r); setDraft(r); setRev((v) => v + 1);
      dispatch({ t: 'toast', text: 'Approvers saved — new requests are routed with these rules' });
    } catch (e) { setErr(apiErrorText(e)); } finally { setBusy(false); }
  };

  // "who would decide this?" — the control plane's own matcher, on the unsaved draft
  useEffect(() => {
    if (!draft || !tryText.trim()) { setTryResult(null); return; }
    const t = setTimeout(() => {
      api.send<TestResult>('POST', '/approval-routing/test', { summary: `${tryKind === 'website' ? 'WebFetch' : tryKind === 'tool' ? '' : 'Bash'}${tryKind === 'tool' ? '' : ': '}${tryText}`, reason: tryText, rule: KIND_RULE[tryKind], config: draft })
        .then(setTryResult).catch(() => setTryResult(null));
    }, 350);
    return () => clearTimeout(t);
  }, [api, draft, tryText, tryKind]);

  const starter = () => edit((d) => {
    const sec = { id: tmpId('grp_'), name: 'Security', description: 'CISO and the security team', members: [] };
    const ops = { id: tmpId('grp_'), name: 'DevOps', description: 'Cloud, infrastructure and deploys', members: [] };
    d.groups.push(sec, ops);
    d.routes.push(
      { id: tmpId('rte_'), name: 'Cloud and AWS', kinds: [], patterns: ['aws ', '*amazonaws.com*', 'terraform', 'kubectl'], machines: [], agents: [], group_id: ops.id },
      { id: tmpId('rte_'), name: 'Network tools and outside hosts', kinds: ['command'], patterns: ['curl', 'wget', 'scp', 'ssh '], machines: [], agents: [], group_id: sec.id },
      { id: tmpId('rte_'), name: 'Websites', kinds: ['website'], patterns: [], machines: [], agents: [], group_id: sec.id },
    );
    d.default_group = sec.id;
    return d;
  });

  const ro = !canWrite;
  const hosts = useMemo(() => [...new Set(endpointRows.filter((e) => !e.revoked).map((e) => e.hostname))], [endpointRows]);

  return (
    <div className="page">
      {!dev && !fixture && <ClerkMembers onMembers={onMembers} onInvite={onInvite} />}
      <PageHead title="Team & Approvers" sub="Who is in the workspace, and who decides which approval requests — e.g. AWS to DevOps, outside hosts to the CISO." >
        {ro && <ReadOnlyNote what="change approvers" />}
      </PageHead>
      <PageGuide id="team" steps={[<>Invite people to the workspace</>, <>Put them in <b>approver groups</b> (Security, DevOps…)</>, <>Add <b>rules</b>: which requests go to which group. Only that group is emailed and can decide; admins can step in</>]} />
      {err && <div className="callout bad"><Ic n="alert" size={16} /><span>{err}</span></div>}

      <Card>
        <CardHead title="Members" sub={isOrg ? 'People in this workspace. Admins and security admins change policy and can step in on any approval; everyone else is read-only unless an approver group includes them.' : 'This is a personal workspace: you are its only member. Create an organization (top right) to add your team.'}>
          {invite && <button className="btn sm" onClick={() => invite()}><Ic n="plus" size={14} /> Invite & manage members</button>}
        </CardHead>
        {!members ? <Loading label="Loading members…" /> : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Approver groups</th></tr></thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.user_id}>
                    <td className="cell-main">{m.name || '—'}{m.user_id === me?.user_id && <span className="badge b-muted" style={{ marginLeft: 8 }}>you</span>}</td>
                    <td className="mono-sm muted">{m.email}</td>
                    <td>{m.role.replace('_', ' ')}</td>
                    <td className="muted">{draft?.groups.filter((g) => g.members.some((x) => x.user_id === m.user_id)).map((g) => g.name).join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {!draft ? (!err && <Loading />) : (
        <>
          <Card>
            <CardHead title="Approver groups" sub="Each group is a set of workspace members. Its members get the email for requests routed to it, and can approve or deny them in the console or from the email.">
              {!ro && <button className="btn sm" onClick={() => edit((d) => { d.groups.push({ id: tmpId('grp_'), name: `Group ${d.groups.length + 1}`, members: [] }); return d; })}><Ic n="plus" size={14} /> Add group</button>}
            </CardHead>
            {draft.groups.length === 0 && (
              <div style={{ padding: '0 20px 18px' }}>
                <div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>No groups yet: every request goes to workspace admins.</div>
                {!ro && <button className="btn primary sm" onClick={starter}><Ic n="spark" size={14} /> Start with Security and DevOps</button>}
              </div>
            )}
            <div className="grid-2" style={{ padding: '0 20px 18px', gap: 12 }}>
              {draft.groups.map((g, gi) => (
                <div key={g.id} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input className="input" style={{ flex: 1, fontWeight: 600 }} value={g.name} disabled={ro} aria-label="Group name"
                      onChange={(e) => edit((d) => { d.groups[gi].name = e.target.value; return d; })} />
                    {!ro && <button className="btn sm" title="Delete group" onClick={() => edit((d) => {
                      d.groups.splice(gi, 1); d.routes = d.routes.filter((r) => r.group_id !== g.id); if (d.default_group === g.id) d.default_group = ''; return d;
                    })}><Ic n="trash" size={14} /></button>}
                  </div>
                  <input className="input" style={{ width: '100%', marginTop: 8, fontSize: 13 }} placeholder="What this group decides (optional)" value={g.description ?? ''} disabled={ro}
                    onChange={(e) => edit((d) => { d.groups[gi].description = e.target.value; return d; })} aria-label="Group description" />
                  <div className="section-label" style={{ margin: '12px 0 6px' }}>Members</div>
                  {(members ?? []).length === 0 && <div className="muted" style={{ fontSize: 13 }}>No members loaded.</div>}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {(members ?? []).map((m) => {
                      const on = g.members.some((x) => x.user_id === m.user_id);
                      return (
                        <label key={m.user_id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5 }}>
                          <input type="checkbox" checked={on} disabled={ro} onChange={(e) => edit((d) => {
                            const gm = d.groups[gi].members;
                            d.groups[gi].members = e.target.checked ? [...gm, { user_id: m.user_id, email: m.email, name: m.name }] : gm.filter((x) => x.user_id !== m.user_id);
                            return d;
                          })} />
                          <span>{m.name || m.email}</span><span className="muted mono-sm">{m.name ? m.email : ''}</span>
                        </label>
                      );
                    })}
                    {g.members.filter((x) => members && !members.some((m) => m.user_id === x.user_id)).map((x) => (
                      <div key={x.user_id} className="muted" style={{ fontSize: 12.5 }} title="No longer in the workspace">⚠ {x.name || x.email || x.user_id} (left the workspace)</div>
                    ))}
                  </div>
                  {g.members.length === 0 && <div className="callout warn" style={{ margin: '10px 0 0' }}><Ic n="alert" size={14} /><span>Nobody in this group: only admins can decide its requests.</span></div>}
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardHead title="Routing rules" sub="Checked top to bottom when an agent asks; the first rule that matches decides which group gets the request. Text matches the action as it was reported (secrets redacted), case-insensitive; * is a wildcard; leave a box empty to match anything.">
              {!ro && draft.groups.length > 0 && <button className="btn sm" onClick={() => edit((d) => { d.routes.push({ id: tmpId('rte_'), name: '', kinds: [], patterns: [], machines: [], agents: [], group_id: d.groups[0].id }); return d; })}><Ic n="plus" size={14} /> Add rule</button>}
            </CardHead>
            <div style={{ padding: '0 20px 6px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {draft.routes.length === 0 && <div className="muted" style={{ fontSize: 13 }}>{draft.groups.length ? 'No rules: every request goes to the default below.' : 'Add a group first.'}</div>}
              {draft.routes.map((r, ri) => (
                <div key={r.id} style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 12, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 12px', alignItems: 'center' }}>
                  <div className="tnum muted" style={{ fontWeight: 700, alignSelf: 'start', paddingTop: 8 }}>{ri + 1}</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <input className="input" style={{ flex: '1 1 200px' }} placeholder="Rule name, e.g. Cloud and AWS" value={r.name} disabled={ro} aria-label="Rule name"
                      onChange={(e) => edit((d) => { d.routes[ri].name = e.target.value; return d; })} />
                    <select className="select" style={{ flex: '0 1 190px' }} value={r.kinds[0] ?? ''} disabled={ro} aria-label="Kind of request"
                      onChange={(e) => edit((d) => { d.routes[ri].kinds = e.target.value ? [e.target.value] : []; return d; })}>
                      {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
                    </select>
                    <span className="muted">→</span>
                    <select className="select" style={{ flex: '0 1 170px', fontWeight: 600 }} value={r.group_id} disabled={ro} aria-label="Goes to group"
                      onChange={(e) => edit((d) => { d.routes[ri].group_id = e.target.value; return d; })}>
                      {draft.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>
                    {!ro && <>
                      <button className="btn sm" disabled={ri === 0} title="Move up" onClick={() => edit((d) => { [d.routes[ri - 1], d.routes[ri]] = [d.routes[ri], d.routes[ri - 1]]; return d; })}><Ic n="arrowUp" size={14} /></button>
                      <button className="btn sm" disabled={ri === draft.routes.length - 1} title="Move down" onClick={() => edit((d) => { [d.routes[ri + 1], d.routes[ri]] = [d.routes[ri], d.routes[ri + 1]]; return d; })}><Ic n="arrowDown" size={14} /></button>
                      <button className="btn sm" title="Delete rule" onClick={() => edit((d) => { d.routes.splice(ri, 1); return d; })}><Ic n="trash" size={14} /></button>
                    </>}
                  </div>
                  <span />
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <label className="muted" style={{ flex: '2 1 260px', fontSize: 12.5 }}>Matches any of (comma-separated)
                      <input key={`p-${r.id}-${rev}`} className="input mono" style={{ width: '100%', marginTop: 3 }} placeholder="empty = any request of this kind (e.g. aws, *amazonaws.com*)" defaultValue={r.patterns.join(', ')} disabled={ro}
                        onBlur={(e) => edit((d) => { d.routes[ri].patterns = list(e.target.value); return d; })} aria-label="Patterns" />
                    </label>
                    <label className="muted" style={{ flex: '1 1 180px', fontSize: 12.5 }}>On machines (optional)
                      <input key={`m-${r.id}-${rev}`} className="input mono" style={{ width: '100%', marginTop: 3 }} placeholder="empty = every machine" list="team-hosts" defaultValue={r.machines.join(', ')} disabled={ro}
                        onBlur={(e) => edit((d) => { d.routes[ri].machines = list(e.target.value); return d; })} aria-label="Machines" />
                    </label>
                    <label className="muted" style={{ flex: '1 1 160px', fontSize: 12.5 }}>Agent (optional)
                      <select className="select" style={{ width: '100%', marginTop: 3 }} value={r.agents[0] ?? ''} disabled={ro} aria-label="Agent"
                        onChange={(e) => edit((d) => { d.routes[ri].agents = e.target.value ? [e.target.value] : []; return d; })}>
                        <option value="">Any agent</option>
                        {['claude-code', 'codex', 'gemini-cli', 'cursor-agent'].map((a) => <option key={a} value={a}>{agentMeta(a).label}</option>)}
                      </select>
                    </label>
                  </div>
                </div>
              ))}
              <datalist id="team-hosts">{hosts.map((h) => <option key={h} value={h} />)}</datalist>
            </div>
            <div className="toolbar" style={{ padding: '10px 20px 16px' }}>
              <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5 }}>Anything else goes to
                <select className="select" style={{ width: 220 }} value={draft.default_group} disabled={ro} aria-label="Default group"
                  onChange={(e) => edit((d) => { d.default_group = e.target.value; return d; })}>
                  <option value="">Workspace admins</option>
                  {draft.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </label>
            </div>
          </Card>

          <Card>
            <CardHead title="Try it" sub="Type an action an agent might ask for and see who would decide it — with the rules above, saved or not." />
            <div className="toolbar" style={{ padding: '0 20px 16px' }}>
              <select className="select" style={{ flex: '0 1 190px' }} value={tryKind} onChange={(e) => setTryKind(e.target.value)} aria-label="Kind">
                {KINDS.filter((k) => k.id).map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
              </select>
              <input className="input mono" style={{ flex: '1 1 300px' }} value={tryText} onChange={(e) => setTryText(e.target.value)} aria-label="Action to try"
                placeholder="aws s3 rm s3://prod --recursive" />
              <span style={{ fontSize: 14 }}>
                {tryResult ? <>→ <b>{tryResult.group_name || 'Workspace admins'}</b> <span className="muted">{tryResult.route_name ? `(rule “${tryResult.route_name}”)` : tryResult.default ? '(default)' : '(no rule matched)'}</span></> : <span className="muted">—</span>}
              </span>
            </div>
          </Card>

          {!ro && (
            <div className="toolbar" style={{ position: 'sticky', bottom: 0, padding: '12px 0', background: 'var(--bg)' }}>
              <span className="muted" style={{ fontSize: 13 }}>
                {dirty ? 'Unsaved changes. Requests already waiting keep the group they were routed to.' : saved?.updated_at ? `Saved · requests are routed with these rules` : 'Not set up yet.'}
              </span>
              <span className="grow" />
              <button className="btn" disabled={!dirty || busy} onClick={() => { setDraft(saved); setRev((v) => v + 1); }}><Ic n="rotate" /> Discard</button>
              <button className="btn primary" disabled={!dirty || busy} onClick={save}><Ic n="check" /> {busy ? 'Saving…' : 'Save approvers'}</button>
            </div>
          )}
          <div className="muted" style={{ fontSize: 13 }}>
            What needs approval at all is set in <Link href="/policies" className="view-all">Policies</Link> (<code>command_approve</code>, <code>domain_approve</code>, <code>tool_approve</code>…). Requests and decisions: <Link href="/approvals" className="view-all">Approvals</Link>.
          </div>
        </>
      )}
    </div>
  );
}
