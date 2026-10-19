import type { Metadata } from 'next';
import { Roboto_Flex, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';

// Roboto Flex is a variable font — the full weight axis (100–1000) ships in one
// file, so light body text and very heavy headings contrast sharply.
const sans = Roboto_Flex({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-mono', display: 'swap' });

const description =
  'Effigent is the AI Agent Control Plane. A lightweight daemon on every laptop, server and Kubernetes node recognises Claude Code, Codex, Cursor, Gemini CLI and other coding agents, attributes every process, file, network and MCP action to the agent that caused it, enforces signed policy on the machine with kernel-level eBPF and agent hooks, routes risky actions for approval, keeps a tamper-evident audit trail, and finds wasted AI spend.';
const title = 'Effigent — the AI Agent Control Plane';

export const metadata: Metadata = {
  title,
  description,
  keywords: ['AI agent control plane', 'AI agent security', 'coding agents', 'Claude Code', 'Codex', 'Cursor', 'Gemini CLI', 'GitHub Copilot', 'agent policy', 'eBPF', 'MCP', 'approvals', 'audit trail', 'AI spend', 'Pricing Leaks'],
  openGraph: {
    title,
    description,
    type: 'website',
    siteName: 'Effigent',
  },
  twitter: {
    card: 'summary_large_image',
    title,
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
