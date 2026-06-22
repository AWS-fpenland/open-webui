#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import { loadConfig, selectedEnvironments, stackPrefix, resourcePrefix, DeployConfig, EnvironmentConfig } from '../lib/config';
import { NetworkStack } from '../lib/network-stack';
import { DataStack } from '../lib/data-stack';
import { AuthStack } from '../lib/auth-stack';
import { ComputeStack } from '../lib/compute-stack';
import { PipelineStack } from '../lib/pipeline-stack';

const app = new cdk.App();
const cdkRoot = path.join(__dirname, '..');
// Repo root = four levels up from deploy/aws/cdk/bin → used as the Docker build context for image.source='build'.
const repoRoot = path.join(cdkRoot, '..', '..', '..');

const config: DeployConfig = loadConfig(app, cdkRoot);

const env: cdk.Environment = {
  account: config.account,
  region: config.region,
};

/** Build the full stack set for a single environment. */
function deployEnvironment(envName: string, envConfig: EnvironmentConfig): void {
  const prefix = stackPrefix(config, envName);
  const resPrefix = resourcePrefix(config, envName);

  const network = new NetworkStack(app, `${prefix}-Network`, {
    env,
    resourcePrefix: resPrefix,
    maxAzs: envConfig.maxAzs,
    natGateways: envConfig.natGateways,
    enableBedrockEndpoint: config.bedrock.enabled,
  });

  const data = new DataStack(app, `${prefix}-Data`, {
    env,
    resourcePrefix: resPrefix,
    vpc: network.vpc,
    ecsSecurityGroup: network.ecsSecurityGroup,
    auroraMinCapacity: envConfig.auroraMinCapacity,
    auroraMaxCapacity: envConfig.auroraMaxCapacity,
    auroraDeletionProtection: envConfig.auroraDeletionProtection,
    enableRedis: config.websocket.enabled,
  });
  data.addDependency(network);

  // App URL is needed at Auth deploy time for Cognito callback URLs. Prefer the
  // custom domain; otherwise the callback is patched post-deploy (pipeline) or
  // by re-running with the resolved CloudFront URL.
  const appUrl = envConfig.domainName ? `https://${envConfig.domainName}` : undefined;
  const cognitoDomainPrefix = `${resPrefix}-${config.account ?? 'acct'}`;

  let authStack: AuthStack | undefined;
  let cognitoWiring;
  if (config.auth.mode === 'cognito') {
    authStack = new AuthStack(app, `${prefix}-Auth`, {
      env,
      resourcePrefix: resPrefix,
      callbackUrls: appUrl ? [`${appUrl}/oauth/oidc/callback`] : ['https://localhost/oauth/oidc/callback'],
      logoutUrls: appUrl ? [`${appUrl}/auth`] : ['https://localhost/auth'],
      cognitoDomainPrefix,
    });
    cognitoWiring = {
      userPool: authStack.userPool,
      userPoolClient: authStack.userPoolClient,
      userPoolDomainName: `${cognitoDomainPrefix}.auth.${config.region}.amazoncognito.com`,
    };
  }

  const compute = new ComputeStack(app, `${prefix}-Compute`, {
    env,
    resourcePrefix: resPrefix,
    vpc: network.vpc,
    ecsSecurityGroup: network.ecsSecurityGroup,
    albSecurityGroup: network.albSecurityGroup,
    auroraCluster: data.auroraCluster,
    uploadBucket: data.uploadBucket,
    redisEndpoint: data.redisEndpoint,
    image: config.image,
    buildContext: config.image.buildContext ? path.resolve(config.image.buildContext) : repoRoot,
    bedrock: config.bedrock,
    features: config.features,
    websocketEnabled: config.websocket.enabled,
    cognito: cognitoWiring,
    domainName: envConfig.domainName,
    certificateArn: envConfig.certificateArn,
    cpu: envConfig.fargateCpu,
    memoryLimitMiB: envConfig.fargateMemory,
    ecsDesiredCount: envConfig.ecsDesiredCount,
    ecsMinCapacity: envConfig.ecsMinCapacity,
    ecsMaxCapacity: envConfig.ecsMaxCapacity,
    enableAutoScaling: envConfig.enableAutoScaling,
  });
  compute.addDependency(data);
  if (authStack) compute.addDependency(authStack);
}

// Synthesize the selected environment(s). `-c environment=NAME` narrows to one
// (used by the pipeline's per-stage deploys); otherwise all configured envs.
for (const envName of selectedEnvironments(app, config)) {
  deployEnvironment(envName, config.environments[envName]);
}

// Pipeline is its own stack, deployed deliberately (mode 2 / mode 3).
//
// Skip it whenever a single environment is explicitly targeted (`-c environment=`).
// That context is set by the pipeline's own per-stage `cdk deploy`, so without
// this guard each stage would re-synth and redeploy the pipeline into itself.
const singleEnvTargeted = app.node.tryGetContext('environment') !== undefined;
if (config.pipeline.enabled && !singleEnvTargeted) {
  new PipelineStack(app, `${config.appName}-Pipeline`, { env, config });
}

app.synth();
