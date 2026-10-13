'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ACTION_CLASS_LABEL, AGENT_TYPES, ENVS, MODES, userById } from '@/data.ts';
import { Ic } from '@/icons.tsx';
import { useStore } from '@/store.tsx';
import type { ActionClass, AgentType, Env, Mode, Policy, RuleEffect } from '@/types.ts';
import { Card, CardHead, EffectPill, Empty, ModeTag, StatusPill } from '@/components/ui.tsx';

/** Render the kernel half of a policy in effigentd's own YAML format
 *  (internal/endpoint/policy/default.yaml). Hook-level rules are listed as comments. */
function toYaml(p: Policy): string {
  const vals = (cls: ActionClass[], eff: RuleEffect) =>
    p.rules.filter((r) => cls.includes(r.class) && r.effect === eff).flatMap((r) => r.match.split(/,\s*/)).filter((m) => m.startsWith('/') || m.startsWith('*/'));
  const list = (k: string, xs: string[]) => (xs.length ? `  ${k}:\n${xs.map((x) => `    - ${x.replace(/^\*/, '')}`).join('\n')}\n` : '');
  const hook = p.rules.filter((r) => r.effect === 'require_approval' || r.class === 'mcp_call' || r.class === 'tool_call');
  const network = p.rules.some((r) => r.class === 'network');
  const header = p.scope.envs.length || p.scope.agentTypes.length || p.scope.users.length
    ? `# scope: ${[...p.scope.envs, ...p.scope.agentTypes, ...p.scope.users].join(', ')}\n` : '# scope: every agent on every endpoint\n';
  return (
    `# ${p.name} — v${p.version}\n${header}defaults:\n  mode: ${p.mode}\n` +
    list('exec_deny', vals(['exec'], 'deny')) +
    list('exec_allow', vals(['exec'], 'allow')) +
    list('file_deny', vals(['file_read', 'file_write'], 'deny')) +
    list('file_alert', vals(['file_read', 'file_write'], 'alert')) +
    (network ? '  network: true\n' : '') +
    (hook.length ? `\n# ${hook.length} hook-level rule(s) — enforced in the agent's hooks, paused for approval via the control plane:\n${hook.map((r) => `#   ${r.effect.padEnd(16)} ${r.class.padEnd(10)} ${r.match}`).join('\n')}\n` : '')
  );
}

function YamlBlock({ text }: { text: string }) {
  return (
    <pre className="yaml">
      {text.split('\n').map((line, i) => {
        if (line.trimStart().startsWith('#')) return <div key={i} className="c">{line}</div>;
        const m = line.match(/^(\s*-?\s*)([\w_]+)(:)(.*)$/);
        return m ? <div key={i}>{m[1]}<span className="k">{m[2]}</span>{m[3]}{m[4]}</div> : <div key={i}>{line || ' '}</div>;
      })}
    </pre>
  );
}

function toggle<T>(xs: T[], x: T): T[] { return xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]; }

