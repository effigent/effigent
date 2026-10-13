import type { Metadata } from 'next';
import { Audit } from '@/views/Audit.tsx';

export const metadata: Metadata = { title: 'Audit & Compliance' };

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function AuditPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  return <Audit key={one(sp.q) ?? ''} initialQuery={one(sp.q)} />;
}
