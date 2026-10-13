'use client';

import Link from 'next/link';
import { useState } from 'react';
import { userById } from '@/data.ts';
import { Ic } from '@/icons.tsx';
import { useStore } from '@/store.tsx';
import type { ListEntry, ListKind } from '@/types.ts';
import { Card, DemoNote, Empty, PageHead, Seg } from '@/components/ui.tsx';

const KINDS: { id: ListKind | 'all'; label: string; icon: string }[] = [
  { id: 'all', label: 'All', icon: 'layers' },
  { id: 'exec', label: 'Executables', icon: 'terminal' },
  { id: 'file', label: 'Files', icon: 'file' },
  { id: 'network', label: 'Network', icon: 'globe' },
  { id: 'mcp', label: 'MCP tools', icon: 'plug' },
];

const PLACEHOLDER: Record<ListKind, string> = {
  exec: '/usr/local/bin/terraform',
  file: '*/.env.production',
  network: 'api.example.com:443',
  mcp: 'github.create_pull_request',
};

function validate(kind: ListKind, v: string): string | null {
  if (!v.trim()) return null;
  if (kind === 'exec' && !v.startsWith('/')) return 'Exec entries must be absolute paths — the kernel matches the resolved binary (symlinks followed).';
  if (kind === 'network' && /\s/.test(v)) return 'Use host or host:port, no spaces.';
  return null;
}

export function Lists({ initialList }: { initialList?: string }) {
  const { lists, dispatch, viewer } = useStore();
  const [list, setList] = useState<'allow' | 'deny'>(initialList === 'deny' ? 'deny' : 'allow');
  const [kind, setKind] = useState<ListKind | 'all'>('all');
  const [q, setQ] = useState('');
  const [nk, setNk] = useState<ListKind>('exec');
  const [val, setVal] = useState('');
  const [scope, setScope] = useState('Global');
  const [note, setNote] = useState('');

  const rows = lists.filter((e) => e.list === list && (kind === 'all' || e.kind === kind) && `${e.value} ${e.note}`.toLowerCase().includes(q.toLowerCase()));
  const err = validate(nk, val.trim());
  const add = () => {
    if (!val.trim() || err) return;
    const entry: ListEntry = { id: `le-${Date.now().toString(36)}`, list, kind: nk, value: val.trim(), scope, note: note.trim() || '—', addedBy: viewer.name, addedAgo: 'just now', hits24h: 0 };
    dispatch({ t: 'addEntry', entry });
    setVal(''); setNote('');
  };

  return (
    <div className="page">
      <PageHead title="Allow/Deny Lists" sub="Org-wide lists every policy can reference — binaries, files, hosts and MCP tools.">
        <DemoNote />
        <Seg value={list} onChange={setList} options={[
          { id: 'allow', label: <>Allowlist · {lists.filter((e) => e.list === 'allow').length}</> },
          { id: 'deny', label: <>Denylist · {lists.filter((e) => e.list === 'deny').length}</> },
        ]} />
      </PageHead>

      <div className="callout warn" style={{ margin: 0 }}><Ic n="layers" size={16} /><span>
        The lists your endpoints actually enforce — <code>exec_deny</code>, <code>exec_allow</code>, <code>file_deny</code>, <code>file_alert</code>, <code>network_deny</code>, <code>network_allow</code> — live in the workspace policy.
        Edit and publish them on <Link href="/policies" style={{ textDecoration: 'underline' }}>Policies</Link>. Shared org-wide lists below are a preview and are not sent to endpoints.
      </span></div>

      <div className="toolbar">
        <div className="chips">
          {KINDS.map((k) => (
            <button key={k.id} className={`chip ${kind === k.id ? 'on' : ''}`} onClick={() => setKind(k.id)}>
              <Ic n={k.icon} size={14} /> {k.label}
              <span className="n">{lists.filter((e) => e.list === list && (k.id === 'all' || e.kind === k.id)).length}</span>
            </button>
          ))}
        </div>
        <span className="grow" />
        <input className="input" style={{ width: 260 }} placeholder="Filter entries…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter entries" />
      </div>

      <Card>
        {rows.length === 0 ? <Empty icon="listCheck" title="No entries" sub="Nothing matches this filter." /> : (
          <div className="tbl-wrap" style={{ paddingTop: 6 }}>
            <table className="tbl">
              <thead><tr><th>Entry</th><th>Type</th><th>Scope</th><th>Note</th><th>Added</th><th className="num">Hits 24h</th><th aria-label="Remove" /></tr></thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td><span className="mono-chip" style={{ color: list === 'allow' ? 'var(--green)' : 'var(--red)' }}>{e.value}</span></td>
                    <td className="muted">{KINDS.find((k) => k.id === e.kind)?.label}</td>
                    <td>{e.scope}</td>
                    <td className="muted">{e.note}</td>
                    <td className="muted">{userById(e.addedBy)?.name ?? e.addedBy} · {e.addedAgo}</td>
                    <td className="num tnum">{e.hits24h.toLocaleString()}</td>
                    <td className="right"><button className="icon-btn ghost" aria-label={`Remove ${e.value}`} onClick={() => dispatch({ t: 'removeEntry', id: e.id })}><Ic n="trash" size={15} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="form-row">
          <div className="field" style={{ flex: '0 1 150px' }}>
            <label htmlFor="l-kind">Type</label>
            <select id="l-kind" className="select" value={nk} onChange={(e) => setNk(e.target.value as ListKind)}>
              {KINDS.filter((k) => k.id !== 'all').map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
            </select>
          </div>
          <div className="field" style={{ flex: '2 1 240px' }}>
            <label htmlFor="l-val">Value</label>
            <input id="l-val" className="input mono" placeholder={PLACEHOLDER[nk]} value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
          </div>
          <div className="field" style={{ flex: '0 1 160px' }}>
            <label htmlFor="l-scope">Scope</label>
            <select id="l-scope" className="select" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option>Global</option><option>Production</option><option>Staging</option><option>Development</option>
            </select>
          </div>
          <div className="field" style={{ flex: '2 1 200px' }}>
            <label htmlFor="l-note">Note</label>
            <input id="l-note" className="input" placeholder="Why" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
          </div>
          <button className={`btn ${list === 'allow' ? 'primary' : 'danger'}`} onClick={add} disabled={!val.trim() || !!err}><Ic n="plus" /> Add to {list}list</button>
        </div>
        {err && <div className="callout warn" style={{ margin: '0 20px 16px' }}><Ic n="alert" size={16} /><span>{err}</span></div>}
      </Card>

      <div className="callout"><Ic n="cpu" size={16} /><span>
        Executables are matched on the resolved binary path, per binary — not per argument: <code>node good.js</code> and <code>node evil.js</code> are the same binary.
        Argument-level checks (e.g. <code>kubectl delete</code>) belong in a policy rule, where agent hooks can see the full command.
      </span></div>
    </div>
  );
}
