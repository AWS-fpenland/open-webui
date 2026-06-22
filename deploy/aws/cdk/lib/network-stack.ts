import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface NetworkStackProps extends cdk.StackProps {
  resourcePrefix: string;
  maxAzs?: number;
  natGateways?: number;
  /** Add an interface endpoint for the Bedrock runtime (only useful when Bedrock is enabled). */
  enableBedrockEndpoint?: boolean;
}

/**
 * VPC with public + private-with-egress subnets, interface/gateway endpoints
 * for the AWS services the app talks to, and the two security groups shared
 * with the data and compute stacks.
 *
 * The ALB lives in private subnets; CloudFront reaches it via a VPC origin,
 * so there is no public ingress to the application.
 */
export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly ecsSecurityGroup: ec2.SecurityGroup;
  public readonly albSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    const maxAzs = props.maxAzs ?? 2;
    const natGateways = props.natGateways ?? maxAzs;

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs,
      natGateways,
      subnetConfiguration: [
        { cidrMask: 24, name: 'Public', subnetType: ec2.SubnetType.PUBLIC },
        { cidrMask: 24, name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      ],
    });

    // Gateway endpoint for S3 (free; keeps image-layer + upload traffic off NAT).
    this.vpc.addGatewayEndpoint('S3Endpoint', { service: ec2.GatewayVpcEndpointAwsService.S3 });

    // Interface endpoints for the control-plane services the task talks to.
    this.vpc.addInterfaceEndpoint('EcrEndpoint', { service: ec2.InterfaceVpcEndpointAwsService.ECR });
    this.vpc.addInterfaceEndpoint('EcrDockerEndpoint', { service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER });
    this.vpc.addInterfaceEndpoint('CloudWatchLogsEndpoint', { service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS });
    this.vpc.addInterfaceEndpoint('SecretsManagerEndpoint', { service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER });

    if (props.enableBedrockEndpoint) {
      this.vpc.addInterfaceEndpoint('BedrockRuntimeEndpoint', {
        service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
      });
    }

    // ECS task security group.
    this.ecsSecurityGroup = new ec2.SecurityGroup(this, 'EcsTaskSG', {
      vpc: this.vpc,
      description: 'Open WebUI ECS Fargate tasks',
      allowAllOutbound: true,
    });

    // Internal ALB security group. The inbound rule allowing CloudFront's VPC
    // origin to reach the ALB is added in the compute stack (where the ALB and
    // VPC origin are created) via the CloudFront origin-facing managed prefix
    // list — CloudFront does NOT open the target SG for you.
    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSG', {
      vpc: this.vpc,
      description: 'Open WebUI internal ALB (reached by CloudFront VPC origin)',
      allowAllOutbound: true,
    });

    // ALB → tasks on the app port.
    this.ecsSecurityGroup.addIngressRule(this.albSecurityGroup, ec2.Port.tcp(8080), 'ALB to ECS tasks');

    new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
  }
}
