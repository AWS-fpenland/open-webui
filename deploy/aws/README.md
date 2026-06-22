# Open WebUI on AWS

Additive, parameterized AWS deployment infrastructure for [Open WebUI](https://github.com/open-webui/open-webui).

This directory is **purely additive**: it adds `deploy/aws/` and touches **no upstream
files**. The application image is never modified — by default the deployment pulls the
official prebuilt `ghcr.io/open-webui/open-webui` image. You can keep `main` in sync with
upstream and rebase this directory on top with zero conflicts.

## Architecture

```
        Internet
           │  HTTPS (TLS, WebSocket)
           ▼
   ┌───────────────┐
   │  CloudFront    │  custom domain or *.cloudfront.net
   └───────┬───────┘
           │  VPC origin (private link — no public ALB)
           ▼
   ┌───────────────┐   private subnets
   │ Internal ALB   │   idle timeout 3600s (long generations + WS)
   └───────┬───────┘
           ▼
   ┌───────────────┐   ECS Fargate (private), autoscaled
   │  Open WebUI    │   official image :v0.9.6 — port 8080
   └───┬───────┬───┘
       │       │
       ▼       ▼
  ┌─────────┐ ┌──────────────┐ ┌──────────────┐
  │ Aurora  │ │ ElastiCache  │ │      S3       │
  │ Postgres│ │ Redis (TLS)  │ │ uploads (s3) │
  │ Svrlss v2│ │ Socket.IO mgr│ │              │
  └─────────┘ └──────────────┘ └──────────────┘
```

**Why this shape:** CloudFront shipped **WebSocket support for VPC origins on
2026-05-01**, so the ALB stays *private* (reached only through CloudFront's VPC origin)
while Socket.IO WebSocket traffic flows end-to-end. There is no public load balancer.
Redis backs the Socket.IO manager so multiple tasks share session state with no sticky
sessions required.

## What gets deployed

| Stack | Resources |
|---|---|
| `…-Network` | VPC, public/private subnets, NAT, S3 + interface endpoints, security groups |
| `…-Data` | Aurora PostgreSQL Serverless v2, ElastiCache Redis (TLS, when WebSocket enabled), S3 upload bucket |
| `…-Auth` *(optional)* | Cognito user pool + OIDC client + groups — only when `auth.mode=cognito` |
| `…-Compute` | ECS Fargate, internal ALB, CloudFront VPC-origin distribution, Secrets Manager |
| `…-Pipeline` *(optional)* | CodePipeline + CodeBuild deploy/smoke stages — modes 2 & 3 |

## Three deployment modes

| Mode | What it is | Guide |
|---|---|---|
| **1 — One-click CDK** | Deploy straight from your machine. | [docs/MODE-1-one-click.md](docs/MODE-1-one-click.md) |
| **2 — Single-env pipeline** | CodePipeline wired to a Git repo, deploys one environment on push. | [docs/MODE-2-single-pipeline.md](docs/MODE-2-single-pipeline.md) |
| **3 — Multi-env pipeline** | Flexible dev → staging → prod (or any envs) with approval gates + smoke tests. | [docs/MODE-3-multi-env-pipeline.md](docs/MODE-3-multi-env-pipeline.md) |

## Quick start (Mode 1, vanilla)

```bash
cd deploy/aws
./deploy.sh --profile YOUR_AWS_PROFILE
```

That deploys pristine official Open WebUI behind CloudFront. Add a custom domain:

```bash
./deploy.sh --profile YOUR_AWS_PROFILE \
  --domain oui.example.com \
  --cert-arn arn:aws:acm:us-east-1:ACCOUNT:certificate/XXXX   # ACM cert MUST be in us-east-1
```

Or drive CDK directly:

```bash
cd deploy/aws/cdk
npm install
npx cdk deploy --all -c account=$(aws sts get-caller-identity --query Account --output text)
```

## Configuration

Everything is parameterized. Precedence: **CDK context (`-c key=value`) > config file
(`-c configFile=…`) > built-in defaults**. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md)
for the full reference. The headline knobs:

| Key | Default | Meaning |
|---|---|---|
| `image.source` | `registry` | `registry` = official prebuilt image; `build` = build this repo's Dockerfile |
| `image.tag` | `v0.9.6` | Pinned Open WebUI version (never `:main`) |
| `auth.mode` | `none` | `none` = built-in auth; `cognito` = add Cognito SSO |
| `bedrock.enabled` | `false` | Grant Bedrock IAM + set `ENABLE_BEDROCK_API` (requires Bedrock code in the image) |
| `websocket.enabled` | `true` | Native WebSocket over the VPC origin + Redis Socket.IO manager |
| `environments` | one `default` env | Map of env name → sizing/domain; drives multi-env pipelines |

Example config files live in [`cdk/config/`](cdk/config/):
- `defaults.json` — pristine one-click (loaded automatically)
- `example-single-pipeline.json` — mode 2
- `example-multi-env-pipeline.json` — mode 3
- `example-bedrock-cognito.json` — opt-in Bedrock provider + Cognito SSO, build-from-source

## How it stays upstream-clean

- **No upstream files changed.** Everything lives under `deploy/aws/`.
- **Image untouched.** `DATABASE_URL` is composed at container start via an ECS *command
  override* (`export DATABASE_URL=… && exec bash start.sh`) because upstream `env.py` reads
  `DATABASE_URL` directly. No `start.sh` patch, no Dockerfile edit.
- **Fork features are opt-in.** Bedrock, Cognito, and the AgentCore-WebSocket IAM grant are
  all `false`/`none` by default.

See [docs/UPSTREAM-SYNC.md](docs/UPSTREAM-SYNC.md) for keeping the fork in sync and for the
upstream-contribution checklist (Open WebUI requires a Discussion first and has a CLA).

## Validation

```bash
cd deploy/aws/cdk
npm install
npx tsc --noEmit                                  # type check
npx cdk synth -c account=123456789012             # mode 1
npx cdk synth -c configFile=config/example-multi-env-pipeline.json -c account=123456789012
```

## Cost note

Baseline (1 Fargate task, Aurora min 0.5 ACU, 1× cache.t3.micro Redis, 2 NAT gateways,
CloudFront) runs on the order of low-hundreds USD/month and scales with traffic. NAT
gateways and Aurora are the main fixed costs — drop to `natGateways: 1` and Redis-less
(`websocket.enabled` with a single task) for the cheapest dev footprint.
