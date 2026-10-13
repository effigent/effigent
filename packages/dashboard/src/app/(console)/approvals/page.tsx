import type { Metadata } from 'next';
import { Approvals } from '@/views/Approvals.tsx';

export const metadata: Metadata = { title: 'Approvals' };

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function ApprovalsPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  return <Approvals key={one(sp.id) ?? ''} initialId={one(sp.id)} />;
}
