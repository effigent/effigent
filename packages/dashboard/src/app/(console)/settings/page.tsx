import type { Metadata } from 'next';
import { devNoAuth } from '@/lib/dev-auth.ts';
import { Settings } from '@/views/Settings.tsx';

export const metadata: Metadata = { title: 'Settings' };

export default function SettingsPage() {
  return <Settings dev={devNoAuth} />;
}
