import type { Metadata } from 'next';
import Link from 'next/link';
import { Nav, Footer, PageHero, DocSection, CodeBlock, DocsPager, H2 } from '../../ui';
import { API_URL } from '../../config';

export const metadata: Metadata = {
  title: 'Quickstart — Effigent docs',
  description: 'Install effigentd on a Linux machine with one command, enroll it with your organization, publish a policy and confirm it blocks.',
};

export default function Quickstart() {
  return (
    <div style={{ width: '100%', overflowX: 'hidden' }}>
      <Nav />
      <PageHero
        eyebrow="Docs · Quickstart"
        title="One command per machine."
        sub="Install effigentd, enroll the machine with your organization, publish a policy and watch it take effect. About five minutes for the first machine; the agents themselves don't change."
      />

      <DocSection>
        <H2>Before you start</H2>
        <ul className="doc-list">
          <li><b>Linux with systemd</b>, x86_64 or arm64. Ubuntu 22.04+, Debian 12+, RHEL/Rocky/Alma 9+ and Amazon Linux 2023 all work.</li>
          <li><b>A kernel with BTF</b> (5.8 or newer; every distro above ships one). Check: <code>ls /sys/kernel/btf/vmlinux</code>.</li>
          <li><b>BPF LSM</b> for blocking. Without it effigentd still watches and reports every agent, but can&apos;t refuse anything. Check: <code>cat /sys/kernel/security/lsm</code> must include <code>bpf</code>. Step 4 shows how to turn it on.</li>
          <li><b>Root</b> (<code>sudo</code>) to install.</li>
          <li><b>Outbound HTTPS</b> to <code>{API_URL}</code> (policy and events), <code>effigent.ai</code> and <code>github.com</code> (downloads).</li>
          <li>macOS isn&apos;t supported by the installer yet.</li>
        </ul>
      </DocSection>

      <DocSection>
        <H2 n={1}>Get an enrollment token</H2>
        <p className="doc-p">
          A token is single-use by default and expires after 24 hours. It ties the machine to your organization. An admin creates one per machine, or one with several uses for a batch:
        </p>
        <CodeBlock title="sh — admin">{`curl -s -X POST ${API_URL}/api/v1/enrollment-tokens \\
  -H "Authorization: Bearer $EFFIGENT_ADMIN_TOKEN" -H "X-Effigent-Tenant: org:<your-org>" \\
  -d '{"label":"build-server-3","ttl_hours":24,"max_uses":1}'

{
  "token":   { "token": "eft_5c1e…", "expires_at": "…", "max_uses": 1 },
  "command": "sudo effigentd enroll --server ${API_URL} --token eft_5c1e…"
}`}</CodeBlock>
      </DocSection>

      <DocSection>
        <H2 n={2}>Install and enroll</H2>
        <p className="doc-p">On the machine where your agents run:</p>
        <CodeBlock title="sh — on the machine">{`curl -fsSL https://effigent.ai/install.sh | sudo sh -s -- --token eft_5c1e…`}</CodeBlock>
        <p className="doc-p" style={{ marginTop: 14 }}>The installer:</p>
        <ol className="doc-list">
          <li>checks the kernel (BTF, BPF LSM) and tells you exactly what&apos;s missing;</li>
          <li>installs Tetragon v1.7.1 as the <code>tetragon</code> service, checksum-verified, listening only on a root-owned local socket;</li>
          <li>installs <code>effigentd</code> (checksum-verified) and enrolls the machine with your token;</li>
          <li>starts the <code>effigentd</code> service, which keeps enforcing across restarts and while the control plane is unreachable;</li>
          <li>prints <code>effigentd status</code>.</li>
        </ol>
        <p className="doc-p">
          Running it again is safe: an enrolled machine keeps its enrollment and just gets the new version. Options: <code>--server URL</code> (self-hosted control plane), <code>--version vX.Y.Z</code> (pin a version), <code>--skip-tetragon</code> (you already run Tetragon), <code>--uninstall</code>.
        </p>
      </DocSection>

      <DocSection>
        <H2 n={3}>Check it</H2>
        <CodeBlock title="sh — on the machine">{`$ effigentd status
ok  effigentd v0.1.0 running
ok  Tetragon connected
ok  Blocking available (BPF LSM enabled)
ok  Enrolled as b180e07c-… with ${API_URL} (org:acme)
ok  Policy version 4
    Agents being watched right now: 2`}</CodeBlock>
        <p className="doc-p" style={{ marginTop: 14 }}>
          <code>effigentd status --json</code> gives the same as JSON for your own monitoring. The machine also appears in your organization&apos;s endpoint list with its hostname, OS, last-seen time and the policy version it runs.
        </p>
      </DocSection>

      <DocSection>
        <H2 n={4}>Turn on blocking (only if status says it&apos;s unavailable)</H2>
        <p className="doc-p">Add <code>bpf</code> to the kernel&apos;s LSM list and reboot once. Keep the modules already listed; the installer prints your exact current list.</p>
        <CodeBlock title="Ubuntu / Debian">{`cat /sys/kernel/security/lsm            # e.g. lockdown,capability,landlock,yama,apparmor
sudo sed -i 's/^GRUB_CMDLINE_LINUX="/&lsm=lockdown,capability,landlock,yama,apparmor,bpf /' /etc/default/grub
sudo update-grub && sudo reboot`}</CodeBlock>
        <div style={{ height: 12 }} />
        <CodeBlock title="RHEL / Rocky / Alma / Amazon Linux">{`sudo grubby --update-kernel=ALL --args="lsm=$(cat /sys/kernel/security/lsm),bpf"
sudo reboot`}</CodeBlock>
      </DocSection>

      <DocSection>
        <H2 n={5}>Publish a policy</H2>
        <p className="doc-p">
          Policies are YAML, versioned per organization, signed by the control plane and verified by every machine before it applies them. Machines pick up a new version within about five seconds. Start in <code>monitor</code> mode: nothing is refused, and anything a rule would stop is reported as <code>would_block</code>.
        </p>
        <CodeBlock title="policy.yaml">{`defaults:
  mode: monitor             # monitor | learn | denylist | allowlist
  exec_deny:                # programs agents may not run
    - /usr/bin/curl
    - /usr/bin/wget
    - /usr/bin/nc
  file_deny: [/etc/shadow]  # path suffixes agents may not open
  file_alert: [/.env, /.ssh/id_rsa, /.aws/credentials]
  network_deny:             # destinations agents may not connect to
    - 203.0.113.7
    - 10.0.0.0/8
  network: true             # report every outbound connection

agents:
  - name: claude-code
    binary_names: [claude]
    args_contains: ["@anthropic-ai/claude-code"]
    mode: denylist          # enforce for Claude Code, keep others in monitor`}</CodeBlock>
        <div style={{ height: 12 }} />
        <CodeBlock title="sh — admin">{`python3 -c 'import json,sys; print(json.dumps({"body": open("policy.yaml").read(), "comment": "first policy"}))' |
  curl -s -X PUT ${API_URL}/api/v1/policy \\
    -H "Authorization: Bearer $EFFIGENT_ADMIN_TOKEN" -H "X-Effigent-Tenant: org:<your-org>" --data-binary @-

{ "version": 1 }`}</CodeBlock>
        <p className="doc-p" style={{ marginTop: 14 }}>
          An invalid policy (unknown mode, relative path, bad IP or CIDR) is rejected before any machine sees it. <code>GET /api/v1/policy/history</code> lists every version with its author and comment. The full format is in <Link href="/docs/policies">Policies</Link>.
        </p>
      </DocSection>

      <DocSection>
        <H2 n={6}>See it work</H2>
        <p className="doc-p">With the policy above, ask Claude Code to fetch something with curl:</p>
        <CodeBlock title="what the agent gets">{`/bin/bash: line 1: /usr/bin/curl: Operation not permitted     (exit 126)`}</CodeBlock>
        <div style={{ height: 12 }} />
        <CodeBlock title="sh — admin: recent blocks">{`curl -s "${API_URL}/api/v1/events?type=blocked&limit=5" \\
  -H "Authorization: Bearer $EFFIGENT_ADMIN_TOKEN" -H "X-Effigent-Tenant: org:<your-org>"

[{ "time": "…", "type": "blocked", "agent": "claude-code", "severity": "high",
   "body": { "target": "exec /usr/bin/curl", "process": { "binary": "/bin/bash" } } }]`}</CodeBlock>
        <p className="doc-p" style={{ marginTop: 14 }}>
          The same curl typed by a person, outside any agent, still works: rules apply only to an agent and the processes it starts.
        </p>
      </DocSection>

      <DocSection>
        <H2 n={7}>Close the startup gap (optional)</H2>
        <p className="doc-p">
          When effigentd spots an agent starting on its own, loading that agent&apos;s rules into the kernel takes under a second. To enforce from the agent&apos;s very first instruction, start it through effigentd. It waits until the kernel confirms the rules are live, then becomes the agent:
        </p>
        <CodeBlock title="sh — developer">{`effigentd run --agent claude-code -- claude
effigentd run --agent claude-code --strict -- claude   # refuse to start if enforcement can't be confirmed`}</CodeBlock>
      </DocSection>

      <DocSection>
        <H2>Troubleshooting</H2>
        <CodeBlock title="sh — on the machine">{`effigentd status                       # what's up and what isn't
journalctl -u effigentd -n 50          # daemon log (policy applied, sync errors)
journalctl -u tetragon -n 50           # kernel sensor log
tail -f /var/log/effigent/events.jsonl # every event, as JSON lines
ls /var/lib/effigent                   # endpoint.json (enrollment), policy.json (last signed policy)`}</CodeBlock>
        <ul className="doc-list" style={{ marginTop: 14 }}>
          <li><b>&quot;enrollment token is invalid, expired or used up&quot;</b>: create a new token. Each one works once unless you set <code>max_uses</code>.</li>
          <li><b>Status shows &quot;Blocking unavailable&quot;</b>: see step 4. Events still flow meanwhile.</li>
          <li><b>Policy version stays at 0</b>: no policy published yet for your organization, or the machine can&apos;t reach <code>{API_URL}</code>. It keeps enforcing its last signed policy while offline.</li>
          <li><b>Remove a machine</b>: <code>curl -fsSL https://effigent.ai/install.sh | sudo sh -s -- --uninstall</code>, then revoke it with <code>DELETE /api/v1/endpoints/&lt;id&gt;</code> and delete <code>/var/lib/effigent</code>.</li>
        </ul>
      </DocSection>

      <DocsPager current="/docs/quickstart" />
      <Footer />
    </div>
  );
}
