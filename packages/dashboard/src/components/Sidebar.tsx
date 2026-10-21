'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AGENTS, ENVS, navSections } from '@/data.ts';
import { BrandMark, Ic } from '@/icons.tsx';
import { useLive } from '@/live.tsx';
import { useStore } from '@/store.tsx';
import { useDemoMode } from '@/demo.tsx';
import { useRuntime } from '@/lib/runtime.tsx';

export function Sidebar({ open, onClose, collapsed = false, onToggle }: { open: boolean; onClose: () => void; collapsed?: boolean; onToggle?: () => void }) {
  const pathname = usePathname();
  const { pending, env, dispatch } = useStore();
  const { endpointRows, loaded, fixture, pendingApprovals } = useLive();
  const selfHosted = useRuntime().auth === 'oidc';
  const { demo } = useDemoMode();
  const eps = endpointRows.filter((e) => !e.revoked);
  const online = eps.filter((e) => e.status === 'online').length;
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`));

  return (
    <aside className={`sidebar ${open ? 'open' : ''}`} aria-label="Main navigation">
      <div className="brand">
        <Link href="/" className="brand-link" onClick={onClose}>
          <BrandMark size={36} />
          <span className="brand-text">
            <span className="brand-name">Effigent</span>
            <span className="brand-tag">AI Agent Control Plane</span>
          </span>
        </Link>
        <button className="sidebar-close" onClick={onClose} aria-label="Close menu"><Ic n="x" /></button>
      </div>

      <nav className="nav">
        {navSections.map((sec) => (
          <div key={sec.title} className={`nav-section ${sec.soon ? 'soon' : ''}`}>
            <div className="nav-group">{sec.title}</div>
            {sec.items.map((item) => (
              <Link key={item.href} href={item.href} title={collapsed ? item.label : item.hint} className={`nav-item ${isActive(item.href) ? 'active' : ''} ${sec.soon ? 'muted' : ''}`} onClick={onClose}
                aria-current={isActive(item.href) ? 'page' : undefined}>
                <Ic n={item.icon} />
                <span>{item.label}</span>
                {item.href === '/approvals' && (demo ? pending.length : pendingApprovals) > 0 && (
                  <span className="nav-count" title={`${demo ? pending.length : pendingApprovals} pending`}>{demo ? pending.length : pendingApprovals}</span>
                )}
              </Link>
            ))}
          </div>
        ))}
      </nav>

      {/* Environments are not modelled by the control plane yet: sample workspace only. */}
      {demo && <>
      <div className="nav-sep" />
      <div className="nav-group">Environments</div>
      <div className="env-list">
        {ENVS.map((e) => {
          const n = AGENTS.filter((a) => a.env === e.id).length;
          const on = env === e.id;
          return (
            <button key={e.id} className={`env-item ${on ? 'on' : ''} ${env && !on ? 'dim' : ''}`}
              onClick={() => dispatch({ t: 'env', env: on ? null : e.id })}
              title={on ? 'Show all environments' : `Only show ${e.label}`}>
              <span className="env-dot lg" style={{ background: e.color }} />
              <span className="env-name">{e.label}</span>
              <span className="env-n">{n}</span>
            </button>
          );
        })}
      </div>
      </>}

      <div className="deploy-card">
        <div className="deploy-head">
          <span className="deploy-icon"><Ic n="hex" size={16} /></span>
          <div>
            <div className="deploy-title">Hybrid Deployment</div>
            <div className="deploy-line">
              {loaded ? <><span className="dot" style={online ? undefined : { background: 'var(--txt-4)', boxShadow: 'none' }} /> {online}/{eps.length} endpoints online</> : 'Connecting…'}
            </div>
            <div className="deploy-line muted">Control plane: {fixture ? 'Demo Mode (sample)' : selfHosted ? 'Self-hosted' : 'Cloud'}</div>
          </div>
        </div>
        <Link href="/enforcement" className="deploy-link" onClick={onClose}>Manage deployment <Ic n="arrowRight" size={13} /></Link>
      </div>
      <Link href="/enforcement" className="deploy-mini" onClick={onClose} title={loaded ? `${online}/${eps.length} endpoints online · Manage deployment` : 'Connecting…'}>
        <Ic n="hex" /><span className="dot" style={online ? undefined : { background: 'var(--txt-4)', boxShadow: 'none' }} />
      </Link>
      {onToggle && (
        <button className="sidebar-toggle" onClick={onToggle} aria-label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'} title={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
          aria-expanded={!collapsed}>
          <Ic n="chevronRight" /><span>Collapse</span>
        </button>
      )}
    </aside>
  );
}
