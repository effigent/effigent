import type { Metadata } from 'next';
import { Roboto_Flex, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';

// Roboto Flex is a variable font — the full weight axis (100–1000) ships in one
// file, so light body text and very heavy headings contrast sharply.
const sans = Roboto_Flex({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-mono', display: 'swap' });

const description =
  'Effigent runs alongside your agents, learns which steps are always the same, and automatically replaces them with efficient deterministic code — dramatically reducing LLM token consumption while eliminating non-deterministic outputs.';

export const metadata: Metadata = {
  title: 'Effigent — the compiler for AI agents',
  description,
  keywords: ['AI agents', 'agent cost optimization', 'LLM caching', 'determinism', 'agent runtime', 'token cost'],
  openGraph: {
    title: 'Effigent — the compiler for AI agents',
    description,
    type: 'website',
    siteName: 'Effigent',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Effigent — the compiler for AI agents',
    description,
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
