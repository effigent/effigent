# Effigent — engineering guide

> **Effigent** — the AI Agent Control Plane. A daemon on each Linux/macOS machine
> (`effigentd`) recognises AI coding agents (Claude Code, Cursor, Codex, …), attributes
> every process, file, network and MCP action to the agent that caused it, and enforces
> policy on the machine (Linux: BPF LSM via Tetragon). Policies are managed centrally
> (`effigent-cp`), signed, and keep working offline. The console shows agents, events,
> approvals and policy. Product spec: `PRD.md` (not committed; ask the founder).

Keep this file current when architecture, data model or deployment change.

## 1. Layout

| Path | What | Runs on |
|---|---|---|
| `cmd/effigentd`, `internal/endpoint/*` | Endpoint daemon (Go). `tetragon/` gRPC client + TracingPolicy rendering, `engine/` agent detection, attribution, per-agent kernel policy lifecycle, `policy/` the endpoint policy format (`default.yaml`), `cpclient/` enrollment + signed policy sync, `sink/` stdout/JSONL/HTTP, `api/` local REST, `procscan/`. Subcommands: `enroll`, `run` (zero-gap launcher). | Linux host next to Tetragon (dev: Docker Desktop VM) |
| `cmd/effigent-cp`, `internal/controlplane/*` | Control plane (Go): `store/` Postgres (schema `cp`, embedded migrations tracked in `cp.schema_migrations`), `server/` endpoint protocol `/ep/v1/*` + console API `/api/v1/*`. Image: `Dockerfile.cp`. | AWS App Runner `effigent-cp` (628713530358, us-east-1) at https://api.effigent.ai — redeploy with `AWS_PROFILE=effigent deploy/aws/deploy-cp.sh` |
| `internal/shared/*` | `action/` action model, fingerprint, state machine · `policy/` central policy types + evaluator · `sign/` ed25519 policy signing. | both |
| `packages/dashboard` | Console — Next.js 16 + Clerk. **Live** on `/api/v1` (`src/lib/api.ts`, Clerk Bearer token, `NEXT_PUBLIC_EFFIGENT_API_URL`): Overview, Enforcement (machines, enroll, revoke), Policies (YAML editor, versions), Audit (events + verifiable trail), Settings (workspace/role). **Still demo**: Approvals, Allow/Deny Lists, Identity, Agent Graph. Dev bypass serves `src/lib/fixture-api.ts`. | Vercel, app.effigent.ai |
| `packages/site` | Marketing site + docs, Next.js static export. | S3 + CloudFront, effigent.ai |
| `test/endpoint` | Endpoint e2e against Tetragon (37 checks). | Docker Desktop |
| `test/claude` | Real Claude Code in a container, enforced by effigentd, policy from the control plane. | Docker Desktop |

## 2. How policy reaches the kernel

1. Console/admin `PUT /api/v1/policy` with an endpoint policy YAML → validated with the
   endpoint's own parser → stored as the next version in `cp.policy_versions`.
2. `effigentd` (enrolled) polls `GET /ep/v1/policy?have=N` every `-sync-interval` (5s).
   The control plane signs the document (ed25519); the endpoint verifies signature and
   tenant against the key pinned at enrollment, refuses versions ≤ current, applies it
   live (`engine.SetPolicy`, make-before-break per agent), caches it in `policy.json`.
3. Offline restart → the cached signed policy is applied; a tampered cache is rejected and
   the built-in default applies. Local `PUT /policy` is refused while enrolled.
4. Events are POSTed in batches to `/ep/v1/events` and stored in `cp.events`.

**Central policies** (`internal/shared/policy`: rules for users / teams / agent types,
allow / deny / require_approval) are compiled per machine by `internal/controlplane/compile`:
- `PUT /api/v1/policy {"body": <base yaml>, "policies": [...]}` → `body` is the base every
  machine starts from (agent detection, modes, alerts; its denies are a floor), `policies`
  is stored in `cp.policy_versions.source`. Publish compiles for every endpoint and returns
  `report.unsupported` (clause, reason, `hooks_only` / `observe_only` / `not_enforced`) and
  what each machine gets. Omitting `policies` keeps the published ones; `[]` clears them.
- A machine's identity is `owner` (user id or email) + `teams` on `cp.endpoints`, set with
  `PATCH /api/v1/endpoints/{id}`; that republishes so endpoints refetch.
  `GET /api/v1/endpoints/{id}/policy` previews the compiled body.
- `GET /ep/v1/policy` compiles at serve time against the version's `created_at`
  (deterministic); the signed document carries `endpoint`, and effigentd refuses a
  document compiled for another machine.
