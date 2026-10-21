import type { Metadata } from 'next';
import Link from 'next/link';
import { Nav, Footer, CodeBlock, PageHero, DocSection } from '../ui';
import { SECURITY_EMAIL } from '../config';

export const metadata: Metadata = {
  title: 'Security & trust — Effigent',
  description:
    'Effigent security and compliance: SOC 2 in progress, hosted or self-hosted with your own identity provider, where data is hosted and how it is encrypted, what effigentd sends and never sends, retention and legal hold, four-eyes controls, access control, subprocessors, and what we share for a security review.',
};

const STATUS = [
  { label: 'SOC 2', value: 'In progress', hue: '85' },
  { label: 'Hosting', value: 'United States', hue: '250' },
  { label: 'Encryption', value: 'In transit and at rest', hue: '150' },
  { label: 'Audit trail', value: 'Append-only, hash-chained', hue: '290' },
  { label: 'Retention', value: 'Per workspace, with legal hold', hue: '200' },
  { label: 'Deployment', value: 'Hosted or self-hosted', hue: '25' },
];

const PILLARS = [
  {
    hue: '150',
    title: 'Decisions are made on the machine',
    body: 'effigentd evaluates every action locally against the last signed policy it received. The control plane distributes policy and collects events; it is not in the path of a block. If the network or the control plane is down, the last policy keeps enforcing and events wait on the machine’s disk (up to 256 MB) until it reconnects. Approval requests are the exception: they need an approver, so while the control plane can’t be reached the paused action is denied — never silently allowed.',
  },
  {
    hue: '250',
    title: 'Metadata about actions, not your code',
    body: 'effigentd sends what a rule and an audit trail need: which agent, the command, the file path, the destination host and port, the MCP server and tool name, the user and the machine. It does not read or send file contents, and it does not record model prompts or responses. Secrets are removed on the machine before anything leaves it (API keys, tokens, passwords — detected with the gitleaks rule set).',
  },
  {
    hue: '25',
    title: 'Agents can’t lift their own policy',
    body: 'Agents run as the developer; effigentd runs as root. Its local API is read-only unless the daemon was started with a token, because the agents it governs can reach localhost. Policies are signed (Ed25519) by the control plane and checked against a key pinned when the machine enrolled, so a tampered policy on disk is refused.',
  },
  {
    hue: '290',
    title: 'Every decision has an author',
    body: 'Machines join with a single-use enrollment token. Console roles separate admins and security admins (who change policy) from members (read-only). Approver groups decide which people may approve which requests, for example AWS changes to DevOps and outside hosts to the CISO. An admin stepping in is recorded as an override. Each approval covers one exact action. A rule can require two different approvers and a ticket. Nobody can approve their own request, admins included.',
  },
  {
    hue: '320',
    title: 'Four eyes on the policy itself',
    body: 'With policy change approval on, every change that would publish a new policy becomes a proposal: an edit, an exception, a new machine owner or team. It is applied only when a second admin approves it. The author can’t approve their own change, and a proposal made with an API key can’t be approved by the person who created that key. Every proposal, approval and refusal is in the audit trail.',
  },
  {
    hue: '85',
    title: 'Logs you can prove weren’t edited',
    body: 'Every console change (policy, approvals, exceptions, settings) and every agent event is append-only and hash-chained: each record commits to the one before it. Verify recomputes the chains on the server and names any record that was edited, removed or inserted. Archived events sit in S3 with Object Lock, and everything exports as CSV or streams to your systems through signed webhooks.',
  },
  {
    hue: '200',
    title: 'Hosted or self-hosted, with your data kept apart',
    body: 'The hosted control plane isolates every workspace: every record is scoped to a tenant and every query runs through that scope. You can also run the control plane and the console in your own infrastructure, with a Helm chart or Docker Compose. People sign in with your own OIDC provider (Okta, Entra ID, Keycloak and others), with roles from your groups. Your own CA, SMTP server and S3-compatible archive work too. effigentd behaves the same against either.',
  },
];