export function PolicyDetail({ id }: { id: string }) {
  const { policies, dispatch } = useStore();
  const p = policies.find((x) => x.id === id);
  const [cls, setCls] = useState<ActionClass>('exec');
  const [match, setMatch] = useState('');
  const [effect, setEffect] = useState<RuleEffect>('deny');
  const [desc, setDesc] = useState('');

  if (!p) {
    return (
      <div className="page">
        <Link href="/policies" className="back-link"><Ic n="arrowLeft" size={15} /> Policies</Link>
        <Card><Empty icon="shield" title="Policy not found" sub={`No policy with id “${id}” in this workspace.`} /></Card>
      </div>
    );
  }

  const patch = (x: Partial<Policy>) => dispatch({ t: 'policy', id: p.id, patch: x });
  const addRule = () => {
    if (!match.trim()) return;
    dispatch({ t: 'addRule', id: p.id, rule: { id: `r-${Date.now().toString(36)}`, class: cls, match: match.trim(), effect, description: desc.trim() || '—', hits24h: 0 } });
    setMatch(''); setDesc('');
  };
  const kernelPath = cls === 'exec' || cls === 'file_read' || cls === 'file_write';
  const badMatch = kernelPath && match.trim() !== '' && cls === 'exec' && effect !== 'require_approval' && !match.trim().startsWith('/') && match.trim() !== '*';

  return (
    <div className="page">
      <Link href="/policies" className="back-link"><Ic n="arrowLeft" size={15} /> Policies</Link>
      <header className="page-head">
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <input className="input" aria-label="Policy name" value={p.name} onChange={(e) => patch({ name: e.target.value })}
              style={{ fontSize: 26, fontWeight: 700, height: 46, background: 'transparent', border: '1px solid transparent', padding: '0 6px', marginLeft: -7, width: Math.max(220, p.name.length * 15), maxWidth: '100%' }} />
            <StatusPill status={p.status} />
          </h1>
          <p className="page-sub">{p.description}</p>
        </div>
        <div className="page-head-actions">
          <span className="muted">v{p.version} · updated {p.updatedAgo} by {userById(p.updatedBy)?.name ?? p.updatedBy}</span>
          {p.status === 'active'
            ? <button className="btn danger" onClick={() => patch({ status: 'disabled' })}><Ic n="ban" /> Disable</button>
            : <button className="btn primary" onClick={() => patch({ status: 'active' })} disabled={p.mode === 'allowlist' && !p.rules.some((r) => r.class === 'exec' && r.effect === 'allow')}
                title={p.mode === 'allowlist' && !p.rules.some((r) => r.class === 'exec' && r.effect === 'allow') ? 'Allowlist mode with an empty exec_allow would block every exec' : undefined}>
                <Ic n="check" /> Activate
              </button>}
        </div>
      </header>

      <div className="grid-2">
        <Card>
          <CardHead title="Enforcement mode" sub={MODES[p.mode].desc} />
          <div className="chips" style={{ padding: '0 20px 18px' }}>
            {(Object.keys(MODES) as Mode[]).map((m) => (
              <button key={m} className={`chip ${p.mode === m ? 'on' : ''}`} onClick={() => patch({ mode: m })}>{MODES[m].label}</button>
            ))}
          </div>
        </Card>
        <Card>
          <CardHead title="Scope" sub="Empty means everywhere. Narrow by environment, agent or person." />
          <div style={{ padding: '0 20px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="chips">
              {ENVS.map((e) => (
                <button key={e.id} className={`chip ${p.scope.envs.includes(e.id) ? 'on' : ''}`}
                  onClick={() => patch({ scope: { ...p.scope, envs: toggle<Env>(p.scope.envs, e.id) } })}>
                  <span className="env-dot" style={{ background: e.color }} /> {e.label}
                </button>
              ))}
            </div>
            <div className="chips">
              {(Object.keys(AGENT_TYPES) as AgentType[]).map((t) => (
                <button key={t} className={`chip ${p.scope.agentTypes.includes(t) ? 'on' : ''}`}
                  onClick={() => patch({ scope: { ...p.scope, agentTypes: toggle<AgentType>(p.scope.agentTypes, t) } })}>
                  {AGENT_TYPES[t].label}
                </button>
              ))}
            </div>
          </div>
        </Card>
      </div>

      <Card>
        <CardHead title={`Rules (${p.rules.length})`} sub="First match wins within a policy; exec and file rules are matched by the kernel on resolved paths." />
        {p.rules.length === 0 ? <Empty icon="listCheck" title="No rules yet" sub="Add the first rule below." /> : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Action class</th><th>Match</th><th>Effect</th><th>Description</th><th className="num">Hits 24h</th><th aria-label="Remove" /></tr></thead>
              <tbody>
                {p.rules.map((r) => (
                  <tr key={r.id}>
                    <td>{ACTION_CLASS_LABEL[r.class]}</td>
                    <td><span className="mono-chip">{r.match}</span></td>
                    <td><EffectPill effect={r.effect} /></td>
                    <td className="muted">{r.description}</td>
                    <td className="num tnum">{r.hits24h.toLocaleString()}</td>
                    <td className="right">
                      <button className="icon-btn ghost" aria-label="Remove rule" onClick={() => dispatch({ t: 'removeRule', id: p.id, ruleId: r.id })}><Ic n="trash" size={15} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="form-row">
          <div className="field" style={{ flex: '0 1 150px' }}>
            <label htmlFor="r-cls">Action class</label>
            <select id="r-cls" className="select" value={cls} onChange={(e) => setCls(e.target.value as ActionClass)}>
              {Object.entries(ACTION_CLASS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="field" style={{ flex: '2 1 220px' }}>
            <label htmlFor="r-match">Match</label>
            <input id="r-match" className="input mono" placeholder={cls === 'exec' ? '/usr/bin/curl' : cls === 'network' ? 'api.example.com:443' : cls === 'mcp_call' ? 'github.delete_*' : '*/.env'}
              value={match} onChange={(e) => setMatch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addRule()} />
          </div>
          <div className="field" style={{ flex: '0 1 170px' }}>
            <label htmlFor="r-eff">Effect</label>
            <select id="r-eff" className="select" value={effect} onChange={(e) => setEffect(e.target.value as RuleEffect)}>
              <option value="deny">Deny</option><option value="allow">Allow</option><option value="require_approval">Require approval</option><option value="alert">Alert</option>
            </select>
          </div>
          <div className="field" style={{ flex: '2 1 200px' }}>
            <label htmlFor="r-desc">Description</label>
            <input id="r-desc" className="input" placeholder="Why this rule exists" value={desc} onChange={(e) => setDesc(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addRule()} />
          </div>
          <button className="btn primary" onClick={addRule} disabled={!match.trim() || badMatch}><Ic n="plus" /> Add rule</button>
        </div>
        {badMatch && <div className="callout warn" style={{ margin: '0 20px 16px' }}><Ic n="alert" size={16} /><span>Kernel exec rules match the resolved binary path — use an absolute path such as <code>/usr/bin/curl</code>.</span></div>}
      </Card>

      <Card>
        <CardHead title="Compiled for effigentd" sub={`What endpoints receive (${p.endpoints} endpoint${p.endpoints === 1 ? '' : 's'} in scope).`}>
          <ModeTag mode={p.mode} />
        </CardHead>
        <YamlBlock text={toYaml(p)} />
      </Card>
    </div>
  );
}
