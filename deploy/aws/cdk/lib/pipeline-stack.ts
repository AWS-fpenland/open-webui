import * as cdk from 'aws-cdk-lib';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { DeployConfig, PipelineStageConfig, stackPrefix, resourcePrefix } from './config';

export interface PipelineStackProps extends cdk.StackProps {
  config: DeployConfig;
}

/**
 * CI/CD pipeline for Open WebUI.
 *
 * One construct covers both deploy modes 2 and 3:
 *   - Single-environment pipeline:  pipeline.stages = [{ environment: "prod" }]
 *   - Flexible multi-environment:   pipeline.stages = [
 *       { environment: "dev" },
 *       { environment: "staging", manualApprovalBefore: true, smokeTest: true },
 *       { environment: "prod",    manualApprovalBefore: true },
 *     ]
 *
 * Each stage runs `cdk deploy` scoped to its environment. When image.source
 * is 'build', the DockerImageAsset hash is deterministic from the source tree,
 * so the first stage builds + pushes the image and later stages find the same
 * digest already in ECR and promote it bit-identically. With image.source
 * 'registry' (default), every stage simply pulls the same pinned tag.
 *
 * Source is wired through a CodeStar Connection, so it works against GitHub,
 * GitHub Enterprise, Bitbucket, or GitLab — any provider the connection
 * supports — i.e. "any private code repository".
 */
