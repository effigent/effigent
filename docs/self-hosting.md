# Self-hosting the control plane

Run Effigent's control plane (`effigent-cp`) and console (`effigent-console`) in your own
infrastructure: people sign in with your OIDC provider, policies are signed with a key you
hold, and events stay in your Postgres. effigentd on your machines works the same as against
`api.effigent.ai`; it just enrolls with your URL.

One install serves one workspace (default `org:self-hosted`).

Code: `internal/controlplane/server/oidc.go` (token checks), `console_users.go` +
migration `020_console_users.sql` (who signed in), `cmd/effigent-cp/main.go` (env);
console `src/lib/oidc.ts`, `src/app/auth/*` (sign-in), `src/middleware.ts`;
`Dockerfile.cp`, `Dockerfile.console`; `deploy/helm/effigent-cp`, `deploy/selfhost`;
test `test/selfhost/kind.sh`.

## What you need

| | |
|---|---|
| Postgres | 14 or newer, one database. The control plane only uses schema `cp`, creates it and runs its migrations on every start. Size: events dominate, roughly 1 KB per agent action, kept 90 days by default. |
| OIDC provider | Okta, Entra ID, Google Workspace, Keycloak, Authentik, Dex, Auth0, … with one client registered for the console. |
| Two hostnames | One for the control plane (effigentd and the console API, e.g. `effigent-api.example.com`), one for the console (`effigent.example.com`). They can't share a host: both serve `/api/v1/*`. |
| TLS | In front of both (Ingress / Caddy / load balancer), or served by the control plane itself (`EFFIGENT_TLS_CERT_FILE`, `EFFIGENT_TLS_KEY_FILE`). |
| Compute | Control plane: 100m CPU / 128 MB at rest, up to 512 MB. Console: about the same. |
| Optional | SMTP for approval emails; an S3 or S3-compatible bucket for the event archive. |

Machines (effigentd) must reach the control plane URL over HTTPS. Browsers must reach both
URLs and the identity provider. The control plane and the console must reach the identity
provider (discovery, keys, token endpoint).

## 1. Register the console with your identity provider

- Application type: web, **authorization code with PKCE**. Confidential (with a client secret)
  or public both work.
- Redirect URI: `https://<console host>/auth/callback`
- Post-logout redirect: `https://<console host>/sign-in?signed_out=1`
- Scopes: `openid email profile offline_access` (add `groups` where your provider needs it
  for a groups claim). `offline_access` gives the console a refresh token so sessions last
  their full length (12 hours by default).
- Groups: put the people who should run Effigent in groups and send them in the ID token
  (claim `groups` by default; any claim path works, e.g. `realm_access.roles` in Keycloak).

Roles come from the token on every request:

| Role | Who | Can |
|---|---|---|
| admin | in `EFFIGENT_OIDC_ADMIN_GROUPS`, or a verified email in `EFFIGENT_OIDC_ADMIN_EMAILS` | everything |
| security_admin | in `EFFIGENT_OIDC_SECURITY_ADMIN_GROUPS` | decide approvals, policy |
| viewer | anyone else who signs in | read |

`EFFIGENT_OIDC_ALLOWED_GROUPS` (optional) refuses everyone outside the listed groups.
Emails are only trusted when the token says `email_verified: true`
(`EFFIGENT_OIDC_ALLOW_UNVERIFIED_EMAIL=1` for providers that never send it).

## 2. Keys

| Key | What | If lost |
|---|---|---|
| `EFFIGENT_SIGNING_KEY` | base64 32-byte ed25519 seed (`openssl rand -base64 32`). Signs every policy; each machine pins its public key at enrollment. | **Every machine must be enrolled again.** Machines refuse policies signed with another key and keep running on their cached policy. |
| `EFFIGENT_SECRETS_KEY` | ≥ 32 characters. Seals vendor API keys and Slack credentials in Postgres. | Re-enter those keys in the console. |
| `EFFIGENT_SESSION_SECRET` | ≥ 32 characters, console only. Seals session cookies. | Everyone signs in again. |
| `EFFIGENT_ADMIN_TOKEN` | Optional bearer token for automation (`Authorization: Bearer …` + `X-Effigent-Tenant: org:self-hosted`). API keys (Settings → Integrations) are usually the better choice. | Set a new one. |

Back up the signing key outside the cluster or VM (a password manager or your secrets
vault) the day you install. The control plane logs its public half on start
(`policy signing public key …`); keep that next to it so you can check a restore.

## 3a. Install on Kubernetes (Helm)

