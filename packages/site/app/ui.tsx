/** Shared chrome — nav, footer, code blocks. Same design language as the home page. */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { DASHBOARD_URL } from './config';

export function Nav({ cta = true }: { cta?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '22px 56px', borderBottom: '1px solid var(--line)', position: 'sticky', top: 0, background: 'oklch(0.985 0.004 90 / 0.92)', backdropFilter: 'blur(8px)', zIndex: 10 }}>
      <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <div style={{ width: 20, height: 20, background: 'var(--ink)', position: 'relative' }}><div style={{ position: 'absolute', inset: 5, background: 'var(--cream)' }} /></div>
        <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em' }}>Optimizer</div>
      </Link>
      <div className="nav-links" style={{ display: 'flex', alignItems: 'center', gap: 36, fontSize: 14, color: 'var(--ink-2)', fontWeight: 500 }}>
        <Link href="/#how">How it works</Link>
        <Link href="/developers">Developers</Link>
        <Link href="/pricing">Pricing</Link>
        <Link href="/security">Security</Link>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <a href={`${DASHBOARD_URL}/sign-in`} style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-2)', padding: '9px 12px' }}>
          Log in
        </a>
        {cta && (
          <Link href="/developers" className="btn btn-primary" style={{ padding: '9px 18px', fontSize: 13.5, display: 'inline-block' }}>
            Install in 2 minutes
          </Link>
        )}
      </div>
    </div>
  );
}

export function Footer() {
  return (
    <div style={{ borderTop: '1px solid var(--line)', padding: '28px 56px', display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--ink-4)' }}>
      <div>© 2026 Optimizer — the compiler for AI agents</div>
      <div style={{ display: 'flex', gap: 24 }}>
        <Link href="/developers">Developer guide</Link>
        <Link href="/pricing">Pricing</Link>
        <Link href="/security">Security</Link>
        <a href="https://github.com/SpectorHacked/ccopt" target="_blank" rel="noreferrer">GitHub</a>
      </div>
    </div>
  );
}

/** Dark terminal-style code block (matches the hero terminal). */
export function CodeBlock({ title, children }: { title?: string; children: string }) {
  return (
    <div style={{ borderRadius: 9, background: 'oklch(0.16 0.012 260)', overflow: 'hidden', boxShadow: '0 12px 30px -18px oklch(0.14 0.01 260 / 0.5)' }}>
      {title && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 14px', background: 'oklch(0.19 0.012 260)', borderBottom: '1px solid oklch(0.26 0.012 260)' }}>
          <div style={{ width: 9, height: 9, borderRadius: '50%', background: 'oklch(0.65 0.17 25)' }} />
          <div style={{ width: 9, height: 9, borderRadius: '50%', background: 'oklch(0.78 0.15 85)' }} />
          <div style={{ width: 9, height: 9, borderRadius: '50%', background: 'oklch(0.68 0.16 150)' }} />
          <div style={{ marginLeft: 8, fontFamily: 'var(--mono)', fontSize: 11, color: 'oklch(0.55 0.012 260)' }}>{title}</div>
        </div>
      )}
      <pre style={{ margin: 0, padding: '18px 20px', fontFamily: 'var(--mono)', fontSize: 13, color: 'oklch(0.85 0.01 150)', lineHeight: 1.8, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{children}</pre>
    </div>
  );
}

export function PageHero({ eyebrow, title, sub }: { eyebrow: string; title: string; sub: string }) {
  return (
    <div style={{ background: 'linear-gradient(180deg, oklch(0.95 0.018 275) 0%, oklch(0.985 0.004 90) 100%)' }}>
      <div style={{ maxWidth: 880, margin: '0 auto', padding: '80px 32px 56px' }}>
        <div className="eyebrow" style={{ color: 'oklch(0.52 0.15 250)' }}><span className="d" style={{ background: 'oklch(0.58 0.17 250)' }} />{eyebrow}</div>
        <h1 className="h-serif" style={{ fontSize: 44, lineHeight: 1.15, margin: '0 0 18px' }}>{title}</h1>
        <p style={{ fontSize: 17, color: 'var(--ink-2)', lineHeight: 1.65, maxWidth: 640, margin: 0 }}>{sub}</p>
      </div>
    </div>
  );
}

export function DocSection({ children, id }: { children: ReactNode; id?: string }) {
  return <div id={id} style={{ maxWidth: 880, margin: '0 auto', padding: '46px 32px', borderTop: '1px solid var(--line)' }}>{children}</div>;
}

export function StepBadge({ n }: { n: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: '50%', background: 'var(--ink)', color: 'var(--cream)', fontFamily: 'var(--mono)', fontSize: 12.5, fontWeight: 700, marginRight: 12, flexShrink: 0 }}>{n}</span>
  );
}
