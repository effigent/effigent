# SOC 2 readiness: gap list and plan

**Internal working document (2026-10-21). Effigent has no SOC 2 report and is not certified.**
No audit firm is engaged and no compliance platform is set up. Outside, say "SOC 2: in
progress, no report yet", which is the wording of the architecture doc and checklist item 28.
Don't say "SOC 2 compliant" or name a date until an auditor has agreed one.

Each row below was checked against the repo and deploy scripts at commit f9a7774, plus the
GitHub API on 2026-10-21. "Unknown" means it lives in an account or console we didn't look
at (AWS, Neon, Clerk, Vercel, Google Workspace), not that it is missing.

## 1. What exists today

| Area | What exists | Evidence |
|---|---|---|
| Encryption in transit | TLS on every hop: endpoint→API, console→API, API→providers | `api.effigent.ai` (App Runner), Vercel, `EFFIGENT_SMTP_URL`/SES |
| Encryption at rest | DB encrypted by the provider. S3 archive uses SSE-S3 with Object Lock. Integration secrets are sealed with AES-256-GCM (AAD = tenant + field) | `server/secrets.go`, `deploy/aws/set-event-archive.sh` |
| Secrets management | Server secrets in AWS Secrets Manager (`effigent/cp/*`), read only by the instance role `effigent-cp-instance` | `deploy/aws/deploy-cp.sh` header |
| Tenant isolation | Every query is scoped to the caller's tenant. Endpoint credentials are bound to one tenant, and each policy is signed for one machine | `server/auth.go`, `compile/`, CLAUDE.md §2 |
| Customer-facing audit trail | Append-only, hash-chained per tenant. Verifiable via `GET /api/v1/audit/verify`. Records refused attempts (`denied.*`) | `store/migrations/002_audit.sql`, `server/auth.go` |
| Integrity of customer data | Event batches hash-chained per endpoint and computed by Postgres. `cp.events` append-only by trigger. Legal hold | migrations 007, 015 |
| Policy integrity | Ed25519-signed policies; tenant and machine pinned at enrollment | `internal/shared/sign`, `cpclient` |
| Credential storage | Enrollment tokens, machine secrets and API keys stored as SHA-256 hashes only | `store/` |
| App-level access control | Roles admin / security_admin / read-only from Clerk. Scoped API keys. Admin token limited to the tenants in `EFFIGENT_ADMIN_TENANTS` | `server/auth.go` |
| Rate limits | Per IP, per enrollment IP, per console user | `server/ratelimit.go` |
| Retention | 90 days online minimum, configurable per workspace. Daily archives with 365-day governance-mode Object Lock. Nothing is deleted without a verified upload | `server/retention.go`, CLAUDE.md §2c |
| Release tests | `go test ./... && go vet ./...` gate the effigentd release workflow. sha256 files are published next to the binaries | `.github/workflows/release-effigentd.yml`, `deploy/release/build-effigentd.sh` |
| Product change control (for customers) | Optional two-person approval of policy changes (proposals), two-person approvals for actions | migrations 012, 013 |

## 2. Gaps by Trust Services area

Ordered roughly by audit risk. **Status:** *missing* = no trace in the repo and probably not
done. *unknown* = lives outside the repo; check it.

### Access control (CC6)

