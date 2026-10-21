import type { Metadata } from 'next';
import { Inventory } from '@/views/Inventory.tsx';

export const metadata: Metadata = { title: 'Inventory' };

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function InventoryPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  return <Inventory key={one(sp.tab) ?? ''} initialTab={one(sp.tab)} />;
}
