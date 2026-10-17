'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { StoreProvider, useStore } from '@/store.tsx';
import { LiveDataProvider, useLive } from '@/live.tsx';
import { DemoModeProvider, useDemoMode } from '@/demo.tsx';
import { Ic } from '@/icons.tsx';
import { Sidebar } from './Sidebar.tsx';
import { TopBar } from './TopBar.tsx';

function Toast() {
  const { toast } = useStore();
  if (!toast) return null;
  return <div className="toast" role="status"><Ic n="checkCircle" size={16} /> {toast}</div>;
}

/** Shown on every page while Demo Mode is on. */
function DemoBanner() {
  const { demo, setDemo } = useDemoMode();
  if (!demo) return null;
  return (
    <div className="callout demo api-banner" role="status">
      <Ic n="eye" size={16} /><span><strong>Demo Mode — sample data, nothing here is real.</strong> Changes stay in this browser tab and never reach your workspace.</span>
      <button className="btn sm" onClick={() => setDemo(false)}><Ic n="x" size={14} /> Turn off</button>
    </div>
  );
}

/** One banner for control-plane failures (unreachable, 401, 429…); views keep
 *  showing the last good data underneath. Under the dev auth bypass there is
 *  no session to call the API with, so say that instead. */
function ApiBanner({ dev }: { dev: boolean }) {
  const { error, refresh, fixture } = useLive();
  const { setDemo } = useDemoMode();
  if (fixture) return null;
  if (dev && process.env.NEXT_PUBLIC_EFFIGENT_DEV_ADMIN_TOKEN) {
    return (
      <div className="callout api-banner" role="status">
        <Ic n="eye" size={16} /><span>Dev build: auth is bypassed and the console uses the local control plane&apos;s admin token ({process.env.NEXT_PUBLIC_EFFIGENT_DEV_TENANT}).</span>
      </div>
    );
  }
  if (dev) {
    return (
      <div className="callout api-banner" role="status">
        <Ic n="eye" size={16} /><span>Auth is bypassed in this dev build, so there is no control-plane session and live pages stay empty. Turn on Demo Mode to see sample data.</span>
        <button className="btn sm" onClick={() => setDemo(true)}>Turn on Demo Mode</button>
      </div>
    );
  }
  if (!error) return null;
  return (
    <div className="callout warn api-banner" role="alert">
      <Ic n="alert" size={16} /><span>{error}</span>
      <button className="btn sm" onClick={() => void refresh()}><Ic n="rotate" /> Retry</button>
    </div>
  );
}

function Frame({ dev, userMenu, children }: { dev: boolean; userMenu: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();
  const { ready } = useDemoMode();
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => { try { setCollapsed(localStorage.getItem('effigent.sidebar') === 'collapsed'); } catch { /* storage blocked */ } }, []);
  const toggle = () => setCollapsed((c) => {
    try { localStorage.setItem('effigent.sidebar', c ? 'open' : 'collapsed'); } catch { /* storage blocked */ }
    return !c;
  });
  return (
    <div className={`app ${collapsed ? 'collapsed' : ''}`}>
      {open && <div className="sidebar-backdrop" onClick={() => setOpen(false)} />}
      <Sidebar open={open} onClose={() => setOpen(false)} collapsed={collapsed} onToggle={toggle} />
      <div className="main">
        <TopBar dev={dev} userMenu={userMenu} onMenu={() => setOpen(true)} />
        <DemoBanner />
        <ApiBanner dev={dev} />
        {/* Hidden until Demo Mode has been read from storage, so a demo session never flashes the empty real views. */}
        <main className="content" style={ready ? undefined : { visibility: 'hidden' }}>{children}</main>
      </div>
      <Toast />
    </div>
  );
}

/** The console chrome: sidebar + top bar around every page. `dev` comes from
 *  the server (lib/dev-auth.ts) — the client never decides auth on its own. */
export function AppShell({ dev, userMenu, children }: { dev: boolean; userMenu: ReactNode; children: ReactNode }) {
  return (
    <DemoModeProvider>
      <Workspace dev={dev} userMenu={userMenu}>{children}</Workspace>
    </DemoModeProvider>
  );
}

/** Everything below remounts when Demo Mode flips: sample edits, fetched
 *  workspace data and half-finished forms (a policy draft, an enrollment
 *  token) never carry over from the sample workspace to the real one. */
function Workspace({ dev, userMenu, children }: { dev: boolean; userMenu: ReactNode; children: ReactNode }) {
  const { demo } = useDemoMode();
  return (
    <StoreProvider key={demo ? 'demo' : 'live'} demo={demo}>
      <LiveDataProvider dev={dev}>
        <Frame dev={dev} userMenu={userMenu}>{children}</Frame>
      </LiveDataProvider>
    </StoreProvider>
  );
}
