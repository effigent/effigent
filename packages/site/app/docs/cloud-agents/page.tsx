import type { Metadata } from 'next';
import Link from 'next/link';
import { Nav, Footer, PageHero, DocSection, CodeBlock, DocsPager, H2 } from '../../ui';

export const metadata: Metadata = {
  title: 'Cloud agents & containers — Effigent docs',
  description: 'Put Claude Code on the web, the GitHub Copilot coding agent and Cursor background agents under the same policy as your laptops, and give agents in containers and Kubernetes pods the full hook checks.',
};

const VENDORS: Array<[string, string, string, string]> = [
  ['Claude Code on the web', 'Environment variable EFFIGENT_CLOUD_TOKEN', 'Environment setup script', '.claude/settings.json'],
  ['GitHub Copilot coding agent', 'Secret in the repository’s copilot environment', '.github/workflows/copilot-setup-steps.yml', '.github/hooks/effigent.json'],
  ['Cursor background agents', 'Runtime Secret', '.cursor/environment.json install', '.cursor/hooks.json'],
];

export default function CloudAgents() {
  return (
    <div style={{ width: '100%', overflowX: 'hidden' }}>
      <Nav />
      <PageHero
        eyebrow="Docs · Cloud agents & containers"
        title="The same policy, wherever the agent runs."
        sub="Agents that run on a vendor's machines and agents that run in containers get the same checks as an agent on a laptop: deny lists, approvals, and every call in the audit trail."
      />

      <DocSection>
        <H2>Cloud agents</H2>
        <p className="doc-p">
          Claude Code on the web, the GitHub Copilot coding agent and Cursor background agents run in the vendor&apos;s cloud, where you can&apos;t install a daemon. They do run the hooks committed in your repository. Effigent uses that: the hook itself decides each tool call.
        </p>
        <ul className="doc-list">
          <li><b>A cloud environment</b> is created in the console (Machines → Add cloud environment). It is a machine in your workspace, with its own policy, events and approvals, and no enrollment step. You get its <code>efc_</code> token once.</li>
          <li><b>The setup step</b> installs effigentd in the session, checks its checksum, and caches the environment&apos;s signed policy.</li>
          <li><b>The repository&apos;s hook</b> runs <code>.effigent/cloud-hook.sh</code> before every tool call. It decides with the signed policy, waits for approvals the policy asks for, and sends the call&apos;s events to the control plane before it answers.</li>
          <li><b>Fail closed.</b> No policy means deny. In a cloud session without effigentd, the hook blocks.</li>
          <li><b>Laptops unaffected.</b> The script acts only in a cloud session. A developer who clones the repository keeps using their own machine&apos;s effigentd.</li>
        </ul>
      </DocSection>

      <DocSection>
        <H2>Set up a vendor</H2>
        <p className="doc-p">The console builds every snippet below with your token and control plane host. Per vendor:</p>
        <div className="tbl-wrap">
          <table className="doc-tbl">
            <thead><tr><th>Agent</th><th>Token</th><th>Setup step</th><th>Hook config</th></tr></thead>
            <tbody>{VENDORS.map((r) => <tr key={r[0]}><td style={{ fontWeight: 600 }}>{r[0]}</td>{r.slice(1).map((c, i) => <td key={i}>{c.startsWith('.') ? <code>{c}</code> : c}</td>)}</tr>)}</tbody>
          </table>
        </div>
        <CodeBlock title="setup step">{`# with EFFIGENT_CLOUD_TOKEN set from the vendor's secret
curl -fsSL https://effigent.ai/cloud-setup.sh | sh`}</CodeBlock>
        <div style={{ height: 14 }} />
        <CodeBlock title=".claude/settings.json">{`{"hooks": {"PreToolUse": [{"matcher": "*", "hooks": [
  {"type": "command",
   "command": "sh \\"$CLAUDE_PROJECT_DIR/.effigent/cloud-hook.sh\\" claude",
   "timeout": 60}]}]}}`}</CodeBlock>
        <div style={{ height: 14 }} />
        <CodeBlock title=".github/hooks/effigent.json">{`{"version": 1, "hooks": {"preToolUse": [
  {"type": "command", "bash": "sh .effigent/cloud-hook.sh copilot", "timeoutSec": 45}]}}`}</CodeBlock>
        <ul className="doc-list" style={{ marginTop: 14 }}>
          <li>Allow <code>effigent.ai</code> and your control plane host in the vendor&apos;s network settings.</li>
          <li>Add <code>/.effigent/</code>, <code>/.claude/settings.json</code>, <code>/.github/hooks/</code> and <code>/.cursor/hooks.json</code> to <code>file_write_deny</code>, so the agent can&apos;t edit its own hooks.</li>
          <li>The token lets a session fetch its environment&apos;s policy, send its events and ask for approvals. It can&apos;t decide an approval or change a policy. Revoke the environment to stop it, and use one environment per repository.</li>
          <li>Any other agent with Claude Code-style hooks works too: run the setup step, then use <code>effigentd hook claude --remote</code> as its pre-tool hook.</li>
        </ul>
      </DocSection>

      <DocSection>
        <H2>Containers and Kubernetes pods</H2>
        <p className="doc-p">
          On a Docker host or a Kubernetes node, the kernel layer already covers agents in containers. The hook socket adds the hook checks: approvals, command, tool and MCP rules for agents running in pods.
        </p>
        <ul className="doc-list">
          <li><b>One socket per node.</b> effigentd serves its hook API on <code>/var/run/effigent/hook.sock</code>. The Helm chart turns it on by default (<code>hookSocket.enabled</code>), and the Docker compose file mounts the same directory.</li>
          <li><b>Mount it in the agent&apos;s pod</b>, with the effigentd binary in the agent&apos;s image for its hooks. <code>effigentd hook</code> finds the socket by itself.</li>
          <li><b>The kernel says who is calling</b>, not the request: the caller&apos;s uid, its container and its pod, with the user named from the container&apos;s own <code>/etc/passwd</code>. Events and approvals carry that identity.</li>
          <li><b>Files are read inside the container.</b> Scripts, <code>package.json</code> and cloud configs come from the agent&apos;s own file system.</li>
        </ul>
        <CodeBlock title="agent pod">{`volumes:
  - name: effigent
    hostPath: { path: /var/run/effigent, type: Directory }
containers:
  - name: agent
    volumeMounts:
      - { name: effigent, mountPath: /var/run/effigent }`}</CodeBlock>
        <p className="doc-p" style={{ marginTop: 14 }}>
          Installing the chart and Tetragon is covered in <Link href="/docs/kubernetes">Kubernetes &amp; containers</Link>.
        </p>
      </DocSection>

      <DocsPager current="/docs/cloud-agents" />
      <Footer />
    </div>
  );
}
