import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';
import { BedrockAccess } from './constructs/bedrock-access';
import { BedrockConfig, FeatureFlags, ImageConfig } from './config';

export interface CognitoWiring {
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
  userPoolDomainName: string;
}

export interface ComputeStackProps extends cdk.StackProps {
  resourcePrefix: string;
  vpc: ec2.Vpc;
  ecsSecurityGroup: ec2.SecurityGroup;
  albSecurityGroup: ec2.SecurityGroup;
  auroraCluster: rds.DatabaseCluster;
  uploadBucket: s3.Bucket;
  redisEndpoint?: string;

  image: ImageConfig;
  /** Absolute path to the build context (repo root w/ Dockerfile) for image.source='build'. */
  buildContext: string;
  bedrock: BedrockConfig;
  features: FeatureFlags;
  websocketEnabled: boolean;

  /** Present only when auth.mode='cognito'. */
  cognito?: CognitoWiring;

  domainName?: string;
  certificateArn?: string;
  cpu?: number;
  memoryLimitMiB?: number;
  ecsDesiredCount?: number;
  ecsMinCapacity?: number;
  ecsMaxCapacity?: number;
  enableAutoScaling?: boolean;
}

/**
 * Compute + edge for Open WebUI:
 *   ECS Fargate (private) → internal ALB (private) → CloudFront (VPC origin).
 *
 * The application container image is NEVER modified:
 *   - 'registry' (default): pull the official prebuilt image.
 *   - 'build': build the repo's Dockerfile as-is via a DockerImageAsset.
 *
 * DATABASE_URL is composed at container start via a command override, because
 * upstream env.py reads DATABASE_URL directly (no DATABASE_HOST/USER/PASSWORD
 * component support). The DB password is injected from Secrets Manager and
 * never appears in the task definition in plaintext.
 */
