'use client';

import { useEffect } from 'react';
import { useClerk, useOrganization, useUser } from '@clerk/nextjs';
import { useLive } from '@/live.tsx';

/** A workspace member, as approver groups store them (user_id = the Clerk user id the control plane sees). */
export interface Member { user_id: string; email: string; name: string; role: string }

const roleOf = (r?: string) => (r ?? '').replace(/^org:/, '') || 'member';

/**
 * Reads the workspace's members from Clerk (the browser's own session) and
 * reports them. Only rendered inside <ClerkProvider>: the dev bypass and Demo
 * Mode don't run Clerk and use their own member lists. A personal workspace
 * has one member, its owner. Up to 100 members are read.
 */
/**
 * Self-hosted (OIDC): there is no directory to read, so the members are the
 * people who signed in (the control plane's GET /members, last 30 days).
 * Inviting happens in the identity provider: no invite button.
 */
export function OidcMembers({ onMembers, onInvite }: { onMembers: (m: Member[], org: boolean) => void; onInvite: (open: (() => void) | null) => void }) {
  const { api } = useLive();
  useEffect(() => {
    let live = true;
    onInvite(null);
    api.get<{ members: { user_id: string; email: string; name: string; role: string }[] }>('/members')
      .then((r) => { if (live) onMembers((r.members ?? []).map((m) => ({ user_id: m.user_id, email: m.email, name: m.name || m.email, role: m.role || 'member' })), true); })
      .catch(() => { if (live) onMembers([], true); });
    return () => { live = false; };
  }, [api, onMembers, onInvite]);
  return null;
}

export function ClerkMembers({ onMembers, onInvite }: { onMembers: (m: Member[], org: boolean) => void; onInvite: (open: (() => void) | null) => void }) {
  const { user } = useUser();
  const clerk = useClerk();
  const { organization, memberships } = useOrganization({ memberships: { pageSize: 100 } });
  const rows = memberships?.data;

  useEffect(() => {
    if (organization) {
      if (!rows) return;
      onMembers(rows.map((m) => {
        const u = m.publicUserData;
        const name = [u?.firstName, u?.lastName].filter(Boolean).join(' ');
        return { user_id: u?.userId ?? '', email: u?.identifier ?? '', name: name || (u?.identifier ?? ''), role: roleOf(m.role) };
      }).filter((m) => m.user_id), true);
      onInvite(() => clerk.openOrganizationProfile());
    } else if (user) {
      onMembers([{ user_id: user.id, email: user.primaryEmailAddress?.emailAddress ?? '', name: user.fullName || user.username || '', role: 'admin' }], false);
      onInvite(null);
    }
  }, [organization, rows, user, clerk, onMembers, onInvite]);
  return null;
}
