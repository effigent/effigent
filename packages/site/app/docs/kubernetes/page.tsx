import type { Metadata } from 'next';
import Link from 'next/link';
import { Nav, Footer, PageHero, DocSection, CodeBlock, DocsPager, H2 } from '../../ui';

export const metadata: Metadata = {
  title: 'Kubernetes & containers — Effigent docs',
  description: 'Run effigentd on Kubernetes nodes with Helm or on plain Docker hosts next to Tetragon: requirements, install, agent hooks and approvals inside pods, upgrade, uninstall and operations.',
};

const VALUES: Array<[string, string, string]> = [
  ['server', 'https://api.effigent.ai', 'Control plane the nodes enroll with.'],
  ['enrollment.existingSecret', 'effigent-enrollment', 'Secret holding the enrollment token (key enrollment.secretKey, default token).'],
  ['enrollment.token', '""', 'Or let the chart create the Secret. The token then sits in the release values.'],
  ['stateHostPath', '/var/lib/effigent', 'Credentials and the cached signed policy on each node. Keep it: a restarted pod stays the same machine.'],
  ['tetragon.address', '127.0.0.1:54321', 'Tetragon’s gRPC address on the node.'],
  ['listen', '127.0.0.1:7777', 'effigentd’s local API on the node’s loopback; "" turns it off.'],
  ['hookSocket.enabled', 'true', 'Serves the agent hook API on a unix socket, so agents in pods get hook checks and approvals.'],
  ['hookSocket.hostPath', '/var/run/effigent', 'Node directory holding hook.sock; agent pods mount it.'],
  ['resources', '50m / 64Mi, limit 256Mi', 'Requests and limits for the effigentd container.'],
  ['nodeSelector', 'kubernetes.io/os: linux', 'Which nodes run effigentd.'],
  ['tolerations', 'operator: Exists', 'Runs on every node, tainted ones included.'],
  ['image.repository / image.tag', 'ghcr.io/effigent/effigentd / chart appVersion', 'amd64 and arm64.'],
];