export class ComputeStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;
  public readonly fargateService: ecs.FargateService;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    const { vpc, ecsSecurityGroup, albSecurityGroup, auroraCluster, uploadBucket, redisEndpoint } = props;
    const cpu = props.cpu ?? 1024;
    const memoryLimitMiB = props.memoryLimitMiB ?? 2048;
    const desiredCount = props.ecsDesiredCount ?? 1;
    const minCapacity = props.ecsMinCapacity ?? 1;
    const maxCapacity = props.ecsMaxCapacity ?? 4;
    const enableAutoScaling = props.enableAutoScaling ?? true;

    // ── Container image ──
    let containerImage: ecs.ContainerImage;
    let imageRef: string;
    if (props.image.source === 'build') {
      const buildHash = process.env.CODEBUILD_RESOLVED_SOURCE_VERSION ?? process.env.GIT_COMMIT ?? 'local';
      const appImage = new DockerImageAsset(this, 'AppImage', {
        directory: props.buildContext,
        platform: Platform.LINUX_AMD64,
        buildArgs: { BUILD_HASH: buildHash },
        // Keep this deployment tooling out of the Docker build context. The
        // build context is the repo root (where the upstream Dockerfile lives),
        // and `deploy/` contains the CDK app's node_modules and synth output
        // (`cdk.out*`) — including these would bloat the context and, with a
        // custom --output dir, recursively nest it. Upstream's own .dockerignore
        // still applies on top of these excludes.
        exclude: ['deploy/aws/cdk/node_modules', 'deploy/aws/cdk/cdk.out', 'deploy/aws/cdk/cdk.out.*', '**/cdk.out', '.git'],
      });
      containerImage = ecs.ContainerImage.fromDockerImageAsset(appImage);
      imageRef = appImage.imageUri;
    } else {
      imageRef = `${props.image.registry}:${props.image.tag}`;
      containerImage = ecs.ContainerImage.fromRegistry(imageRef);
    }

    // ── Secrets ──
    const webuiSecret = new secretsmanager.Secret(this, 'WebUISecretKey', {
      secretName: `${props.resourcePrefix}/webui-secret-key`,
      description: 'Open WebUI JWT signing key (shared across all tasks)',
      generateSecretString: {
        secretStringTemplate: '{}',
        generateStringKey: 'WEBUI_SECRET_KEY',
        excludePunctuation: true,
        passwordLength: 64,
      },
    });

    // ── ECS cluster ──
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: `${props.resourcePrefix}-cluster`,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // ── Task role ──
    const taskRole = new iam.Role(this, 'TaskRole', { assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com') });
    uploadBucket.grantReadWrite(taskRole);
    webuiSecret.grantRead(taskRole);
    auroraCluster.secret!.grantRead(taskRole);
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: ['*'],
    }));

    if (props.bedrock.enabled) {
      const bedrockAccess = new BedrockAccess(this, 'BedrockAccess', { allowedModels: props.bedrock.allowedModels });
      bedrockAccess.policyStatements.forEach((s) => taskRole.addToPolicy(s));
    }

    // Opt-in: allow opening native bidirectional WebSocket terminals to
    // AgentCore runtimes (downstream fork feature; not needed by vanilla OWUI).
    if (props.features.agentcoreWebsocket) {
      taskRole.addToPolicy(new iam.PolicyStatement({
        actions: ['bedrock-agentcore:InvokeAgentRuntimeWithWebSocketStream'],
        resources: ['*'],
      }));
    }

    // ── Cognito client secret (only when SSO is enabled) ──
    // Seed it from the user-pool client's generated secret at deploy time so
    // OIDC works out of the box (Mode 1). Without this the secret would be empty
    // and the OIDC token exchange would fail with invalid_client. The value is a
    // CloudFormation reference to the client's secret (resolved via a managed
    // custom resource), not a plaintext literal. The pipeline modes additionally
    // re-sync this secret post-deploy (idempotent).
    let cognitoClientSecret: secretsmanager.Secret | undefined;
    if (props.cognito) {
      cognitoClientSecret = new secretsmanager.Secret(this, 'CognitoClientSecret', {
        secretName: `${props.resourcePrefix}/cognito-client-secret`,
        description: 'Cognito User Pool Client secret',
        secretStringValue: props.cognito.userPoolClient.userPoolClientSecret,
      });
      cognitoClientSecret.grantRead(taskRole);
    }

    // ── Task definition ──
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', { cpu, memoryLimitMiB, taskRole });

    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/ecs/${props.resourcePrefix}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Base environment — vanilla Open WebUI, S3 storage, Postgres + (optional) Redis.
    const environment: Record<string, string> = {
      PORT: '8080',
      WEBUI_URL: cdk.Lazy.string({ produce: () => `https://${props.domainName ?? this.distribution.distributionDomainName}` }),
      STORAGE_PROVIDER: 's3',
      S3_BUCKET_NAME: uploadBucket.bucketName,
      S3_REGION_NAME: cdk.Aws.REGION,
      // DATABASE_URL is composed by the command override below from these parts.
      DATABASE_HOST: auroraCluster.clusterEndpoint.hostname,
      DATABASE_PORT: '5432',
      DATABASE_NAME: 'openwebui',
      DATABASE_USER: 'postgres',
      ENABLE_OLLAMA_API: 'false',
    };

    // WebSocket / Socket.IO. CloudFront supports WebSocket over VPC origins
    // (GA 2026-05-01), so we enable native WS by default. With >1 task, the
    // Redis manager shares Socket.IO state so no sticky sessions are required.
    environment.ENABLE_WEBSOCKET_SUPPORT = props.websocketEnabled ? 'true' : 'false';
    if (redisEndpoint) {
      environment.REDIS_URL = `rediss://${redisEndpoint}:6379`;
      if (props.websocketEnabled) {
        environment.WEBSOCKET_MANAGER = 'redis';
        environment.WEBSOCKET_REDIS_URL = `rediss://${redisEndpoint}:6379/0`;
      }
    }

    // Bedrock provider toggle (provider plumbing lives in a fork; off by default).
    if (props.bedrock.enabled) {
      environment.ENABLE_BEDROCK_API = 'true';
      environment.BEDROCK_REGION = props.bedrock.region ?? cdk.Aws.REGION;
    }

    // Cognito OIDC wiring (only when auth.mode='cognito'). Standard OAUTH_*/OPENID_*
    // settings — no application code changes.
    if (props.cognito) {
      const { userPool, userPoolClient, userPoolDomainName } = props.cognito;
      Object.assign(environment, {
        ENABLE_OAUTH_SIGNUP: 'true',
        OAUTH_CLIENT_ID: userPoolClient.userPoolClientId,
        OPENID_PROVIDER_URL: `https://cognito-idp.${cdk.Aws.REGION}.amazonaws.com/${userPool.userPoolId}/.well-known/openid-configuration`,
        OAUTH_PROVIDER_NAME: 'Amazon Cognito',
        OAUTH_SCOPES: 'openid email profile',
        OPENID_REDIRECT_URI: cdk.Lazy.string({ produce: () => `https://${props.domainName ?? this.distribution.distributionDomainName}/oauth/oidc/callback` }),
        ENABLE_OAUTH_PERSISTENT_CONFIG: 'false',
        OAUTH_USERNAME_CLAIM: 'email',
        OAUTH_MERGE_ACCOUNTS_BY_EMAIL: 'true',
        ENABLE_OAUTH_ROLE_MANAGEMENT: 'true',
        OAUTH_ROLES_CLAIM: 'cognito:groups',
        OAUTH_ADMIN_ROLES: 'admin,webui-admins,admins',
        OAUTH_ALLOWED_ROLES: 'admin,webui-admins,admins,user,power-users,basic-users',
        ENABLE_OAUTH_GROUP_MANAGEMENT: 'true',
        OAUTH_GROUP_CLAIM: 'cognito:groups',
        ENABLE_OAUTH_GROUP_CREATION: 'true',
        WEBUI_AUTH_SIGNOUT_REDIRECT_URL: cdk.Lazy.string({ produce: () => `https://${userPoolDomainName}/logout?client_id=${userPoolClient.userPoolClientId}&logout_uri=https://${this.resolveHost(props)}/auth` }),
        OPENID_END_SESSION_ENDPOINT: cdk.Lazy.string({ produce: () => `https://${userPoolDomainName}/logout?client_id=${userPoolClient.userPoolClientId}&logout_uri=https://${this.resolveHost(props)}/auth` }),
      });
    }

    const secrets: Record<string, ecs.Secret> = {
      WEBUI_SECRET_KEY: ecs.Secret.fromSecretsManager(webuiSecret, 'WEBUI_SECRET_KEY'),
      // Injected as an env var; the command override interpolates it into DATABASE_URL.
      DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(auroraCluster.secret!, 'password'),
    };
    if (cognitoClientSecret) {
      secrets.OAUTH_CLIENT_SECRET = ecs.Secret.fromSecretsManager(cognitoClientSecret);
    }

    taskDefinition.addContainer('OpenWebUI', {
      image: containerImage,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'open-webui', logGroup }),
      portMappings: [{ containerPort: 8080, protocol: ecs.Protocol.TCP }],
      environment,
      secrets,
      // Compose DATABASE_URL from the component env vars + the injected secret,
      // then hand off to the image's normal entrypoint. Upstream WORKDIR is
      // /app/backend and its CMD is `bash start.sh`; we reproduce that exactly.
      // This keeps the official image (or a from-source build) byte-for-byte
      // unmodified — the URL assembly lives in the task definition, not the image.
      command: [
        '/bin/sh',
        '-c',
        'export DATABASE_URL="postgresql://${DATABASE_USER}:${DATABASE_PASSWORD}@${DATABASE_HOST}:${DATABASE_PORT}/${DATABASE_NAME}" && exec bash start.sh',
      ],
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:8080/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });

    // ── Internal ALB (private subnets) ──
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: false,
      securityGroup: albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      // Raise the idle timeout well above Socket.IO's ping interval (~25s) and
      // typical long-generation gaps so neither WebSocket nor SSE/long-polling
      // connections are reset mid-stream.
      idleTimeout: cdk.Duration.seconds(3600),
    });

    // ── ECS service ──
    this.fargateService = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition,
      desiredCount,
      securityGroups: [ecsSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      // First task on a new image pulls a multi-GB container and warms models
      // before /health is reliable.
      healthCheckGracePeriod: cdk.Duration.seconds(180),
      circuitBreaker: { rollback: true },
      // Keep 100% of desired capacity serving during a rolling deploy (spin new
      // tasks up before draining old ones) and allow up to 200% briefly. Avoids
      // the default 50% dip that would degrade availability mid-deploy.
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc,
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: { path: '/health', healthyHttpCodes: '200', interval: cdk.Duration.seconds(30), timeout: cdk.Duration.seconds(5) },
      // Slightly longer deregistration drain so in-flight streams finish.
      deregistrationDelay: cdk.Duration.seconds(30),
    });
    this.fargateService.attachToApplicationTargetGroup(targetGroup);

    alb.addListener('HttpListener', { port: 80, defaultAction: elbv2.ListenerAction.forward([targetGroup]) });

    // Allow CloudFront's VPC origin to reach the ALB on port 80.
    //
    // CRITICAL: CloudFront does NOT add this rule for you. When you create a VPC
    // origin, CloudFront provisions service-managed ENIs in your VPC behind its
    // own security group (CloudFront-VPCOrigins-Service-SG), but it never edits
    // the *target* (ALB) security group. Without an explicit inbound rule the ALB
    // SG default-denies and every request — HTTP page load and WebSocket upgrade
    // alike — fails with HTTP 504. (Confirmed against the CloudFront Developer
    // Guide and the aws-cloudfront-origins CDK README.)
    //
    // We allow the CloudFront origin-facing managed prefix list (AWS's
    // documented option for VPC origins). It needs no dependency on the
    // not-yet-created VPC origin SG (whose id CloudFormation does not expose).
    // It admits CloudFront origin traffic on port 80; the ALB itself is private
    // (internal) so it is not otherwise reachable. The ALB→target health check
    // originates inside the VPC and is unaffected.
    //
    // The prefix-list id is region-specific. By default we resolve it with a
    // context lookup (real deploys always have credentials). For offline synth /
    // CI dry-runs without credentials, pass `-c cloudfrontPrefixListId=pl-xxxx`
    // to skip the lookup.
    const overridePrefixListId = this.node.tryGetContext('cloudfrontPrefixListId') as string | undefined;
    const cloudFrontPeer = overridePrefixListId
      ? ec2.Peer.prefixList(overridePrefixListId)
      : ec2.Peer.prefixList(
          ec2.PrefixList.fromLookup(this, 'CloudFrontOriginFacing', {
            prefixListName: 'com.amazonaws.global.cloudfront.origin-facing',
          }).prefixListId,
        );
    albSecurityGroup.addIngressRule(cloudFrontPeer, ec2.Port.tcp(80), 'CloudFront VPC origin to internal ALB');

    // ── CloudFront via VPC origin ──
    const vpcOriginResource = new cloudfront.VpcOrigin(this, 'VpcOrigin', {
      endpoint: cloudfront.VpcOriginEndpoint.applicationLoadBalancer(alb),
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
    });
    const vpcOrigin = origins.VpcOrigin.withVpcOrigin(vpcOriginResource);

    const distributionProps: cloudfront.DistributionProps = {
      comment: `${props.resourcePrefix} Open WebUI`,
      defaultBehavior: {
        origin: vpcOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        // Disable caching and forward all viewer headers/cookies — required for
        // the WebSocket upgrade (Sec-WebSocket-* headers) and dynamic chat API.
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      },
    };
    if (props.domainName && props.certificateArn) {
      const certificate = acm.Certificate.fromCertificateArn(this, 'Certificate', props.certificateArn);
      (distributionProps as any).domainNames = [props.domainName];
      (distributionProps as any).certificate = certificate;
    }
    this.distribution = new cloudfront.Distribution(this, 'Distribution', distributionProps);

    // ── Auto scaling ──
    if (enableAutoScaling) {
      const scaling = this.fargateService.autoScaleTaskCount({ minCapacity, maxCapacity });
      scaling.scaleOnCpuUtilization('CpuScaling', { targetUtilizationPercent: 70, scaleInCooldown: cdk.Duration.seconds(300), scaleOutCooldown: cdk.Duration.seconds(60) });
      scaling.scaleOnMemoryUtilization('MemoryScaling', { targetUtilizationPercent: 80, scaleInCooldown: cdk.Duration.seconds(300), scaleOutCooldown: cdk.Duration.seconds(60) });
    }

    // ── Outputs ──
    new cdk.CfnOutput(this, 'DistributionDomainName', { value: this.distribution.distributionDomainName });
    new cdk.CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
    new cdk.CfnOutput(this, 'AppUrl', { value: props.domainName ? `https://${props.domainName}` : `https://${this.distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, 'ServiceName', { value: this.fargateService.serviceName });
    new cdk.CfnOutput(this, 'AppImageRef', { value: imageRef, description: 'Container image deployed to ECS' });
  }

  /** Resolve the app host (custom domain or CloudFront default) lazily for logout URLs. */
  private resolveHost(props: ComputeStackProps): string {
    return props.domainName ?? this.distribution.distributionDomainName;
  }
}