| # | Gap | Status | Action |
|---|---|---|---|
| A1 | **`main` has no branch protection or rulesets** (`gh api …/branches/main/protection` → 404 "Branch not protected"; rulesets `[]`). Pushing `main` deploys the console (Vercel) and the site | missing | Protect `main`: PRs, one review, required checks, no force-push. One-person teams use a documented self-review exception or a second reviewer |
| A2 | **The repository `effigent/effigent` is public** (GitHub API: `"visibility": "public"`). The architecture doc is marked "Confidential — shared under NDA" and lives in it | needs decision | Decide on purpose: either make it private, or accept it as public and remove confidentiality markings. Auditors will ask |
| A3 | MFA on every admin console: AWS root and IAM, GitHub org, Vercel, Clerk, Neon, Google Workspace / email, DNS registrar | unknown | Turn on and record MFA everywhere. Use SSO where the plan allows (Clerk's Business plan has SSO for its own dashboard) |
| A4 | One AWS account (628713530358) runs prod, deploys and the site. There is some role separation: the deploy user can't manage S3/IAM/App Runner, so that is done in CloudShell | partial | Write down who holds which IAM identity. Consider an AWS Organization with a separate prod account. Enable IAM Access Analyzer |
| A5 | **Long-lived AWS access keys in GitHub secrets** (`AWS_ACCESS_KEY_ID` in both workflows) | missing | Switch to GitHub OIDC → an IAM role scoped to the site bucket. Rotate the current keys |
| A6 | `EFFIGENT_ADMIN_TOKEN` (`effigent/cp/admin-token`) is a static superuser credential for the tenants in `EFFIGENT_ADMIN_TENANTS` | unknown | Check the prod value of `EFFIGENT_ADMIN_TENANTS`. Ideally empty in prod. If it is kept, rotate it, log its use (it already appears in the audit trail as `via: admin-token`) and limit who can read the secret |
| A7 | Quarterly access reviews for AWS, GitHub, Vercel, Clerk, Neon, plus a joiner/leaver checklist | missing | Use the compliance platform's access-review module |
| A8 | Production database access: who can connect to the Neon DB directly, and whether those connections are logged | unknown | Limit it to named people, turn on provider logging, record break-glass access |

### Change management (CC8)

| # | Gap | Status | Action |
|---|---|---|---|
| C1 | **The control plane is deployed by hand from a laptop** (`AWS_PROFILE=effigent deploy/aws/deploy-cp.sh`). It builds the **working tree**, so uncommitted changes ship, and tags the image with `git rev-parse --short HEAD`. The tag doesn't prove what's in the image | missing | Deploy from CI on a protected branch or tag. Refuse a dirty tree. Keep a deploy log (who, when, which commit). App Runner's deployment history helps; record it |
| C2 | **No CI on push or pull request.** Tests and vet run only in the effigentd release workflow. The control plane and console ship without an automated test gate. DB tests need Postgres and run by hand | missing | Add a CI workflow on PRs: `go test ./...`, the DB tests against a Postgres service, `go vet`, the console typecheck and build. Make it a required check (A1) |
| C3 | Database migrations run on boot (`st.Migrate` in `cmd/effigent-cp/main.go`), so a deploy changes the schema with no separate approval or rollback plan | partial | Document migration review in the PR template. Back up or snapshot before migrations with destructive steps |
| C4 | No dependency or code scanning: Dependabot alerts endpoint → 404 (not enabled), no code-scanning analyses, no SAST in workflows | missing | Turn on Dependabot alerts and security updates, add `govulncheck` and `npm audit` (or the platform's scanner) to CI, and CodeQL if the repo stays on GitHub |
| C5 | **Release integrity.** sha256 files sit in the same S3 bucket as the binaries: integrity, not authenticity. The macOS pkg is signed only when `SIGN_ID` is set, and no notarization step is visible. The ghcr image has no signature or provenance | partial | Sign releases (cosign/Sigstore for binaries and image), notarize the macOS pkg, publish SBOMs. The install script checks the signature |
| C6 | Written change-management policy (what needs review, emergency changes, hotfixes) | missing | Policy template from the platform, adapted to the actual workflow |

### Logging and monitoring (CC7)

| # | Gap | Status | Action |
|---|---|---|---|
| L1 | Infrastructure logs: App Runner application logs go to CloudWatch by default; retention not checked. CloudTrail status unknown | unknown | Turn on CloudTrail (all regions, log-file validation), set CloudWatch retention to ≥1 year, alarm on root login and IAM changes |
| L2 | No alerting on the service itself beyond App Runner's `/healthz` | missing | Uptime monitor on `api.effigent.ai/healthz` and `app.effigent.ai`. Alarm on 5xx rate and on failed archive uploads |
| L3 | GuardDuty / Security Hub not visible | unknown | Turn on GuardDuty and route its findings to email/Slack |
| L4 | The console audit trail covers customer actions. Operator actions in AWS/Neon/Clerk are recorded only in those providers | partial | CloudTrail (L1), provider audit logs, retained and reviewed |

### Availability, backups, continuity (A1, CC9)

| # | Gap | Status | Action |
|---|---|---|---|
| B1 | Database backups: per the architecture doc the DB is Neon (US). Point-in-time restore window depends on the Neon plan. **No restore has ever been tested** | unknown | Confirm the provider and plan, set PITR ≥7 days, take a documented quarterly restore test into a scratch branch |
| B2 | The S3 archive is versioned and Object-Locked (governance, 365 days) | exists | Include it in the restore test |
| B3 | Single region (us-east-1); App Runner instance 0.25 vCPU / 0.5 GB | accepted | Write down RTO/RPO. Endpoints keep enforcing offline, which is a real continuity property (architecture doc §5) |
| B4 | No business continuity or disaster recovery plan | missing | Short BCP/DR plan: who restores what, from where, in what order (DB → control plane → DNS) |
| B5 | Signing key (`effigent/cp/signing-key`) loss or compromise plan. Endpoints pin the public key at enrollment | missing | Key backup (escrow), plus a rotation procedure: re-enrollment or a signed key-rollover message (not built) |

### Vendor management (CC9.2)

| # | Gap | Status | Action |
|---|---|---|---|
| V1 | No vendor or sub-processor register | missing | Start from `dpa-template.md` §6: AWS, Neon (confirm), Clerk, Vercel, Anthropic (policy assistant), Slack (off), GitHub (distribution) |
| V2 | Vendor SOC 2 reports / DPAs not collected | missing | Download AWS (Artifact), Clerk, Vercel and Neon SOC 2 reports and DPAs. Review them yearly |

### Incident response (CC7.3–7.5)

| # | Gap | Status | Action |
|---|---|---|---|
| I1 | No incident-response plan or runbook. Contact `security@effigent.ai` (architecture doc); monitoring of that mailbox not verified | missing | IR plan: severity levels, roles, the customer notice commitments from the DPA (without undue delay, target ≤48 h), the Israeli PPA notice duty, a post-mortem template. Run one tabletop exercise |
| I2 | No vulnerability disclosure policy (`SECURITY.md` absent) | missing | Add `SECURITY.md` and an effigent.ai/security disclosure section |
| I3 | No pen test | missing | External pen test of the API, console and endpoint before the Type I report (auditors and customers will ask) |

### Organisation and HR (CC1–CC3, CC5)

These are all **missing** from the repo, and are normally kept in the compliance platform:
- Information security policy set
- Risk assessment and risk register
- Security awareness training
- Background checks
- Acceptable-use and confidentiality agreements
- Asset inventory: laptops with disk encryption and MDM
- Board/management oversight record

### Privacy (if the Privacy criteria are in scope)

Data inventory: architecture doc §3. DPA: `dpa-template.md`. Employee-monitoring guidance:
`employee-monitoring.md`. Retention and legal hold are built. Recommendation: start the first
report with **Security only**, and add Availability and Confidentiality once B1–B4 are done.
Leave Privacy and Processing Integrity out at first.

## 3. Suggested path

1. **Pick a compliance platform** (Vanta, Drata, Secureframe or similar), weeks 0–2. Connect
   AWS, GitHub, Google Workspace, Vercel, Clerk where supported, the HR source and laptops. The
   platform turns most of §2 into tracked tests and supplies the policy templates.
2. **Fix the engineering gaps**, weeks 2–8. Most of the work is A1–A5, C1, C2, C4, L1–L3, B1
   and B5. These are also what customers' security reviews ask about first. Each is days of
   work, not weeks.
3. **Write and adopt policies and evidence**, in parallel: policies, risk assessment, vendor
   register, IR plan with a tabletop, access review, restore test, pen test.
4. **SOC 2 Type I** (design of controls at a point in time). Engage an auditor (the platforms
   have partner firms) once the platform shows the controls passing, around months 2–3. The
   report usually arrives a few weeks after fieldwork.
5. **SOC 2 Type II** (controls operating over time). Start the observation window as soon as
   the Type I controls are in place. A first window is commonly 3 months, then 6–12 months for
   the following reports. The report is roughly months 6–9 from the start.

The timeline assumes a team of one or two engineers and no major redesign. It is an estimate,
not a quote. Auditor and platform prices are quote-based, so get quotes before budgeting.

**While the audit is pending:** keep answering SIG Lite / CAIQ / custom questionnaires from
`docs/security/architecture-and-data-flow.md`. Share the AWS, Clerk, Vercel and Neon SOC 2
reports under NDA as evidence of the infrastructure layer, and say clearly that they cover the
providers, not Effigent.
