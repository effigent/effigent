#!/usr/bin/env bash
# Turn on Slack approvals with approver identity: store EFFIGENT_SECRETS_KEY
# (generated here; seals each workspace's Slack bot token and signing secret)
# and CLERK_SECRET_KEY (matches Slack approvers to console admins) in Secrets
# Manager and point the control plane (App Runner effigent-cp) at them.
# Run once in AWS CloudShell (account 628713530358) or with an admin profile
# for that account — the deploy user can't manage secrets or IAM.
# Re-running keeps the existing secrets key (a new one would disconnect every
# Slack app) and only replaces the Clerk key. Nothing secret is printed.
set -euo pipefail
export AWS_REGION=us-east-1
ROLE=effigent-cp-instance
[ "$(aws sts get-caller-identity --query Account --output text)" = 628713530358 ] || { echo "wrong AWS account: use Effigent's (628713530358)" >&2; exit 1; }

read -rsp "Clerk secret key (sk_live_…, hidden; same value as CLERK_SECRET_KEY in Vercel): " CLERK; echo
case "$CLERK" in sk_live_*|sk_test_*) ;; *) echo "that doesn't look like a Clerk secret key (sk_live_…)" >&2; exit 1 ;; esac

TMP=$(mktemp); chmod 600 "$TMP"; trap 'rm -f "$TMP"' EXIT
store() { # name description -> ARN; value from $TMP
  if arn=$(aws secretsmanager describe-secret --secret-id "$1" --query ARN --output text 2>/dev/null); then
    aws secretsmanager put-secret-value --secret-id "$1" --secret-string "file://$TMP" >/dev/null
  else
    arn=$(aws secretsmanager create-secret --name "$1" --description "$2" --secret-string "file://$TMP" --query ARN --output text)
  fi
  echo "$arn"
}

echo "==> EFFIGENT_SECRETS_KEY (effigent/cp/secrets-key)"
if KEY_ARN=$(aws secretsmanager describe-secret --secret-id effigent/cp/secrets-key --query ARN --output text 2>/dev/null); then
  echo "    exists — kept"
else
  openssl rand -base64 48 | tr -d '\n' > "$TMP"
  KEY_ARN=$(store effigent/cp/secrets-key "Effigent control plane key that seals tenant Slack credentials")
fi
echo "==> CLERK_SECRET_KEY (effigent/cp/clerk-secret-key)"
printf '%s' "$CLERK" > "$TMP"; unset CLERK
CLERK_ARN=$(store effigent/cp/clerk-secret-key "Clerk Backend API key (Slack approvers -> console roles)")
rm -f "$TMP"

echo "==> Letting the control plane read them ($ROLE)"
aws iam put-role-policy --role-name "$ROLE" --policy-name effigent-cp-slack --policy-document "$(python3 -c '
import json, sys
print(json.dumps({"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "secretsmanager:GetSecretValue", "Resource": sys.argv[1:]}]}))' "$KEY_ARN" "$CLERK_ARN")"

echo "==> Updating the App Runner service"
SERVICE_ARN=$(aws apprunner list-services --query "ServiceSummaryList[?ServiceName=='effigent-cp'].ServiceArn" --output text)
SRC=$(aws apprunner describe-service --service-arn "$SERVICE_ARN" --query Service.SourceConfiguration --output json)
export SRC KEY_ARN CLERK_ARN
NEW=$(python3 -c '
import json, os
src = json.loads(os.environ["SRC"])
sec = src["ImageRepository"].setdefault("ImageConfiguration", {}).setdefault("RuntimeEnvironmentSecrets", {})
sec["EFFIGENT_SECRETS_KEY"] = os.environ["KEY_ARN"]
sec["CLERK_SECRET_KEY"] = os.environ["CLERK_ARN"]
print(json.dumps(src))')
aws apprunner update-service --service-arn "$SERVICE_ARN" --source-configuration "$NEW" --query Service.Status --output text
until [ "$(aws apprunner describe-service --service-arn "$SERVICE_ARN" --query Service.Status --output text)" = RUNNING ]; do sleep 10; done
curl -fsS https://api.effigent.ai/healthz >/dev/null && echo "Done. Console → Settings → Approvals → Slack app: Create the Slack app."
