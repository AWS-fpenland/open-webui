import * as cdk from 'aws-cdk-lib';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Deployment configuration for Open WebUI on AWS.
 *
 * Everything here is parameterized so a deployer can change settings without
 * editing the CDK code. Precedence (highest wins):
 *
 *   1. CDK context (`-c key=value`)            — quick one-off overrides
 *   2. Config file (`-c configFile=path.json`) — committed, per-deployment
 *   3. Built-in DEFAULTS (below)               — sensible vanilla defaults
 *
 * The defaults deploy a pristine, official Open WebUI (no Bedrock, no Cognito,
 * official prebuilt image) so the deployment layer stays additive and the
 * upstream application image is never modified.
 */

export type ImageSource = 'registry' | 'build';
export type AuthMode = 'none' | 'cognito';

export interface ImageConfig {
  /** 'registry' = pull official prebuilt image (no Docker needed). 'build' = build from source tree (fork use-case). */
  source: ImageSource;
  /** Container registry image (registry mode). Default: official Open WebUI image. */
  registry?: string;
  /** Image tag (registry mode) — pin to a released version, never ':main'. */
  tag?: string;
  /** Build context dir (build mode). Defaults to the repo root containing the Dockerfile. */
  buildContext?: string;
}

export interface AuthConfig {
  /** 'none' = Open WebUI built-in email/password auth (pristine default). 'cognito' = add a Cognito user pool + OIDC. */
  mode: AuthMode;
  /** When mode='cognito': admin role names mapped from the cognito:groups claim. */
  adminRoles?: string;
  /** When mode='cognito': all allowed role names. */
  allowedRoles?: string;
}

export interface BedrockConfig {
  /** Off by default. When true, grants the task role Bedrock invoke/converse permissions and sets ENABLE_BEDROCK_API. */
  enabled: boolean;
  /** Optional allow-list of model IDs. Empty = all foundation models + inference profiles. */
  allowedModels?: string[];
  /** Bedrock region (defaults to the deployment region). */
  region?: string;
}

export interface WebSocketConfig {
  /**
   * WebSocket (Socket.IO) support. Enabled by default.
   *
   * CloudFront added WebSocket support for VPC origins (GA 2026-05-01), so the
   * private-ALB-behind-CloudFront topology now carries native WebSocket traffic
   * end-to-end. When enabled with >1 task, a Redis Socket.IO manager is wired so
   * sessions are shared across tasks (no sticky sessions required).
   */
  enabled: boolean;
}

export interface FeatureFlags {
  /**
   * Off by default. When true, grants the task role
   * bedrock-agentcore:InvokeAgentRuntimeWithWebSocketStream so a downstream
   * fork (e.g. the in-chat terminal) can open native WebSocket terminals to
   * AgentCore runtimes. Vanilla Open WebUI does not need this.
   */
  agentcoreWebsocket?: boolean;
}

export interface EnvironmentConfig {
  /** Custom domain (e.g. "oui.example.com"). Omit to use the CloudFront default *.cloudfront.net domain. */
  domainName?: string;
  /** ACM certificate ARN in us-east-1 for the custom domain. Required when domainName is set. */
  certificateArn?: string;

  // ── Network sizing ──
  maxAzs?: number;
  natGateways?: number;

  // ── Compute sizing ──
  fargateCpu?: number;
  fargateMemory?: number;
  ecsDesiredCount?: number;
  ecsMinCapacity?: number;
  ecsMaxCapacity?: number;
  enableAutoScaling?: boolean;

  // ── Data sizing ──
  auroraMinCapacity?: number;
  auroraMaxCapacity?: number;
  auroraDeletionProtection?: boolean;
}

export interface PipelineStageConfig {
  /** Name of an environment defined in `environments`. */
  environment: string;
  /** Insert a manual approval gate BEFORE deploying this stage. */
  manualApprovalBefore?: boolean;
  /** Run a post-deploy HTTP smoke test against this stage's URL. */
  smokeTest?: boolean;
}

export interface PipelineConfig {
  enabled: boolean;
  /**
   * Path (relative to the cdk/ dir) of the config file that defines this
   * deployment. The pipeline passes it to each per-stage `cdk deploy` so the
   * CodeBuild deploy uses the SAME config that created the pipeline. Set
   * automatically by loadConfig from the `configFile` context key.
   */
  configFile?: string;
  /** CodeStar Connection ARN to GitHub / Bitbucket / GitHub Enterprise / any supported Git host. */
  connectionArn?: string;
  repoOwner?: string;
  repoName?: string;
  branch?: string;
  /** Email for manual-approval notifications. */
  approvalEmail?: string;
  /**
   * Ordered deployment stages. One entry = single-environment pipeline.
   * Multiple entries (e.g. dev → staging → prod) = flexible multi-environment pipeline.
   */
  stages: PipelineStageConfig[];
}

