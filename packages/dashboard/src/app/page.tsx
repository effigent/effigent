import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { Dashboard } from '@/Dashboard.tsx';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');
  return <Dashboard />;
}
