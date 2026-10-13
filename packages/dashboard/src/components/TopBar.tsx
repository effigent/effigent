'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { agentMeta } from '@/data.ts';
import { Ic } from '@/icons.tsx';
import { useLive } from '@/live.tsx';
import { useStore } from '@/store.tsx';
import { useDemoMode } from '@/demo.tsx';
import { AgentGlyph, Switch } from './ui.tsx';

interface Hit { group: string; label: string; sub: string; href: string; icon: ReactNode }

function useOutside(ref: React.RefObject<HTMLElement | null>, onOut: () => void) {
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onOut(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [ref, onOut]);
}

function Search() {
  const { consoleEvents, endpointRows } = useLive();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();
  useOutside(box, () => setOpen(false));

  // "/" focuses search from anywhere (except while typing in a field).
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) { e.preventDefault(); input.current?.focus(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const hits = useMemo<Hit[]>(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    const out: Hit[] = [];
    const agents = new Map<string, number>();
    for (const e of consoleEvents) if (e.agentType) agents.set(e.agentType, (agents.get(e.agentType) ?? 0) + 1);
    for (const [t, n] of agents) {
      const m = agentMeta(t);
      if (`${m.label} ${t} ${m.vendor}`.toLowerCase().includes(s))
        out.push({ group: 'Agents', label: m.label, sub: `${n} recent events · ${m.vendor}`, href: `/audit?q=${encodeURIComponent(t)}`, icon: <AgentGlyph type={t} size={24} /> });
    }
    for (const e of endpointRows)
      if (`${e.hostname} ${e.id} ${e.os}`.toLowerCase().includes(s))
        out.push({ group: 'Endpoints', label: e.hostname, sub: `${e.os} · ${e.status}`, href: `/enforcement?endpoint=${encodeURIComponent(e.id)}`, icon: <span className="hit-ic"><Ic n={e.platform === 'linux' ? 'server' : 'laptop'} size={14} /></span> });
    for (const e of consoleEvents)
      if (`${e.title} ${e.summary} ${e.target ?? ''} ${e.rule ?? ''}`.toLowerCase().includes(s))
        out.push({ group: 'Events', label: e.summary, sub: `${e.title} · ${e.endpointName ?? ''} · ${e.ago}`, href: `/audit?q=${encodeURIComponent(e.target ?? e.summary)}`, icon: <span className="hit-ic"><Ic n="activity" size={14} /></span> });
    return out.slice(0, 12);
  }, [q, consoleEvents, endpointRows]);

  const go = (h: Hit) => { setOpen(false); setQ(''); router.push(h.href); };

  return (
    <div className="search" ref={box}>
      <Ic n="search" />
      <input
        ref={input}
        value={q}
        placeholder="Search agents, endpoints, or events…"
        aria-label="Search"
        onChange={(e) => { setQ(e.target.value); setOpen(true); setSel(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { setOpen(false); (e.target as HTMLInputElement).blur(); }
          if (e.key === 'ArrowDown') { e.preventDefault(); setSel((x) => Math.min(x + 1, hits.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setSel((x) => Math.max(x - 1, 0)); }
          if (e.key === 'Enter' && hits[sel]) go(hits[sel]);
        }}
      />
      <kbd className="search-kbd">/</kbd>
      {open && q.trim() && (
        <div className="search-pop" role="listbox">
          {hits.length === 0 && <div className="search-none">No matches for “{q}”</div>}
          {hits.map((h, i) => (
            <div key={`${h.group}-${h.href}-${i}`}>
              {(i === 0 || hits[i - 1].group !== h.group) && <div className="search-group">{h.group}</div>}
              <button className={`search-hit ${i === sel ? 'sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => go(h)} role="option" aria-selected={i === sel}>
                {h.icon}
                <span><span className="cell-main">{h.label}</span><span className="cell-sub">{h.sub}</span></span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Bell() {
  const { pending } = useStore();
  const { demo } = useDemoMode();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useOutside(box, () => setOpen(false));
  return (
    <div className="bell-wrap" ref={box}>
      <button className="icon-btn bell" aria-label={`${pending.length} pending approvals`} onClick={() => setOpen((o) => !o)}>
        <Ic n="bell" />
        {pending.length > 0 && <span className="bell-count">{pending.length}</span>}
      </button>
      {open && (
        <div className="pop bell-pop">
          <div className="pop-head">Pending approvals</div>
          {pending.length === 0 && <div className="search-none">{demo ? 'Nothing waiting on you.' : 'No approval requests yet.'}</div>}
          {pending.slice(0, 5).map((a) => (
            <Link key={a.id} href={`/approvals?id=${a.id}`} className="pop-row" onClick={() => setOpen(false)}>
              <AgentGlyph type={a.agentType} size={26} />
              <span><span className="cell-main">{a.title}</span><span className="cell-sub">{agentMeta(a.agentType).label} · {a.user} · {a.requestedAgo}</span></span>
            </Link>
          ))}
          <Link href="/approvals" className="pop-foot" onClick={() => setOpen(false)}>Open approvals <Ic n="arrowRight" size={13} /></Link>
        </div>
      )}
    </div>
  );
}

/** The Demo Mode switch as a user-menu row. */
export function DemoModeSwitch() {
  const { demo, setDemo } = useDemoMode();
  return (
    <div className="pop-switch">
      <div><div className="setting-title">Demo Mode</div><div className="setting-desc">Show a sample workspace</div></div>
      <Switch on={demo} onChange={setDemo} label="Demo Mode" />
    </div>
  );
}

function DevUserMenu() {
  const { viewer } = useStore();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useOutside(box, () => setOpen(false));
  return (
    <div className="bell-wrap" ref={box}>
      <button className="user-menu user-btn" onClick={() => setOpen((o) => !o)} aria-label="Account">
        <span className="avatar">{viewer.initials}</span>
        <span className="user-text">
          <span className="user-name">{viewer.name}</span>
          <span className="user-role">{viewer.role}</span>
        </span>
        <Ic n="chevronDown" size={16} />
      </button>
      {open && (
        <div className="pop user-pop">
          <div className="pop-head">Local development session</div>
          <p className="pop-text">
            Clerk is bypassed because <code>EFFIGENT_DEV_NOAUTH=1</code> and this is not a production build.
            “{viewer.name}” is a fixed demo identity.
          </p>
          <DemoModeSwitch />
        </div>
      )}
    </div>
  );
}

export function TopBar({ dev, userMenu, onMenu }: { dev: boolean; userMenu: ReactNode; onMenu: () => void }) {
  return (
    <header className="topbar">
      <button className="icon-btn hamburger" onClick={onMenu} aria-label="Open menu"><Ic n="menu" /></button>
      <Search />
      <div className="topbar-right">
        {dev && <span className="dev-badge" title="EFFIGENT_DEV_NOAUTH=1 — never active in production builds">DEV — auth bypassed</span>}
        <Bell />
        {dev ? <DevUserMenu /> : userMenu}
      </div>
    </header>
  );
}
