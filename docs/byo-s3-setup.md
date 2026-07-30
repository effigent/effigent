# Bring-your-own S3 bucket ("on-permit" storage)

For organizations that require captured run data to live **in their own AWS
account**, Effigent writes each run's (already-redacted) blob directly into a
bucket you own, by assuming a **cross-account IAM role you grant us**. Effigent
never stores your run content on its own infrastructure — the durable copy
exists only in your bucket. Our database keeps metadata (cost, model, step
count, timestamps) and a pointer.

This guide is for the partner's cloud/security team. Placeholders:

| Placeholder | Meaning | Who provides |
|---|---|---|
| `<EFFIGENT_AWS_ACCOUNT_ID>` | Effigent's AWS account that assumes your role | **Effigent** |
| `<EXTERNAL_ID>` | A per-org secret tying the trust to this workspace | **Effigent** (generated per org) |
| `<YOUR_BUCKET>` | The S3 bucket you create for Effigent runs | You |
| `<YOUR_REGION>` | The bucket's region, e.g. `us-east-1` | You |
| `<YOUR_KMS_KEY_ARN>` | *Optional* — your CMK if you want KMS encryption | You |

Ask Effigent for `<EFFIGENT_AWS_ACCOUNT_ID>` and `<EXTERNAL_ID>` before you start —
or skip the asking entirely with the quickstart below (both values are baked into
the template the dashboard serves).

---

## Quickstart — one command (recommended)

An Effigent org admin downloads the CloudFormation template from the dashboard
(**Storage → Customer S3 → Download the CloudFormation template** — it comes
pre-filled with your workspace's external id and Effigent's account id) and your
cloud team deploys it:

```bash
aws cloudformation deploy \
  --stack-name effigent-storage \
  --template-file effigent-byo-storage.yaml \
  --capabilities CAPABILITY_NAMED_IAM
```

That creates everything in Steps 1–2 below (private encrypted bucket +
least-privilege cross-account role). Then paste the stack **Outputs**
(bucket / region / role ARN) into the dashboard's **Storage** view — it saves and
immediately verifies access with a write→read probe. Optional parameters:
`BucketName=…` (else AWS generates one), `KmsKeyArn=…` (else SSE-S3).

Prefer Terraform? Use the module at `infra/aws/terraform/` with the same two
inputs (`effigent_account_id`, `external_id`). A raw copy of the CloudFormation
template lives at `infra/aws/effigent-byo-storage.yaml`.

To revoke Effigent's access at any time: delete the stack (or just the role).
Capture then fails closed.

The rest of this guide is the manual path — for teams that want to review or
hand-build each resource.

---

## What Effigent needs from you (checklist)

1. An S3 **bucket** (`<YOUR_BUCKET>` in `<YOUR_REGION>`), private, encrypted.
2. An IAM **role** Effigent can assume, that grants **only** `s3:PutObject` and
   `s3:GetObject` on that bucket (plus KMS if you use a CMK).
3. Hand back four values: **bucket name, region, role ARN, and the external id**
   you were given (and the KMS key ARN if you used one).

That's the entire surface. Effigent gets no other access to your account, and
the role is scoped to this one bucket.

---

## Step 1 — Create the bucket

Private, versioning optional, encryption on. Example (SSE-S3):

```bash
aws s3api create-bucket --bucket <YOUR_BUCKET> --region <YOUR_REGION> \
  --create-bucket-configuration LocationConstraint=<YOUR_REGION>
aws s3api put-public-access-block --bucket <YOUR_BUCKET> \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-encryption --bucket <YOUR_BUCKET> \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'
```

(For your own CMK, use `"SSEAlgorithm":"aws:kms","KMSMasterKeyID":"<YOUR_KMS_KEY_ARN>"` and add the KMS permissions shown in Step 2.)

## Step 2 — Create the cross-account role

**Trust policy** — lets *only* Effigent's account assume the role, and *only*
when it presents your external id (this prevents the "confused deputy" problem):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "AWS": "arn:aws:iam::<EFFIGENT_AWS_ACCOUNT_ID>:root" },
    "Action": "sts:AssumeRole",
    "Condition": { "StringEquals": { "sts:ExternalId": "<EXTERNAL_ID>" } }
  }]
}
```

**Permissions policy** on the role — the least privilege Effigent needs (write
new runs, read them back for the dashboard's deep-dive/insights):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EffigentRunBlobs",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::<YOUR_BUCKET>/*"
    }
  ]
}
```

If the bucket uses **your own KMS CMK**, also grant on that key:

```json
{
  "Sid": "EffigentRunBlobsKms",
  "Effect": "Allow",
  "Action": ["kms:GenerateDataKey", "kms:Decrypt"],
  "Resource": "<YOUR_KMS_KEY_ARN>"
}
```

Create it (Terraform/CloudFormation/console all fine); note the **role ARN**,
e.g. `arn:aws:iam::<YOUR_ACCOUNT>:role/effigent-run-storage`.

## Step 3 — Hand back to Effigent

Send: **bucket**, **region**, **role ARN**, the **external id**, and the **KMS
key ARN** (only if you used a CMK). An Effigent org admin enters these in the
dashboard **Storage** settings (`PUT /api/v1/storage`), which immediately runs a
**write→read probe** and only marks the workspace provisioned if the round-trip
succeeds — so you get instant confirmation the grant works.

---

## How Effigent accesses the bucket

At capture time, on Effigent's collector (a serverless function):

1. The incoming run is **redacted** at the single write choke point
   (`persistRun`) — API keys, credentials, tokens, emails, etc. → typed
   `[REDACTED:…]` placeholders — *before* anything is written.
2. The collector calls `sts:AssumeRole(<role ARN>, ExternalId=<EXTERNAL_ID>)`
   to obtain short-lived credentials (cached in-memory ~50 min, under the 1-hour
   STS session), then `PutObject` into your bucket.
3. Object layout: `<prefix?>/<agent>/<session-id>.json.gz` — gzipped JSON,
   server-side encrypted (SSE-S3 or your CMK).
4. Reads (the dashboard's DAG deep-dive and determinism insights) use the same
   assumed-role credentials to `GetObject` the blobs on demand.

**Security properties**
- Data lands **only** in your bucket. Effigent stores no run content itself
  (its DB keeps `blob_path = s3://<your-bucket>/…` + metadata, `parsed = null`).
- Run content transits the collector **in memory only**, redacted, and is never
  persisted on Effigent's side.
- The role is scoped to `PutObject`/`GetObject` on this one bucket; no list, no
  delete, no other bucket, no other service.
- The external-id condition means a leaked role ARN alone cannot be assumed —
  the caller must also be Effigent's account presenting your secret.
- **You hold the kill switch:** delete the role (or drop the trust) and Effigent
  loses all access instantly; capture then fails closed (ingest returns 409).

**Effigent-side requirement** (for reference — Effigent configures this): the
collector's own IAM principal in `<EFFIGENT_AWS_ACCOUNT_ID>` is granted
`sts:AssumeRole` on your role ARN. No long-lived keys to your account ever exist.

---

## Alternative: Effigent-hosted bucket

If you don't require data in your own account, Effigent provisions a dedicated,
per-org bucket in its account (block-public-access + encryption, one bucket per
organization, no cross-tenant access). Same redaction and residency-isolation
guarantees, zero setup on your side. See `docs/onboarding.md`.
