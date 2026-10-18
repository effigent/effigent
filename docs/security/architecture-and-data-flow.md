# Effigent — Architecture & Data Flow

**Confidential — shared under NDA.** Version 1.0, October 2026. Contact: security@effigent.ai

Effigent is a control plane for AI coding agents (Claude Code, Codex, Gemini CLI, Cursor and
others). A daemon on each machine (**effigentd**) sees what agents do, enforces the workspace's
policy on the machine, and reports to a hosted **control plane**. Admins use a web **console**.

## 1. Components

```
 Developer machine (customer)                     Effigent cloud (United States)
┌──────────────────────────────┐   HTTPS (TLS)   ┌───────────────────────────────────────┐
│ AI agent (Claude Code, …)    │                  │ Control plane API  api.effigent.ai    │
│   │ pre-tool hook            │  ── events ───▶  │   AWS App Runner, us-east-1           │
│   ▼                          │  ◀─ signed ────  │   │                                   │
│ effigentd (root)             │     policy       │   ├── PostgreSQL (Neon, US)           │
│  • evaluates every action    │  ── approval ─▶  │   │     events ≤ 90 days, audit trail,│
│  • blocks in the kernel      │     requests     │   │     policies, approvals, settings │
│    (Linux, Tetragon / BPF)   │                  │   ├── S3 archive (us-east-1)          │
│    or via agent hooks        │                  │   │     events > 90 days, 1 year,     │
│    (macOS, Windows)          │                  │   │     Object Lock                   │
│  • local disk spool ≤256 MB  │                  │   └── Amazon SES → approver email     │
└──────────────────────────────┘                  │                                       │
                                                  │ Console  app.effigent.ai  (Vercel)    │
 Admins / approvers ── browser (Clerk sign-in) ─▶ │   reads the API; stores nothing        │
                                                  └───────────────────────────────────────┘
```

| Component | Runs on | Stores | Notes |
|---|---|---|---|
| effigentd | Customer machines (Linux, macOS, Windows), as root | Last signed policy, enrollment credential, unsent events (≤256 MB) | State directory readable by root only |
| Control plane API | AWS App Runner, us-east-1 | Nothing on local disk | Stateless container; secrets from AWS Secrets Manager |
| Database | Neon managed PostgreSQL, US region | All workspace data (see §3) | Encrypted at rest by the provider; TLS in transit |
| Event archive | Amazon S3, us-east-1 | Agent events older than 90 days | SSE-S3, versioning, Object Lock (governance, 365 days), lifecycle deletes after 1 year |
| Email | Amazon SES | Transient | Approval requests to approvers |
| Console | Vercel | Nothing | Browser app; every call goes to the API with the user's session token |
| Identity | Clerk | Users' name, email, organization membership and role | Sign-in for the console |
| Policy assistant (optional) | Anthropic API | Not retained by us beyond the request | Only when an admin uses "Ask AI"; sends the policy text and the request |

## 2. Data flows

1. **Enrollment.** An admin creates a single-use (or limited-use), expiring enrollment token in the
   console. The installer runs `effigentd enroll` with it; the control plane returns a per-machine
   secret and its policy-signing public key. The token is stored only as a SHA-256 hash; the
   machine secret likewise.