```sh
kubectl create namespace effigent
kubectl -n effigent create secret generic effigent-keys \
  --from-literal=signing-key="$(openssl rand -base64 32)" \
  --from-literal=admin-token="$(openssl rand -hex 24)" \
  --from-literal=secrets-key="$(openssl rand -hex 24)" \
  --from-literal=session-secret="$(openssl rand -hex 24)"
kubectl -n effigent create secret generic effigent-db \
  --from-literal=url='postgres://effigent:…@db.internal:5432/effigent?sslmode=require'
kubectl -n effigent create secret generic effigent-oidc --from-literal=client-secret='…'

helm install effigent-cp effigent/effigent-cp -n effigent -f values.yaml
```

with a `values.yaml` like

```yaml
controlPlane:
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
smtp:
  url: smtp://effigent:…@smtp.example.com:587   # or smtp.existingSecret
  from: Effigent <effigent@example.com>
ingress:
  enabled: true
  className: nginx
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "120"   # approval long-polls wait up to 90s
  tls:
    - secretName: effigent-tls
      hosts: [effigent.example.com, effigent-api.example.com]
```

Every option is documented in `deploy/helm/effigent-cp/values.yaml`. Notes:

- Without `keys.existingSecret` the chart generates the keys once into
  `<release>-effigent-cp-keys` (or `<release>-keys` when the release name contains
  `effigent-cp`), reuses them on every upgrade (Helm `lookup`) and keeps that Secret on
  `helm uninstall`. Under `helm template`, Argo CD or Flux, `lookup` sees nothing and a render
  would generate new keys: create the Secret yourself there. If you bring your own Secret
  and also turn on the bundled Postgres, add a `postgres-password` key to it.
- `postgres.enabled=true` runs a single Postgres StatefulSet for **evaluation only** (no
  backups, no HA, no major-version upgrades).
- `controlPlane.tls.secretName` makes the control plane serve HTTPS itself (no Ingress); don't
  combine it with `ingress.enabled`.
- `caBundle.configMap` adds your private CA for outbound calls (identity provider, SMTP, S3)
  from both pods. In the control plane it goes through `SSL_CERT_DIR`, which replaces Go's
  default certificate *directories* but not its default bundle *file*, so public roots keep
  working; the console uses `NODE_EXTRA_CA_CERTS`.
- The pods run as non-root with read-only root filesystems.

## 3b. Install on one VM (Docker Compose)

```sh
# in a directory with deploy/selfhost/{compose.yaml,Caddyfile,env.example}
cp env.example .env && $EDITOR .env
docker compose up -d
docker compose logs cp | grep 'signing public key'
```

`compose.yaml` runs Postgres, the control plane, the console and Caddy, which gets
certificates for both hostnames from Let's Encrypt (ports 80 and 443 open, DNS pointing at
the VM). On a private network set `EFFIGENT_CADDY_TLS="tls internal"`: Caddy uses its own CA,
whose root is in the `caddy-data` volume (`/data/caddy/pki/authorities/local/root.crt`); give
it to effigentd with `--ca-file`. For an external Postgres, replace `DATABASE_URL` in
`compose.yaml` and remove the `postgres` service.

Back up `.env` (it holds the signing key) and the Postgres volume (`pg_dump`, below).

## 4. Enroll machines

Sign in to the console, open Enforcement → Enroll a machine for a token, then on each machine:

```sh
sudo effigentd enroll --server https://effigent-api.example.com --token eft_…
```

or `curl -fsSL https://effigent.ai/install.sh | sudo sh -s -- --server https://effigent-api.example.com --token eft_…`
(`EFFIGENT_RELEASES` points the installer at your own mirror of the release files). The
Kubernetes chart for nodes (`deploy/helm/effigent`) takes `server=https://effigent-api.example.com`.

**Private CA.** If the control plane's certificate comes from your own CA, give effigentd the
CA bundle once: `effigentd enroll --ca-file /path/ca.pem …` (or `EFFIGENT_CA_FILE`). The
bundle is copied to `<state dir>/ca.pem` and trusted, in addition to the system roots, on
every start. The installer scripts and the macOS package don't pass `--ca-file` yet: on those
machines run `effigentd enroll --ca-file … --state-dir /var/lib/effigent` (Linux) or
`/Library/Application Support/Effigent` (macOS) yourself before or instead of the installer's
enrollment.

## 5. Upgrade

Upgrade the control plane first, then the console, then effigentd (the same order as the
hosted service; see CLAUDE.md §2 for the policy features that need newer endpoints).
Migrations run on start under a Postgres advisory lock, so several replicas can start at
once. Back up Postgres before an upgrade: the safe rollback is the previous image on the
restored backup (an older image skips migrations it doesn't know, but isn't tested against a
newer schema).

