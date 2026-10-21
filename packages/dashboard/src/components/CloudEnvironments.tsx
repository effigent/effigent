'use client';

import { useState } from 'react';
import { Ic } from '@/icons.tsx';
import { useLive } from '@/live.tsx';
import { apiErrorText, type ApiCloudEnvironment } from '@/lib/api.ts';
import { Card, CardHead, CodeBlock, ReadOnlyNote, Seg } from '@/components/ui.tsx';

/** Cloud environments (docs/cloud-agents.md): agents that run in a vendor's cloud get no
 *  effigentd of their own. The repository's hook config runs `effigentd hook <agent> --remote`,
 *  which decides each tool call with this workspace's signed policy, files approvals and
 *  sends events, using one token per environment. */

export type CloudVendor = 'claude-code-web' | 'copilot' | 'cursor' | 'other';

export const CLOUD_VENDORS: Record<CloudVendor, string> = {
  'claude-code-web': 'Claude Code on the web',
  copilot: 'GitHub Copilot cloud agent',
  cursor: 'Cursor cloud agents',
  other: 'Other (Claude Code-style hooks)',
};

const SETUP = 'curl -fsSL https://effigent.ai/cloud-setup.sh | sh';

/** deploy/cloud/cloud-hook.sh: keep the two in step. */
const CLOUD_HOOK = `#!/bin/sh
# Effigent: checks every tool call of a cloud agent session against your
# workspace's policy. Outside a cloud session it does nothing; in one without
# effigentd (the setup step didn't run) it blocks (exit 2).
agent="$1"
cloud=
case "$agent" in
  claude) [ "\${CLAUDE_CODE_REMOTE:-}" = true ] && cloud=1 ;;  # Claude Code on the web
  copilot) [ -n "\${GITHUB_COPILOT_API_TOKEN:-}" ] || [ "\${GITHUB_ACTIONS:-}" = true ] && cloud=1 ;;  # Copilot cloud agent
esac
[ -n "\${EFFIGENT_CLOUD_TOKEN:-}" ] && cloud=1                 # the token (Cursor: the Runtime Secret)
# The setup step ran here (effigentd cloud-setup), if the state is root's or this user's:
f="\${EFFIGENT_STATE_DIR:-/var/tmp/effigent-cloud}/endpoint.json"
if [ -r "$f" ] && { [ -O "$f" ] || [ -n "$(find "$f" -prune -user 0 2>/dev/null)" ]; }; then cloud=1; fi
[ -n "$cloud" ] || exit 0
if command -v effigentd >/dev/null 2>&1; then
  exec effigentd hook "$agent" --remote
fi
echo "Blocked by Effigent: effigentd is not installed in this cloud environment (add the Effigent setup step)." >&2
exit 2
`;

const json = (v: unknown) => JSON.stringify(v, null, 2);

interface Step { title: string; text?: string; code?: string; file?: string }

/** What to set up for one vendor. `token` is the real token or a placeholder; `host` the control plane's. */
export function cloudSteps(vendor: CloudVendor, token: string, host: string): Step[] {
  const hosts = `effigent.ai and ${host}`;
  const hookFile: Step = { title: 'Commit the hook script', file: '.effigent/cloud-hook.sh', code: CLOUD_HOOK };
  switch (vendor) {
    case 'claude-code-web':
      return [
        { title: 'Environment (claude.ai/code → the environment → Edit)', text: `Environment variables, then the setup script. Network access: Custom, and allow ${hosts}.`,
          code: `EFFIGENT_CLOUD_TOKEN=${token}` },
        { title: 'Setup script', code: SETUP },
        hookFile,
        { title: 'Commit the hook config', file: '.claude/settings.json', code: json({ hooks: { PreToolUse: [{ matcher: '*', hooks: [
          { type: 'command', command: 'sh "$CLAUDE_PROJECT_DIR/.effigent/cloud-hook.sh" claude', timeout: 60 }] }] } }) },
      ];
    case 'copilot':
      return [
        { title: 'Secret', text: 'Repository Settings → Environments → copilot → Environment secrets: add EFFIGENT_CLOUD_TOKEN.', code: token },
        { title: 'Setup steps', file: '.github/workflows/copilot-setup-steps.yml', code: [
          'name: Copilot Setup Steps', 'on: workflow_dispatch', 'jobs:', '  copilot-setup-steps:', '    runs-on: ubuntu-latest',
          '    permissions:', '      contents: read', '    steps:', '      - name: Effigent', `        run: ${SETUP}`,
          '        env:', '          EFFIGENT_CLOUD_TOKEN: ${{ secrets.EFFIGENT_CLOUD_TOKEN }}'].join('\n') },
        hookFile,
        { title: 'Commit the hook config (default branch)', file: '.github/hooks/effigent.json', code: json({ version: 1, hooks: { preToolUse: [
          { type: 'command', bash: 'sh .effigent/cloud-hook.sh copilot', timeoutSec: 45 }] } }) },
        { title: 'Firewall', text: `Settings → Copilot → Cloud agent → Firewall: add ${hosts} to the custom allowlist.` },
      ];
    case 'cursor': {
      const h = { command: 'sh .effigent/cloud-hook.sh cursor', timeout: 60, failClosed: true };
      return [
        { title: 'Secret', text: 'Cursor dashboard → Cloud Agents → Secrets: add EFFIGENT_CLOUD_TOKEN.', code: token },
        { title: 'Environment', file: '.cursor/environment.json', text: 'Add the install step (keep yours after it).', code: json({ install: SETUP }) },
        hookFile,
        { title: 'Commit the hook config', file: '.cursor/hooks.json', code: json({ version: 1, hooks: {
          beforeShellExecution: [h], beforeMCPExecution: [h], beforeReadFile: [h], preToolUse: [h] } }) },
        { title: 'Network', text: `If the environment's network is restricted, allow ${hosts}.` },
      ];
    }
    default:
      return [
        { title: 'Setup step (runs once per environment)', code: `export EFFIGENT_CLOUD_TOKEN=${token}\n${SETUP}` },
        { title: 'Pre-tool hook command', text: 'Claude Code-compatible PreToolUse JSON on stdin; a deny is printed as Claude Code reads it.',
          code: 'effigentd hook claude --remote' },
      ];
  }
}