2. **Policy distribution.** Admins publish a policy (validated with the endpoint's own parser).
   effigentd polls every few seconds; each policy is compiled per machine and signed with Ed25519.
   effigentd verifies the signature against the key pinned at enrollment and the tenant, refuses
   older versions, applies it live and caches it for offline restarts. A tampered cache is refused.
3. **Enforcement.** Every agent action is evaluated on the machine: on Linux in the kernel (BPF LSM
   via Tetragon) for executions, file opens and network connections; on macOS and Windows through
   the agents' pre-tool hooks. The control plane is not in the decision path.
4. **Events.** effigentd sends events in batches every ~2 s over TLS. Each batch carries an ID so a
   retried batch is stored once. If the control plane is unreachable, batches wait in a local
   spool (≤256 MB, oldest dropped and counted beyond that) and are replayed when it is back.
5. **Approvals.** When an action requires approval, effigentd sends a redacted one-line summary and a
   fingerprint of the exact action. The control plane routes the request to an approver group
   (by kind, text patterns, machine, agent), emails that group's members with per-recipient signed
   Approve/Deny links (opening a link shows a confirmation page; only the POST decides), and long-
   polls for a decision. An approval lets that exact action run once. If the control plane is
   unreachable, the action is denied (fail closed).
6. **Console.** Users sign in through Clerk; the browser calls the API with a short-lived session
   token. Roles: admin and security admin (change policy, step in on any approval), member
   (read-only; may decide approvals routed to a group they belong to).
7. **Automation.** API keys (scoped: read, approvals, endpoints, policy; stored as SHA-256 hashes)
   and signed webhooks (HMAC-SHA256, HTTPS only, private and internal addresses refused at connect
   time) for SIEM / SOAR / workflow tools.
8. **Retention.** Hourly, one control-plane instance (database advisory lock) writes each workspace's
   events older than 90 days, one gzip'd JSON-lines file per day, to S3; checks the stored size;
   then deletes them in one transaction. If no archive is configured or an upload fails, nothing is
   deleted.

## 3. Data inventory

| Data | Source | Where | Retention | Protection |
|---|---|---|---|---|
| Agent events: agent, command (secrets redacted), file path, destination host/IP and port, MCP server/tool name, OS user, machine, rule and outcome | effigentd | Database → S3 archive | 90 days live, then 1 year archived | Append-only (trigger), batches hash-chained per machine and verifiable; archive Object-Locked |
| Approval requests and decisions (summary, fingerprint, approver identity, note) | effigentd, approvers | Database | Life of the workspace | Decisions recorded with identity; audit trail |
| Console audit trail (every change and every refused attempt: actor, role, IP, details) | Control plane | Database | Life of the workspace | Append-only, hash-chained per workspace, verifiable from the console |
| Policies and versions | Admins | Database | Life of the workspace | Signed per machine when served |
| Machines (hostname, OS, version, owner, teams) | effigentd, admins | Database | Until revoked/deleted | — |
| Users (name, email, role) | Clerk | Clerk; approver-group members' IDs and emails in the database | While a member | — |
| Credentials: enrollment tokens, machine secrets, API keys | Control plane | Database | Until revoked | SHA-256 hashes only |
| Integration secrets (e.g. Slack app tokens) | Admins | Database | Until removed | AES-256-GCM, bound to the workspace; never returned by the API |

**Not collected:** file contents, source code, model prompts or completions, keystrokes, screen
contents. Shell commands are recorded as run (after secret redaction), which can include text
written inline in the command (for example a heredoc). For approvals of MCP tools, the approver
sees up to 800 characters of the tool's redacted arguments.

## 4. Security controls

- **Encryption in transit:** TLS for all traffic between machines, the API, the console and providers.
- **Encryption at rest:** database (provider-managed), S3 archive (SSE-S3), integration secrets
  (AES-256-GCM, application level).
- **Integrity:** Ed25519-signed policies; hash-chained, append-only audit trail and event batches with
  server-side verification; S3 Object Lock on archives.
- **Tenant isolation:** every record carries the workspace; every query is scoped to the caller's
  workspace; endpoint credentials are bound to one workspace and policies to one machine.
- **Secrets management:** server secrets (database URL, signing key, archive and integration keys)
  in AWS Secrets Manager, read by the control plane's IAM role only.
- **Least privilege on the machine:** effigentd's local API is read-only without a token (agents can
  reach localhost); hooks fail closed when the daemon is unreachable.
- **Secret redaction on the machine** (gitleaks rule set) before anything leaves it.
- **Rate limits** per IP, per machine and per user; request size limits.
- **Webhook SSRF protection:** the resolved address is checked at connect time.

## 5. Availability and failure modes

| Failure | Effect |
|---|---|
| Control plane or network down | Last policy keeps enforcing; events spooled locally; actions needing approval are denied |
| effigentd stopped (needs root) | Agent hooks deny (fail closed); missing heartbeat visible in the console |
| Archive upload fails | Events stay in the database; nothing deleted; error shown in the console |

## 6. Compliance status

SOC 2: in progress. Until a report is issued we answer security questionnaires (SIG Lite, CAIQ or
custom) directly. Running the control plane in a customer's own infrastructure is on the roadmap.

## 7. Known limits

Stated publicly on effigent.ai/security and in the coverage matrix: on macOS and Windows enforcement
relies on the agents' hooks rather than the kernel; command-level checks read the command, not
what a script it runs does internally; hostname rules are enforced by resolved address; anyone
with root on the machine can stop the daemon.
