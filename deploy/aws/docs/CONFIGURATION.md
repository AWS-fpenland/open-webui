# Configuration reference

All deployment behavior is parameterized. There is **no need to edit the CDK code** to
change settings.

## Precedence

Highest wins:

1. **CDK context** — `-c key=value` on the command line (quick overrides)
2. **Config file** — `-c configFile=path.json` (committed, per-deployment)
3. **Built-in defaults** — a pristine official Open WebUI deployment

If no `configFile` is given, `config/defaults.json` is loaded automatically when present.

## Config file schema

```jsonc
{
  "appName": "OpenWebUI",          // stack-name prefix + resource base name
  "account": "123456789012",        // optional; else CDK_DEFAULT_ACCOUNT
  "region": "us-east-1",            // optional; else CDK_DEFAULT_REGION

  "image": {
    "source": "registry",           // "registry" (official prebuilt) | "build" (this repo's Dockerfile)
    "registry": "ghcr.io/open-webui/open-webui",
    "tag": "v0.9.6",                // pin a release — never ":main"
    "buildContext": null            // optional path for source='build'; defaults to repo root
  },

  "auth": {
    "mode": "none"                  // "none" (built-in auth) | "cognito" (add Cognito SSO)
  },

  "bedrock": {
    "enabled": false,               // grant Bedrock IAM + set ENABLE_BEDROCK_API
    "region": "us-east-1",          // optional; defaults to deploy region
    "allowedModels": []             // [] = all foundation models + inference profiles
  },

  "websocket": {
    "enabled": true                 // native WebSocket over the VPC origin + Redis Socket.IO manager
  },

  "features": {
    "agentcoreWebsocket": false     // opt-in IAM for AgentCore WebSocket terminals (fork feature)
  },

  "environments": {                 // one entry = single env; multiple = multi-env (pipeline)
    "default": {
      "domainName": null,           // e.g. "oui.example.com" (requires certificateArn)
      "certificateArn": null,       // ACM cert ARN — MUST be in us-east-1
      "maxAzs": 2,
      "natGateways": 2,
      "fargateCpu": 1024,
      "fargateMemory": 2048,
      "ecsDesiredCount": 1,
      "ecsMinCapacity": 1,
      "ecsMaxCapacity": 4,
      "enableAutoScaling": true,
      "auroraMinCapacity": 0.5,
      "auroraMaxCapacity": 4,
      "auroraDeletionProtection": false
    }
  },

  "pipeline": {
    "enabled": false,
    "connectionArn": "arn:aws:codestar-connections:...",
    "repoOwner": "your-org",
    "repoName": "open-webui",
    "branch": "main",
    "approvalEmail": "you@example.com",
    "stages": [
      { "environment": "dev", "smokeTest": true },
      { "environment": "prod", "manualApprovalBefore": true, "smokeTest": true }
    ]
  }
}
```

> Note on `environments`: a config file's `environments` object **replaces** the built-in
> default set (it is not merged). So a file that declares only `prod` deploys only `prod` —
> the built-in `default` env does not leak in.

## Context-key shortcuts

Common knobs are exposed as context keys so you can override without a file:

| Context key | Maps to |
|---|---|
| `-c account=` / `-c region=` | `account` / `region` |
| `-c appName=` | `appName` |
| `-c imageSource=` / `-c imageTag=` / `-c imageRegistry=` | `image.*` |
| `-c authMode=` | `auth.mode` |
| `-c bedrockEnabled=true` | `bedrock.enabled` |
| `-c websocketEnabled=` | `websocket.enabled` |
| `-c agentcoreWebsocket=true` | `features.agentcoreWebsocket` |
| `-c environment=NAME` | select a single env to synth/deploy |
| `-c domainName=` / `-c certificateArn=` | override the selected env's domain/cert |
| `-c pipeline=true` | `pipeline.enabled` |
| `-c connectionArn=` / `-c repoOwner=` / `-c repoName=` / `-c branch=` / `-c approvalEmail=` | `pipeline.*` |

## Open WebUI environment variables set for you

The compute stack wires these into the task automatically:

| Variable | Source |
|---|---|
| `DATABASE_URL` | composed at container start from Aurora host + Secrets Manager password (command override) |
| `DATABASE_PASSWORD` | Secrets Manager (Aurora-generated; URL-safe characters only) |
| `WEBUI_SECRET_KEY` | Secrets Manager (generated, 64 chars) — shared across all tasks |
| `STORAGE_PROVIDER`, `S3_BUCKET_NAME`, `S3_REGION_NAME` | S3 upload bucket |
| `REDIS_URL`, `WEBSOCKET_MANAGER`, `WEBSOCKET_REDIS_URL` | ElastiCache (when `websocket.enabled`) |
| `ENABLE_WEBSOCKET_SUPPORT` | `websocket.enabled` |
| `ENABLE_BEDROCK_API`, `BEDROCK_REGION` | when `bedrock.enabled` |
| `OAUTH_*`, `OPENID_*`, `OAUTH_CLIENT_SECRET` | when `auth.mode=cognito` |

You can set any additional Open WebUI variable by extending the `environment` map in
`lib/compute-stack.ts` — but most operational settings are configurable at runtime in the
Open WebUI admin UI.

## Validation

```bash
cd deploy/aws/cdk && npm install
npx tsc --noEmit
npx cdk synth -c account=123456789012
npx cdk synth -c configFile=config/example-multi-env-pipeline.json -c account=123456789012
```
