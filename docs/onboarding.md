# Onboarding a design partner (secure, per-org storage)

Effigent captures an org's agent runs and stores the run content **only in that
org's own S3 bucket** (S3-only residency). Effigent's database keeps just
metadata (cost, models, step count, timestamps) and a pointer — never raw
payloads. Capture is **refused until an org's bucket is configured**, so no data
lands before the workspace is deliberately provisioned.

## One-time AWS / Vercel setup (Effigent side)

1. **CMK (optional but recommended):** create a KMS key for run buckets; note its ARN.
2. **Dashboard IAM principal** (the identity the Vercel app runs as) — scope it to:
   - `s3:PutObject`, `s3:GetObject` on `arn:aws:s3:::effigent-runs-*/*`
   - `s3:CreateBucket` is **not** needed by the app (buckets are created by the
     owner-run script below).
   - `kms:GenerateDataKey`, `kms:Decrypt` on the CMK (if used)
   - `sts:AssumeRole` on partner BYO role ARNs (for the BYO path)
   The dashboard IAM also needs `s3:CreateBucket`, `s3:PutPublicAccessBlock`,
   `s3:PutBucketEncryption` for auto-provisioning, and `kms:GenerateDataKey`/
   `kms:Decrypt` on the CMK.
3. **Vercel env** (dashboard project): `AWS_REGION`, `AWS_ACCESS_KEY_ID`,
   `AWS_SECRET_ACCESS_KEY` (or Vercel OIDC), `EFFIGENT_S3_KMS_KEY` (the run-data
   CMK ARN), `EFFIGENT_S3_BUCKET_PREFIX` (optional),
   `CLERK_WEBHOOK_SIGNING_SECRET` (for the org.created webhook),
   `EFFIGENT_AWS_ACCOUNT_ID` (Effigent's 12-digit account — shown to partners and
   baked into the BYO CloudFormation template), and
   `EFFIGENT_EXTERNAL_ID_SECRET` (HMAC secret behind the per-org BYO external
   ids; set once and never rotate casually — rotating changes every org's
   external id and breaks existing BYO trust policies).
4. **Clerk webhook:** add an `organization.created` webhook pointing at
   `https://<dashboard>/api/v1/webhooks/clerk`; put its signing secret in the env
   var above.
5. **Schema:** once, `PROD_DATABASE_URL=… node scripts/apply-org-storage.mjs`.

## Per-partner onboarding

1. **Create the workspace (Clerk):** create a Clerk **Organization** for the
   partner and invite their users (Clerk owns invites/SSO). A Clerk org = an
   Effigent tenant; only that org's members can see its data.
2. **Provision storage — pick one:**
   - **Effigent-hosted bucket (default) — AUTOMATIC:** when the Clerk org is
     created, the `organization.created` webhook (`/api/v1/webhooks/clerk`)
     provisions `effigent-runs-<id>` (block-public-access + SSE-KMS with the
     Effigent CMK) and records it on the tenant. Nothing to run per org.
     Manual fallback (re-provision / pre-webhook orgs):
     ```
     AWS_REGION=us-east-1 PROD_DATABASE_URL=… \
       node scripts/provision-org-bucket.mjs --ref <clerk_org_id> [--kms <cmk-arn>]
     ```
   - **BYO bucket (partner's own AWS account):** in the dashboard **Storage**
     view, download the pre-filled CloudFormation template (external id +
     Effigent account id baked in; served by `GET /api/v1/storage/template`,
     requires `EFFIGENT_AWS_ACCOUNT_ID` in the env). The partner's cloud team
     runs one `aws cloudformation deploy` (or the Terraform module at
     `infra/aws/terraform/`), then an org admin pastes the stack outputs
     (bucket/region/roleArn) into the same view. Saving runs a write→read probe
     and only reports success if access works. Manual path: `docs/byo-s3-setup.md`.
     Orgs can switch between managed and BYO at any time from the Storage view
     (`PUT /api/v1/storage` with `{mode:'managed'}` switches back).
3. **Issue a capture key:** in the dashboard **Keys** view, mint a scoped `eff_`
   key for the partner's agent (shown once). Prefer a per-agent scoped key over
   the tenant owner key.
4. **Partner installs capture** (insights-only — no injection):
   ```
   npm i -g effigent
   effigent login --key eff_…            # tenant key: also used to auto-mint per-project keys
   effigent install claude               # ONE hook; each project becomes its own agent
   ```
   No `effigent agent add` needed for Claude Code: the hook resolves the agent per
   session from the transcript's cwd (`agentRules` → git repo name) and registers a
   scoped key for a project the first time it sees one. Pass
   `install claude --agent <agent>` only to pin every session to one agent
   (CI/single-purpose machines). Codex still takes an explicit
   `install codex --agent <agent>`.

   To keep a project from ever being captured, add an `excludeRules` entry to
   `~/.effigent/config.json` — a hard veto that `sync --all` cannot override:
   ```json
   { "excludeRules": [{ "pattern": "/client-work(/|$)", "note": "under NDA" }] }
   ```
5. **Verify:** after the partner's next session, a run appears under the agent in
   the dashboard; the object exists in the org's bucket; the `runs` row has an
   `s3://` `blob_path` and `parsed IS NULL`. Sessions from different repos must
   appear as **different agents**; sessions outside any repo appear as
   `unattributed`.

## Notes
- Before step 2, capture returns **409 "workspace storage not provisioned"** — a
  feature, not a bug: no bucket ⇒ no data.
- Tool **injection** is off in the POC (`EFFIGENT_ENABLE_INJECTION`); onboarding
  wires capture + read-only insights only.
