import type { Metadata } from 'next';
import Link from 'next/link';
import { Nav, Footer, PageHero, DocSection, CodeBlock } from '../../ui';
import { DASHBOARD_URL } from '../../config';

export const metadata: Metadata = {
  title: 'Run storage — Effigent docs',
  description:
    'Where captured run data lives: Effigent-managed storage, or a bucket in your own AWS account provisioned with one CloudFormation command. S3-only residency, cross-account IAM, revocable at any time.',
};

const MODES = [
  {
    title: 'Managed (default)',
    tag: 'zero AWS setup',
    body:
      'A dedicated bucket for your organization in Effigent’s AWS account — one bucket per org, block-public-access, encrypted at rest. Provisioned automatically when your workspace is created. Nothing to configure; start capturing in minutes.',
  },
  {
    title: 'Customer S3 (bring your own bucket)',
    tag: 'your account · your keys',
    body:
      'Run data lands only in a bucket you own, in your AWS account. Effigent writes and reads through a cross-account IAM role you grant — scoped to that one bucket — and you can revoke it instantly. You control encryption (your KMS key), retention, lifecycle, and audit (CloudTrail on your side).',
  },
];

const PROPERTIES = [
  ['Data stays in your account', 'The durable copy of every run exists only in your bucket. Effigent’s database keeps metadata — cost, models, step count, timestamps — and an s3:// pointer. Never raw payloads.'],
  ['Least-privilege access', 'The role you grant allows exactly two actions — s3:PutObject and s3:GetObject — on that one bucket. No list, no delete, no other bucket, no other service.'],
  ['No long-lived credentials', 'Effigent holds no AWS keys to your account. Every access assumes your role via STS for short-lived credentials, gated by a per-workspace external id (the standard confused-deputy protection).'],
  ['You hold the kill switch', 'Delete the role — or just its trust relationship — and Effigent loses all access that instant. Capture then fails closed: ingest refuses new runs rather than storing them anywhere else.'],
  ['Redacted before it lands', 'Payloads pass the redaction choke point before the object is written — in your bucket or ours, secrets are already typed placeholders.'],
  ['Fail-closed onboarding', 'A workspace with no storage configured cannot capture at all (the collector returns 409). No bucket, no data — nothing is ever parked somewhere temporary.'],
];