export interface DeployConfig {
  /** AWS account (defaults to CDK_DEFAULT_ACCOUNT). */
  account?: string;
  /** AWS region (defaults to CDK_DEFAULT_REGION or us-east-1). */
  region?: string;
  /** Stack-name prefix and resource base name. Default "OpenWebUI". */
  appName: string;

  image: ImageConfig;
  auth: AuthConfig;
  bedrock: BedrockConfig;
  websocket: WebSocketConfig;
  features: FeatureFlags;

  /** Map of environment name → its config. For a one-click single deploy, use a single entry (e.g. "default"). */
  environments: Record<string, EnvironmentConfig>;

  pipeline: PipelineConfig;
}

// ──────────────────────────────────────────────────────────────────────────
// Built-in defaults — a pristine, official Open WebUI deployment.
// ──────────────────────────────────────────────────────────────────────────
const DEFAULTS: DeployConfig = {
  appName: 'OpenWebUI',
  image: {
    source: 'registry',
    registry: 'ghcr.io/open-webui/open-webui',
    tag: 'v0.9.6',
  },
  auth: { mode: 'none' },
  bedrock: { enabled: false },
  websocket: { enabled: true },
  features: {},
  environments: {
    default: {
      fargateCpu: 1024,
      fargateMemory: 2048,
      ecsDesiredCount: 1,
      ecsMinCapacity: 1,
      ecsMaxCapacity: 4,
      enableAutoScaling: true,
      auroraMinCapacity: 0.5,
      auroraMaxCapacity: 4,
      auroraDeletionProtection: false,
      maxAzs: 2,
      natGateways: 2,
    },
  },
  pipeline: { enabled: false, stages: [] },
};

/** Deep-merge helper (objects only; arrays and scalars are replaced wholesale). */
function deepMerge<T>(base: T, override: Partial<T> | undefined): T {
  if (!override) return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...base };
  for (const key of Object.keys(override)) {
    const o = (override as any)[key];
    const b = (base as any)?.[key];
    if (o && typeof o === 'object' && !Array.isArray(o) && b && typeof b === 'object' && !Array.isArray(b)) {
      out[key] = deepMerge(b, o);
    } else if (o !== undefined) {
      out[key] = o;
    }
  }
  return out;
}

function ctx(app: cdk.App, key: string): string | undefined {
  const v = app.node.tryGetContext(key);
  return v === undefined || v === null || v === '' ? undefined : String(v);
}

function ctxBool(app: cdk.App, key: string): boolean | undefined {
  const v = ctx(app, key);
  if (v === undefined) return undefined;
  return v === 'true' || v === '1' || v === 'yes';
}

/**
 * Load and normalize the deployment config from (in precedence order)
 * context > config file > defaults.
 */
