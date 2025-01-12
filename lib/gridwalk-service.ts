import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

// Product landing page
interface ProductConfig {
  ecrRepository: ecr.IRepository;
  imageTag: string;
  cpu: number;
  memoryLimitMiB: number;
  desiredCount: number;
  dynamodbLandingTable: dynamodb.TableV2;
}

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
  primaryGeoDatabaseSecret: secretsmanager.ISecret;
}

interface GridwalkProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  cluster: ecs.ICluster;
  serviceName: string;
  serviceConnectNamespace: string;
  listener: elbv2.IApplicationListener;
  baseUrl: string;

  product: ProductConfig;
  ui: UiConfig;
  backend: BackendConfig;
}

export class Gridwalk extends Construct {
  public readonly backendSecurityGroup: ec2.SecurityGroup;
  public readonly backendTaskDefinition: ecs.FargateTaskDefinition;
  public readonly uiTaskDefinition: ecs.FargateTaskDefinition;
  public readonly productTaskDefinition: ecs.FargateTaskDefinition;

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
        GW_DYNAMODB_TABLE: props.backend.dynamodbTable.tableName,
        GW_USER_EMAIL: "admin@gridwalk.co",
        GW_USER_PASSWORD: "initialPass999",
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
        GW_POSTGRES_HOST: ecs.Secret.fromSecretsManager(
          props.backend.primaryGeoDatabaseSecret,
          "host",
        ),
        GW_POSTGRES_PORT: ecs.Secret.fromSecretsManager(
          props.backend.primaryGeoDatabaseSecret,
          "port",
        ),
        GW_POSTGRES_DB: ecs.Secret.fromSecretsManager(
          props.backend.primaryGeoDatabaseSecret,
          "database",
        ),
        GW_POSTGRES_USERNAME: ecs.Secret.fromSecretsManager(
          props.backend.primaryGeoDatabaseSecret,
          "username",
        ),
        GW_POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(
          props.backend.primaryGeoDatabaseSecret,
          "password",
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
        path: "/login",
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(3),
      },
    });

    // Attach the UI service to the target group
    uiService.attachToApplicationTargetGroup(uiTargetGroup);

    // Add a redirect rule for the root path of app subdomain
    props.listener.addAction("AppRootRedirect", {
      priority: 4, // Higher priority (lower number) than the app rule
      conditions: [
        elbv2.ListenerCondition.hostHeaders([`app.${props.baseUrl}`]),
        elbv2.ListenerCondition.pathPatterns(['/'])
      ],
      action: elbv2.ListenerAction.redirect({
        host: props.baseUrl,
        path: '/',
        permanent: true,
        port: '443',
        protocol: 'HTTPS'
      })
    });

    // Add the target group to the listener
    props.listener.addTargetGroups("GridwalkUiTargetGroup", {
      targetGroups: [uiTargetGroup],
      priority: 5,
      conditions: [
        elbv2.ListenerCondition.hostHeaders([`app.${props.baseUrl}`])
      ],
    });

    // Grant the task execution role permission to pull images from ECR
    props.ui.ecrRepository.grantPull(this.uiTaskDefinition.executionRole!);

    // Product landing page
    this.productTaskDefinition = new ecs.FargateTaskDefinition(this, "ProductTaskDef", {
      memoryLimitMiB: props.backend.memoryLimitMiB,
      cpu: props.backend.cpu,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
      },
    });

    // Add container to the product task definition
    const productContainer = this.productTaskDefinition.addContainer("GridwalkProductContainer", {
      image: ecs.ContainerImage.fromEcrRepository(
        props.product.ecrRepository,
        props.product.imageTag,
      ),
      environment: {
        DYNAMODB_LANDING_TABLE: props.product.dynamodbLandingTable.tableName,
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
      logging: new ecs.AwsLogDriver({ streamPrefix: "GridwalkProductService" }),
    });

    productContainer.addPortMappings({
      containerPort: 3000,
      protocol: ecs.Protocol.TCP,
    });

    const productSecurityGroup = new ec2.SecurityGroup(this, "ProductSecurityGroup", {
      vpc: props.vpc,
      description: "Used by Gridwalk Product Service",
      allowAllOutbound: true,
      disableInlineRules: true,
    });

    // Allow inbound traffic on port 3000 from the ALB's security group
    productSecurityGroup.addIngressRule(
      ec2.SecurityGroup.fromSecurityGroupId(
        this,
        "ProductAlbSecurityGroup",
        props.listener.connections.securityGroups[0].securityGroupId,
      ),
      ec2.Port.tcp(3000),
      "Allow inbound traffic from ALB",
    );

    const productService = new ecs.FargateService(this, "ProductService", {
      cluster: props.cluster,
      taskDefinition: this.productTaskDefinition,
      desiredCount: props.product.desiredCount,
      serviceName: `${props.serviceName}-product`,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [productSecurityGroup],
      assignPublicIp: true,
      enableECSManagedTags: true,
      enableExecuteCommand: true,
      propagateTags: ecs.PropagatedTagSource.TASK_DEFINITION,
      serviceConnectConfiguration: {
        namespace: props.serviceConnectNamespace,
      },
    });

    const productTargetGroup = new elbv2.ApplicationTargetGroup(this, "ProductTargetGroup", {
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
    productService.attachToApplicationTargetGroup(productTargetGroup);

    // Add the target group to the listener
    props.listener.addTargetGroups("GridwalkProductTargetGroup", {
      targetGroups: [productTargetGroup],
      priority: 30,
      conditions: [
        elbv2.ListenerCondition.hostHeaders([props.baseUrl]),
      ],
    });

    // Grant the task execution role permission to pull images from ECR
    props.product.ecrRepository.grantPull(this.productTaskDefinition.executionRole!);
  }
}
