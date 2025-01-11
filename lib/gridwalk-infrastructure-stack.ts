import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';
import { Network } from './network';
import { ImageRepositories } from './storage'
import { Instance } from './ec2'
import { Database } from './data'
import { Gridwalk } from './gridwalk-service'


export class GridwalkInfrastructureStack extends cdk.Stack {
  public readonly network: Network;
  public readonly hostedZone: route53.IPublicHostedZone;
  public readonly ecrImage: ImageRepositories;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

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

    const gridwalkTable = new dynamodb.TableV2(this, 'GridwalkTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey : { name: 'SK', type: dynamodb.AttributeType.STRING },
      globalSecondaryIndexes: [
        {
          indexName: 'GSI_USER',
          partitionKey: { name: 'user_id', type: dynamodb.AttributeType.STRING },
        },
        {
          indexName: 'GSI_WORKSPACE_BY_NAME',
          partitionKey: { name: 'workspace_name', type: dynamodb.AttributeType.STRING },
        }

      ]
    });

    const gridwalkLandingTable = new dynamodb.TableV2(this, 'GridwalkLandingTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
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


    const gridwalk = new Gridwalk(this, 'Gridwalk', {
      vpc: this.network.vpc,
      cluster: cluster,
      serviceName: "gridwalk",
      serviceConnectNamespace: namespace.namespaceName,
      listener: this.network.httpsListener,
      baseUrl: 'gridwalk.co',
      backend: {
        ecrRepository: this.ecrImage.gridwalkBackend,
        imageTag: "latest",
        cpu: 256,
        memoryLimitMiB: 512,
        desiredCount: 1,
        dynamodbTable: gridwalkTable,
      },
      ui: {
        ecrRepository: this.ecrImage.gridwalkUi,
        imageTag: "latest",
        cpu: 512,
        memoryLimitMiB: 1024,
        desiredCount: 1,
        dynamodbLandingTable: gridwalkLandingTable
      },
      product: {
        ecrRepository: this.ecrImage.gridwalkProduct,
        imageTag: "latest",
        cpu: 256,
        memoryLimitMiB: 512,
        desiredCount: 1,
        dynamodbLandingTable: gridwalkLandingTable
      }
    });

    gridwalk.backendTaskDefinition.taskRole!.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:ListTables'],
        resources: [`arn:aws:dynamodb:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:table/*`]
      })
    );
    gridwalkTable.grantReadWriteData(gridwalk.backendTaskDefinition.taskRole!);
    gridwalkLandingTable.grantReadWriteData(gridwalk.uiTaskDefinition.taskRole!);
    gridwalkLandingTable.grantReadWriteData(gridwalk.productTaskDefinition.taskRole!);
  }
}