const INFRA: [string, string, string, string][] = [
  ['Endpoint daemon (effigentd)', 'Your machines', 'The last signed policy; events waiting to be sent (up to 256 MB, root-only)', 'Ed25519-signed policy pinned at enrollment; fails closed'],
  ['Control plane API', 'AWS App Runner, us-east-1', 'Nothing on disk', 'TLS only; enrollment tokens, machine secrets and API keys stored only as SHA-256 hashes'],
  ['Database', 'Neon (managed PostgreSQL), US', 'Agent events (90 days), audit trail, policies, approvals, settings', 'Encrypted at rest by the provider; events and audit trail append-only and hash-chained'],
  ['Event archive', 'Amazon S3, us-east-1', 'Events past the workspace’s retention, one file per day', 'Encrypted (SSE-S3), versioned, Object Lock for 365 days, deleted after one year unless on legal hold'],
  ['Console', 'Vercel (app.effigent.ai)', 'Nothing — it reads the API', 'Sign-in through Clerk (self-hosted: your OIDC provider); TLS'],
  ['Approval email', 'Amazon SES', 'The request being approved', 'Approve / deny links are signed, per recipient, single request, expire with it'],
];

const SUBPROCESSORS: [string, string, string][] = [
  ['Amazon Web Services', 'Control plane hosting, event archive (S3), approval email (SES), website', 'United States'],
  ['Neon', 'Managed PostgreSQL database', 'United States'],
  ['Vercel', 'Console hosting', 'United States'],
  ['Clerk', 'Sign-in and workspace membership (name, email)', 'United States'],
  ['Anthropic', 'Policy assistant — only when an admin uses “Ask AI”: the policy text and the request are sent; not used for training', 'United States'],
];

const FAQ: [string, string][] = [
  ['Do you see our source code?', 'No. effigentd records the file paths an agent opens or edits, not their contents. Prompts and completions never reach us. If you turn on the optional model gateway, effigentd forwards the agent’s model calls from the machine straight to the provider and records only the model, the token counts and the timing.'],
  ['Command lines can contain secrets. What happens to them?', 'Commands are sent as the agent ran them because rules and the audit trail depend on them, the same way they land in shell history — including text written inline, such as a heredoc. Secrets are redacted on the machine before they leave. For an approval of an MCP tool, the approver sees up to 800 characters of its (redacted) arguments.'],
  ['Do you train AI models on our data?', 'No. The only model call is the optional policy assistant, which sends your policy text and request to Anthropic’s API under terms that exclude training.'],
  ['What happens when the control plane is unreachable?', 'Blocking continues with the last policy, and events are kept on the machine until it reconnects. Actions that need an approval are denied until an approver can be reached.'],
  ['Can an agent turn effigentd off?', 'Not through its API, which is read-only without a token, and not as the developer user. If an agent can run sudo it can do what root can, so deny sudo for agents that don’t need it. Anyone with root can stop the daemon or remove a hook. Effigent alerts you when that happens: a removed or switched-off hook, a stopped daemon and a machine gone silent each raise an alert by email and webhook.'],
  ['Can we run it ourselves?', 'Yes. The control plane and console run in your Kubernetes cluster (Helm chart) or on one host (Docker Compose with automatic HTTPS), on PostgreSQL, behind your OIDC sign-in. Machines enroll against it with your own CA. See the self-hosting guide.'],
  ['Can we put data on legal hold?', 'Yes. An admin turns on legal hold for the workspace, with a reason. While it is on, nothing in the workspace is deleted: retention stops, the database refuses deletes of its events, and every archived file in S3 gets an Object Lock legal hold.'],
  ['Can we get our data out, or deleted?', 'Yes. Events and the audit trail export as CSV, stream through signed webhooks, and archived days download from the console. Ask us and we remove a machine’s or a whole workspace’s data from live systems; archives are deleted when their one-year lock ends.'],
  ['Does it work on macOS and Windows?', 'Yes. The same policy, approvals and audit trail apply on Linux, macOS and Windows. effigentd enforces through the agents’ own hooks (Claude Code, Codex, Gemini CLI, Cursor) and, on Linux, through the kernel (eBPF). The coverage table shows how each kind of action is enforced.'],
];

