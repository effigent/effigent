'use client';

import { useEffect, useRef, useState } from 'react';
import { Ic } from '@/icons.tsx';
import { useLive } from '@/live.tsx';
import { useStore } from '@/store.tsx';
import { DemoModeSwitch, ThemeSwitchRow } from './TopBar.tsx';
import { initials } from './ui.tsx';

const roleLabel = (r?: string | null) => (!r ? 'Member' : r.replace('_', ' ').replace(/^\w/, (c) => c.toUpperCase()));

/** Self-hosted sign-in (OIDC): who is signed in, Demo Mode, theme, sign out.
 *  Name and email come from the session (the server reads the cookie); the
 *  role is what the control plane decided from the token's groups. */
export function OidcUserMenu({ name, email, provider }: { name: string; email: string; provider: string }) {
  const { me } = useLive();
  const { dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const shown = name || email || 'Signed in';
  const role = roleLabel(me?.role);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  // Approvals record who decided — feed the signed-in identity into the store.
  useEffect(() => {
    dispatch({ t: 'viewer', viewer: { name: shown, role, initials: initials(shown) } });
  }, [shown, role, dispatch]);

  return (
    <div className="bell-wrap" ref={box}>
      <button className="user-menu user-btn" onClick={() => setOpen((o) => !o)} aria-label="Account">
        <span className="avatar">{initials(shown)}</span>
        <span className="user-text">
          <span className="user-name">{shown}</span>
          <span className="user-role">{role}</span>
        </span>
        <Ic n="chevronDown" size={16} />
      </button>
      {open && (
        <div className="pop user-pop">
          <div className="pop-head">Signed in with {provider}</div>
          <p className="pop-text">{email || shown}</p>
          <DemoModeSwitch />
          <ThemeSwitchRow />
          <form method="post" action="/auth/logout">
            <button type="submit" className="btn sm" style={{ margin: '8px 10px 6px' }}><Ic n="arrowLeft" size={14} /> Sign out</button>
          </form>
        </div>
      )}
    </div>
  );
}
