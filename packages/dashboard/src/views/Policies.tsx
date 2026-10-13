'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AGENT_TYPES, ENDPOINTS, envMeta, userById } from '@/data.ts';
import { Ic } from '@/icons.tsx';
import { useStore } from '@/store.tsx';
import type { Policy, RuleEffect } from '@/types.ts';
import { Card, DemoNote, ModeTag, PageHead, StatusPill } from '@/components/ui.tsx';

const EFFECT_COLOR: Record<RuleEffect, string> = { allow: 'var(--green)', deny: 'var(--red)', require_approval: 'var(--gold)', alert: 'var(--blue)' };

export function scopeLabel(p: Policy): string[] {
  const out: string[] = [];
  if (p.scope.envs.length) out.push(...p.scope.envs.map((e) => envMeta(e).label));
  if (p.scope.agentTypes.length) out.push(...p.scope.agentTypes.map((t) => AGENT_TYPES[t].label));
  if (p.scope.users.length) out.push(...p.scope.users.map((u) => userById(u)?.name ?? u));
  return out.length ? out : ['All agents · all endpoints'];
}

function EffectBar({ p }: { p: Policy }) {
  const total = p.rules.length || 1;
  const effects: RuleEffect[] = ['allow', 'deny', 'require_approval', 'alert'];
  return (
    <div className="effect-bar" title="Rule effects">
      {effects.map((e) => {
        const n = p.rules.filter((r) => r.effect === e).length;
        return n ? <i key={e} style={{ width: `${(n / total) * 100}%`, background: EFFECT_COLOR[e] }} /> : null;
      })}
    </div>
  );
}

export function Policies() {
  const { policies, dispatch } = useStore();
  const router = useRouter();
  const active = policies.filter((p) => p.status === 'active');
  const rules = active.flatMap((p) => p.rules);
  const current = ENDPOINTS.filter((e) => e.policyVersion === 42).length;

  const create = () => {
    const id = `pol-new-${policies.length + 1}`;
    dispatch({
      t: 'addPolicy',
      policy: {
        id, name: 'Untitled policy', status: 'draft', mode: 'monitor', priority: 120,
        description: 'Draft — add rules, pick a scope, then activate.', scope: { envs: [], agentTypes: [], users: [] },
        rules: [], version: 0, updatedAgo: 'just now', updatedBy: 'jane.doe', endpoints: 0,
      },
    });
    router.push(`/policies/${id}`);
  };

  return (
    <div className="page">
      <PageHead title="Policies" sub="What agents may run, read, write and reach — enforced on the endpoint by the kernel and agent hooks.">
        <DemoNote />
        <button className="btn primary" onClick={create}><Ic n="plus" /> New policy</button>
      </PageHead>

      <div className="grid-4">
        <Card className="mini-stat"><div className="k">Active policies</div><div className="v">{active.length}</div><div className="s">{policies.length - active.length} draft / disabled</div></Card>
        <Card className="mini-stat"><div className="k">Active rules</div><div className="v">{rules.length}</div><div className="s">{rules.filter((r) => r.effect === 'deny').length} deny · {rules.filter((r) => r.effect === 'allow').length} allow</div></Card>
        <Card className="mini-stat"><div className="k">Approval rules</div><div className="v">{rules.filter((r) => r.effect === 'require_approval').length}</div><div className="s">Route to a human approver</div></Card>
        <Card className="mini-stat"><div className="k">Endpoints on latest</div><div className="v">{current}/{ENDPOINTS.length}</div><div className="s">Policy bundle v42</div></Card>
      </div>

      <div className="grid-3">
        {[...policies].sort((a, b) => b.priority - a.priority).map((p) => (
          <Link key={p.id} href={`/policies/${p.id}`} className="card pol-card">
            <div className="pol-top">
              <span className="pol-name">{p.name}</span>
              <StatusPill status={p.status} />
            </div>
            <div className="pol-desc">{p.description}</div>
            <div className="chips">
              <ModeTag mode={p.mode} />
              {scopeLabel(p).map((s) => <span key={s} className="mono-chip" style={{ fontFamily: 'var(--sans)' }}>{s}</span>)}
            </div>
            <EffectBar p={p} />
            <div className="pol-meta">
              <span><b>{p.rules.length}</b> rules</span>
              <span>priority <b>{p.priority}</b></span>
              <span>v{p.version} · {p.updatedAgo} by {userById(p.updatedBy)?.name ?? p.updatedBy}</span>
            </div>
          </Link>
        ))}
      </div>

      <div className="callout"><Ic n="layers" size={16} /><span>
        Policies merge per agent: higher priority wins, and every field an agent-scoped policy leaves unset falls back to the defaults.
        Kernel rules (exec / file / network) compile into an effigentd policy per agent process; approval, MCP and tool-call rules run in the agent&apos;s hooks.
      </span></div>
    </div>
  );
}
