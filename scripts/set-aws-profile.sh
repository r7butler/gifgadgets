#!/usr/bin/env bash
# Source this script to set the AWS profile:
#   source ./scripts/set-aws-profile.sh

export AWS_PROFILE="${1:-gifwidgets}"
echo "AWS_PROFILE set to: $AWS_PROFILE"

if ! aws sts get-caller-identity >/dev/null 2>&1; then
  echo "No valid session. Run: aws sso login --profile $AWS_PROFILE"
else
  aws sts get-caller-identity --query '{Account:Account,Arn:Arn}' --output table
fi
