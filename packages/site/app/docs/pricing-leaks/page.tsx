import type { Metadata } from 'next';
import Link from 'next/link';
import { Nav, Footer, PageHero, DocSection, CodeBlock, DocsPager, H2 } from '../../ui';

export const metadata: Metadata = {
  title: 'Pricing Leaks — Effigent docs',
  description: 'How Pricing Leaks joins AI vendor seats, usage and cost with the agents effigentd sees on each machine, finds unused seats, duplicate tools, shadow spend and runaway costs, and alerts on runaway spend.',
};

const VENDORS: Array<[string, string, string]> = [
  ['Cursor', 'Admin API key', 'Team members, daily usage, charged usage events'],
  ['Anthropic · Claude Code', 'Admin API key', 'Organisation members, the Claude Code usage report per user or API key, the daily cost report'],
  ['GitHub Copilot', 'Token with Copilot billing access + organisation', 'Plan, seats with last activity'],
  ['OpenAI · Codex', 'Admin API key', 'Organisation members, daily costs, token usage per user'],
];

const LEAKS: Array<[string, string, string]> = [
  ['Unused seat', 'A paid seat with no use in 30 days: the vendor reports no activity and effigentd saw none of that vendor’s agents for the person. Seats younger than 14 days are skipped.', 'The seat price'],
  ['Duplicate tool', 'The person works with one tool most days and opens the paid seat of another on only a few.', 'The seat they don’t use'],
  ['Shadow spend', 'effigentd sees a vendor’s agent for a person who has no seat or usage on your connected account: a personal plan or card.', 'The personal plan price, at risk'],
  ['Runaway cost', 'One person far above the team median for a vendor, or a day several times the usual: an agent looping in CI, a key used by an automation.', 'Spend above the usual, per month'],
];

const IDENTITY: Array<[string, string]> = [
  ['OS user', 'The account the agent runs as. Mapped per machine (dana@build-7) or everywhere (dana).'],
  ['Git email', 'user.email of the repository the agent works in, or the user’s global git config.'],
  ['Machine owner', 'The owner set on the machine in Machines.'],
  ['Hostname', 'A machine mapped to a person in People.'],
];

export default function PricingLeaksDocs() {
  return (
    <div style={{ width: '100%', overflowX: 'hidden' }}>
      <Nav />
      <PageHero
        eyebrow="Docs · Pricing Leaks"
        title="What you pay for, next to what runs."
        sub="Pricing Leaks joins the seats, usage and cost your AI coding vendors report with the agents effigentd sees on each machine, person by person, and prices every gap."
      />

      <DocSection>
        <H2 n={1}>Connect your vendors</H2>
        <p className="doc-p">
          In the console, open Settings → AI vendors and paste each vendor&apos;s admin key. Effigent pulls the last 30 days straight away and again every day. Keys are encrypted at rest and never shown again; only their last four characters are.
        </p>
        <div className="tbl-wrap">
          <table className="doc-tbl">
            <thead><tr><th>Vendor</th><th>Credential</th><th>What Effigent reads</th></tr></thead>
            <tbody>{VENDORS.map(([v, k, r]) => <tr key={v}><td style={{ whiteSpace: 'nowrap' }}><b>{v}</b></td><td>{k}</td><td>{r}</td></tr>)}</tbody>
          </table>
        </div>
        <p className="doc-p" style={{ marginTop: 14 }}>
          No admin key? Upload the vendor&apos;s seat or usage export as CSV on the Pricing Leaks page instead. Columns are matched by name (email or login, date, cost, requests), so the export works as it comes.
        </p>
      </DocSection>

      <DocSection>
        <H2 n={2}>Match people</H2>
        <p className="doc-p">
          Vendors know people by email or login. effigentd records who is behind every agent action, and each day of agent activity goes to a person through the first of these that matches:
        </p>
        <div className="tbl-wrap">
          <table className="doc-tbl">
            <thead><tr><th>Signal</th><th>From</th></tr></thead>
            <tbody>{IDENTITY.map(([s, d], i) => <tr key={s}><td style={{ whiteSpace: 'nowrap' }}>{i + 1}. <b>{s}</b></td><td>{d}</td></tr>)}</tbody>
          </table>
        </div>
        <p className="doc-p" style={{ marginTop: 14 }}>
          A shared build machine splits by OS user and git email. Workspace → People suggests the mappings it can infer (an OS user whose commits use a known work email, a machine where every run is one person&apos;s) and applies them when you accept. Every finding says how its person was matched.
        </p>
      </DocSection>

      <DocSection>
        <H2 n={3}>Read the leaks</H2>
        <div className="tbl-wrap">
          <table className="doc-tbl">
            <thead><tr><th>Leak</th><th>When</th><th>Monthly saving</th></tr></thead>
            <tbody>{LEAKS.map(([l, w, s]) => <tr key={l}><td style={{ whiteSpace: 'nowrap' }}><b>{l}</b></td><td>{w}</td><td>{s}</td></tr>)}</tbody>
          </table>
        </div>
        <p className="doc-p" style={{ marginTop: 14 }}>
          Each finding lists its evidence from both sides, the vendor&apos;s record and what effigentd saw, with a confidence. Seat prices default to each vendor&apos;s list price and can be set to what you actually pay on the page.
        </p>
      </DocSection>

      <DocSection>
        <H2 n={4}>Spend over time</H2>
        <p className="doc-p">
          The Spend over time chart shows daily cost per vendor and how many machines ran each vendor&apos;s agents, for 30, 90 or 180 days, with a table view of the same numbers. Effigent records the report every hour and whenever vendor data changes, so the open leaks and their saving have a history too.
        </p>
      </DocSection>

      <DocSection>
        <H2 n={5}>Runaway cost alerts</H2>
        <p className="doc-p">
          A runaway cost is announced as soon as it shows up in the vendor data, by email and to webhooks subscribed to <code>pricing_leaks.runaway_cost</code>, then weekly while it lasts. If it stops and starts again, that is a new alert. Choose the recipients or turn alerts off under Alerts on the Pricing Leaks page; by default they go to your approval recipients. Every alert is recorded in the audit trail with where it was sent.
        </p>
        <CodeBlock title="webhook · pricing_leaks.runaway_cost">{`{
  "id": "…",
  "type": "pricing_leaks.runaway_cost",
  "created_at": "2026-10-19T06:13:04Z",
  "tenant": "org:…",
  "data": {
    "leak": {
      "id": "runaway_cost:anthropic:apikey:ci-nightly",
      "vendor": "anthropic",
      "title": "Claude Code API key spike",
      "evidence": ["Spike today: $412 vs a $71/day average the week before"],
      "monthly_savings_cents": 34100,
      "first_seen_at": "2026-10-19T06:12:00Z"
    },
    "review_url": "https://app.effigent.ai/pricing-leaks?leak=…"
  }
}`}</CodeBlock>
        <p className="doc-p" style={{ marginTop: 14 }}>
          Example payload. Each delivery is signed: <code>X-Effigent-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code>, an HMAC-SHA256 of <code>t.body</code> with the webhook&apos;s secret, shown once when you add the webhook in Settings → Integrations. A failed delivery is retried six times over about nine hours; see <Link href="/docs/api">API</Link> for the console API.
        </p>
      </DocSection>

      <DocsPager current="/docs/pricing-leaks" />
      <Footer />
    </div>
  );
}
