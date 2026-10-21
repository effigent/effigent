import type { Metadata } from 'next';
import { Anomalies } from '@/views/Anomalies.tsx';

export const metadata: Metadata = { title: 'New behaviour' };

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function AnomaliesPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const kind = one(sp.kind), endpoint = one(sp.endpoint);
  return <Anomalies key={`${kind ?? ''}|${endpoint ?? ''}`} initialKind={kind} initialEndpoint={endpoint} />;
}
