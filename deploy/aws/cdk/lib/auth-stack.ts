import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

export interface AuthStackProps extends cdk.StackProps {
  resourcePrefix: string;
  callbackUrls?: string[];
  logoutUrls?: string[];
  cognitoDomainPrefix?: string;
}

/**
 * Optional Cognito user pool + OIDC client for Open WebUI SSO.
 *
 * Only created when auth.mode='cognito'. Open WebUI consumes Cognito as a
 * standard OIDC provider via its built-in OAUTH_* settings — no application
 * code changes. With auth.mode='none' (the default), Open WebUI's built-in
 * email/password auth is used and this stack is never instantiated.
 */
export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly userPoolDomain: cognito.UserPoolDomain;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${props.resourcePrefix}-users`,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
        fullname: { required: false, mutable: true },
      },
      passwordPolicy: { minLength: 8, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: false },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.userPoolClient = new cognito.UserPoolClient(this, 'Client', {
      userPool: this.userPool,
      userPoolClientName: `${props.resourcePrefix}-app`,
      generateSecret: true,
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: props.callbackUrls ?? ['https://localhost/oauth/oidc/callback'],
        logoutUrls: props.logoutUrls ?? ['https://localhost/auth'],
      },
      preventUserExistenceErrors: true,
    });

    this.userPoolDomain = new cognito.UserPoolDomain(this, 'Domain', {
      userPool: this.userPool,
      cognitoDomain: { domainPrefix: props.cognitoDomainPrefix ?? `${props.resourcePrefix}-${cdk.Aws.ACCOUNT_ID}` },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    new cognito.CfnManagedLoginBranding(this, 'ManagedLoginBranding', {
      userPoolId: this.userPool.userPoolId,
      clientId: this.userPoolClient.userPoolClientId,
      useCognitoProvidedValues: true,
    });

    // Role-mapping groups (consumed via OAUTH_ROLES_CLAIM=cognito:groups).
    for (const [groupName, description] of [
      ['admin', 'Admin users with full access'],
      ['user', 'Standard users'],
      ['power-users', 'Power users'],
      ['basic-users', 'Basic users'],
    ] as const) {
      new cognito.CfnUserPoolGroup(this, `Group-${groupName}`, {
        userPoolId: this.userPool.userPoolId,
        groupName,
        description,
      });
    }

    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'CognitoDomain', { value: `${this.userPoolDomain.domainName}.auth.${cdk.Aws.REGION}.amazoncognito.com` });
  }
}
