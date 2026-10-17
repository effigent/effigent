import type { Metadata } from 'next';
import { Team } from '@/views/Team.tsx';
import { devNoAuth } from '@/lib/dev-auth.ts';

export const metadata: Metadata = { title: 'Team & Approvers' };

export default function TeamPage() {
  return <Team dev={devNoAuth} />;
}