export default function Kubernetes() {
  return (
    <div style={{ width: '100%', overflowX: 'hidden' }}>
      <Nav />
      <PageHero
        eyebrow="Docs · Kubernetes & containers"
        title="Agents in pods and containers, governed per node."
        sub="effigentd runs once per node, next to Tetragon, and governs agents in every pod or container on it. Kubernetes gets a Helm chart; a plain Docker host gets two containers. No systemd needed."
      />

      <DocSection>
        <H2>Whatever model drives the agent</H2>
        <p className="doc-p">
          effigentd governs what an agent does on the machine: the programs it runs, the files it opens, the addresses it connects to. It doesn&apos;t matter which model drives the agent (Claude, GPT, Gemini, Grok, or anything else called over an API), or whether the agent is a known CLI or your own code. What matters is that it runs on a machine you control: a laptop, a server, a container host or a Kubernetes node. Agents that run in a provider&apos;s cloud, such as Claude Code on the web or the GitHub Copilot coding agent, are covered through a <Link href="/docs/cloud-agents">cloud environment</Link>.
        </p>
      </DocSection>

      <DocSection>
        <H2>Requirements</H2>
        <ul className="doc-list">
          <li><b>Linux nodes with BTF and BPF LSM.</b> Check on a node: <code>ls /sys/kernel/btf/vmlinux</code> and <code>cat /sys/kernel/security/lsm</code>, which must include <code>bpf</code>. Without BPF LSM effigentd still sees and reports every agent, but can&apos;t block. Many managed node images leave it off; turning it on is a kernel boot parameter (<code>lsm=…,bpf</code>) in the node image.</li>
          <li><b>Privileged pods.</b> Tetragon and effigentd use the node&apos;s process view and network (<code>hostPID</code>, <code>hostNetwork</code>, <code>privileged</code>). With Pod Security Admission, label their namespaces <code>pod-security.kubernetes.io/enforce=privileged</code>.</li>
          <li><b>Kubernetes 1.23+</b> and Helm 3, or Docker 20.10+ on a plain host. amd64 or arm64.</li>
          <li><b>Outbound HTTPS</b> to <code>api.effigent.ai</code> (policy and events) and image pulls from <code>ghcr.io</code> and <code>quay.io</code>.</li>
          <li><b>An enrollment token</b> from the console (Machines → Enroll) whose Machines count covers every node, including nodes the autoscaler will add before the token expires.</li>
        </ul>
      </DocSection>

      <DocSection>
        <H2 n={1}>Tetragon</H2>
        <p className="doc-p">
          Install Tetragon from its official chart with two settings effigentd needs: gRPC on the node&apos;s loopback, and process ancestors, which is how every event is attributed to the agent that caused it. Already running Tetragon? Add the same two values to it.
        </p>
        <CodeBlock title="sh">{`helm repo add cilium https://helm.cilium.io
helm repo add effigent https://effigent.ai/charts
helm repo update

helm upgrade --install tetragon cilium/tetragon -n kube-system \\
  --set tetragon.grpc.address=localhost:54321 \\
  --set 'tetragon.processAncestors.enabled=base\\,kprobe\\,lsm'`}</CodeBlock>
        <p className="doc-p" style={{ marginTop: 14 }}>
          In Kubernetes, Tetragon fills in pod details itself, so leave its event cache settings at their defaults.
        </p>
      </DocSection>

      <DocSection>
        <H2 n={2}>effigentd</H2>
        <p className="doc-p">Put the token in a Secret and install the chart. It runs a DaemonSet: one effigentd per node.</p>
        <CodeBlock title="sh">{`kubectl create namespace effigent
kubectl -n effigent create secret generic effigent-enrollment --from-literal=token=eft_…
helm install effigent effigent/effigent -n effigent`}</CodeBlock>
        <p className="doc-p" style={{ marginTop: 14 }}>On its first start each pod:</p>
        <ol className="doc-list">
          <li>enrolls the node under the node&apos;s name (not the pod&apos;s) and saves its credentials in <code>/var/lib/effigent</code> on the node;</li>
          <li>connects to Tetragon on <code>127.0.0.1:54321</code> and scans the node&apos;s <code>/proc</code> for agents that are already running;</li>
          <li>applies your published policy and keeps enforcing it, offline included.</li>
        </ol>
        <p className="doc-p">
          After that the saved credentials win: a restarted, rescheduled or upgraded pod comes back as the same machine and doesn&apos;t use the token again.
        </p>
        <div className="tbl-wrap" style={{ marginTop: 18 }}>
          <table className="doc-tbl">
            <thead><tr><th>Value</th><th>Default</th><th>What it does</th></tr></thead>
            <tbody>
              {VALUES.map(([k, d, w]) => (
                <tr key={k}><td><code>{k}</code></td><td><code>{d}</code></td><td>{w}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </DocSection>

      <DocSection>
        <H2 n={3}>Check it</H2>
        <CodeBlock title="sh">{`kubectl -n effigent get pods -o wide        # one effigentd per node, Running
kubectl -n effigent logs ds/effigent | grep -E 'enrolled|Tetragon|policy'
# effigentd: enrolled node-a as endpoint 9922538e-… (tenant org:…)
# effigentd: connected to Tetragon at 127.0.0.1:54321
# effigentd: applied policy v7 from the control plane`}</CodeBlock>
        <p className="doc-p" style={{ marginTop: 14 }}>
          Each node shows up under Machines in the console with its node name. Agents in any pod on it appear under Agents, and blocked actions under Events. A pod that logs <code>enroll: … 401</code> has a token that expired or has no machines left: put a new one in the Secret and delete the pod.
        </p>
      </DocSection>

      <DocSection>
        <H2 n={4}>No unenforced first second</H2>
        <p className="doc-p">
          effigentd loads an agent&apos;s kernel policy one to two seconds after the agent starts. For an agent that acts at once, start it through <code>effigentd run</code> inside its own container: it waits until the kernel proves the policy is live, then execs the agent under the same pid. It needs no network access to effigentd. Copy the binary into the agent&apos;s image:
        </p>
        <CodeBlock title="Dockerfile — your agent image">{`COPY --from=ghcr.io/effigent/effigentd:latest /usr/local/bin/effigentd /usr/local/bin/effigentd
ENTRYPOINT ["effigentd", "run", "--agent", "claude-code", "--strict", "--"]
CMD ["claude", "-p", "fix the failing test"]`}</CodeBlock>
      </DocSection>

      <DocSection id="hooks">
        <H2>Hooks and approvals inside pods</H2>
        <p className="doc-p">
          The kernel layer covers every pod on its own. To also get command-level rules, MCP and tool rules, and approvals for agents in pods, point their hooks at the node&apos;s effigentd. The chart serves the hook API on a unix socket, <code>/var/run/effigent/hook.sock</code>, on every node. It is on by default (<code>hookSocket.enabled</code>). An agent pod mounts the directory, and its image runs <code>effigentd hook claude|codex|gemini|cursor</code> as the agent&apos;s hook:
        </p>
        <CodeBlock title="agent pod spec">{`spec:
  containers:
    - name: agent
      env:
        - name: EFFIGENT_HOOK_SOCKET
          value: /var/run/effigent/hook.sock
      volumeMounts:
        - name: effigent-hooks
          mountPath: /var/run/effigent
  volumes:
    - name: effigent-hooks
      hostPath:
        path: /var/run/effigent
        type: Directory`}</CodeBlock>
        <ul className="doc-list" style={{ marginTop: 14 }}>
          <li><b>Identified by the kernel.</b> effigentd works out who is calling from the socket itself: process, user, container and pod. It never relies on what the request says. Events and approval requests name the pod and container.</li>
          <li><b>Read inside the container.</b> Files a rule needs to read, like a script the agent runs or its MCP config, are read from the container&apos;s own file system.</li>
          <li><b>The same policy.</b> Deny lists, approval lists, actions and MCP rules work as on a laptop, and the agent waits in its pod while the approver decides.</li>
          <li><b>Pod Security.</b> A hostPath volume needs a namespace at the <code>privileged</code> Pod Security level, or an admission policy that allows this one path.</li>
        </ul>
        <p className="doc-p">
          On a Docker host, add <code>-v /var/run/effigent:/var/run/effigent</code> and <code>-hook-socket /var/run/effigent/hook.sock</code> to effigentd. Then run agent containers with the same volume and <code>-e EFFIGENT_HOOK_SOCKET=/var/run/effigent/hook.sock</code>.
        </p>
      </DocSection>

      <DocSection id="docker">
        <H2>Docker hosts without Kubernetes</H2>
        <p className="doc-p">
          Two privileged containers on the host&apos;s network and process view. Agents in any container on the host, or on the host itself, are covered.
        </p>
        <CodeBlock title="sh — on the Docker host">{`docker run -d --name tetragon --restart unless-stopped --privileged --pid host --cgroupns host --network host \\
  -v /sys/kernel/btf/vmlinux:/var/lib/tetragon/btf:ro \\
  quay.io/cilium/tetragon:v1.7.1 --server-address=127.0.0.1:54321 --enable-ancestors=base,kprobe,lsm \\
  --event-cache-retries=2 --event-cache-retry-delay=1

docker run -d --name effigentd --restart unless-stopped --privileged --pid host --network host \\
  -e EFFIGENT_ENROLL_TOKEN=eft_… \\
  -v /var/lib/effigent:/var/lib/effigent -v /proc:/host/proc:ro -v /sys/kernel/security:/sys/kernel/security:ro \\
  -v /var/run/effigent:/var/run/effigent \\
  ghcr.io/effigent/effigentd:latest \\
  -state-dir /var/lib/effigent -procfs /host/proc -output json -hook-socket /var/run/effigent/hook.sock`}</CodeBlock>
        <p className="doc-p" style={{ marginTop: 14 }}>The same as a Compose file:</p>
        <CodeBlock title="compose.yaml">{`services:
  tetragon:
    image: quay.io/cilium/tetragon:v1.7.1
    restart: unless-stopped
    privileged: true
    pid: host
    cgroup: host
    network_mode: host
    command:
      - --server-address=127.0.0.1:54321
      - --enable-ancestors=base,kprobe,lsm
      - --event-cache-retries=2
      - --event-cache-retry-delay=1
    volumes:
      - /sys/kernel/btf/vmlinux:/var/lib/tetragon/btf:ro

  effigentd:
    image: ghcr.io/effigent/effigentd:latest
    restart: unless-stopped
    privileged: true
    pid: host
    network_mode: host
    depends_on: [tetragon]
    command: [-state-dir, /var/lib/effigent, -procfs, /host/proc, -output, json, -hook-socket, /var/run/effigent/hook.sock]
    environment:
      EFFIGENT_ENROLL_TOKEN: \${EFFIGENT_ENROLL_TOKEN:-}   # put it in .env next to this file
    volumes:
      - /var/lib/effigent:/var/lib/effigent
      - /proc:/host/proc:ro
      - /sys/kernel/security:/sys/kernel/security:ro
      - /var/run/effigent:/var/run/effigent          # hook socket for agent containers`}</CodeBlock>
        <ul className="doc-list" style={{ marginTop: 14 }}>
          <li><b>The event cache flags matter here.</b> Outside Kubernetes nothing fills in pod details, and Tetragon by default holds every event from a container about 30 seconds (15 retries × 2 s) waiting for them. With <code>--event-cache-retries=2 --event-cache-retry-delay=1</code> events arrive in about two seconds, and <code>effigentd run</code> confirms enforcement in about one.</li>
          <li><b>The token is used once.</b> The credentials stay in <code>/var/lib/effigent</code> on the host; later starts reuse them and ignore the token.</li>
          <li>The machine is named after the host. Set <code>EFFIGENT_HOSTNAME</code> to name it yourself.</li>
          <li><code>EFFIGENT_SERVER</code> points at a control plane other than <code>https://api.effigent.ai</code>.</li>
        </ul>
      </DocSection>

      <DocSection>
        <H2>Upgrade</H2>
        <CodeBlock title="sh">{`# Kubernetes
helm repo update
helm upgrade effigent effigent/effigent -n effigent --reuse-values

# Docker
docker pull ghcr.io/effigent/effigentd:latest
docker rm -f effigentd && docker run -d --name effigentd …   # same command as above`}</CodeBlock>
        <p className="doc-p" style={{ marginTop: 14 }}>
          Each node keeps its machine and its last signed policy. While a node&apos;s effigentd restarts, its agents&apos; kernel policies are removed and reloaded within seconds; pass <code>--set extraArgs={'{'}-keep-policies-on-exit{'}'}</code> to keep them loaded across the restart instead (fail-closed).
        </p>
      </DocSection>

      <DocSection>
        <H2>Uninstall</H2>
        <CodeBlock title="sh">{`# Kubernetes
helm uninstall effigent -n effigent
kubectl delete namespace effigent
helm uninstall tetragon -n kube-system         # if nothing else uses it

# Docker
docker rm -f effigentd tetragon`}</CodeBlock>
        <p className="doc-p" style={{ marginTop: 14 }}>
          effigentd removes the kernel policies it loaded when it stops. Revoke the machines in the console (Machines → Revoke), and delete <code>/var/lib/effigent</code> on each node or host if it should enroll as a new machine later.
        </p>
      </DocSection>

      <DocSection>
        <H2>Operating notes</H2>
        <ul className="doc-list">
          <li><b>Kernel enforcement for every pod.</b> Agents in containers are governed by the node&apos;s kernel layer: programs, files and network, for the agent and every process it starts. Pods that mount the hook socket also get hook checks and approvals (<a href="#hooks">above</a>). See <Link href="/docs/enforcement">Enforcement &amp; coverage</Link>.</li>
          <li><b>One machine per node, one policy per machine.</b> Every agent on a node follows that node&apos;s policy, whichever pod or namespace it runs in. Agent detection and per-agent rules work as on any Linux machine.</li>
          <li><b>Paths are the container&apos;s.</b> <code>exec_deny</code> and <code>file_deny</code> match the path inside the agent&apos;s container (<code>/usr/bin/curl</code> in its image), not on the node.</li>
          <li><b>New nodes need a valid token.</b> An autoscaled node enrolls with the token in the Secret. When it expires (30 days at most) or runs out of machines, new nodes can&apos;t enroll: put a fresh token in the Secret. Replaced nodes stay in the console as stale machines until you revoke them.</li>
          <li><b>One Tetragon per kernel.</b> Don&apos;t run the Docker containers on a Kubernetes node that already has the chart.</li>
          <li><b>MicroVMs and gVisor.</b> Agents in microVMs (Firecracker, Kata) or gVisor run on their own kernel: run effigentd inside that VM.</li>
          <li><b>Laptops.</b> Docker Desktop is a quick way to try the containers. To govern the laptop itself, use the macOS or Windows install.</li>
        </ul>
      </DocSection>

      <DocsPager current="/docs/kubernetes" />
      <Footer />
    </div>
  );
}
