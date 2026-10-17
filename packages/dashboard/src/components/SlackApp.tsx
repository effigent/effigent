'use client';

import { useState } from 'react';
import { Ic } from '@/icons.tsx';
import { useLive } from '@/live.tsx';
import { apiErrorText, type ApiNotifications } from '@/lib/api.ts';

const SCOPES = ['chat:write', 'chat:write.public', 'users:read', 'users:read.email'];

/** The Slack app manifest for this workspace's Effigent app. */
function manifest(interactionsUrl: string) {
  return {
    display_information: { name: 'Effigent', description: 'Approve or deny AI agent actions paused by Effigent', background_color: '#0f1530' },
    features: { bot_user: { display_name: 'Effigent', always_online: true } },
    oauth_config: { scopes: { bot: SCOPES } },
    settings: { interactivity: { is_enabled: true, request_url: interactionsUrl }, org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
  };
}

/** Connect the workspace's own Slack app: requests arrive with Approve / Deny
 *  buttons, and every click is recorded with the person's Slack identity and
 *  email (the server checks they may approve). */
export function SlackApp({ n, onChange }: { n: ApiNotifications; onChange: (v: ApiNotifications) => void }) {
  const { api, canWrite } = useLive();
  const app = n.slack_app;
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState('');
  const [secret, setSecret] = useState('');
  const [channel, setChannel] = useState(app?.channel ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  if (!app) return null; // control plane before Slack apps
  const url = app.interactions_url ?? 'https://api.effigent.ai/slack/interactions';
  const json = JSON.stringify(manifest(url), null, 2);
  const createHref = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest(url)))}`;
  const editing = !app.connected || open;

  const send = async (method: 'PUT' | 'DELETE', body: Record<string, string> | undefined, done: string) => {
    setBusy(true); setMsg(null);
    try {
      const v = await api.send<ApiNotifications>(method, '/notifications/slack-app', body);
      onChange(v); setToken(''); setSecret(''); setOpen(false);
      setMsg({ ok: true, text: done });
    } catch (e) { setMsg({ ok: false, text: apiErrorText(e) }); } finally { setBusy(false); }
  };
  const connect = () => send('PUT', { bot_token: token.trim(), signing_secret: secret.trim(), channel: channel.trim(), approvers: app.approvers },
    'Connected — a confirmation message was posted to the channel. Use “Send sample approval request” to try the buttons.');
  const copy = async () => {
    try { await navigator.clipboard.writeText(json); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };

  return (
    <div style={{ padding: '0 20px 14px' }}>
      <div className="setting-row" style={{ padding: '4px 0 10px' }}>
        <div style={{ minWidth: 0 }}>
          <div className="setting-title">Slack app <span className="badge b-green" style={{ marginLeft: 6 }}>Recommended</span></div>
          <div className="setting-desc">Approve / Deny right in Slack. Every click is recorded with the person’s Slack name and email, and only approvers can decide.</div>
        </div>
        {app.connected
          ? <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <span className="badge b-green">Connected to {app.team_name || app.team_id}</span>
              <button className="btn sm" disabled={!canWrite || busy} onClick={() => setOpen((o) => !o)}>{open ? 'Cancel' : 'Change'}</button>
              <button className="btn sm" disabled={!canWrite || busy} onClick={() => send('DELETE', undefined, 'Slack app disconnected.')}>Disconnect</button>
            </span>
          : !app.available && <span className="badge b-gold" title="The control plane needs EFFIGENT_SECRETS_KEY to store Slack credentials">Not set up on the server</span>}
      </div>

      {app.connected && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 13, margin: '0 0 10px' }}>
          <span className="muted">Posts to channel <code>{app.channel}</code> · Who can decide from Slack:</span>
          <select className="select" style={{ flex: '0 1 330px' }} value={app.approvers} disabled={!canWrite || busy} aria-label="Who can decide from Slack"
            onChange={(e) => send('PUT', { approvers: e.target.value }, 'Saved.')}>
            <option value="members">Effigent admins and security admins (matched by email)</option>
            <option value="workspace">Anyone in the Slack workspace (identity still recorded)</option>
          </select>
        </div>
      )}
      {app.approvers === 'members' && !app.directory_available && (app.connected || editing) && (
        <div className="callout warn" style={{ margin: '0 0 10px' }}>
          <Ic n="alert" size={16} />
          <span>The control plane can’t match Slack users to Effigent approvers yet (it needs <code>CLERK_SECRET_KEY</code>), so Slack clicks are refused until then. Decide in the console meanwhile, or allow anyone in the Slack workspace.</span>
        </div>
      )}

      {editing && app.available && (
        <ol className="steps-list" style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 13.5, lineHeight: 1.6 }}>
          <li>
            <a className="btn sm" href={createHref} target="_blank" rel="noreferrer"><Ic n="plus" size={14} /> Create the Slack app</a>
            <span className="muted"> — opens Slack with everything filled in (scopes, interactivity URL). Or </span>
            <button className="view-all" style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer' }} onClick={copy}>{copied ? 'copied' : 'copy the manifest'}</button>
            <span className="muted">.</span>
            <details style={{ margin: '4px 0' }}>
              <summary className="muted" style={{ cursor: 'pointer', fontSize: 12.5 }}>Manifest</summary>
              <pre className="mono-sm" style={{ whiteSpace: 'pre-wrap', background: 'var(--bg-2, var(--panel))', border: '1px solid var(--border)', borderRadius: 8, padding: 10, margin: '6px 0' }}>{json}</pre>
            </details>
          </li>
          <li><b>Install to Workspace</b>, then paste the <b>Bot User OAuth Token</b> (OAuth &amp; Permissions):
            <input className="input mono" style={{ display: 'block', width: '100%', margin: '4px 0 8px' }} placeholder={app.connected ? 'xoxb-… (leave empty to keep the current one)' : 'xoxb-…'}
              value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} aria-label="Slack bot token" />
          </li>
          <li>Paste the <b>Signing Secret</b> (Basic Information → App Credentials):
            <input className="input mono" type="password" style={{ display: 'block', width: '100%', margin: '4px 0 8px' }} placeholder={app.connected ? 'leave empty to keep the current one' : 'signing secret'}
              value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" aria-label="Slack signing secret" />
          </li>
          <li>The <b>channel ID</b> for requests (open the channel → its name → About, at the bottom: <code>C…</code>). For a private channel, <code>/invite @Effigent</code> first.
            <input className="input mono" style={{ display: 'block', width: '100%', maxWidth: 260, margin: '4px 0 8px' }} placeholder="C0123456789"
              value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Slack channel ID" />
          </li>
          <li style={{ listStyle: 'none', marginLeft: -18 }}>
            <button className="btn primary sm" disabled={!canWrite || busy || (!app.connected && (!token.trim() || !secret.trim())) || !channel.trim()} onClick={connect}>
              <Ic n="check" size={14} /> {busy ? 'Checking with Slack…' : app.connected ? 'Save' : 'Connect'}
            </button>
            <span className="muted" style={{ fontSize: 12.5, marginLeft: 8 }}>Effigent checks the token and posts a short confirmation in the channel.</span>
          </li>
        </ol>
      )}
      {msg && <div className={`callout ${msg.ok ? '' : 'bad'}`} style={{ margin: '10px 0 0' }}><Ic n={msg.ok ? 'checkCircle' : 'alert'} size={16} /><span>{msg.text}</span></div>}
    </div>
  );
}
