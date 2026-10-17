'use client';

import { useState } from 'react';
import { Ic } from '@/icons.tsx';
import { useLive } from '@/live.tsx';
import { ApiError, apiErrorText } from '@/lib/api.ts';
import { Card, CardHead } from '@/components/ui.tsx';

interface Proposal { summary: string; yaml: string; valid: boolean; error?: string; model?: string }

/** Changed lines between two texts (a small LCS diff; policies are short). */
function diffLines(a: string, b: string): { t: ' ' | '+' | '-'; s: string }[] {
  const x = a.split('\n'), y = b.split('\n');
  const n = x.length, m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: { t: ' ' | '+' | '-'; s: string }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ t: ' ', s: x[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ t: '-', s: x[i++] });
    else out.push({ t: '+', s: y[j++] });
  }
  while (i < n) out.push({ t: '-', s: x[i++] });
  while (j < m) out.push({ t: '+', s: y[j++] });
  return out;
}

const EXAMPLES = [
  'Ask for approval before any git push or terraform apply',
  'Block curl and wget for every agent, but only warn in Codex',
  'Require approval for GitHub MCP tools that create or merge pull requests',
];

/** Plain-language policy changes, proposed by the assistant and validated
 *  with effigentd's parser. Nothing is published until you press Publish. */
export function PolicyAssist({ current, onLoad }: { current: string; onLoad: (yaml: string) => void }) {
  const { api, canWrite } = useLive();
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [p, setP] = useState<Proposal | null>(null);

  const ask = async () => {
    setBusy(true); setErr(null); setP(null);
    try {
      setP(await api.send<Proposal>('POST', '/policy/assist', { prompt: prompt.trim(), body: current }));
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 404 ? 'The control plane does not have the policy assistant yet — it needs to be updated.' : apiErrorText(e));
    } finally { setBusy(false); }
  };
  const changes = p ? diffLines(current.replace(/\n+$/, ''), p.yaml.replace(/\n+$/, '')) : [];
  const changed = changes.filter((c) => c.t !== ' ').length;

  return (
    <Card>
      <CardHead title={<><Ic n="spark" size={16} /> Ask AI to change the policy</>} sub="Describe what you want in plain words. The assistant proposes a policy, checked with effigentd’s own parser — you review it and publish." />
      <div style={{ padding: '0 20px 16px' }}>
        <textarea className="textarea" rows={2} style={{ width: "100%", boxSizing: "border-box" }} value={prompt} disabled={!canWrite || busy} onChange={(e) => setPrompt(e.target.value)}
          placeholder={EXAMPLES[0]} aria-label="What to change" onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && prompt.trim()) void ask(); }} />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
          <button className="btn primary sm" disabled={!canWrite || busy || !prompt.trim()} onClick={ask}><Ic n="spark" /> {busy ? 'Thinking…' : 'Propose a change'}</button>
          {!p && !busy && EXAMPLES.map((x) => <button key={x} className="btn sm" disabled={!canWrite} onClick={() => setPrompt(x)} style={{ opacity: 0.8 }}>{x}</button>)}
        </div>
        {err && <div className="callout bad" style={{ margin: '10px 0 0' }}><Ic n="alert" size={16} /><span>{err}</span></div>}
        {p && (
          <div style={{ marginTop: 12 }}>
            <div className={`callout ${p.valid ? '' : 'bad'}`} style={{ margin: '0 0 8px' }}>
              <Ic n={p.valid ? 'checkCircle' : 'alert'} size={16} />
              <span>{p.summary || 'Proposed change'}{!p.valid && <> — effigentd rejects it: <code>{p.error}</code></>}{p.valid && ` · ${changed} line${changed === 1 ? '' : 's'} changed`}</span>
            </div>
            <pre className="code" style={{ maxHeight: 320, overflow: 'auto', fontSize: 12, padding: 10, margin: 0 }}>
              {changes.map((c, i) => c.t === ' ' && changes.slice(Math.max(0, i - 2), i + 3).every((d) => d.t === ' ') ? null : (
                <div key={i} style={{ color: c.t === '+' ? 'var(--green)' : c.t === '-' ? 'var(--red)' : undefined, whiteSpace: 'pre' }}>{c.t} {c.s}</div>
              ))}
            </pre>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="btn primary sm" disabled={!p.valid} onClick={() => { onLoad(p.yaml); setP(null); setPrompt(''); }}><Ic n="check" /> Load into editor</button>
              <button className="btn sm" onClick={() => setP(null)}>Discard</button>
              {p.model && <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>{p.model}</span>}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
