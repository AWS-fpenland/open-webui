import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/**
 * Full IAM access to the Amazon Bedrock model + agent platform for the ECS
 * task role:
 *
 *   - `bedrock:*`            — Bedrock runtime (InvokeModel / Converse /
 *                             InvokeModelWithResponseStream / ConverseStream)
 *                             AND the control/management plane. A single prefix
 *                             covers both; there is no separate `bedrock-runtime:`
 *                             IAM prefix.
 *   - `bedrock-agentcore:*` — Bedrock AgentCore, both the data plane
 *                             (InvokeAgentRuntime, InvokeAgentRuntimeForUser,
 *                             InvokeAgentRuntimeWithWebSocketStream, gateway/
 *                             browser/code-interpreter/memory invoke) AND the
 *                             control plane (CreateAgentRuntime, CreateGateway,
 *                             CreateMemory, …). One prefix covers both — the
 *                             `bedrock-agentcore-control` name is only an API
 *                             endpoint / CLI client, NOT an IAM prefix.
 *   - `bedrock-mantle:*`     — "Amazon Bedrock Powered by AWS Mantle", the
 *                             OpenAI-/Anthropic-compatible inference endpoint
 *                             (CreateInference, projects, fine-tuning, …). A
 *                             separate service from the classic Bedrock runtime.
 *
 * Granted unconditionally to every deployment path so the application can fully
 * invoke and interact with Bedrock, AgentCore, and Mantle out of the box.
 */
export class AgentCoreFullAccess extends Construct {
  public readonly policyStatements: iam.PolicyStatement[];

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.policyStatements = [
      new iam.PolicyStatement({
        sid: 'BedrockFullAccess',
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:*'],
        resources: ['*'],
      }),
      new iam.PolicyStatement({
        sid: 'BedrockAgentCoreFullAccess',
        effect: iam.Effect.ALLOW,
        actions: ['bedrock-agentcore:*'],
        resources: ['*'],
      }),
      new iam.PolicyStatement({
        sid: 'BedrockMantleFullAccess',
        effect: iam.Effect.ALLOW,
        actions: ['bedrock-mantle:*'],
        resources: ['*'],
      }),
    ];
  }
}