const cell = { padding: '12px 14px', borderTop: '1px solid var(--line)', fontSize: 13.5, lineHeight: 1.55, verticalAlign: 'top' as const };

export default function SecurityPage() {
  return (
    <div style={{ width: '100%', overflowX: 'hidden' }}>
      <Nav />
      <PageHero
        eyebrow="Security & trust"
        title="Built to be trusted on developer machines."
        sub="Effigent sits on developer machines with root and sees what agents do there. Here is where your data lives, how it is protected, what effigentd sends and never sends, and what we can share for your review."
      />

      <DocSection>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(128px, 1fr))', gap: 10 }}>
          {STATUS.map((s) => (
            <div key={s.label} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '16px 16px 14px', background: 'var(--paper, #fff)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--ink-3)' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: `oklch(0.6 0.16 ${s.hue})` }} />{s.label}
              </div>
              <div style={{ fontSize: 16, fontWeight: 700, marginTop: 8 }}>{s.value}</div>
            </div>
          ))}
        </div>
      </DocSection>

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 26, margin: '0 0 14px' }}>For your security review</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
          <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 18 }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>SOC 2 — in progress</div>
            <div style={{ fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.65 }}>We are working toward a SOC 2 report. Meanwhile, the controls below are the ones we run, and we answer your questions directly.</div>
          </div>
          <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 18 }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>Available under NDA</div>
            <ul style={{ fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.7, margin: 0, paddingLeft: 18 }}>
              <li>Your security questionnaire, completed (SIG Lite, CAIQ or your own)</li>
              <li>Architecture and data-flow document: components, data flows, storage and access</li>
            </ul>
          </div>
          <div style={{ border: '1px solid var(--line)', borderRadius: 12, padding: 18 }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>Talk to us</div>
            <div style={{ fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.65 }}>
              Security questions, documents and vulnerability reports: <a href={`mailto:${SECURITY_EMAIL}`} style={{ fontWeight: 600, color: 'oklch(0.4 0.14 250)' }}>{SECURITY_EMAIL}</a>.
              We answer every report and won’t pursue good-faith security research. <a href="/.well-known/security.txt" style={{ color: 'oklch(0.4 0.14 250)' }}>security.txt</a>
            </div>
          </div>
        </div>
      </DocSection>

      <DocSection>
        {PILLARS.map((p) => (
          <div key={p.title} style={{ display: 'flex', gap: 18, padding: '26px 0', borderBottom: '1px solid var(--line)' }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: `oklch(0.58 0.16 ${p.hue})`, marginTop: 7, flexShrink: 0 }} />
            <div>
              <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 8px' }}>{p.title}</h2>
              <p style={{ fontSize: 14.5, color: 'var(--ink-2)', lineHeight: 1.7, margin: 0, maxWidth: 720 }}>{p.body}</p>
            </div>
          </div>
        ))}
      </DocSection>

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 26, margin: '0 0 6px' }}>Where your data lives</h2>
        <p className="doc-p">Every component, where it runs, what it keeps and how it is protected. All customer data is stored in the United States.</p>
        <div style={{ overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
            <thead><tr>{['Component', 'Runs on', 'Keeps', 'Protection'].map((h) => <th key={h} style={{ ...cell, borderTop: 'none', textAlign: 'left', fontSize: 12, fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--ink-3)' }}>{h}</th>)}</tr></thead>
            <tbody>{INFRA.map((r) => <tr key={r[0]}>{r.map((c, i) => <td key={i} style={{ ...cell, fontWeight: i === 0 ? 600 : 400, color: i === 0 ? 'var(--ink)' : 'var(--ink-2)' }}>{c}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </DocSection>

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 26, margin: '0 0 14px' }}>Access and secrets</h2>
        <ul style={{ fontSize: 14.5, color: 'var(--ink-2)', lineHeight: 1.8, margin: 0, paddingLeft: 18, maxWidth: 760 }}>
          <li>People sign in through Clerk, with roles set per workspace (admin, security admin, member). Self-hosted, people sign in with your OIDC provider instead, with roles from your groups or admin email list.</li>
          <li>Automation uses scoped API keys (read, approvals, machines, policy), shown once and stored only as a hash; revocation is immediate.</li>
          <li>Webhooks are HTTPS-only, signed with HMAC-SHA256, and can’t be pointed at private or internal addresses.</li>
          <li>Integration credentials we must use later are sealed with AES-256-GCM, bound to the workspace, and never returned by the API.</li>
          <li>Every change made in the console, and every refused attempt, is written to the audit trail with who, when and from where.</li>
        </ul>
      </DocSection>

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 26, margin: '0 0 14px' }}>What one agent event looks like</h2>
        <p className="doc-p">A blocked command from Claude Code. This is the whole record; there is no file content or prompt behind it.</p>
        <CodeBlock title="event · one record">{`{
  "time": "2026-10-13T14:32:07Z",
  "node": "alex-mbp",
  "type": "blocked",
  "severity": "high",
  "agent": "claude-code",
  "mode": "denylist",
  "kind": "tool",
  "target": "Bash: curl https://paste.example.net",
  "rule": "domain_deny"
}`}</CodeBlock>
      </DocSection>

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 26, margin: '0 0 14px' }}>Retention and deletion</h2>
        <p className="doc-p">Agent events stay in the database for 90 days by default. Each workspace can keep them longer, up to ten years. They then move to the S3 archive, where they are locked for a year and then deleted. The console audit trail, policies and approvals are kept for the life of the workspace. You can ask us to delete a machine’s or a workspace’s data at any time.</p>
        <p className="doc-p"><b>Legal hold.</b> An admin can put the workspace on legal hold, with a reason. Until it is lifted nothing is deleted:</p>
        <ul className="doc-list">
          <li>Retention skips the workspace.</li>
          <li>The database refuses any delete of its events.</li>
          <li>Every archived file gets an S3 Object Lock legal hold, which lifecycle rules can&apos;t remove.</li>
        </ul>
        <p className="doc-p">Turning the hold on or off, and every change to it, is in the audit trail.</p>
      </DocSection>

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 26, margin: '0 0 14px' }}>Subprocessors</h2>
        <div style={{ overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
            <thead><tr>{['Provider', 'What for', 'Location'].map((h) => <th key={h} style={{ ...cell, borderTop: 'none', textAlign: 'left', fontSize: 12, fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--ink-3)' }}>{h}</th>)}</tr></thead>
            <tbody>{SUBPROCESSORS.map((r) => <tr key={r[0]}>{r.map((c, i) => <td key={i} style={{ ...cell, fontWeight: i === 0 ? 600 : 400, color: i === 0 ? 'var(--ink)' : 'var(--ink-2)' }}>{c}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </DocSection>

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 26, margin: '0 0 14px' }}>Questions CTOs and CISOs ask us</h2>
        {FAQ.map(([q, a]) => (
          <div key={q} style={{ padding: '18px 0', borderTop: '1px solid var(--line)' }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>{q}</div>
            <div style={{ fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.65, maxWidth: 700 }}>{a}</div>
          </div>
        ))}
        <p className="doc-p" style={{ marginTop: 18 }}>
          More detail: <Link href="/docs/enforcement">Enforcement &amp; coverage</Link> · <Link href="/docs/self-hosting">Self-hosting</Link> · <Link href="/docs/approvals">Approvals</Link> · <Link href="/privacy">Privacy Policy</Link> · <a href={`mailto:${SECURITY_EMAIL}`}>{SECURITY_EMAIL}</a>
        </p>
      </DocSection>

      <Footer />
    </div>
  );
}