export default function StorageDocs() {
  return (
    <div style={{ width: '100%', overflowX: 'hidden' }}>
      <Nav />
      <PageHero
        eyebrow="Docs · Run storage"
        title="Your data, your bucket."
        sub="Every workspace's run content lives in its own S3 bucket — Effigent-managed for the fastest start, or a bucket in your own AWS account for full ownership. Same product, same dashboard, switchable at any time."
      />

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 26, margin: '0 0 14px' }}>Two modes</h2>
        <div className="grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          {MODES.map((m) => (
            <div key={m.title} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '20px 22px', background: 'oklch(0.995 0.002 90)' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 15, fontWeight: 700 }}>{m.title}</div>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600, border: '1px solid var(--line-2)', borderRadius: 12, padding: '3px 10px', color: 'var(--ink-2)' }}>{m.tag}</span>
              </div>
              <div style={{ fontSize: 13.5, color: 'var(--ink-3)', lineHeight: 1.6 }}>{m.body}</div>
            </div>
          ))}
        </div>
        <p style={{ fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.65, marginTop: 16, maxWidth: 720 }}>
          Both modes share everything else — redaction before write, tenant isolation, the same capture keys and CLI. Start
          managed today, move to your own bucket when security review asks for it: switching is an organization-admin
          setting, and nothing about your agents or their configuration changes.
        </p>
      </DocSection>

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 26, margin: '0 0 14px' }}>What lives where</h2>
        <p style={{ fontSize: 14.5, color: 'var(--ink-2)', lineHeight: 1.65, margin: '0 0 16px', maxWidth: 720 }}>
          Run content is S3-only: the redacted, gzipped run blob is written to the workspace&apos;s bucket, and Effigent&apos;s
          database stores only a pointer plus the metadata the dashboard lists runs by.
        </p>
        <CodeBlock title="residency — one captured run">{`your bucket        s3://<bucket>/<prefix?>/<agent>/<session-id>.json.gz
                   (redacted, gzipped, SSE-S3 or your KMS key)

effigent database  blob_path  = s3://<bucket>/…      ← pointer only
                   cost_usd, models, n_steps, timestamps
                   parsed     = null                  ← no run content`}</CodeBlock>
        <p style={{ fontSize: 13.5, color: 'var(--ink-3)', lineHeight: 1.6, margin: '16px 0 0', maxWidth: 720 }}>
          The dashboard&apos;s session deep-dive and the optimization engine fetch blobs on demand through the same access
          path — nothing is copied out and cached on Effigent&apos;s side.
        </p>
      </DocSection>

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 26, margin: '0 0 14px' }}>Customer S3 in one command</h2>
        <p style={{ fontSize: 14.5, color: 'var(--ink-2)', lineHeight: 1.65, margin: '0 0 16px', maxWidth: 720 }}>
          No hand-built IAM. An organization admin opens <strong>Storage</strong> in the{' '}
          <a href={`${DASHBOARD_URL}/sign-in`} style={{ fontWeight: 600, color: 'oklch(0.4 0.14 250)' }}>dashboard</a> and
          downloads a CloudFormation template pre-filled with your workspace&apos;s external id and Effigent&apos;s AWS
          account id. Your cloud team deploys it — that&apos;s the whole setup:
        </p>
        <CodeBlock title="in your AWS account">{`aws cloudformation deploy \\
  --stack-name effigent-storage \\
  --template-file effigent-byo-storage.yaml \\
  --capabilities CAPABILITY_NAMED_IAM

# optional parameters:
#   BucketName=my-effigent-runs     (else AWS generates one)
#   KmsKeyArn=arn:aws:kms:…         (else SSE-S3)`}</CodeBlock>
        <p style={{ fontSize: 14.5, color: 'var(--ink-2)', lineHeight: 1.65, margin: '16px 0 0', maxWidth: 720 }}>
          The stack creates a private, encrypted bucket and the least-privilege cross-account role. Paste its three outputs —
          bucket, region, role ARN — back into the Storage view. Saving runs a live write→read probe against your bucket
          and only reports the workspace provisioned if the round-trip succeeds, so you get instant confirmation the grant
          works. A Terraform module with the same two inputs is available for teams that prefer it, and the underlying
          IAM policies are documented step by step for security review.
        </p>
      </DocSection>

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 26, margin: '0 0 14px' }}>The access model</h2>
        <p style={{ fontSize: 14.5, color: 'var(--ink-2)', lineHeight: 1.65, margin: '0 0 16px', maxWidth: 720 }}>
          Effigent never holds credentials to your account. The role you create trusts exactly one principal — Effigent&apos;s
          AWS account — and only when it presents your workspace&apos;s external id:
        </p>
        <CodeBlock title="trust policy — created by the template">{`{
  "Effect": "Allow",
  "Principal": { "AWS": "arn:aws:iam::<EFFIGENT_ACCOUNT>:root" },
  "Action": "sts:AssumeRole",
  "Condition": { "StringEquals": { "sts:ExternalId": "<your workspace id>" } }
}`}</CodeBlock>
        <p style={{ fontSize: 13.5, color: 'var(--ink-3)', lineHeight: 1.6, margin: '16px 0 0', maxWidth: 720 }}>
          At capture time the collector redacts the run, assumes the role for short-lived STS credentials, and writes the
          object. Dashboard reads use the same assumed role. A leaked role ARN alone is useless — the caller must also be
          Effigent&apos;s account presenting the external id.
        </p>
      </DocSection>

      <DocSection>
        <h2 className="h-serif" style={{ fontSize: 26, margin: '0 0 14px' }}>The guarantees, plainly</h2>
        {PROPERTIES.map(([q, a]) => (
          <div key={q} style={{ padding: '18px 0', borderTop: '1px solid var(--line)' }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>{q}</div>
            <div style={{ fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.65, maxWidth: 700 }}>{a}</div>
          </div>
        ))}
        <p style={{ fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.65, marginTop: 22 }}>
          What gets redacted before any of this is stored is on the{' '}
          <Link href="/docs/redaction" style={{ fontWeight: 600, color: 'oklch(0.4 0.14 250)' }}>privacy &amp; redaction page</Link>;
          the full posture is on the{' '}
          <Link href="/security" style={{ fontWeight: 600, color: 'oklch(0.4 0.14 250)' }}>security page</Link>.
        </p>
      </DocSection>
      <Footer />
    </div>
  );
}