export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    const { config } = props;
    const pc = config.pipeline;
    const branch = pc.branch ?? 'main';

    const artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(30) }],
    });

    const sourceOutput = new codepipeline.Artifact('SourceOutput');
    const sourceAction = new codepipeline_actions.CodeStarConnectionsSourceAction({
      actionName: 'Source',
      owner: pc.repoOwner!,
      repo: pc.repoName!,
      branch,
      output: sourceOutput,
      connectionArn: pc.connectionArn!,
    });

    // Shared role for the deploy CodeBuild projects. It assumes the CDK
    // bootstrap toolkit roles (cdk-*) to publish assets and execute changesets.
    const cdkDeployRole = new iam.Role(this, 'CdkDeployRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      inlinePolicies: {
        CdkDeploy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/cdk-*`] }),
            // Post-deploy Cognito secret sync (only used by cognito-auth deployments).
            new iam.PolicyStatement({ actions: ['cloudformation:DescribeStacks'], resources: [`arn:aws:cloudformation:*:${cdk.Aws.ACCOUNT_ID}:stack/${config.appName}-*`] }),
            new iam.PolicyStatement({ actions: ['cognito-idp:DescribeUserPoolClient'], resources: [`arn:aws:cognito-idp:*:${cdk.Aws.ACCOUNT_ID}:userpool/*`] }),
            // Sanitized base must match resourcePrefix() (used for secretName), not a raw toLowerCase().
            new iam.PolicyStatement({ actions: ['secretsmanager:PutSecretValue'], resources: [`arn:aws:secretsmanager:*:${cdk.Aws.ACCOUNT_ID}:secret:${config.appName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}*`] }),
          ],
        }),
      },
    });

    // Image build (source='build') needs Docker-in-Docker + a large compute
    // class for the multi-GB image. Registry mode still uses this image but
    // never invokes docker build.
    const buildEnvironment: codebuild.BuildEnvironment = {
      buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
      privileged: config.image.source === 'build',
      computeType: config.image.source === 'build' ? codebuild.ComputeType.LARGE : codebuild.ComputeType.SMALL,
    };
    const deployCache = codebuild.Cache.local(codebuild.LocalCacheMode.DOCKER_LAYER, codebuild.LocalCacheMode.CUSTOM);

    const approvalTopic = new sns.Topic(this, 'ApprovalTopic', { topicName: `${config.appName}-Pipeline-Approval` });
    // Subscribe the approval email ONCE at the topic. Each ManualApprovalAction
    // then references the topic without re-subscribing (passing notifyEmails on
    // every action would create duplicate subscription ids on a multi-gate
    // pipeline). One subscription covers all approval gates.
    if (pc.approvalEmail) {
      approvalTopic.addSubscription(new subscriptions.EmailSubscription(pc.approvalEmail));
    }

    const stages: codepipeline.StageProps[] = [{ stageName: 'Source', actions: [sourceAction] }];

    pc.stages.forEach((stageCfg, index) => {
      const envName = stageCfg.environment;
      const envConfig = config.environments[envName];
      const prefix = stackPrefix(config, envName);
      const actions: codepipeline.IAction[] = [];
      let runOrder = 1;

      // Optional approval gate before this stage's deploy.
      if (stageCfg.manualApprovalBefore) {
        actions.push(new codepipeline_actions.ManualApprovalAction({
          actionName: `Approve-${capitalize(envName)}`,
          notificationTopic: approvalTopic,
          additionalInformation: `Approve deployment to '${envName}'.`,
          runOrder: runOrder++,
        }));
      }

      // Deploy action: cdk deploy scoped to THIS environment's stacks only.
      //
      // - Passes the same configFile that created the pipeline, so the per-stage
      //   deploy uses the right image/auth/bedrock/sizing (not defaults.json).
      // - Targets the explicit `${prefix}-*` stacks rather than `--all`, so it
      //   never tries to redeploy the pipeline stack or any sibling environment.
      const secretId = `${resourcePrefix(config, envName)}/cognito-client-secret`;
      const deployProject = new codebuild.PipelineProject(this, `Deploy-${capitalize(envName)}-Project`, {
        projectName: `${config.appName}-Deploy-${capitalize(envName)}`,
        role: cdkDeployRole,
        environment: buildEnvironment,
        cache: deployCache,
        environmentVariables: {
          TARGET_ENV: { value: envName },
          CONFIG_FILE: { value: config.pipeline.configFile ?? 'config/defaults.json' },
          STACK_PREFIX: { value: prefix },
          SECRET_ID: { value: secretId },
          DOMAIN_NAME: { value: envConfig.domainName ?? '' },
          CERTIFICATE_ARN: { value: envConfig.certificateArn ?? '' },
        },
        buildSpec: codebuild.BuildSpec.fromObject({
          version: '0.2',
          phases: {
            install: { 'runtime-versions': { nodejs: 22 }, commands: ['npm install -g aws-cdk'] },
            build: {
              commands: [
                'cd deploy/aws/cdk && npm ci',
                'export GIT_COMMIT=$CODEBUILD_RESOLVED_SOURCE_VERSION',
                'CTX="-c configFile=$CONFIG_FILE -c environment=$TARGET_ENV"',
                'if [ -n "$DOMAIN_NAME" ]; then CTX="$CTX -c domainName=$DOMAIN_NAME"; fi',
                'if [ -n "$CERTIFICATE_ARN" ]; then CTX="$CTX -c certificateArn=$CERTIFICATE_ARN"; fi',
                // Deploy only this environment's stacks (Network/Data/Auth/Compute).
                'eval "npx cdk deploy \\"$STACK_PREFIX-*\\" $CTX --require-approval never"',
              ],
            },
            post_build: {
              commands: [
                // Cognito client-secret sync — no-op unless an Auth stack exists for this env.
                `POOL_ID=$(aws cloudformation describe-stacks --stack-name $STACK_PREFIX-Auth --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text 2>/dev/null || echo "")`,
                `if [ -n "$POOL_ID" ] && [ "$POOL_ID" != "None" ]; then \
CLIENT_ID=$(aws cloudformation describe-stacks --stack-name $STACK_PREFIX-Auth --query "Stacks[0].Outputs[?OutputKey=='UserPoolClientId'].OutputValue" --output text); \
CLIENT_SECRET=$(aws cognito-idp describe-user-pool-client --user-pool-id $POOL_ID --client-id $CLIENT_ID --query "UserPoolClient.ClientSecret" --output text); \
aws secretsmanager put-secret-value --secret-id "$SECRET_ID" --secret-string "$CLIENT_SECRET"; \
echo "Synced Cognito client secret to $SECRET_ID"; \
else echo "No Auth stack for $TARGET_ENV; skipping Cognito secret sync"; fi`,
              ],
            },
          },
        }),
      });

      actions.push(new codepipeline_actions.CodeBuildAction({
        actionName: `Deploy-${capitalize(envName)}`,
        project: deployProject,
        input: sourceOutput,
        runOrder: runOrder++,
      }));

      // Optional post-deploy smoke test.
      if (stageCfg.smokeTest) {
        const smokeProject = new codebuild.PipelineProject(this, `Smoke-${capitalize(envName)}-Project`, {
          projectName: `${config.appName}-Smoke-${capitalize(envName)}`,
          environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0, computeType: codebuild.ComputeType.SMALL },
          environmentVariables: {
            APP_URL: { value: envConfig.domainName ? `https://${envConfig.domainName}` : '' },
            TARGET_STACK: { value: `${prefix}-Compute` },
          },
          buildSpec: codebuild.BuildSpec.fromObject({
            version: '0.2',
            phases: {
              build: {
                commands: [
                  // If no custom domain, resolve the CloudFront URL from the stack output.
                  'if [ -z "$APP_URL" ]; then APP_URL=$(aws cloudformation describe-stacks --stack-name $TARGET_STACK --query "Stacks[0].Outputs[?OutputKey==\'AppUrl\'].OutputValue" --output text); fi',
                  'echo "Smoke testing $APP_URL"',
                  'echo "Waiting 60s for service to stabilize..."',
                  'sleep 60',
                  'S=$(curl -s -o /dev/null -w "%{http_code}" $APP_URL/health); if [ "$S" != "200" ]; then echo "health failed: $S"; exit 1; fi',
                  'S=$(curl -s -o /dev/null -w "%{http_code}" $APP_URL/api/config); if [ "$S" != "200" ]; then echo "config failed: $S"; exit 1; fi',
                  'echo "Smoke tests passed"',
                ],
              },
            },
          }),
        });
        smokeProject.addToRolePolicy(new iam.PolicyStatement({ actions: ['cloudformation:DescribeStacks'], resources: [`arn:aws:cloudformation:*:${cdk.Aws.ACCOUNT_ID}:stack/${prefix}-Compute/*`] }));
        actions.push(new codepipeline_actions.CodeBuildAction({
          actionName: `Smoke-${capitalize(envName)}`,
          project: smokeProject,
          input: sourceOutput,
          type: codepipeline_actions.CodeBuildActionType.TEST,
          runOrder: runOrder++,
        }));
      }

      stages.push({ stageName: `${capitalize(envName)}-${index}`, actions });
    });

    new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: `${config.appName}-Pipeline`,
      pipelineType: codepipeline.PipelineType.V2,
      artifactBucket,
      stages,
    });

    new cdk.CfnOutput(this, 'PipelineName', { value: `${config.appName}-Pipeline` });
    new cdk.CfnOutput(this, 'ApprovalTopicArn', { value: approvalTopic.topicArn });
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Re-exported for the app entrypoint to reason about stage envs if needed.
export type { PipelineStageConfig };
