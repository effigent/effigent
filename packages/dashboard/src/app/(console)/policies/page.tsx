import type { Metadata } from 'next';
import { Policies } from '@/views/Policies.tsx';

export const metadata: Metadata = { title: 'Policies' };

export default function PoliciesPage() {
  return <Policies />;
}
