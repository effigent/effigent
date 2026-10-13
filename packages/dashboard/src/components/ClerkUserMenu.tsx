'use client';

import { useEffect } from 'react';
import { OrganizationSwitcher, UserButton, useOrganization, useUser } from '@clerk/nextjs';
import { useStore } from '@/store.tsx';
import { useDemoMode } from '@/demo.tsx';
import { Ic } from '@/icons.tsx';
import { initials, THEME_ICON } from './ui.tsx';
import { THEME_OPTIONS, useTheme } from '@/theme.tsx';

const appearance = {
  elements: {
    rootBox: { display: 'flex', alignItems: 'center' },
    organizationSwitcherTrigger: {
      padding: '6px 10px', borderRadius: '10px', border: '1px solid var(--border)',
      backgroundColor: 'var(--panel-2)', color: 'var(--txt)', maxWidth: '200px',
    },
    organizationSwitcherTriggerIcon: { color: 'var(--txt-3)' },
    organizationPreviewMainIdentifier: { color: 'var(--txt)', fontWeight: 600 },
    userButtonAvatarBox: { width: '36px', height: '36px' },
  },
};

const roleLabel = (r?: string | null) =>
  !r ? 'Member' : r.replace(/^org:/, '').replace(/^\w/, (c) => c.toUpperCase());

/** Signed-in user + org from Clerk. Only rendered inside <ClerkProvider>. */
export function ClerkUserMenu() {
  const { user } = useUser();
  const { organization, membership } = useOrganization();
  const { dispatch } = useStore();
  const { demo, setDemo } = useDemoMode();
  const { pref, setPref } = useTheme();
  const name = user?.fullName || user?.username || user?.primaryEmailAddress?.emailAddress || 'Signed in';
  const role = organization ? roleLabel(membership?.role) : 'Owner';

  // Approvals record who decided — feed the Clerk identity into the store.
  useEffect(() => {
    if (user) dispatch({ t: 'viewer', viewer: { name, role, initials: initials(name) } });
  }, [user, name, role, dispatch]);

  return (
    <div className="user-menu">
      <OrganizationSwitcher appearance={appearance} afterCreateOrganizationUrl="/" afterSelectOrganizationUrl="/" hidePersonal={false} />
      <UserButton appearance={appearance}>
        <UserButton.MenuItems>
          <UserButton.Action
            label={demo ? 'Turn off Demo Mode' : 'Turn on Demo Mode (sample data)'}
            labelIcon={<Ic n="eye" size={16} />}
            onClick={() => setDemo(!demo)}
          />
          {THEME_OPTIONS.map((o) => (
            <UserButton.Action key={o.id} label={`${o.label} theme${pref === o.id ? ' ✓' : ''}`} labelIcon={<Ic n={THEME_ICON[o.id]} size={16} />} onClick={() => setPref(o.id)} />
          ))}
        </UserButton.MenuItems>
      </UserButton>
      <span className="user-text">
        <span className="user-name">{name}</span>
        <span className="user-role">{role}</span>
      </span>
    </div>
  );
}
