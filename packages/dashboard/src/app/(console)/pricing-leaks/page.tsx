import type { Metadata } from 'next';
import { PricingLeaks } from '@/views/PricingLeaks.tsx';
import { devNoAuth } from '@/lib/dev-auth.ts';

export const metadata: Metadata = { title: 'Pricing Leaks' };

export default function PricingLeaksPage() {
  return <PricingLeaks dev={devNoAuth} />;
}
