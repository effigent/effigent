import type { Metadata } from 'next';
import { Enforcement } from '@/views/Enforcement.tsx';

export const metadata: Metadata = { title: 'Enforcement' };

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function EnforcementPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  return <Enforcement key={one(sp.endpoint) ?? ''} initialEndpoint={one(sp.endpoint)} />;
}
