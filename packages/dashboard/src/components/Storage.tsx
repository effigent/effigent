import { useCallback, useEffect, useState } from 'react';

interface StorageState {
  migrated: boolean;
  provisioned: boolean;
  mode?: 'effigent' | 'byo' | 'none';
  bucket: string | null;
  region: string | null;
  prefix: string | null;
  kmsKey: string | null;
  roleArn: string | null;
  externalId: string | null;
  provisionedAt: string | null;
  effigentAccountId: string | null;
  suggestedExternalId: string;
  canEdit: boolean;
}

interface ByoForm {
  bucket: string; region: string; roleArn: string; externalId: string; kmsKey: string; prefix: string;
}

function CodeBlock({ code, wrap }: { code: string; wrap?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };
  return (
    <div className="code">
      <button className="code-copy" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      <pre className={wrap ? 'wrap' : undefined}>{code}</pre>
    </div>
  );
}

const MODE_LABEL: Record<string, string> = {
  effigent: 'Managed — Effigent-hosted bucket',
  byo: 'Customer S3 — your AWS account',
  none: 'Not provisioned — capture is off',
};

/**
 * Run Storage — where this workspace's run data lives. Two modes:
 * managed (a dedicated per-org bucket in Effigent's account, zero setup) or
 * customer S3 (a bucket in the org's own account via a cross-account role —
 * one CloudFormation deploy). Capture is refused until one is configured.
 */
