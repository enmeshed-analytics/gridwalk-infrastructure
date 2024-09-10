import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';
import { Network } from './network';
import { ImageRepositories } from './storage'
import { Instance } from './ec2'
import { Database } from './data'
import { Martin } from './martin'
import { Gridwalk } from './gridwalk-service'
import { CloudFrontToS3 } from '@aws-solutions-constructs/aws-cloudfront-s3';


export class GridwalkInfrastructureStack extends cdk.Stack {
  public readonly network: Network;
  public readonly hostedZone: route53.IPublicHostedZone;
  public readonly ecrImage: ImageRepositories;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Landing page

    new CloudFrontToS3(this, 'GridwalkLanding', {
      bucketProps: {
        encryption: s3.BucketEncryption.S3_MANAGED,
      },
      cloudFrontDistributionProps: {
        defaultBehavior: {
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
        minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      },
      responseHeadersPolicyProps: {
        responseHeadersPolicyName: 'CustomCSPPolicy',
        securityHeadersBehavior: {
          contentSecurityPolicy: {
            contentSecurityPolicy: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline';",
            override: true,
          },
          strictTransportSecurity: {
            accessControlMaxAge: cdk.Duration.days(2 * 365),
            includeSubdomains: true,
            preload: true,
            override: true,
          },
          contentTypeOptions: {
            override: true,
          },
          referrerPolicy: {
            referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
            override: true,
          },
          xssProtection: {
            protection: true,
            modeBlock: true,
            override: true,
          },
          frameOptions: {
            frameOption: cloudfront.HeadersFrameOption.DENY,
            override: true,
          },
        },
      },
      insertHttpSecurityHeaders: false,
    });

    // Landing page End

    this.hostedZone = route53.PublicHostedZone.fromPublicHostedZoneAttributes(
      this, 'HostedZone', {
        hostedZoneId: 'Z08439812RPAEHD661KZ4',
        zoneName: 'gridwalk.co'
      }
    );

    this.network = new Network(this, "Network", {
      cidr: "10.0.0.0/16",
      hostedZones: [this.hostedZone]
    });

    this.ecrImage = new ImageRepositories(this, "ImageRepositories");

    const database = new Database(this, 'Database', {
      network: {
        vpc: this.network.vpc,
        subnetGroup: this.network.subnetGroup
      },
      databaseName: 'gridwalk',
      schemaName: 'geo',
      allocatedStorage: 20
    });

    const instance = new Instance(this, 'Adhoc', {
      network: {
        vpc: this.network.vpc
      }
    });

    // Allow EC2 to connect to Postgres
    database.databaseSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(instance.instanceSecurityGroup.securityGroupId),
      ec2.Port.POSTGRES,
      "EC2 to Postgres"
    );

    // Allow EC2 to get secretcontaining Postgres details
    database.instance.secret!.grantRead(instance.instanceRole);

    const cluster = new ecs.Cluster(this, 'Cluster', { vpc: this.network.vpc });
    const namespace = new servicediscovery.PrivateDnsNamespace(this, 'Discovery', {
      vpc: this.network.vpc,
      name: "Gridwalk"
    });

    const martin = new Martin(this, 'Martin', {
      vpc: this.network.vpc,
      cluster: cluster,
      ecrRepository: this.ecrImage.martin,
      ecrImageTag: "v0.14.2",
      serviceName: "martin",
      cpu: 256,
      memoryLimitMiB: 512,
      desiredCount: 1,
      serviceConnectNamespace: namespace.namespaceName,
      databaseSecret: database.instance.secret!,
    });

    database.databaseSecurityGroup.addIngressRule(
      martin.securityGroup, ec2.Port.POSTGRES, "Allow martin to connect to Postgres"
    );

    const gridwalkTable = new dynamodb.TableV2(this, 'GridwalkTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
    });

    const gridwalk = new Gridwalk(this, 'Gridwalk', {
      vpc: this.network.vpc,
      cluster: cluster,
      ecrRepository: this.ecrImage.gridwalkWeb,
      ecrImageTag: "latest",
      serviceName: "gridwalk",
      cpu: 512,
      memoryLimitMiB: 1024,
      desiredCount: 1,
      dynamodbTable: gridwalkTable,
      serviceConnectNamespace: namespace.namespaceName,
      tileServerUrl: 'http://martin:8080',
      listener: this.network.httpsListener,
      baseUrl: 'gridwalk.co'
    });

    gridwalkTable.grantReadWriteData(gridwalk.taskDefinition.taskRole!);

    martin.securityGroup.addIngressRule(
      gridwalk.securityGroup, ec2.Port.tcp(8080), "Allow gridwalk to connect to martin"
    );
  }
}