export function loadConfig(app: cdk.App, cdkRoot: string): DeployConfig {
  // 1. Start from defaults.
  let config: DeployConfig = JSON.parse(JSON.stringify(DEFAULTS));

  // 2. Merge a config file if provided (or the conventional default file if present).
  const configFile = ctx(app, 'configFile') ?? 'config/defaults.json';
  const configPath = path.isAbsolute(configFile) ? configFile : path.join(cdkRoot, configFile);
  if (fs.existsSync(configPath)) {
    const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Partial<DeployConfig>;
    config = deepMerge(config, fileConfig);
    // `environments` has REPLACE semantics (not deep-merge): a config file that
    // declares its own environments fully defines the set, so the built-in
    // "default" env never leaks into a multi-env or single-named-env config.
    // Each declared env is still backfilled against the built-in default so a
    // sparsely-specified env (e.g. domain only) inherits sensible sizing.
    if (fileConfig.environments) {
      const base = DEFAULTS.environments.default;
      const merged: Record<string, EnvironmentConfig> = {};
      for (const [name, envCfg] of Object.entries(fileConfig.environments)) {
        merged[name] = deepMerge(base, envCfg as Partial<EnvironmentConfig>);
      }
      config.environments = merged;
    }
  }
  // Remember which config file produced this deployment so the pipeline can
  // hand it to each per-stage `cdk deploy` (otherwise stages would silently
  // fall back to defaults.json and fail on any non-"default" environment).
  if (ctx(app, 'configFile')) {
    config.pipeline.configFile = configFile;
  }

  // 3. Apply targeted context overrides for the most common knobs.
  config.account = ctx(app, 'account') ?? config.account ?? process.env.CDK_DEFAULT_ACCOUNT;
  config.region = ctx(app, 'region') ?? config.region ?? process.env.CDK_DEFAULT_REGION ?? 'us-east-1';
  config.appName = ctx(app, 'appName') ?? config.appName;

  const imageSource = ctx(app, 'imageSource') as ImageSource | undefined;
  if (imageSource) config.image.source = imageSource;
  const imageTag = ctx(app, 'imageTag');
  if (imageTag) config.image.tag = imageTag;
  const imageRegistry = ctx(app, 'imageRegistry');
  if (imageRegistry) config.image.registry = imageRegistry;

  const authMode = ctx(app, 'authMode') as AuthMode | undefined;
  if (authMode) config.auth.mode = authMode;

  const bedrockEnabled = ctxBool(app, 'bedrockEnabled');
  if (bedrockEnabled !== undefined) config.bedrock.enabled = bedrockEnabled;

  const websocketEnabled = ctxBool(app, 'websocketEnabled');
  if (websocketEnabled !== undefined) config.websocket.enabled = websocketEnabled;

  const agentcoreWs = ctxBool(app, 'agentcoreWebsocket');
  if (agentcoreWs !== undefined) config.features.agentcoreWebsocket = agentcoreWs;

  // Pipeline toggles + wiring via context (so you can stand up a pipeline without a config file).
  const pipelineEnabled = ctxBool(app, 'pipeline');
  if (pipelineEnabled !== undefined) config.pipeline.enabled = pipelineEnabled;
  const connectionArn = ctx(app, 'connectionArn');
  if (connectionArn) config.pipeline.connectionArn = connectionArn;
  const repoOwner = ctx(app, 'repoOwner');
  if (repoOwner) config.pipeline.repoOwner = repoOwner;
  const repoName = ctx(app, 'repoName');
  if (repoName) config.pipeline.repoName = repoName;
  const branch = ctx(app, 'branch');
  if (branch) config.pipeline.branch = branch;
  const approvalEmail = ctx(app, 'approvalEmail');
  if (approvalEmail) config.pipeline.approvalEmail = approvalEmail;

  // Single-environment convenience overrides: `-c environment=dev -c domainName=... -c certificateArn=...`
  const targetEnv = ctx(app, 'environment');
  if (targetEnv) {
    if (!config.environments[targetEnv]) config.environments[targetEnv] = {};
    const domainName = ctx(app, 'domainName');
    if (domainName) config.environments[targetEnv].domainName = domainName;
    const certificateArn = ctx(app, 'certificateArn');
    if (certificateArn) config.environments[targetEnv].certificateArn = certificateArn;
  }

  validateConfig(config);
  return config;
}

/** Which environments to synthesize. `-c environment=NAME` narrows to one; otherwise all. */
export function selectedEnvironments(app: cdk.App, config: DeployConfig): string[] {
  const targetEnv = ctx(app, 'environment');
  if (targetEnv) {
    if (!config.environments[targetEnv]) {
      throw new Error(`environment '${targetEnv}' not found in config. Available: ${Object.keys(config.environments).join(', ')}`);
    }
    return [targetEnv];
  }
  return Object.keys(config.environments);
}

function validateConfig(config: DeployConfig): void {
  if (Object.keys(config.environments).length === 0) {
    throw new Error('config.environments must define at least one environment');
  }
  for (const [name, env] of Object.entries(config.environments)) {
    if (env.domainName && !env.certificateArn) {
      throw new Error(`environment '${name}': certificateArn is required when domainName is set (ACM cert must be in us-east-1)`);
    }
  }
  if (config.image.source === 'registry' && (!config.image.registry || !config.image.tag)) {
    throw new Error('image.source=registry requires image.registry and image.tag');
  }
  if (config.pipeline.enabled) {
    if (!config.pipeline.connectionArn) throw new Error('pipeline.enabled requires pipeline.connectionArn (CodeStar Connection ARN)');
    if (!config.pipeline.repoOwner || !config.pipeline.repoName) throw new Error('pipeline.enabled requires pipeline.repoOwner and pipeline.repoName');
    if (!config.pipeline.stages || config.pipeline.stages.length === 0) throw new Error('pipeline.enabled requires at least one entry in pipeline.stages');
    for (const stage of config.pipeline.stages) {
      if (!config.environments[stage.environment]) {
        throw new Error(`pipeline stage references unknown environment '${stage.environment}'`);
      }
    }
  }
}

/** Stack-name prefix for an environment, e.g. "OpenWebUI-Dev" (or just "OpenWebUI" for a lone "default" env). */
export function stackPrefix(config: DeployConfig, envName: string): string {
  if (envName === 'default') return config.appName;
  const titled = envName.charAt(0).toUpperCase() + envName.slice(1);
  return `${config.appName}-${titled}`;
}

/** Resource-name prefix (lowercase, hyphenated), e.g. "openwebui-dev". */
export function resourcePrefix(config: DeployConfig, envName: string): string {
  const base = config.appName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return envName === 'default' ? base : `${base}-${envName}`;
}