export function Storage() {
  const [state, setState] = useState<StorageState | null>(null);
  const [form, setForm] = useState<ByoForm>({ bucket: '', region: '', roleArn: '', externalId: '', kmsKey: '', prefix: '' });
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await fetch('/api/v1/storage');
    if (!r.ok) return;
    const d = (await r.json()) as StorageState;
    setState(d);
    setForm({
      bucket: d.bucket ?? '',
      region: d.region ?? '',
      roleArn: d.roleArn ?? '',
      externalId: d.externalId ?? d.suggestedExternalId ?? '',
      kmsKey: d.kmsKey ?? '',
      prefix: d.prefix ?? '',
    });
  }, []);

  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  const probe = async () => {
    setBusy('probe');
    setStatus(null);
    try {
      const r = await fetch('/api/v1/storage?probe=1');
      const d = (await r.json()) as { probe?: { ok?: boolean; hint?: string; error?: string; skipped?: string } };
      const p = d.probe;
      if (p && 'skipped' in p && p.skipped) setStatus({ kind: 'err', text: `Probe skipped: ${p.skipped}` });
      else if (p?.ok) setStatus({ kind: 'ok', text: 'Probe passed — wrote and read back a test object. Capture is live.' });
      else setStatus({ kind: 'err', text: `Probe failed — ${p?.hint ?? 'unknown'}${p?.error ? ` (${p.error})` : ''}` });
    } catch {
      setStatus({ kind: 'err', text: 'Network error running the probe.' });
    } finally {
      setBusy(null);
    }
  };

  const useManaged = async () => {
    if (state?.mode === 'byo' &&
        !window.confirm('Switch to Effigent-managed storage? New runs will stop writing to your bucket (existing objects there are untouched, but the dashboard can no longer read them).')) return;
    setBusy('managed');
    setStatus(null);
    try {
      const r = await fetch('/api/v1/storage', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'managed' }),
      });
      const d = (await r.json()) as { ok?: boolean; provision?: { reason?: string; hint?: string; error?: string }; probe?: { hint?: string } };
      if (r.ok && d.ok) setStatus({ kind: 'ok', text: 'Managed bucket provisioned and verified — capture is live.' });
      else setStatus({ kind: 'err', text: d.provision?.hint ?? d.provision?.reason ?? d.probe?.hint ?? 'Provisioning failed — see server logs.' });
      await refresh();
    } catch {
      setStatus({ kind: 'err', text: 'Network error provisioning managed storage.' });
    } finally {
      setBusy(null);
    }
  };

  const saveByo = async () => {
    setBusy('byo');
    setStatus(null);
    try {
      const r = await fetch('/api/v1/storage', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      });
      const d = (await r.json()) as { ok?: boolean; error?: string; probe?: string };
      if (r.ok && d.ok) setStatus({ kind: 'ok', text: 'Saved and verified — a probe object was written to your bucket and read back. Capture is live.' });
      else setStatus({ kind: 'err', text: d.error ? `Saved, but the access probe failed: ${d.error}` : `HTTP ${r.status}` });
      await refresh();
    } catch {
      setStatus({ kind: 'err', text: 'Network error — not saved.' });
    } finally {
      setBusy(null);
    }
  };

  if (!state) return <div className="dag-empty">Loading storage settings…</div>;
  if (!state.migrated) {
    return (
      <div className="dag-empty">
        Storage columns not migrated yet — ask the workspace owner to run <code>scripts/apply-org-storage.mjs</code>.
      </div>
    );
  }

  const disabled = !state.canEdit;
  const mode = state.mode ?? 'none';
  const deployCmd = `aws cloudformation deploy \\
  --stack-name effigent-storage \\
  --template-file effigent-byo-storage.yaml \\
  --capabilities CAPABILITY_NAMED_IAM`;

  return (
    <div className="page-stack">
      <section className="panel panel-pad">
        <div className="mono-name" style={{ fontSize: 14 }}>Current storage</div>
        <div className="panel-sub" style={{ marginBottom: 10 }}>
          Run content is stored only in this workspace&apos;s own bucket (S3-only residency); Effigent&apos;s
          database keeps metadata and a pointer. Capture returns 409 until storage is configured.
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <span className="opt-badge" style={{ opacity: 0.9 }}>{MODE_LABEL[mode]}</span>
          {state.bucket && <code>s3://{state.bucket}{state.prefix ? `/${state.prefix}` : ''}</code>}
          {state.region && <span className="panel-sub">{state.region}</span>}
        </div>
        {state.provisioned && (
          <div style={{ marginTop: 10 }}>
            <button className="btn-ghost" disabled={disabled || busy !== null} onClick={probe}>
              {busy === 'probe' ? 'Probing…' : 'Run access probe'}
            </button>
          </div>
        )}
        {!state.canEdit && (
          <div className="foot-note" style={{ marginTop: 8 }}>Only organization admins can change storage settings.</div>
        )}
        {status && (
          <div className="foot-note" style={{ marginTop: 8, color: status.kind === 'err' ? 'var(--warn, #eb6834)' : undefined }}>
            {status.text}
          </div>
        )}
      </section>

      <section className="panel panel-pad">
        <div className="mono-name" style={{ fontSize: 14 }}>
          Managed storage {mode === 'effigent' && '— active'}
        </div>
        <div className="panel-sub" style={{ marginBottom: 10 }}>
          A dedicated bucket for this org in Effigent&apos;s AWS account (block-public-access, encrypted,
          one bucket per organization). Zero AWS setup — the fastest way to start.
        </div>
        <button className="btn-primary" disabled={disabled || busy !== null || mode === 'effigent'} onClick={useManaged}>
          {busy === 'managed' ? 'Provisioning…' : mode === 'byo' ? 'Switch to managed storage' : mode === 'effigent' ? 'Active' : 'Provision managed bucket'}
        </button>
      </section>

      <section className="panel panel-pad">
        <div className="mono-name" style={{ fontSize: 14 }}>
          Customer S3 — your own AWS account {mode === 'byo' && '— active'}
        </div>
        <div className="panel-sub" style={{ marginBottom: 10 }}>
          Run data lands only in a bucket you own; Effigent writes and reads through a cross-account
          role you can revoke at any time. You control encryption (your KMS key), retention, and audit.
        </div>

        <div className="mono-name" style={{ fontSize: 12, marginTop: 6 }}>Step 1 — provision in your account (one command)</div>
        <div className="panel-sub" style={{ margin: '4px 0 8px' }}>
          <a className="link" href="/api/v1/storage/template" download>Download the CloudFormation template</a>
          {' '}— it is pre-filled with your workspace&apos;s external id
          {state.effigentAccountId ? ` and Effigent's AWS account (${state.effigentAccountId})` : ''} — then deploy it:
        </div>
        <CodeBlock code={deployCmd} />
        <div className="panel-sub" style={{ margin: '8px 0' }}>
          It creates a private encrypted bucket plus a role limited to <code>PutObject</code>/<code>GetObject</code> on
          that one bucket. Prefer Terraform, or doing it by hand? See <code>docs/byo-s3-setup.md</code> in the repo —
          your external id is <code>{state.suggestedExternalId}</code>. Deleting the role revokes Effigent&apos;s access instantly.
        </div>

        <div className="mono-name" style={{ fontSize: 12, marginTop: 10 }}>Step 2 — paste the stack outputs</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8, marginTop: 8 }}>
          <input className="rule-input mono" value={form.bucket} disabled={disabled} placeholder="Bucket (required)"
            onChange={(e) => setForm((f) => ({ ...f, bucket: e.target.value.trim() }))} />
          <input className="rule-input mono" value={form.region} disabled={disabled} placeholder="Region (e.g. us-east-1)"
            onChange={(e) => setForm((f) => ({ ...f, region: e.target.value.trim() }))} />
          <input className="rule-input mono" value={form.roleArn} disabled={disabled} placeholder="Role ARN (arn:aws:iam::…:role/…)"
            onChange={(e) => setForm((f) => ({ ...f, roleArn: e.target.value.trim() }))} />
          <input className="rule-input mono" value={form.externalId} disabled={disabled} placeholder="External id"
            onChange={(e) => setForm((f) => ({ ...f, externalId: e.target.value.trim() }))} />
          <input className="rule-input mono" value={form.kmsKey} disabled={disabled} placeholder="KMS key ARN (optional)"
            onChange={(e) => setForm((f) => ({ ...f, kmsKey: e.target.value.trim() }))} />
          <input className="rule-input mono" value={form.prefix} disabled={disabled} placeholder="Key prefix (optional)"
            onChange={(e) => setForm((f) => ({ ...f, prefix: e.target.value.trim() }))} />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button className="btn-primary" disabled={disabled || busy !== null || !form.bucket} onClick={saveByo}>
            {busy === 'byo' ? 'Verifying…' : 'Save & verify access'}
          </button>
        </div>
        <div className="foot-note" style={{ marginTop: 8 }}>
          Saving runs a live write→read probe against your bucket — the workspace only reports
          provisioned if the round-trip succeeds.
        </div>
      </section>
    </div>
  );
}