- Kernel mapping: binaries → exact `exec_deny` paths (a bare name expands over
  `compile.ExecDirs`), `**/name` or absolute paths → `file_deny` suffixes (only when the
  rule covers reads and writes), IPs/CIDRs → `network_deny`. `require_approval` → deny.
  Arguments, tools, MCP, hostnames, ports, OS users, policy defaults and too-narrow
  allows are reported, never silently dropped. Precedence comes from `policy.Evaluate`.
- **Rollout order:** effigentd builds older than the `endpoint` field fail the signature
  check on compiled documents and stay on their current version (fail closed, logged every
  sync). Upgrade endpoints before a tenant's first central-policy publish. A machine whose
  compile fails gets 422 and keeps its version; it shows as a lagging `policy_version`.
  effigentd builds older than `domain_deny` support refuse a policy that uses it (parse
  error) and also stay on their current version: upgrade endpoints before publishing one.

## 3. Auth

- Endpoints: one-time enrollment token (`eft_…`, hashed, expiry + max uses) →
  endpoint secret (`eps_…`, hashed) used as Bearer on `/ep/v1/*`. Revocation via console.
- Console API: Clerk session JWT (verified via `CLERK_ISSUER`/.well-known/jwks.json;
  tenant = `org:<id>` or `user:<id>`, same refs as v1 `tenants.clerk_ref`), or
  `EFFIGENT_ADMIN_TOKEN` + `X-Effigent-Tenant` for automation.
- Console dev bypass: `EFFIGENT_DEV_NOAUTH=1 NEXT_PUBLIC_EFFIGENT_DEV_NOAUTH=1` (never in production builds).

## 4. Running locally

```
docker compose up -d postgres                       # localhost:5433
make tetragon-up                                    # Tetragon in Docker Desktop's VM (BTF + BPF LSM)
DATABASE_URL=postgres://effigent:effigent@localhost:5433/effigent EFFIGENT_ADMIN_TOKEN=devadmin \
  go run ./cmd/effigent-cp -listen 127.0.0.1:8080
curl -H 'Authorization: Bearer devadmin' -H 'X-Effigent-Tenant: org:dev' -X POST localhost:8080/api/v1/enrollment-tokens
go run ./cmd/effigentd enroll --server http://127.0.0.1:8080 --token eft_… --state-dir ~/.effigent
go run ./cmd/effigentd --state-dir ~/.effigent
./test/endpoint/e2e.sh                              # endpoint e2e (standalone, not enrolled)
./test/claude/run.sh                                # real Claude Code (needs ~/.effigent-claude.env)
npm run -w @effigent/dashboard dev                  # console (with the dev bypass vars)
npm run -w @effigent/site build                     # site
```

## 5. Known limits (keep honest; the site's coverage matrix follows these)

- Kernel blocking is per resolved binary path and file path suffix; argument-level rules alert only.
- Network: connects to IPs/CIDRs in `network_deny` / outside `network_allow` are blocked (verified by hand, e7c5125; no automated e2e check yet).
- `domain_deny` (hostnames) is enforced by address: `internal/endpoint/domains` resolves each name every `-dns-refresh` (30s) via the system resolver + `-dns-servers` (1.1.1.1, 8.8.8.8, 9.9.9.9), keeps every address seen in the last 15 min (max 64 per name; a failed lookup never shrinks the set; loopback/link-local answers are dropped), and the engine adds them to `network_deny` at apply time, re-applying only agents whose names changed. While it is in force, a DNS bypass guard blocks agents from DoT (:853 anywhere) and from well-known public resolvers on :53/:443/:853, except the nameservers in effigentd's and the agent's own `resolv.conf` and single addresses listed in `network_allow`. effigentd itself queries the public resolvers every 30s; `-dns-servers ""` limits it to the system resolver. Limits: shared CDN IPs over-block or miss; names are exact (no wildcards, `www.` separate); private DoH, hard-coded IPs, `/etc/hosts` pins and proxies evade it; effigentd resolves from its own vantage point (split-horizon DNS can differ). `network_allow` is the stronger control. e2e section 6.
- macOS: no kernel enforcement (needs an Endpoint Security entitlement); observe only.
- Detected (not launched via `effigentd run`) agents are unenforced for ~0.8s while policies load.
- On a Mac dev box effigentd can't scan the Docker VM's /proc, so agents started before the daemon aren't tracked.

## 6. Conventions

- Prod DB: the control plane only touches schema `cp`; never ALTER v1 tables.
- Never commit secrets (`.env*`, `*.key`). Commit messages end with the Co-Authored-By trailer.
- Pushing `main` deploys the site (GitHub Action) and the console (Vercel).
