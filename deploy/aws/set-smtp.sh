#!/usr/bin/env bash
# Turn on approval emails: store the SMTP login in Secrets Manager and point
# the control plane (App Runner effigent-cp) at it. Run once, in a terminal,
# with an AWS profile that can manage Secrets Manager, IAM and App Runner
# (the deploy user can't):
#   AWS_PROFILE=<admin profile> deploy/aws/set-smtp.sh
# Re-run to change the login or the From address. Nothing secret is printed.
set -euo pipefail
export AWS_REGION=us-east-1
SECRET=effigent/cp/smtp-url
ROLE=effigent-cp-instance

read -rp "SMTP host (e.g. smtp.gmail.com, email-smtp.us-east-1.amazonaws.com): " HOST
read -rp "Port [587]: " PORT; PORT=${PORT:-587}
read -rp "Username: " SMTP_USER
read -rsp "Password (hidden): " SMTP_PASS; echo
read -rp "Send from, e.g. Effigent <approvals@effigent.ai>: " FROM
[ -n "$HOST" ] && [ -n "$SMTP_USER" ] && [ -n "$SMTP_PASS" ] && [ -n "$FROM" ] || { echo "all fields are required" >&2; exit 1; }
SCHEME=smtp; [ "$PORT" = 465 ] && SCHEME=smtps

# Build smtp://user:pass@host:port with the parts URL-encoded (from env, not argv).
export SMTP_USER SMTP_PASS HOST PORT SCHEME
URL=$(python3 -c 'import os, urllib.parse as u; e=os.environ; q=lambda k: u.quote(e[k], safe=""); print("%s://%s:%s@%s:%s" % (e["SCHEME"], q("SMTP_USER"), q("SMTP_PASS"), e["HOST"], e["PORT"]))')
unset SMTP_PASS

echo "==> Storing the SMTP login in Secrets Manager ($SECRET)"
# via a private temp file, so the login never appears in a process list
TMP=$(mktemp); chmod 600 "$TMP"; trap 'rm -f "$TMP"' EXIT
printf '%s' "$URL" > "$TMP"; unset URL
if ARN=$(aws secretsmanager describe-secret --secret-id "$SECRET" --query ARN --output text 2>/dev/null); then
  aws secretsmanager put-secret-value --secret-id "$SECRET" --secret-string "file://$TMP" >/dev/null
else
  ARN=$(aws secretsmanager create-secret --name "$SECRET" --description "Effigent control plane SMTP login (approval emails)" \
    --secret-string "file://$TMP" --query ARN --output text)
fi
rm -f "$TMP"

echo "==> Letting the control plane read it ($ROLE)"
aws iam put-role-policy --role-name "$ROLE" --policy-name effigent-cp-smtp --policy-document "$(python3 -c '
import json, sys
print(json.dumps({"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "secretsmanager:GetSecretValue", "Resource": sys.argv[1]}]}))' "$ARN")"

echo "==> Updating the App Runner service"
SERVICE_ARN=$(aws apprunner list-services --query "ServiceSummaryList[?ServiceName=='effigent-cp'].ServiceArn" --output text)
SRC=$(aws apprunner describe-service --service-arn "$SERVICE_ARN" --query Service.SourceConfiguration --output json)
export SRC ARN FROM
NEW=$(python3 -c '
import json, os
src = json.loads(os.environ["SRC"])
cfg = src["ImageRepository"].setdefault("ImageConfiguration", {})
cfg.setdefault("RuntimeEnvironmentVariables", {})["EFFIGENT_EMAIL_FROM"] = os.environ["FROM"]
cfg.setdefault("RuntimeEnvironmentSecrets", {})["EFFIGENT_SMTP_URL"] = os.environ["ARN"]
print(json.dumps(src))')
aws apprunner update-service --service-arn "$SERVICE_ARN" --source-configuration "$NEW" --query Service.Status --output text
until [ "$(aws apprunner describe-service --service-arn "$SERVICE_ARN" --query Service.Status --output text)" = RUNNING ]; do sleep 10; done
curl -fsS https://api.effigent.ai/healthz >/dev/null && echo "Done. Console → Settings → Approvals: add recipients and press Send test."
