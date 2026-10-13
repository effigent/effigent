'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AGENTS, ENVS, nav } from '@/data.ts';
import { BrandMark, Ic } from '@/icons.tsx';
import { useStore } from '@/store.tsx';

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname();
  const { pending, env, dispatch } = useStore();
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
        {nav.map((item) => (
          <Link key={item.href} href={item.href} className={`nav-item ${isActive(item.href) ? 'active' : ''}`} onClick={onClose}
            aria-current={isActive(item.href) ? 'page' : undefined}>
            <Ic n={item.icon} />
            <span>{item.label}</span>
            {item.href === '/approvals' && pending.length > 0 && <span className="nav-count">{pending.length}</span>}
          </Link>
        ))}
      </nav>

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

      <div className="deploy-card">
        <div className="deploy-head">
          <span className="deploy-icon"><Ic n="hex" size={16} /></span>
          <div>
            <div className="deploy-title">Hybrid Deployment</div>
            <div className="deploy-line"><span className="dot" /> Local enforcement active</div>
            <div className="deploy-line muted">Control plane: Cloud</div>
          </div>
        </div>
        <Link href="/enforcement" className="deploy-link" onClick={onClose}>Manage deployment <Ic n="arrowRight" size={13} /></Link>
      </div>
    </aside>
  );
}