- Helm: `helm upgrade effigent-cp effigent/effigent-cp -n effigent -f values.yaml`
- Compose: set `EFFIGENT_VERSION`, `docker compose pull && docker compose up -d`

## 6. Backups

- **Postgres**: everything except the keys. `pg_dump -Fc -n cp effigent > effigent-$(date +%F).dump`
  daily (or your provider's snapshots). Restore with `pg_restore -d effigent --clean`.
- **The signing key**: once, at install (section 2). Without it a restored database still
  works for the console, but every machine has to be enrolled again.
- **Event archive** (optional): with `EFFIGENT_ARCHIVE_BUCKET` the control plane writes a
  gzip'd JSON-lines file per day older than the retention (`EFFIGENT_EVENT_RETENTION_DAYS`,
  minimum and default 90) before deleting those events; without a bucket nothing is deleted.
  S3-compatible stores: `EFFIGENT_ARCHIVE_ENDPOINT=https://minio.example.com`,
  `EFFIGENT_ARCHIVE_PATH_STYLE=1`, and `EFFIGENT_ARCHIVE_SSE=none` if the store has no SSE-S3.
  Credentials come from `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` or the pod's cloud
  identity. Archive download links are presigned URLs on that endpoint, so the person
  downloading must be able to reach it.

## Differences from effigent.ai

| | Hosted | Self-hosted |
|---|---|---|
| Sign-in | Clerk (email, Google, SSO), organizations | Your OIDC provider, one workspace |
| People in the workspace | Invited in the console | Whoever your provider lets sign in; the Team page lists people who signed in during the last 30 days, with their role from their last sign-in. Invite and remove people in your provider. |
| Approver groups | Picked from Clerk memberships | Picked from people who signed in during the last 30 days |
| Approval emails | Amazon SES | SMTP (`EFFIGENT_SMTP_URL`, `EFFIGENT_EMAIL_FROM`); SES works too with `EFFIGENT_SES_REGION` and AWS credentials |
| Slack approvals | Off for now | Off unless `EFFIGENT_SLACK=1`; then each workspace connects its own Slack app (needs `EFFIGENT_SECRETS_KEY`). The "members" approver rule matches Slack emails against verified emails of admins who have signed in. |
| Event archive | Effigent's S3 bucket | Yours (S3 or S3-compatible), optional |
| AI policy suggestions | Effigent's model key | `EFFIGENT_ANTHROPIC_API_KEY` (optional) |
| Run storage (`/api/v1/storage`), Clerk webhooks | yes | not present |

## Security notes

- The control plane accepts a console token only if its signature checks against the
  issuer's published keys (RS*, PS*, ES* only: no `none`, no HMAC), `iss` equals
  `EFFIGENT_OIDC_ISSUER` exactly, `aud` contains the client id (`EFFIGENT_OIDC_AUDIENCE`),
  and it hasn't expired. Discovery is retried every 10s while the provider is unreachable;
  until then console calls get 401, machines are unaffected.
- The console keeps the provider's tokens server-side in an AES-256-GCM sealed, HTTP-only,
  SameSite=Lax cookie (`Secure` when the console URL is https), hands the current token only
  to same-origin requests (`/auth/token`), refreshes it a minute before it expires, and ends
  the session after `EFFIGENT_SESSION_HOURS` (default 12) whatever the provider says.
  Sign-out also ends the provider session when it publishes an `end_session_endpoint`.
- CORS on the control plane allows only `EFFIGENT_CONSOLE_ORIGIN` (the chart sets it from
  `console.url`).
- Machines authenticate with their own enrollment secret, not with OIDC; revoking a person
  in your provider doesn't affect machines, revoking a machine is done in the console.
- Run the control plane behind TLS. `EFFIGENT_DEV_INSECURE_WEBHOOKS` and the console's
  `EFFIGENT_DEV_NOAUTH` are for local development only.

## Limits

- One workspace per install (`EFFIGENT_OIDC_TENANT`). Changing it later orphans the existing
  machines and policies.
- The Team page knows only people who have signed in (no SCIM, no directory sync); roles shown
  are from each person's last sign-in. Approver groups can only be filled with people who signed
  in during the last 30 days. Approval emails go to the notification emails (Settings) or to the
  routed approver group, as on the hosted service.
- With `EFFIGENT_OIDC_TOKEN=id_token` (default) the provider must return a new ID token on
  refresh (most do; if yours doesn't, sessions end when the first ID token expires: use
  `access_token` with JWT access tokens whose audience is the console's client id).
- Some providers keep one refresh token per user and client (Dex does): signing in from a
  second browser can end the first browser's session at its next refresh.
