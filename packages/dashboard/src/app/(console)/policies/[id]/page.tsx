import type { Metadata } from 'next';
import { PolicyDetail } from '@/views/PolicyDetail.tsx';

export const metadata: Metadata = { title: 'Policy' };

export default async function PolicyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PolicyDetail id={decodeURIComponent(id)} />;
}
