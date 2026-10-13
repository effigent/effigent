'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Ic } from '@/icons.tsx';
import { AGENT_TYPES, envMeta, MODES, userById } from '@/data.ts';
import type { AgentType, ApprovalState, Env, Mode, Outcome, RuleEffect } from '@/types.ts';

const OUTCOME: Record<Outcome, { label: string; cls: string }> = {
  allowed: { label: 'Allowed', cls: 'b-green' },
  blocked: { label: 'Blocked', cls: 'b-red' },
  pending: { label: 'Pending', cls: 'b-gold' },
  would_block: { label: 'Would block', cls: 'b-orange' },
  system: { label: 'System', cls: 'b-blue' },
};

export function OutcomePill({ outcome }: { outcome: Outcome }) {
  const o = OUTCOME[outcome];
  return <span className={`badge ${o.cls}`}>{o.label}</span>;
}

const APPROVAL: Record<ApprovalState, { label: string; cls: string }> = {
  approval_pending: { label: 'Pending', cls: 'b-gold' },
  approved: { label: 'Approved', cls: 'b-green' },
  approval_denied: { label: 'Denied', cls: 'b-red' },
  expired: { label: 'Expired', cls: 'b-muted' },
  cancelled: { label: 'Cancelled', cls: 'b-muted' },
};
export function ApprovalPill({ state }: { state: ApprovalState }) {
  const a = APPROVAL[state];
  return <span className={`badge ${a.cls}`}>{a.label}</span>;
}

const EFFECT: Record<RuleEffect, { label: string; cls: string }> = {
  allow: { label: 'Allow', cls: 'b-green' },
  deny: { label: 'Deny', cls: 'b-red' },
  require_approval: { label: 'Require approval', cls: 'b-gold' },
  alert: { label: 'Alert', cls: 'b-blue' },
};
export function EffectPill({ effect }: { effect: RuleEffect }) {
  const e = EFFECT[effect];
  return <span className={`badge ${e.cls}`}>{e.label}</span>;
}

export function StatusPill({ status }: { status: 'active' | 'idle' | 'offline' | 'online' | 'degraded' | 'draft' | 'disabled' }) {
  const cls = { active: 'b-green', online: 'b-green', idle: 'b-muted', offline: 'b-red', degraded: 'b-gold', draft: 'b-muted', disabled: 'b-muted' }[status];
  return <span className={`badge ${cls}`}>{status[0].toUpperCase() + status.slice(1)}</span>;
}

export function ModeTag({ mode }: { mode: Mode }) {
  return <span className={`mode-tag mode-${mode}`} title={MODES[mode].desc}>{MODES[mode].label}</span>;
}

export function RiskTag({ risk }: { risk: 'low' | 'medium' | 'high' }) {
  return <span className={`risk risk-${risk}`}>{risk}</span>;
}

export function EnvTag({ env }: { env: Env }) {
  const m = envMeta(env);
  return <span className="env-tag"><span className="env-dot" style={{ background: m.color }} />{m.short}</span>;
}

// tip: true shows the agent's name on hover/focus; a string is appended after it as detail.
export function AgentGlyph({ type, size = 30, tip }: { type: AgentType; size?: number; tip?: boolean | string }) {
  const m = AGENT_TYPES[type];
  const label = tip ? (typeof tip === 'string' ? `${m.label} · ${tip}` : m.label) : undefined;
  return (
    <span className={`agent-glyph${label ? ' has-tip' : ''}`} data-tip={label} aria-label={label} role={label ? 'img' : undefined} tabIndex={label ? 0 : undefined}
      style={{ width: size, height: size, color: m.color, background: `color-mix(in srgb, ${m.color} 16%, var(--panel-2))` }}>
      <Ic n={m.icon} size={Math.round(size * 0.55)} />
    </span>
  );
}

export function AgentCell({ type, sub }: { type: AgentType; sub?: string }) {
  const m = AGENT_TYPES[type];
  return (
    <span className="agent-cell">
      <AgentGlyph type={type} />
      <span>
        <span className="cell-main">{m.label}</span>
        <span className="cell-sub">{sub ?? m.kind}</span>
      </span>
    </span>
  );
}

export function initials(name: string) {
  return name.split(/[\s.]+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
}

export function UserCell({ id, sub }: { id: string | null; sub?: string }) {
  const u = userById(id);
  if (!id) return <span className="muted">—</span>;
  return (
    <span className="agent-cell">
      <span className="avatar sm">{initials(u?.name ?? id)}</span>
      <span>
        <span className="cell-main">{u?.name ?? id}</span>
        {sub !== '' && <span className="cell-sub">{sub ?? u?.title}</span>}
      </span>
    </span>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`card ${className}`}>{children}</section>;
}

export function CardHead({ title, sub, href, children }: { title: ReactNode; sub?: ReactNode; href?: string; children?: ReactNode }) {
  return (
    <div className="card-head">
      <div className="card-head-text">
        <h2 className="card-title">{title}</h2>
        {sub && <div className="card-sub">{sub}</div>}
      </div>
      <div className="card-head-actions">
        {children}
        {href && <Link className="view-all" href={href}>View all <Ic n="arrowRight" size={13} /></Link>}
      </div>
    </div>
  );
}

export function PageHead({ title, sub, children }: { title: string; sub: string; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        <p className="page-sub">{sub}</p>
      </div>
      {children && <div className="page-head-actions">{children}</div>}
    </header>
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="tablist">
      {options.map((o) => (
        <button key={o.id} role="tab" aria-selected={value === o.id} className={value === o.id ? 'on' : ''} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Empty({ icon = 'checkCircle', title, sub }: { icon?: string; title: string; sub?: string }) {
  return (
    <div className="empty">
      <Ic n={icon} size={22} />
      <div className="empty-title">{title}</div>
      {sub && <div className="empty-sub">{sub}</div>}
    </div>
  );
}

export function DemoNote() {
  return (
    <span className="demo-chip" title="This console renders a demo dataset until the control-plane API is connected">
      <Ic n="eye" size={12} /> Demo data
    </span>
  );
}
