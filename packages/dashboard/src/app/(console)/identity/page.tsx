import type { Metadata } from 'next';
import { Identity } from '@/views/Identity.tsx';

export const metadata: Metadata = { title: 'Identity & Access' };

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function IdentityPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  return <Identity key={one(sp.user) ?? ''} initialUser={one(sp.user)} />;
}
