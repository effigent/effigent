'use client';

import { useEffect } from 'react';
import { useClerk, useOrganization, useUser } from '@clerk/nextjs';

/** A workspace member, as approver groups store them (user_id = the Clerk user id the control plane sees). */
export interface Member { user_id: string; email: string; name: string; role: string }

const roleOf = (r?: string) => (r ?? '').replace(/^org:/, '') || 'member';

/**
 * Reads the workspace's members from Clerk (the browser's own session) and
 * reports them. Only rendered inside <ClerkProvider>: the dev bypass and Demo
 * Mode don't run Clerk and use their own member lists. A personal workspace
 * has one member, its owner. Up to 100 members are read.
 */
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
