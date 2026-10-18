'use client';

import { HELP } from '@/lib/help.tsx';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { AGENT_TYPES } from '@/data.ts';
import { Ic } from '@/icons.tsx';
import { useLive } from '@/live.tsx';
import { useStore } from '@/store.tsx';
import { apiErrorText, type ApiEnrollment } from '@/lib/api.ts';
import { ago, dateTime, type EndpointRow } from '@/lib/live-map.ts';
import type { AgentType } from '@/types.ts';
import { AgentCell, Card, CardHead, CodeBlock, Empty, Loading, PageGuide, PageHead, ReadOnlyNote, Seg, StatusPill } from '@/components/ui.tsx';

/** How each agent is recognised (policy/default.yaml) and which layers enforce it. */
const INTEGRATIONS: { type: AgentType; detect: string; hooks: string | null }[] = [
  { type: 'claude-code', detect: 'binary claude · args @anthropic-ai/claude-code', hooks: 'PreToolUse hook — checks every tool call against policy (macOS, Windows)' },
  { type: 'cursor-agent', detect: 'binary cursor-agent', hooks: null },
  { type: 'codex', detect: 'binary codex · args @openai/codex', hooks: 'PreToolUse hook — checks every tool call against policy (Codex 0.124+, macOS, Windows)' },
  { type: 'gemini-cli', detect: 'binary gemini · args @google/gemini-cli', hooks: 'BeforeTool hook — checks every tool call against policy (Gemini CLI 0.27+, macOS, Windows)' },
  { type: 'aider', detect: 'binary aider', hooks: null },
  { type: 'opencode', detect: 'binary opencode', hooks: null },
  { type: 'goose', detect: 'binary goose', hooks: null },
];

/** Compare effigentd versions like 2.0.10 vs 2.0.3 (non-numeric parts sort as 0). */
function cmpVersion(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[.-]/).map((x) => Number(x) || 0);
  const pb = b.replace(/^v/, '').split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

type Os = 'macos' | 'linux' | 'grokbot' | 'windows' | 'kubernetes' | 'docker';

const DEFAULT_SERVER = 'https://api.effigent.ai';

/** The install + enroll command for an OS. `server` is added only when it isn't the default. */
function installCommand(os: Os, token: string, server: string): string {
  const custom = server !== DEFAULT_SERVER;
  if (os === 'windows') {
    const extra = custom ? ` -Server ${server}` : '';
    return `iwr https://effigent.ai/install.ps1 -OutFile $env:TEMP\\effigent-install.ps1; powershell -ExecutionPolicy Bypass -File $env:TEMP\\effigent-install.ps1 -Token ${token}${extra}`;
  }
  if (os === 'kubernetes') {
    return [
      'helm repo add cilium https://helm.cilium.io && helm repo add effigent https://effigent.ai/charts && helm repo update',
      'helm upgrade --install tetragon cilium/tetragon -n kube-system \\',
      '  --set tetragon.grpc.address=localhost:54321 \\',
      "  --set 'tetragon.processAncestors.enabled=base\\,kprobe\\,lsm'",
      'kubectl create namespace effigent',
      `kubectl -n effigent create secret generic effigent-enrollment --from-literal=token=${token}`,
      `helm install effigent effigent/effigent -n effigent${custom ? ` --set server=${server}` : ''}`,
    ].join('\n');
  }
  if (os === 'docker') {
    return [
      'docker run -d --name tetragon --restart unless-stopped --privileged --pid host --cgroupns host --network host \\',
      '  -v /sys/kernel/btf/vmlinux:/var/lib/tetragon/btf:ro \\',
      '  quay.io/cilium/tetragon:v1.7.1 --server-address=127.0.0.1:54321 --enable-ancestors=base,kprobe,lsm \\',
      '  --event-cache-retries=2 --event-cache-retry-delay=1',
      'docker run -d --name effigentd --restart unless-stopped --privileged --pid host --network host \\',
      `  -e EFFIGENT_ENROLL_TOKEN=${token}${custom ? ` -e EFFIGENT_SERVER=${server}` : ''} \\`,
      '  -v /var/lib/effigent:/var/lib/effigent -v /proc:/host/proc:ro -v /sys/kernel/security:/sys/kernel/security:ro \\',
      '  ghcr.io/effigent/effigentd:latest',
    ].join('\n');
  }
  const extra = custom ? ` --server ${server}` : '';
  return `curl -fsSL https://effigent.ai/install.sh | sudo sh -s -- --token ${token}${extra}`;
}

