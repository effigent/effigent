import type { Metadata } from 'next';
import { Source_Serif_4, Inter, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';

const serif = Source_Serif_4({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-serif', display: 'swap' });
const sans = Inter({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-sans', display: 'swap' });
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-mono', display: 'swap' });

const description =
  'Optimizer is the runtime layer for production AI agents. It watches which tool calls and reasoning steps never change and replaces them with cache — no code changes, no new framework.';

export const metadata: Metadata = {
  title: 'Optimizer — the compiler for AI agents',
  description,
  keywords: ['AI agents', 'agent cost optimization', 'LLM caching', 'determinism', 'agent runtime', 'token cost'],
  openGraph: {
    title: 'Optimizer — the compiler for AI agents',
    description,
    type: 'website',
    siteName: 'Optimizer',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Optimizer — the compiler for AI agents',
    description,
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
