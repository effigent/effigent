'use client';

import Link from 'next/link';
import { Exceptions } from '@/components/Exceptions.tsx';
import { PolicyAssist } from '@/components/PolicyAssist.tsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PolicyDiff, lineStats } from '@/components/PolicyDiff.tsx';
import { MODES } from '@/data.ts';
import { Ic } from '@/icons.tsx';
import { useLive } from '@/live.tsx';
import { useStore } from '@/store.tsx';
import { ApiError, apiErrorText } from '@/lib/api.ts';
import { ago, dateTime, ms, summarizePolicy } from '@/lib/live-map.ts';
import type { Mode } from '@/types.ts';
import { Card, CardHead, Empty, Loading, ModeTag, PageGuide, PageHead, ReadOnlyNote } from '@/components/ui.tsx';

/**
 * The control plane keeps one endpoint policy per workspace: an effigentd
 * policy YAML (internal/endpoint/policy/default.yaml format), versioned. A
 * publish is validated server-side with the same parser the endpoints use,
 * stored as the next version, signed, and pulled by every enrolled endpoint
 * within its sync interval (5s by default).
 */
export function Policies() {
  const { policy, history, endpointRows, latestPolicy, loaded, canWrite, me, api, now, refresh } = useLive();
  const { dispatch } = useStore();
  const server = policy?.body ?? '';
  const [draft, setDraft] = useState<string | null>(null); // null = untouched, follow the server
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ text: string; parse: boolean } | null>(null);
  const text = draft ?? server;
  const dirty = draft !== null && draft !== server;

  // A newer version published elsewhere while editing: keep the draft, but say so.
  const [base, setBase] = useState<number | null>(null);
  useEffect(() => { if (draft === null) setBase(policy?.version ?? null); }, [draft, policy?.version]);
  const stale = dirty && base !== null && policy !== null && policy.version !== base;

  // Side by side: the left is what's live (or any version), the right is your edit (or any version).
  const [leftSel, setLeftSel] = useState<number | null>(null); // null = the live version
  const [rightSel, setRightSel] = useState<number | null>(null); // null = your edit
  const [onlyChanges, setOnlyChanges] = useState(false);
  const [bodies, setBodies] = useState<Record<number, string>>({});
  const [verErr, setVerErr] = useState<string | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const bodyOf = (v: number | null): string | undefined => (v === null || v === policy?.version ? server : bodies[v]);
  useEffect(() => {
    for (const v of [leftSel, rightSel]) {
      if (v === null || v === policy?.version || bodies[v] !== undefined) continue;
      api.get<{ body: string }>(`/policy/versions/${v}`)
        .then((r) => setBodies((b) => ({ ...b, [v]: r.body ?? '' })))
        .catch((e) => setVerErr(apiErrorText(e)));
    }
  }, [leftSel, rightSel, policy?.version, bodies, api]);
  const leftText = bodyOf(leftSel);
  const rightText = rightSel === null ? text : bodyOf(rightSel);
  const editing = rightSel === null;
  const comparing = leftSel !== null || rightSel !== null;
  const split = dirty || comparing; // one column while just viewing
  const stats = useMemo(() => (leftText !== undefined && rightText !== undefined ? lineStats(leftText, rightText) : null), [leftText, rightText]);
  const liveLabel = latestPolicy > 0 ? `v${latestPolicy} (live)` : 'Built-in default';
  const compare = (from: number, to: number | null) => {
    setLeftSel(from === latestPolicy ? null : from); setRightSel(to === latestPolicy ? null : to);
    if (to === latestPolicy && !dirty) setRightSel(null);
    editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const restore = (v: number) => {
    const b = bodyOf(v);
    const load = (body: string) => { setDraft(body); setRightSel(null); setLeftSel(null); setComment((c) => c || `Restore v${v}`); setErr(null); editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    if (b !== undefined) load(b);
    else api.get<{ body: string }>(`/policy/versions/${v}`).then((r) => load(r.body ?? '')).catch((e) => setVerErr(apiErrorText(e)));
  };

  const eps = endpointRows.filter((e) => !e.revoked);
  const onLatest = eps.filter((e) => latestPolicy > 0 && e.policyVersion === latestPolicy).length;
  const summary = summarizePolicy(text);
  const mode = summary.mode && summary.mode in MODES ? (summary.mode as Mode) : null;
  const lists = Object.entries(summary.lists).filter(([k]) => k !== 'network');

  const publish = async () => {
    if (!comment.trim() && !window.confirm('Publish without a comment? The comment is what the audit trail and history show for this version.')) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.send<{ version: number }>('PUT', '/policy', { body: text, comment: comment.trim() });
      dispatch({ t: 'toast', text: `Published policy v${r.version} — endpoints pick it up within seconds` });
      setDraft(null); setComment('');
      await refresh();
    } catch (e) {
      setErr({ text: apiErrorText(e), parse: e instanceof ApiError && e.status === 400 });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <PageHead title="Policies" sub="What agents may run, open and reach — one signed policy per workspace, enforced on every endpoint by effigentd." >
        {me && !canWrite && <ReadOnlyNote what="publish policy" />}
      </PageHead>
      <PageGuide id="policies" steps={[<>Describe a change to <b>Ask AI</b>, or edit the policy text below</>, <>Add <b>exceptions</b> for machines that need something the company blocks</>, <><b>Publish</b> — every machine applies it within seconds</>]} />

      <div className="grid-4">
        <Card className="mini-stat">
          <div className="k">Published</div>
          <div className="v">{latestPolicy > 0 ? `v${latestPolicy}` : '—'}</div>
          <div className="s">{latestPolicy > 0 ? `${ago(ms(policy?.created_at), now)} by ${policy?.created_by}` : 'Endpoints run the built-in default'}</div>
        </Card>
        <Card className="mini-stat"><div className="k">Default mode</div><div className="v" style={{ fontSize: 22 }}>{mode ? MODES[mode].label : summary.mode ?? '—'}</div><div className="s">{mode ? MODES[mode].desc.split(' — ')[0] : 'per agent overrides allowed'}</div></Card>
        <Card className="mini-stat"><div className="k">Rules</div><div className="v">{lists.reduce((n, [, v]) => n + v, 0)}</div><div className="s">{summary.lists.exec_deny ?? 0} exec deny · {summary.lists.file_deny ?? 0} file deny · {summary.lists.file_alert ?? 0} alert</div></Card>
        <Card className="mini-stat"><div className="k">Endpoints on latest</div><div className="v">{onLatest}/{eps.length}</div><div className="s">{latestPolicy > 0 ? `v${latestPolicy}` : 'nothing published'}</div></Card>
      </div>

      <PolicyAssist current={text} onLoad={(y) => { setDraft(y); setErr(null); setComment((c) => c || 'Changed with the policy assistant'); }} />

      <Card>
        <CardHead
          title={<>Endpoint policy {dirty && <span className="badge b-gold" style={{ marginLeft: 8 }}>Unpublished changes</span>}</>}
          sub={latestPolicy > 0
            ? `v${latestPolicy} · “${policy?.comment || 'no comment'}” · ${dateTime(ms(policy?.created_at))}`
            : 'Nothing published yet — this is effigentd’s built-in default. Publish it (or your edit) to make it the workspace policy.'}
        >
          {mode && <ModeTag mode={mode} />}
        </CardHead>
        {!loaded && !policy ? <Loading /> : (
          <>
            <div ref={editorRef} style={{ padding: '0 20px', scrollMarginTop: 88 }}>
              {!split ? (
                <div className="toolbar" style={{ margin: '0 0 8px', fontSize: 13 }}>
                  <span className="muted">{canWrite ? 'Edit the policy below — as soon as you change something, the live version appears on the left to compare.' : 'The live policy.'}</span>
                  <span className="grow" />
                  {history.length > 1 && (
                    <button className="btn sm" onClick={() => { const prev = history.find((h) => h.version < latestPolicy); if (prev) { setLeftSel(prev.version); setRightSel(latestPolicy); } }}>
                      <Ic n="layers" size={14} /> Compare versions
                    </button>
                  )}
                </div>
              ) : (
                <div className="toolbar" style={{ margin: '0 0 8px', fontSize: 13 }}>
                <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>Left
                  <select className="select" style={{ width: 210 }} value={leftSel ?? 'live'} aria-label="Left side"
                    onChange={(e) => setLeftSel(e.target.value === 'live' ? null : Number(e.target.value))}>
                    <option value="live">{liveLabel}</option>
                    {history.filter((h) => h.version !== latestPolicy).map((h) => <option key={h.version} value={h.version}>v{h.version} — {h.comment || 'no comment'}</option>)}
                  </select>
                </label>
                <Ic n="chevronRight" size={14} />
                <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>Right
                  <select className="select" style={{ width: 210 }} value={rightSel ?? 'edit'} aria-label="Right side"
                    onChange={(e) => setRightSel(e.target.value === 'edit' ? null : Number(e.target.value))}>
                    <option value="edit">{canWrite ? 'Your edit (editable)' : 'Current text'}</option>
                    {history.map((h) => <option key={h.version} value={h.version}>v{h.version}{h.version === latestPolicy ? ' (live)' : ''} — {h.comment || 'no comment'}</option>)}
                  </select>
                </label>
                {stats && (stats.added || stats.removed)
                  ? <span className="tnum"><b style={{ color: 'var(--green, #16a34a)' }}>+{stats.added}</b> <b style={{ color: 'var(--red)' }}>−{stats.removed}</b> lines</span>
                  : <span className="muted">no differences</span>}
                <span className="grow" />
                <button className={`chip ${onlyChanges ? 'on' : ''}`} aria-pressed={onlyChanges} onClick={() => setOnlyChanges((v) => !v)}>Only changes</button>
                {comparing && <button className="btn sm" onClick={() => { setLeftSel(null); setRightSel(null); }}><Ic n="pencil" size={14} /> Back to editing</button>}
              </div>
              )}
              {verErr && <div className="callout bad" style={{ margin: '0 0 8px' }}><Ic n="alert" size={16} /><span>{verErr}</span></div>}
              {leftText === undefined || rightText === undefined ? <Loading label="Loading version…" /> : (
                <PolicyDiff left={leftText} right={rightText} readOnlyRight={!editing || !canWrite} onlyChanges={onlyChanges && split} split={split}
                  onChange={(v) => { if (editing) { setDraft(v); setErr(null); } }} />
              )}
              <div className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>
                {!split ? null : editing ? 'Edit on the right; red is what you removed, green what you added. The arrows copy a block back from the left.' : 'Comparing two published versions (read-only).'}
              </div>
            </div>
            {stale && (
              <div className="callout warn"><Ic n="alert" size={16} /><span>
                Version {policy!.version} was published by {policy!.created_by} while you were editing (you started from v{base}). Publishing now replaces it with your text.
                {' '}<button className="btn sm" onClick={() => setDraft(null)}>Discard my edits</button>
              </span></div>
            )}
            {err && (
              <div className="callout bad"><Ic n="alert" size={16} /><span>
                {err.parse ? <>The control plane rejected this policy (validated with effigentd’s own parser): <code>{err.text}</code></> : err.text}
              </span></div>
            )}
            <div className="form-row">
              <div className="field" style={{ flex: '3 1 280px' }}>
                <label htmlFor="pol-comment">Change comment</label>
                <input id="pol-comment" className="input" placeholder="What changed and why — shown in history and the audit trail" value={comment}
                  disabled={!canWrite} onChange={(e) => setComment(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && canWrite && (dirty || latestPolicy === 0) && !busy && publish()} />
              </div>
              <button className="btn" onClick={() => { setDraft(null); setErr(null); }} disabled={!dirty || busy}><Ic n="rotate" /> Revert</button>
              <button className="btn primary" onClick={publish} disabled={!canWrite || busy || !editing || (!dirty && latestPolicy > 0) || !text.trim()}
                title={!canWrite ? 'Org admins and security admins can publish' : undefined}>
                <Ic n="upload" /> {busy ? 'Publishing…' : latestPolicy > 0 ? `Publish v${latestPolicy + 1}` : 'Publish v1'}
              </button>
            </div>
          </>
        )}
      </Card>

      <Exceptions />

      <div className="grid-2">
        <Card>
          <CardHead title="Version history" sub="Every publish is kept; endpoints never go back to an older version." />
          {history.length === 0 ? <Empty icon="clock" title="No versions yet" sub="The first publish becomes v1." /> : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>Version</th><th>Comment</th><th>By</th><th>When</th><th className="num">Endpoints</th><th /></tr></thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.version}>
                      <td className="mono-sm">v{h.version}{h.version === latestPolicy && <span className="badge b-green" style={{ marginLeft: 8 }}>Live</span>}</td>
                      <td>{h.comment || <span className="muted">—</span>}</td>
                      <td className="mono-sm muted">{h.created_by}</td>
                      <td className="muted" title={dateTime(ms(h.created_at))}>{ago(ms(h.created_at), now)}</td>
                      <td className="num tnum">{eps.filter((e) => e.policyVersion === h.version).length}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {h.version !== latestPolicy && <>
                          <button className="btn sm" onClick={() => compare(h.version, latestPolicy)} title={`v${h.version} on the left, the live v${latestPolicy} on the right`}>Compare</button>{' '}
                          {canWrite && <button className="btn sm" onClick={() => restore(h.version)} title={`Load v${h.version} as your edit (publish to make it live)`}>Restore</button>}
                        </>}
                        {h.version === latestPolicy && h.version > 1 && <button className="btn sm" onClick={() => { setLeftSel(h.version - 1); setRightSel(h.version); editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }} title={`What v${h.version} changed`}>What changed</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card>
          <CardHead title="How the policy is enforced" />
          <dl className="kv">
            <dt>Modes</dt><dd><code>monitor</code> observe · <code>learn</code> record binaries · <code>denylist</code> block listed · <code>allowlist</code> block everything else</dd>
            <dt>Exec rules</dt><dd>Matched on the resolved binary path (symlinks followed), per binary — not per argument</dd>
            <dt>File rules</dt><dd>Path suffixes; <code>file_deny</code> is refused by the kernel, <code>file_alert</code> is reported</dd>
            <dt>Network</dt><dd><code>network: true</code> reports outbound connects; <code>network_deny</code> / <code>network_allow</code> take IPs and CIDRs ; <code>domain_deny</code> takes hostnames</dd>
            <dt>Agent tools</dt><dd><code>tool_deny</code> refuses tools by name, e.g. <code>mcp__claude-in-chrome__*</code> or <code>WebFetch</code> (agent hooks: macOS, Windows)</dd>
            <dt>Approvals</dt><dd><code>command_approve</code> (e.g. <code>git push*</code>), <code>tool_approve</code> (e.g. <code>mcp__github__*</code>), <code>exec_approve</code>, <code>file_approve</code>, <code>domain_approve</code>, <code>network_approve</code>: the agent pauses and asks an approver (<Link href="/approvals" className="view-all">Approvals</Link>, Slack, email). <code>approvals: {'{'} wait_seconds, ttl_minutes {'}'}</code>. Agent hooks only — on Linux the kernel denies them</dd>
            <dt>Delivery</dt><dd>Signed per workspace; endpoints verify, apply live and cache it for offline restarts</dd>
            <dt>macOS / Windows</dt><dd>No kernel enforcement; Claude Code, Codex and Gemini CLI tool calls are checked before they run (agent hooks) — programs by name, files, hostnames and IPs. Same modes: <code>monitor</code> reports, <code>denylist</code> / <code>allowlist</code> block</dd>
          </dl>
        </Card>
      </div>
    </div>
  );
}
