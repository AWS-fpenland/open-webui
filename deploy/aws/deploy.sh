#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Open WebUI on AWS — one-click CDK deployment (Mode 1)
# ============================================================
# Deploys Open WebUI to AWS (ECS Fargate + Aurora + optional Redis, fronted by
# CloudFront via a private VPC origin) directly from your machine.
#
# Defaults deploy the PRISTINE official Open WebUI image — no Docker build, no
# source modifications. All behavior is parameterized via flags or a config
# file (see cdk/config/*.json).
#
# Usage:
#   ./deploy.sh [--profile NAME] [--region REGION] [--config FILE]
#               [--domain DOMAIN --cert-arn ARN] [--app-name NAME]
#               [--bedrock] [--auth cognito] [--build] [--yes]
#
# Examples:
#   ./deploy.sh --profile prod                      # vanilla one-click
#   ./deploy.sh --profile prod --domain oui.example.com --cert-arn arn:aws:acm:us-east-1:...:certificate/xxxx
#   ./deploy.sh --profile prod --config cdk/config/example-bedrock-cognito.json
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDK_DIR="$SCRIPT_DIR/cdk"

AWS_PROFILE=""
AWS_REGION="us-east-1"
CONFIG_FILE=""
DOMAIN=""
CERT_ARN=""
APP_NAME=""
ENABLE_BEDROCK=""
AUTH_MODE=""
IMAGE_SOURCE=""
SKIP_CONFIRM=false

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'
log(){ echo -e "${GREEN}[✓]${NC} $*"; }
warn(){ echo -e "${YELLOW}[!]${NC} $*"; }
err(){ echo -e "${RED}[✗]${NC} $*" >&2; }
info(){ echo -e "${CYAN}[→]${NC} $*"; }

usage(){ grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -28; exit 0; }

while [[ $# -gt 0 ]]; do
  case $1 in
    --profile) AWS_PROFILE="$2"; shift 2;;
    --region) AWS_REGION="$2"; shift 2;;
    --config) CONFIG_FILE="$2"; shift 2;;
    --domain) DOMAIN="$2"; shift 2;;
    --cert-arn) CERT_ARN="$2"; shift 2;;
    --app-name) APP_NAME="$2"; shift 2;;
    --bedrock) ENABLE_BEDROCK="true"; shift;;
    --auth) AUTH_MODE="$2"; shift 2;;
    --build) IMAGE_SOURCE="build"; shift;;
    --yes) SKIP_CONFIRM=true; shift;;
    --help|-h) usage;;
    *) err "Unknown option: $1"; usage;;
  esac
done

aws_cmd(){ if [[ -n "$AWS_PROFILE" ]]; then aws --profile "$AWS_PROFILE" --region "$AWS_REGION" "$@"; else aws --region "$AWS_REGION" "$@"; fi; }

# ── Preflight ──
for c in aws node npm; do command -v "$c" >/dev/null 2>&1 || { err "$c is required"; exit 1; }; done
CDK="npx cdk"; command -v cdk >/dev/null 2>&1 && CDK="cdk"

# Building from source needs a Docker daemon; registry mode does not.
if [[ "$IMAGE_SOURCE" == "build" ]]; then
  docker info >/dev/null 2>&1 || { err "--build requires a running Docker daemon (CDK builds the image)."; exit 1; }
fi

# ── Assemble CDK context from flags ──
CTX=("-c" "region=$AWS_REGION")
[[ -n "$CONFIG_FILE" ]] && CTX+=("-c" "configFile=$CONFIG_FILE")
[[ -n "$APP_NAME" ]] && CTX+=("-c" "appName=$APP_NAME")
[[ -n "$IMAGE_SOURCE" ]] && CTX+=("-c" "imageSource=$IMAGE_SOURCE")
[[ -n "$ENABLE_BEDROCK" ]] && CTX+=("-c" "bedrockEnabled=true")
[[ -n "$AUTH_MODE" ]] && CTX+=("-c" "authMode=$AUTH_MODE")
if [[ -n "$DOMAIN" ]]; then
  [[ -z "$CERT_ARN" ]] && { err "--domain requires --cert-arn (ACM cert in us-east-1)"; exit 1; }
  CTX+=("-c" "environment=default" "-c" "domainName=$DOMAIN" "-c" "certificateArn=$CERT_ARN")
fi

# ── Credentials + account ──
info "Validating AWS credentials..."
ACCOUNT_ID=$(aws_cmd sts get-caller-identity --query Account --output text) || { err "AWS credentials invalid for profile '$AWS_PROFILE'"; exit 1; }
log "Account $ACCOUNT_ID / region $AWS_REGION"
CTX+=("-c" "account=$ACCOUNT_ID")

# Export creds so CDK (SSO profiles) can assume bootstrap roles.
if [[ -n "$AWS_PROFILE" ]]; then eval "$(aws --profile "$AWS_PROFILE" configure export-credentials --format env 2>/dev/null)" || true; fi

echo ""
echo -e "  ${BOLD}Open WebUI → AWS${NC}"
echo -e "  Account:   ${BOLD}$ACCOUNT_ID${NC}"
echo -e "  Region:    ${BOLD}$AWS_REGION${NC}"
echo -e "  Config:    ${BOLD}${CONFIG_FILE:-<built-in defaults: official image, no auth, no bedrock>}${NC}"
echo -e "  Domain:    ${BOLD}${DOMAIN:-<CloudFront default domain>}${NC}"
echo -e "  Image:     ${BOLD}${IMAGE_SOURCE:-registry (official prebuilt)}${NC}"
echo ""
if [[ "$SKIP_CONFIRM" != "true" ]]; then read -rp "$(echo -e "${YELLOW}?${NC}") Proceed? [Y/n]: " yn; [[ -z "$yn" || "$yn" =~ ^[Yy] ]] || { warn "Aborted."; exit 0; }; fi

cd "$CDK_DIR"
info "Installing CDK dependencies..."
npm install --silent

info "Bootstrapping CDK (idempotent)..."
CDK_DEFAULT_ACCOUNT="$ACCOUNT_ID" CDK_DEFAULT_REGION="$AWS_REGION" $CDK bootstrap "aws://$ACCOUNT_ID/$AWS_REGION" "${CTX[@]}"

info "Deploying all stacks..."
CDK_DEFAULT_ACCOUNT="$ACCOUNT_ID" CDK_DEFAULT_REGION="$AWS_REGION" $CDK deploy --all "${CTX[@]}" --require-approval broadening

# ── Resolve the app URL from the Compute stack output ──
PREFIX="${APP_NAME:-OpenWebUI}"
APP_URL=$(aws_cmd cloudformation describe-stacks --stack-name "${PREFIX}-Compute" --query "Stacks[0].Outputs[?OutputKey=='AppUrl'].OutputValue" --output text 2>/dev/null || echo "")

echo ""
log "Deployment complete 🚀"
[[ -n "$APP_URL" ]] && echo -e "  ${GREEN}App URL:${NC} ${BOLD}$APP_URL${NC}"
if [[ "$AUTH_MODE" == "cognito" ]]; then
  warn "Cognito mode: sync the client secret into Secrets Manager and confirm callback URLs — see deploy/aws/docs/MODE-1-one-click.md"
fi
