'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { StoreProvider, useStore } from '@/store.tsx';
import { Ic } from '@/icons.tsx';
import { Sidebar } from './Sidebar.tsx';
import { TopBar } from './TopBar.tsx';

function Toast() {
  const { toast } = useStore();
  if (!toast) return null;
  return <div className="toast" role="status"><Ic n="checkCircle" size={16} /> {toast}</div>;
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
      <Frame dev={dev} userMenu={userMenu}>{children}</Frame>
    </StoreProvider>
  );
}
