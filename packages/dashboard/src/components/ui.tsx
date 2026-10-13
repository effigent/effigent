'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { Ic } from '@/icons.tsx';
import { useDemoMode } from '@/demo.tsx';
import { THEME_OPTIONS, useTheme, type ThemePref } from '@/theme.tsx';
import { agentMeta, envMeta, MODES, userById } from '@/data.ts';
import type { ApprovalState, Env, Mode, Outcome, RuleEffect } from '@/types.ts';

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

/** Small amber tag for a risky command (lib/command-risk.ts). */
export function RiskyTag({ title = 'Risky command — deletes, privilege, network transfer, processes, containers or package installs' }: { title?: string }) {
  return <span className="risk-tag" title={title}>risky</span>;
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

export function StatusPill({ status }: { status: 'active' | 'idle' | 'offline' | 'online' | 'degraded' | 'draft' | 'disabled' | 'revoked' }) {
  const cls = { active: 'b-green', online: 'b-green', idle: 'b-muted', offline: 'b-red', degraded: 'b-gold', draft: 'b-muted', disabled: 'b-muted', revoked: 'b-muted' }[status];
  return <span className={`badge ${cls}`}>{status[0].toUpperCase() + status.slice(1)}</span>;
}

export function ModeTag({ mode }: { mode: Mode }) {
  return <span className={`mode-tag mode-${mode}`} title={MODES[mode].desc}>{MODES[mode].label}</span>;
}

export function RiskTag({ risk }: { risk: 'low' | 'medium' | 'high' }) {
  return <span className={`risk risk-${risk}`}>{risk}</span>;
}

export function EnvTag({ env }: { env: Env | null }) {
  if (!env) return <span className="muted">—</span>;
  const m = envMeta(env);
  return <span className="env-tag"><span className="env-dot" style={{ background: m.color }} />{m.short}</span>;
}

// tip: true shows the agent's name on hover/focus; a string is appended after it as detail.
export function AgentGlyph({ type, size = 30, tip }: { type: string; size?: number; tip?: boolean | string }) {
  const m = agentMeta(type);
  const label = tip ? (typeof tip === 'string' ? `${m.label} · ${tip}` : m.label) : undefined;
  return (
    <span className={`agent-glyph${label ? ' has-tip' : ''}`} data-tip={label} aria-label={label} role={label ? 'img' : undefined} tabIndex={label ? 0 : undefined}
      style={{ width: size, height: size, ['--agent' as string]: m.color, color: 'var(--agent-ink)', background: `color-mix(in srgb, ${m.color} 16%, var(--panel-2))` }}>
      <Ic n={m.icon} size={Math.round(size * 0.55)} />
    </span>
  );
}

export function AgentCell({ type, sub }: { type: string; sub?: string }) {
  const m = agentMeta(type);
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

/** Light / Dark / System (theme.tsx), for Settings and the user menu. */
export function ThemeSelect() {
  const { pref, setPref } = useTheme();
  return (
    <Seg value={pref} onChange={setPref} options={THEME_OPTIONS.map((o) => ({
      id: o.id, label: <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Ic n={THEME_ICON[o.id]} size={14} />{o.label}</span>,
    }))} />
  );
}
export const THEME_ICON: Record<ThemePref, string> = { light: 'sun', dark: 'moon', system: 'monitor' };

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

export function DemoNote({ title = 'Not served by the control plane yet — this shows a demo dataset', label = 'Demo data' }: { title?: string; label?: string }) {
  return (
    <span className="demo-chip" title={title}>
      <Ic n="eye" size={12} /> {label}
    </span>
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} />;
}

/** Honest empty state for a feature the control plane does not serve yet
 *  (Demo Mode off). Offers the sample workspace as a preview. */
export function ComingSoon({ icon = 'clock', title, sub }: { icon?: string; title: string; sub: string }) {
  const { setDemo } = useDemoMode();
  return (
    <div className="empty coming-soon">
      <Ic n={icon} size={22} />
      <div className="empty-title">{title} <span className="badge b-muted">Coming soon</span></div>
      <div className="empty-sub">{sub}</div>
      <button className="btn sm" onClick={() => setDemo(true)}><Ic n="eye" size={14} /> Preview with sample data</button>
    </div>
  );
}

export function CodeBlock({ code, wrap }: { code: string; wrap?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };
  return (
    <div className="code">
      <button className="code-copy" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      <pre className={wrap ? 'wrap' : undefined}>{code}</pre>
    </div>
  );
}

/** Placeholder rows while the first control-plane load is in flight. */
export function Loading({ label = 'Loading from the control plane…' }: { label?: string }) {
  return <div className="empty"><Ic n="rotate" size={20} /><div className="empty-sub">{label}</div></div>;
}

/** Shown in place of a write control for roles the server treats as read-only. */
export function ReadOnlyNote({ what = 'change this' }: { what?: string }) {
  return (
    <span className="badge b-muted" title="Org admins and security admins can make changes; every other member is read-only.">
      <Ic n="lock" size={12} /> View only — ask an admin to {what}
    </span>
  );
}