export function CloudEnvironments() {
  const { api, canWrite, me, refresh } = useLive();
  const [name, setName] = useState('');
  const [vendor, setVendor] = useState<CloudVendor>('claude-code-web');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [made, setMade] = useState<ApiCloudEnvironment | null>(null);

  const create = async () => {
    setBusy(true); setErr(null);
    try {
      setMade(await api.send<ApiCloudEnvironment>('POST', '/cloud-environments', { name: name.trim(), vendor }));
      setName('');
      void refresh();
    } catch (e) {
      setErr(apiErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  let host = 'api.effigent.ai';
  try { if (made) host = new URL(made.server).host; } catch { /* keep the default */ }
  const shown = (made?.endpoint.vendor as CloudVendor | undefined) ?? vendor;
  const steps = cloudSteps(shown, made?.token ?? '<token>', host);

  return (
    <Card>
      <CardHead title="Add a cloud environment" sub="Agents that run in a vendor's cloud (Claude Code on the web, GitHub Copilot's cloud agent, Cursor cloud agents) have no machine to enroll. The repository's hooks check each of their tool calls against your published policy with one token per environment; approvals and events work as on a machine.">
        {me && !canWrite && <ReadOnlyNote what="add cloud environments" />}
      </CardHead>
      <div style={{ padding: '0 20px 20px' }}>
        <div className="section-label" style={{ margin: '0 0 6px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span>1 · Vendor and name</span>
          {!made && <Seg value={vendor} onChange={setVendor} options={(Object.keys(CLOUD_VENDORS) as CloudVendor[]).map((id) => ({ id, label: CLOUD_VENDORS[id] }))} />}
        </div>
        {made ? (
          <div className="callout warn" style={{ margin: 0 }}>
            <Ic n="key" size={16} />
            <span>
              {made.endpoint.hostname} ({CLOUD_VENDORS[shown]}) created. Copy the token now — it is shown once. Revoke the environment below to stop its token.
              {' '}<button className="btn sm" style={{ marginLeft: 6 }} onClick={() => setMade(null)}>Add another</button>
            </span>
          </div>
        ) : (
          <div className="form-row" style={{ padding: 0 }}>
            <div className="field" style={{ flex: '2 1 220px' }}>
              <label htmlFor="cloud-name">Name</label>
              <input id="cloud-name" className="input" placeholder="e.g. the repository: acme/web" value={name} maxLength={100} disabled={!canWrite} onChange={(e) => setName(e.target.value)} />
            </div>
            <button className="btn primary" onClick={create} disabled={!canWrite || busy || !name.trim()}><Ic n="cloud" /> {busy ? 'Creating…' : 'Create token'}</button>
          </div>
        )}
        {err && <div className="callout bad" style={{ margin: '10px 0 0' }}><Ic n="alert" size={16} /><span>{err}</span></div>}

        <div className="section-label" style={{ margin: '18px 0 6px' }}>2 · Set up {CLOUD_VENDORS[shown]}</div>
        <div style={{ display: 'grid', gap: 12, opacity: made ? 1 : 0.55 }} title={made ? undefined : 'Create a token first'}>
          {steps.map((s, i) => (
            <div key={i}>
              <div style={{ fontSize: 13, fontWeight: 600, margin: '0 0 4px' }}>{s.title}{s.file && <span className="mono-sm muted" style={{ fontWeight: 400, marginLeft: 8 }}>{s.file}</span>}</div>
              {s.text && <div className="muted" style={{ fontSize: 13, margin: '0 0 6px' }}>{s.text}</div>}
              {s.code && <CodeBlock code={s.code} wrap />}
            </div>
          ))}
        </div>
        <div className="muted" style={{ fontSize: 13, margin: '12px 0 0' }}>
          No kernel layer: only what the agent&apos;s hooks see is checked, and the agent can read the token and edit the repository&apos;s hook files.
          Add <span className="mono-sm">/.effigent/</span>, <span className="mono-sm">/.claude/settings.json</span>, <span className="mono-sm">/.github/hooks/</span> and <span className="mono-sm">/.cursor/hooks.json</span> to
          {' '}<span className="mono-sm">file_write_deny</span> in your policy. If the control plane can&apos;t be reached and nothing is cached, calls are denied.
        </div>
      </div>
    </Card>
  );
}
