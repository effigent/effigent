import type { Metadata } from 'next';
import { Report } from '@/views/Report.tsx';

export const metadata: Metadata = { title: 'Posture report' };

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function ReportPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  return <Report key={one(sp.days) ?? ''} initialDays={one(sp.days)} />;
}
