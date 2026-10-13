import type { Metadata } from 'next';
import { Roboto_Flex, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';

// Roboto Flex is a variable font — the full weight axis (100–1000) ships in one
// file, so light body text and very heavy headings contrast sharply.
const sans = Roboto_Flex({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-mono', display: 'swap' });

const description =
  'Effigent is a control plane for coding agents. A small daemon on each Linux and macOS machine sees what Claude Code, Cursor and Codex run, enforces allow/deny rules on the machine, pauses risky actions until a named reviewer approves, and keeps a tamper-evident audit trail.';

export const metadata: Metadata = {
  title: 'Effigent — control plane for coding agents',
  description,
  keywords: ['AI agent security', 'coding agents', 'Claude Code', 'Cursor', 'Codex', 'agent policy', 'eBPF', 'MCP', 'approvals', 'audit trail'],
  openGraph: {
    title: 'Effigent — control plane for coding agents',
    description,
    type: 'website',
    siteName: 'Effigent',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Effigent — control plane for coding agents',
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
