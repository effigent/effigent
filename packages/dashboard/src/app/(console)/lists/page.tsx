import type { Metadata } from 'next';
import { Lists } from '@/views/Lists.tsx';

export const metadata: Metadata = { title: 'Allow/Deny Lists' };

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function ListsPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  return <Lists key={one(sp.list) ?? ''} initialList={one(sp.list)} />;
}
