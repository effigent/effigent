import type { Metadata } from 'next';
import Link from 'next/link';
import { Nav, Footer, PageHero, DocSection } from '../ui';
import { CONTACT_EMAIL } from '../config';

export const metadata: Metadata = {
  title: 'About — Effigent',
  description:
    'Effigent builds a control plane for coding agents: see what Claude Code, Cursor and Codex do on developer machines, enforce policy there, and keep a record of every decision.',
};

const PRINCIPLES: Array<[string, string]> = [
  ['Enforce where the action happens', 'A rule about what a shell may run belongs on the machine running the shell, not in front of the model API. effigentd decides locally and keeps deciding when the network is gone.'],
  ['Say what you can’t do', 'Every layer has blind spots. The coverage matrix says which actions are blocked, paused or only observed on each OS, and the console marks rules that an endpoint can’t enforce.'],
  ['A name on every exception', 'An approval comes from a person, covers one action, and is in the audit log next to the action it allowed. Nothing is approved by default or by timeout.'],
  ['Don’t slow developers down by default', 'Start in monitor mode, read what would have been blocked, then enforce. Most actions are allowed and recorded without anyone noticing.'],
];

export default function About() {
  return (
    <div style={{ width: '100%', overflowX: 'hidden' }}>
      <Nav />
      <PageHero
        eyebrow="About"
        title="Agents got shell access. Controls should follow."
        sub="Coding agents now run commands, edit files, call MCP tools and push code on developer machines, with the developer’s credentials. Effigent gives engineering teams a way to see that, set rules for it, and prove what happened."
      />

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 26, margin: '0 0 14px' }}>Why this exists</h2>
        <div style={{ fontSize: 15, color: 'var(--ink-2)', lineHeight: 1.75, maxWidth: 680 }}>
          <p style={{ margin: '0 0 12px' }}>
            A year ago an AI assistant suggested code and a person ran it. Today Claude Code, Cursor and Codex run the
            commands themselves: install packages, read config, open connections, start MCP servers, push branches. They do it
            as the developer, with the developer&apos;s SSH keys and cloud credentials.
          </p>
          <p style={{ margin: '0 0 12px' }}>
            Most of the existing controls sit in the wrong place for this. An API gateway sees the prompt and the model call. It
            doesn&apos;t see the <code style={{ fontFamily: 'var(--mono)', fontSize: 13.5 }}>sh -c</code> that ran next, or the
            postinstall script under it.
          </p>
          <p style={{ margin: 0 }}>
            Effigent puts a small daemon on each machine. It sees the agents and their process trees, enforces policy through
            the agents&apos; own hooks and, on Linux, the kernel, and sends every decision to one place where a team can set the
            rules and review the exceptions.
          </p>
        </div>
      </DocSection>

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 26, margin: '0 0 16px' }}>Principles</h2>
        <div className="grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          {PRINCIPLES.map(([title, desc]) => (
            <div key={title} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '20px 22px', background: 'oklch(0.995 0.002 90)' }}>
              <div style={{ fontSize: 14.5, fontWeight: 700, marginBottom: 8 }}>{title}</div>
              <div style={{ fontSize: 13.5, color: 'var(--ink-2)', lineHeight: 1.6 }}>{desc}</div>
            </div>
          ))}
        </div>
      </DocSection>

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 26, margin: '0 0 14px' }}>Who builds it</h2>
        <p style={{ fontSize: 15, color: 'var(--ink-2)', lineHeight: 1.75, maxWidth: 680, margin: 0 }}>
          Effigent is built by engineers who use coding agents every day and wanted to know what those agents were doing on
          their own machines. We work closely with a small group of design partners. If your team runs coding agents and
          someone has asked you what they can touch,{' '}
          <a href={`mailto:${CONTACT_EMAIL}`} style={{ fontWeight: 600, color: 'oklch(0.4 0.14 250)' }}>we want to hear about it</a>.
        </p>
      </DocSection>

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 26, margin: '0 0 14px' }}>Get in touch</h2>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          <a href={`mailto:${CONTACT_EMAIL}`} className="btn btn-primary" style={{ padding: '12px 22px', fontSize: 14, display: 'inline-block' }}>Email us</a>
          <Link href="/docs/quickstart" className="btn btn-ghost" style={{ padding: '12px 20px', fontSize: 14, display: 'inline-block' }}>Enroll a machine instead</Link>
        </div>
      </DocSection>
      <Footer />
    </div>
  );
}
