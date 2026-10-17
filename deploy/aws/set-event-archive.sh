#!/usr/bin/env bash
# Event archive for retention (run once in AWS CloudShell, account 628713530358;
# the deploy user can't manage S3 buckets, IAM or App Runner config):
#   bucket with Object Lock (GOVERNANCE, 365 days), no public access, archives
#   deleted after 1 year; the control plane may write/read events/*; App Runner
#   gets EFFIGENT_ARCHIVE_BUCKET. Agent events older than 90 days then move here.
set -euo pipefail
export AWS_REGION=us-east-1
B=effigent-event-archive-628713530358
aws s3api create-bucket --bucket $B --object-lock-enabled-for-bucket
aws s3api put-public-access-block --bucket $B --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-object-lock-configuration --bucket $B --object-lock-configuration '{"ObjectLockEnabled":"Enabled","Rule":{"DefaultRetention":{"Mode":"GOVERNANCE","Days":365}}}'
aws s3api put-bucket-lifecycle-configuration --bucket $B --lifecycle-configuration '{"Rules":[{"ID":"keep-1y","Status":"Enabled","Filter":{"Prefix":"events/"},"Expiration":{"Days":365},"NoncurrentVersionExpiration":{"NoncurrentDays":1},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":2}}]}'
aws iam put-role-policy --role-name effigent-cp-instance --policy-name effigent-cp-archive --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:PutObject","s3:GetObject","s3:AbortMultipartUpload"],"Resource":"arn:aws:s3:::'$B'/events/*"},{"Effect":"Allow","Action":"s3:ListBucket","Resource":"arn:aws:s3:::'$B'"}]}'
A=$(aws apprunner list-services --query "ServiceSummaryList[?ServiceName=='effigent-cp'].ServiceArn" --output text)
aws apprunner describe-service --service-arn $A --query Service.SourceConfiguration > /tmp/src.json
jq --arg b $B '.ImageRepository.ImageConfiguration.RuntimeEnvironmentVariables.EFFIGENT_ARCHIVE_BUCKET=$b' /tmp/src.json > /tmp/new.json
aws apprunner update-service --service-arn $A --source-configuration file:///tmp/new.json --query Service.Status --output text
