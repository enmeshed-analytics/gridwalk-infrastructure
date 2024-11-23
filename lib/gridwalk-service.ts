import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

interface UiConfig {
  ecrRepository: ecr.IRepository;
  imageTag: string;
  cpu: number;
  memoryLimitMiB: number;
  desiredCount: number;
  dynamodbLandingTable: dynamodb.TableV2;
}

interface BackendConfig {
  ecrRepository: ecr.IRepository;
  imageTag: string;
  cpu: number;
  memoryLimitMiB: number;
  desiredCount: number;
  dynamodbTable: dynamodb.TableV2;
}

interface GridwalkProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  cluster: ecs.ICluster;
  serviceName: string;
  serviceConnectNamespace: string;
  listener: elbv2.IApplicationListener;
  baseUrl: string;

  ui: UiConfig;
  backend: BackendConfig;
}

export class Gridwalk extends Construct {
  public readonly backendSecurityGroup: ec2.SecurityGroup;
  public readonly backendTaskDefinition: ecs.FargateTaskDefinition;
  public readonly uiTaskDefinition: ecs.FargateTaskDefinition;

  constructor(scope: Construct, id: string, props: GridwalkProps) {
    super(scope, id);

    // Create a task definition for the backend
    this.backendTaskDefinition = new ecs.FargateTaskDefinition(this, "BackendTaskDef", {
      memoryLimitMiB: props.backend.memoryLimitMiB,
      cpu: props.backend.cpu,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
      },
    });

    const os_api_secret = secretsmanager.Secret.fromSecretPartialArn(
      this,
      "OsApiSecret",
      "arn:aws:secretsmanager:us-east-1:017820660020:secret:os_api_gridwalk_basemap",
    );

    // Add container to the backend task definition
    const backendContainer = this.backendTaskDefinition.addContainer("GridwalkBackendContainer", {
      image: ecs.ContainerImage.fromEcrRepository(
        props.backend.ecrRepository,
        props.backend.imageTag,
      ),
      environment: {
        DYNAMODB_TABLE: props.backend.dynamodbTable.tableName,
      },
      secrets: {
        OS_PROJECT_API_KEY: ecs.Secret.fromSecretsManager(
          os_api_secret,
          "project_api_key",
        ),
        OS_PROJECT_API_SECRET: ecs.Secret.fromSecretsManager(
          os_api_secret,
          "project_api_secret",
        ),
      },
      logging: new ecs.AwsLogDriver({ streamPrefix: "GridwalkBackendService" }),
    });

    // Add port mapping to the container
    backendContainer.addPortMappings({
      containerPort: 3001,
      protocol: ecs.Protocol.TCP,
    });

    this.backendSecurityGroup = new ec2.SecurityGroup(this, "BackendSecurityGroup", {
      vpc: props.vpc,
      description: "Used by Gridwalk Backend Service",
      allowAllOutbound: true,
      disableInlineRules: true,
    });

    // Allow inbound traffic on port 3001 from the ALB's security group
    this.backendSecurityGroup.addIngressRule(
      ec2.SecurityGroup.fromSecurityGroupId(
        this,
        "ALBSecurityGroup",
        props.listener.connections.securityGroups[0].securityGroupId,
      ),
      ec2.Port.tcp(3001),
      "Allow inbound traffic from ALB",
    );

    // Create the Fargate service for backend
    const backendService = new ecs.FargateService(this, "BackendService", {
      cluster: props.cluster,
      taskDefinition: this.backendTaskDefinition,
      desiredCount: props.backend.desiredCount,
      serviceName: `${props.serviceName}-backend`,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [this.backendSecurityGroup],
      assignPublicIp: true,
      enableECSManagedTags: true,
      enableExecuteCommand: true,
      propagateTags: ecs.PropagatedTagSource.TASK_DEFINITION,
      serviceConnectConfiguration: {
        namespace: props.serviceConnectNamespace,
      },
    });

