'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { StoreProvider, useStore } from '@/store.tsx';
import { LiveDataProvider, useLive } from '@/live.tsx';
import { Ic } from '@/icons.tsx';
import { Sidebar } from './Sidebar.tsx';
import { TopBar } from './TopBar.tsx';

function Toast() {
  const { toast } = useStore();
  if (!toast) return null;
  return <div className="toast" role="status"><Ic n="checkCircle" size={16} /> {toast}</div>;
}

/** One banner for control-plane failures (unreachable, 401, 429…); views keep
 *  showing the last good data underneath. */
function ApiBanner() {
  const { error, refresh, fixture } = useLive();
  if (!error && !fixture) return null;
  if (!error) {
    return (
      <div className="callout api-banner" role="status">
        <Ic n="eye" size={16} /><span>Auth is bypassed, so this dev build serves a local fixture of the control-plane API — nothing here reaches api.effigent.ai.</span>
      </div>
    );
  }
  return (
    <div className="callout warn api-banner" role="alert">
      <Ic n="alert" size={16} /><span>{error}</span>
      <button className="btn sm" onClick={() => void refresh()}><Ic n="rotate" /> Retry</button>
    </div>
  );
}

function Frame({ dev, userMenu, children }: { dev: boolean; userMenu: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => setOpen(false), [pathname]);
  return (
    <div className="app">
      {open && <div className="sidebar-backdrop" onClick={() => setOpen(false)} />}
      <Sidebar open={open} onClose={() => setOpen(false)} />
      <div className="main">
        <TopBar dev={dev} userMenu={userMenu} onMenu={() => setOpen(true)} />
        <ApiBanner />
        <main className="content">{children}</main>
      </div>
      <Toast />
    </div>
  );
}

/** The console chrome: sidebar + top bar around every page. `dev` comes from
 *  the server (lib/dev-auth.ts) — the client never decides auth on its own. */
export function AppShell({ dev, userMenu, children }: { dev: boolean; userMenu: ReactNode; children: ReactNode }) {
  return (
    <StoreProvider>
      <LiveDataProvider dev={dev}>
        <Frame dev={dev} userMenu={userMenu}>{children}</Frame>
      </LiveDataProvider>
    </StoreProvider>
  );
}
