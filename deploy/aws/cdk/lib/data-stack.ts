import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface DataStackProps extends cdk.StackProps {
  resourcePrefix: string;
  vpc: ec2.Vpc;
  ecsSecurityGroup: ec2.SecurityGroup;
  auroraMinCapacity?: number;
  auroraMaxCapacity?: number;
  auroraDeletionProtection?: boolean;
  /** Provision a Redis replication group for the Socket.IO manager. Set when WebSocket support is enabled. */
  enableRedis?: boolean;
}

/**
 * Stateful backing services for Open WebUI:
 *   - Aurora PostgreSQL Serverless v2  (DATABASE_URL)
 *   - ElastiCache Redis (TLS)          (Socket.IO manager + cache, optional)
 *   - S3 bucket                        (STORAGE_PROVIDER=s3 uploads)
 */
export class DataStack extends cdk.Stack {
  public readonly auroraCluster: rds.DatabaseCluster;
  public readonly uploadBucket: s3.Bucket;
  public readonly redisEndpoint?: string;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { vpc, ecsSecurityGroup } = props;

    // ── Aurora PostgreSQL Serverless v2 ──
    const dbSecurityGroup = new ec2.SecurityGroup(this, 'AuroraSG', {
      vpc,
      description: 'Open WebUI Aurora PostgreSQL',
      allowAllOutbound: false,
    });
    dbSecurityGroup.addIngressRule(ecsSecurityGroup, ec2.Port.tcp(5432), 'ECS tasks to Aurora');

    this.auroraCluster = new rds.DatabaseCluster(this, 'Aurora', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_16_4 }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [dbSecurityGroup],
      serverlessV2MinCapacity: props.auroraMinCapacity ?? 0.5,
      serverlessV2MaxCapacity: props.auroraMaxCapacity ?? 8,
      writer: rds.ClusterInstance.serverlessV2('Writer', { publiclyAccessible: false }),
      readers: [rds.ClusterInstance.serverlessV2('Reader', { scaleWithWriter: true, publiclyAccessible: false })],
      defaultDatabaseName: 'openwebui',
      // The admin credentials secret. We compose DATABASE_URL from this at
      // container start, so the generated password must EXCLUDE characters
      // that would break a URL userinfo segment (/, :, @, ?, #, whitespace, etc.).
      // Upstream's env.py reads DATABASE_URL directly — no component-var support —
      // so a clean URL is essential and the app image stays unmodified.
      credentials: rds.Credentials.fromGeneratedSecret('postgres', {
        secretName: `${props.resourcePrefix}/db-credentials`,
        excludeCharacters: ' /:@?#"\\\'`%&=+<>[]{}|^~',
      }),
      storageEncrypted: true,
      deletionProtection: props.auroraDeletionProtection ?? true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── ElastiCache Redis (optional — Socket.IO manager for multi-task WebSocket) ──
    if (props.enableRedis) {
      const redisSecurityGroup = new ec2.SecurityGroup(this, 'RedisSG', {
        vpc,
        description: 'Open WebUI ElastiCache Redis',
        allowAllOutbound: false,
      });
      redisSecurityGroup.addIngressRule(ecsSecurityGroup, ec2.Port.tcp(6379), 'ECS tasks to Redis');

      const redisSubnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
        description: 'Open WebUI Redis',
        subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
      });

      // CfnReplicationGroup (not CfnCacheCluster) — required for in-transit TLS.
      const redis = new elasticache.CfnReplicationGroup(this, 'Redis', {
        replicationGroupDescription: 'Open WebUI Redis (Socket.IO manager + cache)',
        engine: 'redis',
        cacheNodeType: 'cache.t3.micro',
        numCacheClusters: 1,
        cacheSubnetGroupName: redisSubnetGroup.ref,
        securityGroupIds: [redisSecurityGroup.securityGroupId],
        transitEncryptionEnabled: true,
        atRestEncryptionEnabled: true,
        automaticFailoverEnabled: false,
      });

      this.redisEndpoint = redis.attrPrimaryEndPointAddress;
      new cdk.CfnOutput(this, 'RedisEndpoint', { value: this.redisEndpoint });
    }

    // ── S3 bucket for uploads (STORAGE_PROVIDER=s3) ──
    this.uploadBucket = new s3.Bucket(this, 'UploadBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      versioned: true,
      lifecycleRules: [
        { id: 'CleanupOldVersions', noncurrentVersionExpiration: cdk.Duration.days(30) },
        { id: 'TransitionToIA', transitions: [{ storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: cdk.Duration.days(90) }] },
      ],
    });

    new cdk.CfnOutput(this, 'AuroraClusterEndpoint', { value: this.auroraCluster.clusterEndpoint.hostname });
    new cdk.CfnOutput(this, 'S3BucketName', { value: this.uploadBucket.bucketName });
  }
}
