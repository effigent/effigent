import type { Metadata } from 'next';
import { GraphView } from '@/views/GraphView.tsx';

export const metadata: Metadata = { title: 'Agent Graph' };

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function GraphPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  return <GraphView key={`${one(sp.agent) ?? ''}|${one(sp.view) ?? ''}`} initialAgent={one(sp.agent)} initialView={one(sp.view)} />;
}
