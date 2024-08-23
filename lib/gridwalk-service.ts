import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

interface GridwalkProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  cluster: ecs.ICluster;
  ecrRepository: ecr.IRepository;
  ecrImageTag: string;
  serviceName: string;
  cpu: number;
  memoryLimitMiB: number;
  desiredCount: number;
  dynamodbTable: dynamodb.TableV2;
  serviceConnectNamespace: string;
  tileServerUrl: string;
  listener: elbv2.IApplicationListener;
  baseUrl: string;
}

export class Gridwalk extends Construct {
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly taskDefinition: ecs.FargateTaskDefinition;

  constructor(scope: Construct, id: string, props: GridwalkProps) {
    super(scope, id);

    // Create a task definition
    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      memoryLimitMiB: props.memoryLimitMiB,
      cpu: props.cpu,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64
      }
    });

    // Add container to the task definition
    const container = this.taskDefinition.addContainer('GridwalkContainer', {
      image: ecs.ContainerImage.fromEcrRepository(props.ecrRepository, props.ecrImageTag),
      environment: {
        TILE_SERVER_URL: props.tileServerUrl,
        TABLE_NAME: props.dynamodbTable.tableName,
      },
      logging: new ecs.AwsLogDriver({ streamPrefix: 'GridwalkService' }),
    });

    // Add port mapping to the container
    container.addPortMappings({
      containerPort: 3000,
      protocol: ecs.Protocol.TCP,
    });

    this.securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc: props.vpc,
      description: 'Used by Gridwalk Service',
      allowAllOutbound: true,
      disableInlineRules: true
    });

    // Allow inbound traffic on port 3000 from the ALB's security group
    this.securityGroup.addIngressRule(
      ec2.SecurityGroup.fromSecurityGroupId(
        this, 
        'ALBSecurityGroup', 
        props.listener.connections.securityGroups[0].securityGroupId
      ),
      ec2.Port.tcp(3000),
      'Allow inbound traffic from ALB'
    );

    // Create the Fargate service
    const fargateService = new ecs.FargateService(this, 'Service', {
      cluster: props.cluster,
      taskDefinition: this.taskDefinition,
      desiredCount: props.desiredCount,
      serviceName: props.serviceName,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [this.securityGroup],
      assignPublicIp: true,
      enableECSManagedTags: true,
      enableExecuteCommand: true,
      propagateTags: ecs.PropagatedTagSource.TASK_DEFINITION,
      serviceConnectConfiguration: {
        namespace: props.serviceConnectNamespace,
      },
    });

    // Create a target group for the service
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc: props.vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(3),
      },
    });

    // Attach the service to the target group
    fargateService.attachToApplicationTargetGroup(targetGroup);

    // Add the target group to the listener
    props.listener.addTargetGroups('GridwalkTargetGroup', {
      targetGroups: [targetGroup],
      priority: 10, // Adjust this priority as needed
      conditions: [
        elbv2.ListenerCondition.hostHeaders([`app.${props.baseUrl}`]),
      ],
    });

    // Grant the task execution role permission to pull images from ECR
    props.ecrRepository.grantPull(this.taskDefinition.executionRole!);
  }
}
