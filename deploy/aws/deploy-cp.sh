#!/usr/bin/env bash
# Build, push and roll out the control plane (api.effigent.ai) to App Runner.
# One-time setup already done in account 628713530358 / us-east-1:
#   ECR repo effigent-cp · secrets effigent/cp/{database-url,signing-key,admin-token}
#   IAM roles effigent-cp-ecr-access (ECR pull) + effigent-cp-instance (read those 3 secrets)
#   App Runner service effigent-cp (0.25 vCPU / 0.5 GB, /healthz) · custom domain api.effigent.ai (Route 53)
# Usage: AWS_PROFILE=effigent deploy/aws/deploy-cp.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
export AWS_REGION=us-east-1
ACCT=628713530358
REPO="$ACCT.dkr.ecr.us-east-1.amazonaws.com/effigent-cp"
SERVICE_ARN=$(aws apprunner list-services --query "ServiceSummaryList[?ServiceName=='effigent-cp'].ServiceArn" --output text)
SHA=$(git rev-parse --short HEAD)

aws ecr get-login-password | docker login --username AWS --password-stdin "$ACCT.dkr.ecr.us-east-1.amazonaws.com" >/dev/null
docker buildx build --platform linux/amd64 -f Dockerfile.cp -t "${REPO}:${SHA}" -t "${REPO}:latest" --push .
aws apprunner start-deployment --service-arn "$SERVICE_ARN" --query OperationId --output text
until [ "$(aws apprunner describe-service --service-arn "$SERVICE_ARN" --query Service.Status --output text)" = RUNNING ]; do sleep 10; done
curl -fsS https://api.effigent.ai/healthz && echo "deployed $SHA"
