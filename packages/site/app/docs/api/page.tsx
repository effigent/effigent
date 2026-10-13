import type { Metadata } from 'next';
import Link from 'next/link';
import { Nav, Footer, PageHero, DocSection, CodeBlock, DocsPager, H2 } from '../../ui';
import { API_URL, DASHBOARD_URL } from '../../config';

export const metadata: Metadata = {
  title: 'API — Effigent docs',
  description: 'effigentd’s local REST API on 127.0.0.1:7777, the event stream it sends to the Effigent control plane, and the control-plane API behind the console.',
};

const LOCAL: Array<[string, string, string]> = [
  ['GET', '/health', '{"ok": true, "agents": N}, plus event-stream counters when a backend is configured.'],
  ['GET', '/agents', 'Tracked agents: name, pid, mode and the kernel policies loaded for each.'],
  ['GET', '/learned', 'Every binary each agent has run in learn mode. Seed for exec_allow.'],
  ['GET', '/policy', 'The policy YAML this machine is enforcing.'],
  ['PUT', '/policy', 'Replace the policy (YAML body) and re-apply it to running agents. Needs a token.'],
];

const EVENT_FIELDS: Array<[string, string]> = [
  ['time, node', 'When, and on which machine'],
  ['type', 'agent_start, agent_exit, exec, file_open, connect, blocked, would_block, policy'],
  ['severity', 'info, medium or high'],
  ['agent, agent_pid, mode', 'The agent the event belongs to, its root pid, and the mode it ran in'],
  ['kind, via', 'Whether the process is the agent, an MCP server or a tool, and the nearest MCP server above it (mcp:github)'],
  ['process', 'pid, binary, args, cwd and uid of the process that acted'],
  ['target', 'The exec’d binary, the opened file, or ip:port'],
  ['rule', 'The rule that matched'],
];

export default function ApiDocs() {
  return (
    <div style={{ width: '100%', overflowX: 'hidden' }}>
      <Nav />
      <PageHero
        eyebrow="Docs · API"
        title="Two APIs: one on the machine, one in the control plane."
        sub="effigentd answers on localhost so you can script and debug a single machine. The control plane at your API URL is what the console runs on: endpoints, agents, events, policies, approvals and audit."
      />

      <DocSection>
        <H2>effigentd local API</H2>
        <p className="doc-p">
          Listens on <code>127.0.0.1:7777</code> by default (<code>-listen</code> to change it, <code>-listen &quot;&quot;</code> to turn it off). Responses are JSON except <code>GET /policy</code>, which returns YAML.
        </p>
        <div className="tbl-wrap">
          <table className="doc-tbl">
            <thead><tr><th>Method</th><th>Path</th><th>Returns</th></tr></thead>
            <tbody>{LOCAL.map(([m, p, d]) => <tr key={m + p}><td><code>{m}</code></td><td><code>{p}</code></td><td>{d}</td></tr>)}</tbody>
          </table>
        </div>
        <p className="doc-p" style={{ marginTop: 16 }}>
          <b>Auth.</b> Without <code>EFFIGENT_API_TOKEN</code> the API is read-only and <code>PUT /policy</code> returns 403. The agents it governs run on the same host and can reach localhost, so an open write API would let an agent lift its own policy. With the token set, every request needs <code>Authorization: Bearer &lt;token&gt;</code>.
        </p>
        <CodeBlock title="sh — local API">{`curl -s 127.0.0.1:7777/agents

# seed an allowlist from what an agent actually ran
curl -s 127.0.0.1:7777/learned

# replace the policy (only when effigentd was started with EFFIGENT_API_TOKEN)
curl -s -X PUT 127.0.0.1:7777/policy \\
  -H "Authorization: Bearer $EFFIGENT_API_TOKEN" \\
  --data-binary @policy.yaml
{ "ok": true, "reapplied_to_agents": 2 }`}</CodeBlock>
        <p className="doc-p" style={{ marginTop: 14 }}>
          On enrolled machines the policy comes from the control plane; a local <code>PUT</code> is for machines you run standalone and for testing a policy before publishing it.
        </p>
      </DocSection>

      <DocSection>
        <H2>Event stream</H2>
        <p className="doc-p">
          effigentd batches events and sends them to the control plane over HTTPS. Enrollment configures this; you can also run the daemon by hand and point it anywhere, for example your own collector.
        </p>
        <CodeBlock title="sh — effigentd flags for events">{`# -backend-min-severity: info | medium | high
# -output (stdout):       pretty | json | none
EFFIGENT_BACKEND_TOKEN=<token> effigentd \\
  -backend-url <url> \\
  -backend-min-severity medium \\
  -log-file /var/log/effigentd.jsonl \\
  -output json`}</CodeBlock>
        <div className="tbl-wrap" style={{ marginTop: 16 }}>
          <table className="doc-tbl">
            <thead><tr><th>Field</th><th>Contents</th></tr></thead>
            <tbody>{EVENT_FIELDS.map(([f, d]) => <tr key={f}><td><code>{f}</code></td><td>{d}</td></tr>)}</tbody>
          </table>
        </div>
        <p className="doc-p" style={{ marginTop: 14 }}>
          Every line in <code>-log-file</code> is the same JSON object, so you can ship it to your own SIEM as well as, or instead of, the control plane.
        </p>
      </DocSection>

      <DocSection>
        <H2>Control-plane API</H2>
        <p className="doc-p">
          The console at <a href={DASHBOARD_URL}>{DASHBOARD_URL.replace(/^https?:\/\//, '')}</a> is built on the control-plane API at <code>{API_URL}</code>. It covers the same resources you see in the console:
        </p>
        <ul className="doc-list">
          <li><b>Endpoints</b>: enrolled machines, sensor, effigentd version, policy version, heartbeat.</li>
          <li><b>Agents</b>: running and recent agents per endpoint, with their MCP servers.</li>
          <li><b>Events</b>: the stream above, filterable by agent, user, endpoint and outcome.</li>
          <li><b>Policies</b>: versioned policy documents in the format described in <Link href="/docs/policies">Policies</Link>.</li>
          <li><b>Approvals</b>: open requests and decisions, as in <Link href="/docs/approvals">Approvals</Link>.</li>
          <li><b>Audit</b>: the append-only decision log, exportable.</li>
        </ul>
        <p className="doc-p">
          The API reference and tokens are in the console under Settings. If you need an endpoint that isn&apos;t there yet, tell us what you are trying to automate.
        </p>
      </DocSection>

      <DocsPager current="/docs/api" />
      <Footer />
    </div>
  );
}