const OS_NOTES: Record<Os, { run: string; does: string; fleet: string }> = {
  macos: {
    run: 'Run in Terminal on the Mac (asks for an admin password).',
    does: 'Installs the Effigent package, enrolls the Mac, adds the Claude Code, Codex and Gemini CLI hooks to their machine-wide settings and starts the service. Their tool calls are checked against policy before they run.',
    fleet: 'Fleet (Jamf, Kandji, Intune): deploy the Effigent .pkg with a configuration profile for the ai.effigent domain that sets EnrollmentToken to a multi-use token.',
  },
  linux: {
    run: 'Run as a user with sudo. Needs systemd and a kernel with BTF (Ubuntu 22.04+, Debian 12+, RHEL 9+, Amazon Linux 2023). Without systemd (containers, sandboxes) both run as background processes.',
    does: 'Installs Tetragon and effigentd as services and enrolls the machine. Agents are blocked in the kernel (BPF LSM): programs, files and network.',
    fleet: 'Fleet: run the same command from Ansible, cloud-init or your image build with a multi-use token.',
  },
  grokbot: {
    run: 'Paste into Grok Bot (or run it in its terminal). Its computer is a Linux VM without systemd, so Tetragon and effigentd run as background processes; after the computer restarts, run the same command again (the machine stays enrolled). Needs a kernel with BTF.',
    does: 'Installs Tetragon and effigentd and enrolls the computer. Commands the Bot starts through effigentd run --agent grok-bot -- <command> are blocked in the kernel, including every process they start: programs, files and network.',
    fleet: 'All of an account’s Bots share one computer, so it enrolls once and every Bot is covered by the same policy.',
  },
  windows: {
    run: 'Run in PowerShell as Administrator. Windows support is in preview.',
    does: 'Installs effigentd as a service, enrolls the machine and adds the Claude Code, Codex and Gemini CLI hooks. Their tool calls are checked against policy before they run.',
    fleet: 'Fleet (Intune Win32 app): powershell.exe -ExecutionPolicy Bypass -File install.ps1 -Token <multi-use token>.',
  },
  kubernetes: {
    run: 'Run with kubectl and helm pointed at the cluster. Set Machines to at least the number of nodes: each node enrolls once. Nodes need a kernel with BTF and BPF LSM, and privileged pods allowed. Already running Tetragon? Set the same two values on it instead of reinstalling.',
    does: 'Installs Tetragon from its official chart and effigentd as a DaemonSet on every node. Each node shows up here under its node name, and agents in any pod on it are blocked in the kernel: programs, files and network. A restarted pod stays the same machine.',
    fleet: 'GitOps (Argo CD, Flux): chart effigent/effigent from https://effigent.ai/charts; keep the token in your secret store as the effigent-enrollment Secret (key: token).',
  },
  docker: {
    run: 'Run on the Docker host: Linux with a BTF + BPF LSM kernel, no systemd needed. A Compose file with the same settings is in the Kubernetes & containers docs.',
    does: 'Starts Tetragon and effigentd as two privileged containers on the host’s network and process view and enrolls the host. Agents in any container on it, or on the host itself, are blocked in the kernel. The credentials stay in /var/lib/effigent, so a restart keeps the same machine.',
    fleet: 'Fleet: run the same two containers from your provisioning tool with a multi-use token; each host enrolls once.',
  },
};

function guessOs(): Os {
  const ua = navigator.userAgent;
  return /Windows/i.test(ua) ? 'windows' : /Linux|X11/i.test(ua) && !/Android/i.test(ua) ? 'linux' : 'macos';
}

