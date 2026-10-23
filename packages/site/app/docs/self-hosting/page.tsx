import type { Metadata } from 'next';
import { Nav, Footer, PageHero, DocSection, CodeBlock, DocsPager, H2 } from '../../ui';

export const metadata: Metadata = {
  title: 'Self-hosting — Effigent docs',
  description: 'Run the Effigent control plane and console in your own infrastructure, on Kubernetes with Helm or on one VM with Docker Compose, with sign-in through your own OIDC provider.',
};

const NEEDS: Array<[string, string]> = [
  ['Postgres', '14 or newer, one database. The control plane uses only schema cp and runs its migrations on start.'],
  ['OIDC provider', 'Okta, Entra ID, Google Workspace, Keycloak, Authentik, Auth0, … with one client registered for the console.'],
  ['Two hostnames', 'One for the control plane (machines and the console API), one for the console.'],
  ['TLS', 'From your Ingress, Caddy or load balancer, or served by the control plane itself.'],
  ['Optional', 'SMTP for approval emails; an S3 or S3-compatible bucket for the event archive.'],
];

const ROLES: Array<[string, string, string]> = [
  ['admin', 'In the admin groups, or a verified email in the admin emails', 'Everything'],
  ['security_admin', 'In the security-admin groups', 'Decide approvals, change policy'],
  ['viewer', 'Anyone else your provider lets sign in', 'Read'],
];

