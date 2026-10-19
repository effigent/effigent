import type { Metadata } from 'next';
import Link from 'next/link';
import { Nav, Footer, PageHero, DocSection, CodeBlock, DocsPager, H2 } from '../../ui';

export const metadata: Metadata = {
  title: 'Policies — Effigent docs',
  description: 'How Effigent policies are scoped and evaluated: allow, deny and require-approval rules over exec, files, network, MCP and tool calls, precedence, defaults and kernel modes.',
};

const CLASSES: Array<[string, string, string]> = [
  ['exec', 'Run a program or shell command', 'binaries, commands'],
  ['file_read', 'Read a file', 'paths'],
  ['file_write', 'Create, modify or delete a file', 'paths'],
  ['network', 'Outbound connection or HTTP fetch', 'hosts, ports'],
  ['mcp_call', 'Call a tool on an MCP server', 'mcp_servers, mcp_tools'],
  ['tool_call', 'Any other agent tool', 'tools'],
];

const MODES: Array<[string, string]> = [
  ['monitor', 'Record everything, block nothing. Matches are reported as would_block.'],
  ['learn', 'Monitor, plus record every binary each agent runs. GET /learned turns that into a ready-made allowlist.'],
  ['denylist', 'The kernel blocks exec of listed binaries and opens of listed files.'],
  ['allowlist', 'The kernel blocks exec of anything not listed. An empty allowlist is rejected, because it would block every exec.'],
];

export default function Policies() {
  return (
    <div style={{ width: '100%', overflowX: 'hidden' }}>
      <Nav />
      <PageHero
        eyebrow="Docs · Policies"
        title="A policy is a list of rules with a name on it."
        sub="Each rule matches a kind of action and says allow, deny or require approval. Policies are versioned, scoped to people, teams, agents or machines, and evaluated the same way on the endpoint and in the console."
      />

      <DocSection>
        <H2>An example</H2>
        <p className="doc-p">Force-pushes from the payments team need a lead. Raw HTTP clients are never allowed. Everything else is allowed and recorded.</p>
        <CodeBlock title="policy · Production guardrails">{`{
  "name": "Production guardrails",
  "priority": 10,
  "scope": { "teams": ["payments"] },
  "default": "allow",
  "rules": [
    {
      "id": "force-push",
      "description": "Force-push needs a payments lead",
      "what": { "classes": ["exec"], "commands": ["git push --force*", "git push -f*"] },
      "decision": "require_approval",
      "approval": { "teams": ["payments-leads"], "fallback": "admins", "ttl_seconds": 900 }
    },
    {
      "id": "no-raw-http",
      "what": { "binaries": ["/usr/bin/curl", "/usr/bin/wget", "/usr/bin/nc"] },
      "decision": "deny"
    },
    {
      "id": "secrets",
      "what": { "classes": ["file_read"], "paths": ["**/.env", "**/.aws/credentials", "**/.ssh/id_*"] },
      "decision": "require_approval",
      "approval": { "resource_owner": true, "ttl_seconds": 600 }
    }
  ]
}`}</CodeBlock>
      </DocSection>

      <DocSection>
        <H2>What a rule matches</H2>
        <p className="doc-p">
          Every action an agent attempts is normalised into one shape, whether it came from a hook or from the kernel. A rule&apos;s <code>what</code> picks actions by class and by fields; all non-empty fields must match, and inside a list any entry may match.
        </p>
        <div className="tbl-wrap">
          <table className="doc-tbl">
            <thead><tr><th>Class</th><th>Means</th><th>Fields you match on</th></tr></thead>
            <tbody>
              {CLASSES.map(([c, m, f]) => <tr key={c}><td><code>{c}</code></td><td>{m}</td><td><code>{f}</code></td></tr>)}
            </tbody>
          </table>
        </div>
        <ul className="doc-list" style={{ marginTop: 18 }}>
          <li>Text patterns are exact, or a prefix when they end in <code>*</code>: <code>git push --force*</code>.</li>
          <li>Paths are globs. <code>*</code> stays inside one directory, <code>**</code> spans directories: <code>**/.env</code>.</li>
          <li>Hosts are exact, a subdomain wildcard (<code>*.github.com</code>), or a CIDR (<code>10.0.0.0/8</code>).</li>
          <li><code>who</code> narrows a rule further by agent type, user, team, endpoint or OS user.</li>
          <li><code>valid_until</code> makes a time-limited exception that switches itself off.</li>
        </ul>
      </DocSection>

      <DocSection>
        <H2>Which rule wins</H2>
        <p className="doc-p">Several rules can match one action. The first difference decides:</p>
        <ol className="doc-list">
          <li>The policy with the lower <code>priority</code> number.</li>
          <li>Inside it, the rule with the lower <code>priority</code> number.</li>
          <li>The stricter decision: <code>deny</code> beats <code>require_approval</code> beats <code>allow</code>.</li>
          <li>The smaller rule id, so the result never depends on ordering.</li>
        </ol>
        <p className="doc-p">
          If no rule matches, the strictest <code>default</code> among the policies in scope applies. If no policy is in scope, the action is allowed and the event says <i>no policy applies</i>, so gaps are visible rather than silent. Every decision records the policy id, its version and the rule id.
        </p>
      </DocSection>

      <DocSection>
        <H2>Where each rule is enforced</H2>
        <p className="doc-p">
          One policy is split between two layers on the machine. Rules on binaries and file paths compile into a kernel policy scoped to each agent&apos;s processes. Rules that need the full command line, an MCP tool name or an approval run in the agent&apos;s pre-tool hook. The console shows the compiled result for each policy before you publish it.
        </p>
        <ul className="doc-list">
          <li>Kernel exec rules match the <b>resolved binary path</b>, with symlinks followed. Use absolute paths; on merged-/usr systems <code>/bin/curl</code> is reported as <code>/usr/bin/curl</code>.</li>
          <li>Rules on commands and arguments (<code>git push --force*</code>) run in the agent&apos;s hook, which sees the full command line. Rules on binaries, files and destinations run in the kernel for every process the agent starts.</li>
          <li>When you publish, the console reports how each rule compiles for every machine. See <Link href="/docs/enforcement">Enforcement &amp; coverage</Link>.</li>
        </ul>
      </DocSection>

      <DocSection>
        <H2>Modes</H2>
        <p className="doc-p">The kernel half of a policy runs in one of four modes, set per policy or per agent:</p>
        <div className="tbl-wrap">
          <table className="doc-tbl">
            <thead><tr><th>Mode</th><th>Effect</th></tr></thead>
            <tbody>{MODES.map(([m, d]) => <tr key={m}><td><code>{m}</code></td><td>{d}</td></tr>)}</tbody>
          </table>
        </div>
        <p className="doc-p" style={{ marginTop: 16 }}>
          A sensible order: <code>monitor</code> for a few days, <code>learn</code> on agents you want to lock down, then <code>allowlist</code> seeded from what was learned, with <code>require_approval</code> rules for the rare cases.
        </p>
      </DocSection>

      <DocSection>
        <H2>Simulate before you publish</H2>
        <p className="doc-p">
          The control plane and every endpoint run the same evaluator. Replaying recent events against a draft in the console gives the decisions the endpoints would make, so you can see what a change blocks before anyone hits it.
        </p>
      </DocSection>

      <DocsPager current="/docs/policies" />
      <Footer />
    </div>
  );
}
