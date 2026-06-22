import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface BedrockAccessProps {
  /** Allow-list of model IDs / patterns. Empty = all foundation models + inference profiles. */
  allowedModels?: string[];
}

/**
 * IAM policy statements granting the ECS task role access to the Amazon
 * Bedrock Converse/Invoke APIs and inference-profile discovery.
 *
 * Only instantiated when bedrock.enabled is true, keeping the default
 * (vanilla) task role free of any Bedrock permissions.
 */
export class BedrockAccess extends Construct {
  public readonly policyStatements: iam.PolicyStatement[];

  constructor(scope: Construct, id: string, props?: BedrockAccessProps) {
    super(scope, id);

    const allowedModels = props?.allowedModels ?? [];
    this.policyStatements = [];

    this.policyStatements.push(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:ListFoundationModels', 'bedrock:ListInferenceProfiles', 'bedrock:GetInferenceProfile'],
        resources: ['*'],
      }),
    );

    const modelResources =
      allowedModels.length > 0
        ? allowedModels.map((m) => `arn:aws:bedrock:*::foundation-model/${m}`)
        : ['arn:aws:bedrock:*::foundation-model/*'];
    const profileResources = ['arn:aws:bedrock:*:*:inference-profile/*'];

    this.policyStatements.push(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'bedrock:Converse', 'bedrock:ConverseStream'],
        resources: [...modelResources, ...profileResources],
      }),
    );
  }
}