export default function SelfHosting() {
  return (
    <div style={{ width: '100%', overflowX: 'hidden' }}>
      <Nav />
      <PageHero
        eyebrow="Docs · Self-hosting"
        title="Your control plane, your identity provider, your database."
        sub="Run the Effigent control plane and console in your own infrastructure. People sign in with your OIDC provider, policies are signed with a key you hold, and events stay in your Postgres."
      />

      <DocSection>
        <H2>What you need</H2>
        <div className="tbl-wrap">
          <table className="doc-tbl">
            <tbody>{NEEDS.map(([k, v]) => <tr key={k}><td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{k}</td><td>{v}</td></tr>)}</tbody>
          </table>
        </div>
        <p className="doc-p" style={{ marginTop: 14 }}>
          effigentd on your machines works the same as against the hosted service. It just enrolls with your URL. One install serves one workspace.
        </p>
      </DocSection>

      <DocSection>
        <H2>Sign-in with your OIDC provider</H2>
        <p className="doc-p">
          Register the console as a web application using the authorization code flow with PKCE, with the redirect URI <code>https://&lt;console host&gt;/auth/callback</code> and the scopes <code>openid email profile offline_access</code>. Roles come from the token on every request:
        </p>
        <div className="tbl-wrap">
          <table className="doc-tbl">
            <thead><tr><th>Role</th><th>Who</th><th>Can</th></tr></thead>
            <tbody>{ROLES.map(([r, w, c]) => <tr key={r}><td><code>{r}</code></td><td>{w}</td><td>{c}</td></tr>)}</tbody>
          </table>
        </div>
        <ul className="doc-list" style={{ marginTop: 14 }}>
          <li>Groups come from any claim, including nested ones such as Keycloak&apos;s <code>realm_access.roles</code>. An allowed-groups list can refuse everyone else.</li>
          <li>Emails count only when the provider marks them verified.</li>
          <li>The console keeps the provider&apos;s tokens server-side in a sealed, HTTP-only cookie, refreshes them before they expire, and ends the session after 12 hours by default. Sign-out also ends the provider session.</li>
          <li>The control plane accepts only tokens signed with the issuer&apos;s published keys, for your client, that haven&apos;t expired.</li>
        </ul>
      </DocSection>

      <DocSection>
        <H2>Install on Kubernetes</H2>
        <CodeBlock title="sh">{`helm repo add effigent https://effigent.ai/charts
kubectl create namespace effigent
kubectl -n effigent create secret generic effigent-keys \\
  --from-literal=signing-key="$(openssl rand -base64 32)" \\
  --from-literal=admin-token="$(openssl rand -hex 24)" \\
  --from-literal=secrets-key="$(openssl rand -hex 24)" \\
  --from-literal=session-secret="$(openssl rand -hex 24)"
kubectl -n effigent create secret generic effigent-db \\
  --from-literal=url='postgres://effigent:…@db.internal:5432/effigent?sslmode=require'
kubectl -n effigent create secret generic effigent-oidc --from-literal=client-secret='…'

helm install effigent-cp effigent/effigent-cp -n effigent -f values.yaml`}</CodeBlock>
        <div style={{ height: 14 }} />
        <CodeBlock title="values.yaml">{`controlPlane:
  url: https://effigent-api.example.com
console:
  url: https://effigent.example.com
keys:
  existingSecret: effigent-keys
database:
  existingSecret: effigent-db
oidc:
  issuer: https://example.okta.com/oauth2/default
  clientId: 0oa1example
  clientSecretExistingSecret: effigent-oidc
  providerName: Okta
  scopes: openid email profile offline_access groups
  adminGroups: [effigent-admins]
  securityAdminGroups: [security]
ingress:
  enabled: true
  className: nginx
  tls:
    - secretName: effigent-tls
      hosts: [effigent.example.com, effigent-api.example.com]`}</CodeBlock>
        <ul className="doc-list" style={{ marginTop: 14 }}>
          <li>The pods run as non-root with read-only root filesystems.</li>
          <li><code>caBundle</code> adds your private CA for calls to your identity provider, SMTP and S3.</li>
          <li><code>controlPlane.tls.secretName</code> lets the control plane serve HTTPS itself, without an Ingress.</li>
          <li>A bundled Postgres (<code>postgres.enabled</code>) is there for evaluation.</li>
        </ul>
      </DocSection>

      <DocSection>
        <H2>Install on one VM</H2>
        <CodeBlock title="sh">{`# in a directory with deploy/selfhost/{compose.yaml,Caddyfile,env.example}
cp env.example .env && $EDITOR .env
docker compose up -d
docker compose logs cp | grep 'signing public key'`}</CodeBlock>
        <p className="doc-p" style={{ marginTop: 14 }}>
          Compose runs Postgres, the control plane, the console and Caddy, which gets certificates for both hostnames from Let&apos;s Encrypt. On a private network, set <code>EFFIGENT_CADDY_TLS=&quot;tls internal&quot;</code> and Caddy uses its own CA.
        </p>
      </DocSection>

      <DocSection>
        <H2>Enroll machines</H2>
        <CodeBlock title="sh">{`sudo effigentd enroll --server https://effigent-api.example.com --token eft_…

# certificate from your own CA: trust it once, kept for every start
sudo effigentd enroll --ca-file /path/ca.pem --server https://effigent-api.example.com --token eft_…

# or with the installer (Windows: install.ps1 -Server … -Token … -CaFile C:\\path\\ca.pem)
curl -fsSL https://effigent.ai/install.sh | sudo sh -s -- --server https://effigent-api.example.com --token eft_… --ca-file /path/ca.pem`}</CodeBlock>
        <p className="doc-p" style={{ marginTop: 14 }}>
          The node chart for Kubernetes takes <code>server=https://effigent-api.example.com</code>.
        </p>
      </DocSection>

      <DocSection>
        <H2>Keys, backups and the archive</H2>
        <ul className="doc-list">
          <li><b>The signing key</b> signs every policy, and each machine pins its public half at enrollment. Back it up outside the cluster the day you install.</li>
          <li><b>Postgres</b> holds everything else: <code>pg_dump -Fc -n cp effigent</code> daily, or your provider&apos;s snapshots.</li>
          <li><b>The event archive</b> goes to any S3 or S3-compatible store. Events older than the retention period are written there, one file per day, before they are deleted.</li>
          <li><b>Upgrades</b> go control plane, then console, then effigentd. Migrations run on start under a lock, so replicas can start together.</li>
        </ul>
      </DocSection>

      <DocsPager current="/docs/self-hosting" />
      <Footer />
    </div>
  );
}
