# Mode 2 — Single-environment CI/CD pipeline

Stand up an AWS CodePipeline wired to a Git repository that redeploys **one** environment
on every push to a branch. Works with GitHub, GitHub Enterprise, Bitbucket, or GitLab — any
provider supported by an AWS **CodeStar Connection** ("any private code repository").

## Pipeline shape

```
Source (Git via CodeStar Connection)
   │
   ▼
Prod
  ├─ Deploy-Prod   (cdk deploy --all -c environment=prod)
  └─ Smoke-Prod    (HTTP /health + /api/config)   ← optional
```

## Prerequisites

1. A **CodeStar Connection** to your Git host, in `AVAILABLE` state. Create it once:
   ```bash
   aws codestar-connections create-connection --provider-type GitHub \
     --connection-name open-webui
   # then complete the handshake in the console (Developer Tools → Connections)
   ```
   Copy the connection ARN.
2. Your repo contains this `deploy/aws/` directory (it does — it's part of the fork).
3. CDK bootstrapped in the target account/region.

## Configure

Copy and edit the example:

```bash
cd deploy/aws/cdk
cp config/example-single-pipeline.json config/my-pipeline.json
```

Set in `config/my-pipeline.json`:
- `pipeline.connectionArn` — the ARN from above
- `pipeline.repoOwner` / `pipeline.repoName` — e.g. `your-org` / `open-webui`
- `pipeline.branch` — defaults to `main`
- `pipeline.approvalEmail` — optional; only used if a stage sets `manualApprovalBefore`
- the `prod` environment block — sizing + optional `domainName`/`certificateArn`

## Deploy the pipeline

```bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
npx cdk deploy OpenWebUI-Pipeline -c configFile=config/my-pipeline.json -c account=$ACCOUNT
```

This creates only the `OpenWebUI-Pipeline` stack. On the first source change (or a manual
"Release change" in the console), the pipeline deploys the `prod` environment's stacks
(`OpenWebUI-Prod-Network/Data/Compute`) itself.

## How image promotion works

- `image.source=registry` (default): every run pulls the same pinned `image.tag`. Bump the
  tag in config + push to roll a new version.
- `image.source=build`: CodeBuild builds the Dockerfile during deploy (privileged + LARGE
  compute). The DockerImageAsset hash is deterministic, so rebuilds are skipped when the
  source tree is unchanged.

## Notes

- The deploy stage runs `cdk deploy --all -c environment=prod`, so the pipeline manages the
  full stack set for that environment — not just the app.
- A Cognito client-secret sync runs post-deploy automatically (no-op unless
  `auth.mode=cognito`).
- To gate prod behind a human, set `manualApprovalBefore: true` on the stage and provide
  `approvalEmail`. That turns this into a one-stage version of Mode 3.
