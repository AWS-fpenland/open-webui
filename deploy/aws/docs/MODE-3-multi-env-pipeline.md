# Mode 3 — Flexible multi-environment pipeline

A single CodePipeline that promotes a build through several environments — the classic
`dev → staging → prod`, or any set of environments you define — with per-stage manual
approval gates and smoke tests.

## Pipeline shape (example config)

```
Source
   │
   ▼
Dev        Deploy-Dev → Smoke-Dev
   │
   ▼
Staging    Approve-Staging → Deploy-Staging → Smoke-Staging
   │
   ▼
Prod       Approve-Prod → Deploy-Prod → Smoke-Prod
```

Each stage's actions are driven by its entry in `pipeline.stages`:

```json
"stages": [
  { "environment": "dev",     "smokeTest": true },
  { "environment": "staging", "manualApprovalBefore": true, "smokeTest": true },
  { "environment": "prod",    "manualApprovalBefore": true, "smokeTest": true }
]
```

- `manualApprovalBefore` — insert a human approval gate before this stage deploys.
- `smokeTest` — run `/health` + `/api/config` HTTP checks after this stage deploys.

## Fully flexible

The environment set is **whatever you declare**. Want `dev → test → staging → prod`? Add a
`test` environment to `environments` and a stage for it. Want just `dev → prod`? Remove
`staging`. Each environment gets its own isolated stack set (`OpenWebUI-<Env>-Network/
Data/Compute` and, with Cognito, `-Auth`), so they don't share a VPC, database, or domain.

Per-environment sizing is independent — the example runs dev at 1 task / no autoscaling /
small Aurora, and prod at 2+ tasks / autoscaling / larger Aurora across 3 AZs.

## Configure & deploy

```bash
cd deploy/aws/cdk
cp config/example-multi-env-pipeline.json config/my-envs.json
# edit: pipeline.connectionArn / repoOwner / repoName / approvalEmail,
#       and each environment's sizing + domainName/certificateArn

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
npx cdk deploy OpenWebUI-Pipeline -c configFile=config/my-envs.json -c account=$ACCOUNT
```

Only the pipeline stack is deployed by this command. The pipeline then deploys each
environment in order, pausing at approval gates (an email is sent to `approvalEmail` if
set; approve in the CodePipeline console).

## Image consistency across environments

With `image.source=build`, the **same image digest** is promoted across every environment
(the DockerImageAsset hash is deterministic from the source tree, so staging/prod find the
dev-built image already in ECR and skip rebuilding — what dev tested is exactly what prod
runs). With `image.source=registry`, all environments pull the same pinned tag. Either way,
promotion is bit-identical.

## Custom domains per environment

Set `domainName` + `certificateArn` (ACM cert in `us-east-1`) on each environment block.
Smoke tests auto-resolve the URL: a custom domain if set, otherwise the CloudFront URL from
the stack output.

## Approvals & notifications

A single SNS topic (`<appName>-Pipeline-Approval`) backs all approval gates; the
`approvalEmail` is subscribed once. Approvers click through in the CodePipeline console.