function Enroll() {
  const { api, canWrite, me, refresh } = useLive();
  const [label, setLabel] = useState('');
  const [maxUses, setMaxUses] = useState(1);
  const [ttl, setTtl] = useState(24);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [made, setMade] = useState<ApiEnrollment | null>(null);
  const [os, setOs] = useState<Os>('macos');
  useEffect(() => setOs(guessOs()), []); // after hydration: the server has no navigator

  const create = async () => {
    setBusy(true); setErr(null);
    try {
      setMade(await api.send<ApiEnrollment>('POST', '/enrollment-tokens', { label: label.trim(), ttl_hours: ttl, max_uses: maxUses }));
      setLabel('');
      void refresh(); // the audit trail now has an enrollment_token.create entry
    } catch (e) {
      setErr(apiErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  // The control plane's own URL comes back in its suggested command.
  const server = made?.command.match(/--server\s+(\S+)/)?.[1] ?? DEFAULT_SERVER;
  const note = OS_NOTES[os];

  return (
    <Card>
      <CardHead info={HELP.enroll} title="Enroll an endpoint" sub="Create an enrollment token, then run one command on the machine. It installs effigentd, enrolls the machine into this workspace and starts enforcing your published policy.">
        {me && !canWrite && <ReadOnlyNote what="enroll endpoints" />}
      </CardHead>
      <div style={{ padding: '0 20px 20px' }}>
        <div className="section-label" style={{ margin: '0 0 6px' }}>1 · Create an enrollment token</div>
        {made ? (
          <div className="callout warn" style={{ margin: 0 }}>
            <Ic n="key" size={16} />
            <span>
              Token created. Copy the command now — the token is shown once. Valid for {made.token.max_uses} enrollment{made.token.max_uses === 1 ? '' : 's'} until {dateTime(Date.parse(made.token.expires_at))}.
              {' '}<button className="btn sm" style={{ marginLeft: 6 }} onClick={() => setMade(null)}>Create another</button>
            </span>
          </div>
        ) : (
          <div className="form-row" style={{ padding: 0 }}>
            <div className="field" style={{ flex: '2 1 200px' }}>
              <label htmlFor="enr-label">Label</label>
              <input id="enr-label" className="input" placeholder="e.g. build agents, Jane's laptop" value={label} disabled={!canWrite} onChange={(e) => setLabel(e.target.value)} />
            </div>
            <div className="field" style={{ flex: '0 1 120px' }}>
              <label htmlFor="enr-uses" title="Use more than 1 to enroll a fleet with one token">Machines</label>
              <input id="enr-uses" className="input" type="number" min={1} max={1000} value={maxUses} disabled={!canWrite}
                onChange={(e) => setMaxUses(Math.min(1000, Math.max(1, Number(e.target.value) || 1)))} />
            </div>
            <div className="field" style={{ flex: '0 1 140px' }}>
              <label htmlFor="enr-ttl">Expires after</label>
              <select id="enr-ttl" className="select" value={ttl} disabled={!canWrite} onChange={(e) => setTtl(Number(e.target.value))}>
                <option value={1}>1 hour</option><option value={24}>24 hours</option><option value={168}>7 days</option><option value={720}>30 days</option>
              </select>
            </div>
            <button className="btn primary" onClick={create} disabled={!canWrite || busy}><Ic n="key" /> {busy ? 'Creating…' : 'Create token'}</button>
          </div>
        )}
        {err && <div className="callout bad" style={{ margin: '10px 0 0' }}><Ic n="alert" size={16} /><span>{err}</span></div>}

        <div className="section-label" style={{ margin: '18px 0 6px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span>2 · Run it on the machine</span>
          <Seg value={os} onChange={setOs} options={[{ id: 'macos', label: 'macOS' }, { id: 'linux', label: 'Linux' }, { id: 'grokbot', label: 'Grok Bot' }, { id: 'windows', label: 'Windows' }, { id: 'kubernetes', label: 'Kubernetes (Helm)' }, { id: 'docker', label: 'Docker' }]} />
        </div>
        <div className="muted" style={{ fontSize: 13, margin: '0 0 6px' }}>{note.run}</div>
        {made ? (
          <CodeBlock code={installCommand(os, made.token.token, server)} wrap />
        ) : (
          <div style={{ opacity: 0.55 }} title="Create a token first">
            <CodeBlock code={installCommand(os, '<token>', server)} wrap />
          </div>
        )}
        <div className="muted" style={{ fontSize: 13, margin: '8px 0 0' }}>{note.does}</div>
        <div className="muted" style={{ fontSize: 13, margin: '4px 0 0' }}>{note.fleet}</div>
      </div>
    </Card>
  );
}

export function Enforcement({ initialEndpoint }: { initialEndpoint?: string }) {
  const { endpointRows, consoleEvents, latestPolicy, loaded, now, canWrite, api, refresh } = useLive();
  const { dispatch } = useStore();
  const [sel, setSel] = useState<string | null>(initialEndpoint ?? null);
  const [busy, setBusy] = useState<string | null>(null);

  const eps = endpointRows.filter((e) => !e.revoked);
  const revoked = endpointRows.filter((e) => e.revoked);
  const online = eps.filter((e) => e.status === 'online');
  const kernel = eps.filter((e) => e.platform === 'linux');
  const observe = eps.filter((e) => e.platform !== 'linux');
  const current = eps.filter((e) => latestPolicy > 0 && e.policyVersion === latestPolicy).length;
  const newest = eps.reduce((m, e) => (cmpVersion(e.version, m) > 0 ? e.version : m), '0');
  const n = eps.length || 1;

  // Agents seen per endpoint in the fetched event window, newest first.
  const agentsBy = useMemo(() => {
    const m = new Map<string, Map<string, number>>();
    for (const e of consoleEvents) {
      if (!e.agentType || !e.endpoint) continue;
      const per = m.get(e.endpoint) ?? new Map<string, number>();
      if (!per.has(e.agentType)) per.set(e.agentType, e.at ?? 0);
      m.set(e.endpoint, per);
    }
    return m;
  }, [consoleEvents]);

  const revoke = async (e: EndpointRow) => {
    if (!window.confirm(`Revoke ${e.hostname}? It stops receiving policy and its events are refused. It keeps enforcing the last policy it has until re-enrolled.`)) return;
    setBusy(e.id);
    try {
      await api.send('DELETE', `/endpoints/${encodeURIComponent(e.id)}`);
      dispatch({ t: 'toast', text: `Revoked ${e.hostname}` });
      await refresh();
    } catch (err) {
      window.alert(apiErrorText(err));
    } finally {
      setBusy(null);
    }
  };

  const row = (e: EndpointRow) => {
    const agents = [...(agentsBy.get(e.id) ?? new Map<string, number>())];
    return (
      <Fragment key={e.id}>
        <tr className={`clickable ${sel === e.id ? 'sel' : ''} ${e.revoked ? 'revoked' : ''}`} onClick={() => setSel(sel === e.id ? null : e.id)}>
          <td>
            <span className="agent-cell">
              <span className="res-glyph"><Ic n={e.platform === 'linux' ? 'server' : 'laptop'} size={15} /></span>
              <span><span className="cell-main mono-sm" style={{ color: 'var(--txt)' }}>{e.hostname}</span><span className="cell-sub">{e.os} · {e.arch}</span></span>
            </span>
          </td>
          <td className="muted">{e.platform === 'linux' ? 'Kernel (Tetragon)' : 'Agent hooks'}</td>
          <td className="mono-sm" style={{ color: cmpVersion(e.version, newest) < 0 ? 'var(--gold)' : undefined }}>{e.version || '—'}</td>
          <td className="mono-sm" style={{ color: latestPolicy > 0 && e.policyVersion !== latestPolicy && !e.revoked ? 'var(--gold)' : undefined }}>
            {e.policyVersion > 0 ? `v${e.policyVersion}` : 'default'}
          </td>
          <td className="tnum">{agents.length}</td>
          <td><StatusPill status={e.status} /></td>
          <td className="muted" title={dateTime(e.lastSeenAt)}>{ago(e.lastSeenAt, now)}</td>
          <td className="right" onClick={(ev) => ev.stopPropagation()}>
            {!e.revoked && canWrite && (
              <button className="btn sm danger" disabled={busy === e.id} onClick={() => revoke(e)}><Ic n="ban" size={13} /> {busy === e.id ? 'Revoking…' : 'Revoke'}</button>
            )}
          </td>
        </tr>
        {sel === e.id && (
          <tr>
            <td colSpan={8} style={{ background: 'var(--inset)' }}>
              <div className="muted" style={{ fontSize: 12.5, marginBottom: agents.length ? 8 : 0 }}>
                Enrolled {dateTime(e.enrolledAt)} · id <span className="mono-sm">{e.id}</span>
                {e.revoked && ' · revoked'}
              </div>
              {agents.length === 0 ? <span className="muted">No agent events from this endpoint in the recent window.</span> : (
                <div className="chips">
                  {agents.map(([a, at]) => (
                    <span key={a} className="chip" style={{ cursor: 'default' }}><AgentCell type={a} sub={`last event ${ago(at, now)}`} /></span>
                  ))}
                </div>
              )}
            </td>
          </tr>
        )}
      </Fragment>
    );
  };

  return (
    <div className="page">
      <PageHead info={HELP.machines} title="Machines" sub="Every laptop and server running Effigent: what it can stop, and whether it has your latest policy." />
      <PageGuide id="machines" steps={[<>Create an enrollment token below (one per machine, or multi-use for a fleet)</>, <>Run the one-line install on the machine, or deploy it with your MDM</>, <>It shows up here and starts following your published policy</>]} action={<a className="btn primary sm" href="#enroll"><Ic n="plus" /> Add a machine</a>} />

      <div className="grid-4">
        <Card className="mini-stat"><div className="k">Endpoints online</div><div className="v">{online.length}/{eps.length}</div><div className="s">{eps.length - online.length} need attention</div></Card>
        <Card className="mini-stat"><div className="k">Kernel-enforced</div><div className="v">{kernel.length}</div><div className="s">Linux · Tetragon BPF LSM, pid-scoped</div></Card>
        <Card className="mini-stat"><div className="k">Agent hooks</div><div className="v">{observe.length}</div><div className="s">macOS / Windows · Claude Code checked before each action</div></Card>
        <Card className="mini-stat"><div className="k">On latest policy</div><div className="v">{current}/{eps.length}</div><div className="s">{latestPolicy > 0 ? `Published v${latestPolicy}` : 'Nothing published yet'}</div></Card>
      </div>

      <Card>
        <CardHead info={HELP.coverage} title="Coverage" sub="Share of enrolled endpoints by the strongest layer that can stop an agent action." />
        <div className="coverage">
          <i style={{ width: `${(kernel.filter((e) => e.status === 'online').length / n) * 100}%`, background: 'var(--green)' }} />
          <i style={{ width: `${(observe.filter((e) => e.status === 'online').length / n) * 100}%`, background: 'var(--blue)' }} />
          <i style={{ width: `${((eps.length - online.length) / n) * 100}%`, background: 'var(--red)' }} />
        </div>
        <div className="cov-legend">
          <span><i className="lg-dot" style={{ background: 'var(--green)' }} /> Kernel (exec / file blocked before it happens)</span>
          <span><i className="lg-dot" style={{ background: 'var(--blue)' }} /> Agent hooks (macOS / Windows, Claude Code tool calls)</span>
          <span><i className="lg-dot" style={{ background: 'var(--red)' }} /> Degraded / offline</span>
        </div>
      </Card>

      <Card>
        <CardHead info={HELP.endpoints} title="Endpoints" sub="Online = heartbeat in the last minute (effigentd syncs every 5s). Click a row for the agents it reported." />
        {!loaded ? <Loading /> : endpointRows.length === 0 ? (
          <Empty icon="laptop" title="No endpoints enrolled yet" sub="Create an enrollment token below and run the command on a machine." />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Endpoint</th><th>Enforcement</th><th>effigentd</th><th>Policy</th><th>Agents</th><th>Status</th><th>Last seen</th><th aria-label="Actions" /></tr></thead>
              <tbody>
                {eps.map(row)}
                {revoked.map(row)}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div id="enroll" style={{ scrollMarginTop: 88 }}><Enroll /></div>

      <div className="grid-2">
        <Card>
          <CardHead title="Agent integrations" sub="How effigentd recognises each built-in agent (policy `agents:` can add more)." />
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Agent</th><th>Detection</th><th>Kernel</th><th>Hooks</th></tr></thead>
              <tbody>
                {INTEGRATIONS.map((i) => (
                  <tr key={i.type}>
                    <td><AgentCell type={i.type} sub={AGENT_TYPES[i.type].vendor} /></td>
                    <td className="mono-sm">{i.detect}</td>
                    <td><span className="badge b-green">Exec · file (Linux)</span></td>
                    <td>{i.hooks ? <span className="badge b-blue" title={i.hooks}>{i.hooks.split(' — ')[0]}</span> : <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card>
          <CardHead title="Hybrid deployment" sub="Decisions are made on the endpoint; the control plane distributes signed policy and collects events." />
          <dl className="kv">
            <dt>Enforcement</dt><dd><span className="dot" style={{ marginRight: 8 }} />Local — effigentd on each endpoint</dd>
            <dt>Control plane</dt><dd>Cloud (this console)</dd>
            <dt>Policy delivery</dt><dd>Signed (ed25519), pinned to this workspace at enrollment; versions never go backwards</dd>
            <dt>Offline behaviour</dt><dd>The cached signed policy keeps enforcing; a tampered cache falls back to the built-in default</dd>
          </dl>
        </Card>
      </div>
    </div>
  );
}