    // Create a target group for the backend service
    const backendTargetGroup = new elbv2.ApplicationTargetGroup(this, "BackendTargetGroup", {
      vpc: props.vpc,
      port: 3001,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: "/health",
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(3),
      },
    });

    // Attach the backend service to the target group
    backendService.attachToApplicationTargetGroup(backendTargetGroup);

    // Add the target group to the listener
    props.listener.addTargetGroups("GridwalkBackendTargetGroup", {
      targetGroups: [backendTargetGroup],
      priority: 10,
      conditions: [
        elbv2.ListenerCondition.hostHeaders([`api.${props.baseUrl}`]),
      ],
    });

    // Grant the task execution role permission to pull images from ECR
    props.backend.ecrRepository.grantPull(this.backendTaskDefinition.executionRole!);

    // Create a task definition for the UI
    this.uiTaskDefinition = new ecs.FargateTaskDefinition(this, "UiTaskDef", {
      memoryLimitMiB: props.ui.memoryLimitMiB,
      cpu: props.ui.cpu,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
      },
    });

    const nodemailer_secret = secretsmanager.Secret.fromSecretPartialArn(
      this,
      "NodemailerSecret",
      "arn:aws:secretsmanager:us-east-1:017820660020:secret:welcome_email_gw",
    );


    // Add container to the UI task definition
    const uiContainer = this.uiTaskDefinition.addContainer("GridwalkUiContainer", {
      image: ecs.ContainerImage.fromEcrRepository(
        props.ui.ecrRepository,
        props.ui.imageTag,
      ),
      environment: {
        GRIDWALK_API: "https://api.gridwalk.co",
        DYNAMODB_LANDING_TABLE: props.ui.dynamodbLandingTable.tableName,
      },
      secrets: {
        NODEMAILER_USER: ecs.Secret.fromSecretsManager(
          nodemailer_secret,
          "user",
        ),
        NODEMAILER_PASS: ecs.Secret.fromSecretsManager(
          nodemailer_secret,
          "pass",
        ),
      },
      logging: new ecs.AwsLogDriver({ streamPrefix: "GridwalkUiService" }),
    });

    uiContainer.addPortMappings({
      containerPort: 3000,
      protocol: ecs.Protocol.TCP,
    });

    const uiSecurityGroup = new ec2.SecurityGroup(this, "UiSecurityGroup", {
      vpc: props.vpc,
      description: "Used by Gridwalk UI Service",
      allowAllOutbound: true,
      disableInlineRules: true,
    });

    // Allow inbound traffic on port 3000 from the ALB's security group
    uiSecurityGroup.addIngressRule(
      ec2.SecurityGroup.fromSecurityGroupId(
        this,
        "UiAlbSecurityGroup",
        props.listener.connections.securityGroups[0].securityGroupId,
      ),
      ec2.Port.tcp(3000),
      "Allow inbound traffic from ALB",
    );

    const uiService = new ecs.FargateService(this, "UiService", {
      cluster: props.cluster,
      taskDefinition: this.uiTaskDefinition,
      desiredCount: props.ui.desiredCount,
      serviceName: `${props.serviceName}-ui`,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [uiSecurityGroup],
      assignPublicIp: true,
      enableECSManagedTags: true,
      enableExecuteCommand: true,
      propagateTags: ecs.PropagatedTagSource.TASK_DEFINITION,
      serviceConnectConfiguration: {
        namespace: props.serviceConnectNamespace,
      },
    });

    const uiTargetGroup = new elbv2.ApplicationTargetGroup(this, "UiTargetGroup", {
      vpc: props.vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: "/",
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(3),
      },
    });
    
    // Attach the UI service to the target group
    uiService.attachToApplicationTargetGroup(uiTargetGroup);
    
    // Add the target group to the listener
    props.listener.addTargetGroups("GridwalkUiTargetGroup", {
      targetGroups: [uiTargetGroup],
      priority: 20,
      conditions: [
        elbv2.ListenerCondition.hostHeaders([props.baseUrl]),
      ],
    });
    
    // Grant the task execution role permission to pull images from ECR
    props.ui.ecrRepository.grantPull(this.uiTaskDefinition.executionRole!);
  }
}
