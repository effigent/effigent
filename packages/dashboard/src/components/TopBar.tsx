'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AGENTS, AGENT_TYPES, USERS } from '@/data.ts';
import { Ic } from '@/icons.tsx';
import { useStore } from '@/store.tsx';
import { AgentGlyph } from './ui.tsx';

interface Hit { group: string; label: string; sub: string; href: string; icon: ReactNode }

function useOutside(ref: React.RefObject<HTMLElement | null>, onOut: () => void) {
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onOut(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [ref, onOut]);
}

function Search() {
  const { policies, events } = useStore();
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
    const types = new Set(AGENTS.map((a) => a.type));
    for (const t of types) {
      const m = AGENT_TYPES[t];
      if (`${m.label} ${t} ${m.vendor}`.toLowerCase().includes(s))
        out.push({ group: 'Agents', label: m.label, sub: `${AGENTS.filter((a) => a.type === t).length} instances · ${m.vendor}`, href: `/graph?agent=${t}`, icon: <AgentGlyph type={t} size={24} /> });
    }
    for (const p of policies)
      if (`${p.name} ${p.description}`.toLowerCase().includes(s))
        out.push({ group: 'Policies', label: p.name, sub: `${p.rules.length} rules · ${p.status}`, href: `/policies/${p.id}`, icon: <span className="hit-ic"><Ic n="shield" size={14} /></span> });
    for (const u of USERS)
      if (`${u.name} ${u.id} ${u.title} ${u.team}`.toLowerCase().includes(s))
        out.push({ group: 'Users', label: u.name, sub: `${u.id} · ${u.title}`, href: `/identity?user=${u.id}`, icon: <span className="hit-ic"><Ic n="user" size={14} /></span> });
    for (const e of events)
      if (`${e.title} ${e.summary} ${e.target ?? ''}`.toLowerCase().includes(s))
        out.push({ group: 'Actions', label: e.summary, sub: `${e.title} · ${e.ago}`, href: `/audit?q=${encodeURIComponent(e.summary)}`, icon: <span className="hit-ic"><Ic n="activity" size={14} /></span> });
    return out.slice(0, 12);
  }, [q, policies, events]);

  const go = (h: Hit) => { setOpen(false); setQ(''); router.push(h.href); };

  return (
    <div className="search" ref={box}>
      <Ic n="search" />
      <input
        ref={input}
        value={q}
        placeholder="Search agents, policies, users, or actions…"
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
          {pending.length === 0 && <div className="search-none">Nothing waiting on you.</div>}
          {pending.slice(0, 5).map((a) => (
            <Link key={a.id} href={`/approvals?id=${a.id}`} className="pop-row" onClick={() => setOpen(false)}>
              <AgentGlyph type={a.agentType} size={26} />
              <span><span className="cell-main">{a.title}</span><span className="cell-sub">{AGENT_TYPES[a.agentType].label} · {a.user} · {a.requestedAgo}</span></span>
            </Link>
          ))}
          <Link href="/approvals" className="pop-foot" onClick={() => setOpen(false)}>Open approvals <Ic n="arrowRight" size={13} /></Link>
        </div>
      )}
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
