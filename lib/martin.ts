import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as yaml from 'js-yaml';
import { Construct } from 'constructs';


interface MartinProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  cluster: ecs.ICluster;
  ecrRepository: ecr.IRepository;
  ecrImageTag: string;
  serviceName: string;
  cpu: number;
  memoryLimitMiB: number;
  desiredCount: number;
  serviceConnectNamespace: string;
  databaseSecret: secretsmanager.ISecret;
}

export class Martin extends Construct {
  public readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: MartinProps) {
    super(scope, id);

    // Create the S3 bucket for config
    const configBucket = new s3.Bucket(this, 'ConfigBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const configKey = 'config/config.yaml';

    // Create a task execution role
    const executionRole = new iam.Role(this, 'TaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // Grant the execution role access to ECR and CloudWatch Logs
    executionRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'));

    // Grant the execution role permission to pull images from ECR
    props.ecrRepository.grantPull(executionRole);

    // Create a task role
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // Grant the task role access to the S3 bucket
    configBucket.grantRead(taskRole, configKey);

    // Define the task definition
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      cpu: props.cpu,
      memoryLimitMiB: props.memoryLimitMiB,
      executionRole: executionRole,
      taskRole: taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64
      }
    });

    // Add volume for config file
    taskDefinition.addVolume({
      name: 'config',
      host: {},
    });

    const configContent = yaml.dump({
      'keep_alive': 75,
      'listen_addresses': '0.0.0.0:8080',
      'worker_processes': 30,
      'cache_size_mb': 2048,
      'preferred_encoding': 'gzip',
      'web_ui': 'enable-for-all',
      'postgres': {
        'connection_string': 'postgresql://${DB_USERNAME}:${DB_PASSWORD}@${DB_ENDPOINT}:${DB_PORT}/${DB_NAME}',
        'pool_size': 100,
        'default_srid': 3857,
        'auto_bounds': 'skip',
        'functions': {
          'roads': {
            'schema': 'geo',
            'function': 'roads_mvt',
            'minzoom': 0,
            'maxzoom': 22
          },
          'buildings': {
            'schema': 'geo',
            'function': 'buildings_mvt',
            'minzoom': 12,
            'maxzoom': 22
          }
        }
      }
    });

    new s3deploy.BucketDeployment(this, 'DeployConfig', {
      sources: [s3deploy.Source.data('config.yaml', configContent)],
      destinationBucket: configBucket,
      destinationKeyPrefix: 'config',
    });

    // Container to load Martin config file into task
    const configLoaderContainer = taskDefinition.addContainer('ConfigLoader', {
      image: ecs.ContainerImage.fromRegistry('amazon/aws-cli'),
      entryPoint: ['sh', '-c'],
      command: [
        `aws s3 cp s3://${configBucket.bucketName}/${configKey} /config/config.yaml && echo "Config loaded successfully"`,
      ],
      essential: false,
      logging: new ecs.AwsLogDriver({ streamPrefix: 'config-loader' }),
    });

    configLoaderContainer.addMountPoints({
      sourceVolume: 'config',
      containerPath: '/config',
      readOnly: false,
    });

    const martinContainer = taskDefinition.addContainer('MartinContainer', {
      image: ecs.ContainerImage.fromEcrRepository(props.ecrRepository, props.ecrImageTag),
      essential: true,
      logging: new ecs.AwsLogDriver({ streamPrefix: 'martin-container' }),
      portMappings: [{ containerPort: 8080, name: 'http' }],
      command: [
        "--config",
        "/config/config.yaml"
      ],
      environment: {
        'DB_NAME': 'gridwalk',
      },
      secrets: {
        'DB_USERNAME': ecs.Secret.fromSecretsManager(props.databaseSecret, 'username'),
        'DB_PASSWORD': ecs.Secret.fromSecretsManager(props.databaseSecret, 'password'),
        'DB_ENDPOINT': ecs.Secret.fromSecretsManager(props.databaseSecret, 'host'),
        'DB_PORT': ecs.Secret.fromSecretsManager(props.databaseSecret, 'port'),
        //'DB_NAME': ecs.Secret.fromSecretsManager(props.databaseSecret, 'database'),
      },
    });

    martinContainer.addMountPoints({
      sourceVolume: 'config',
      containerPath: '/config',
      readOnly: true,
    });

    // Add dependency to ensure the config loader runs before the martin container
    martinContainer.addContainerDependencies({
      container: configLoaderContainer,
      condition: ecs.ContainerDependencyCondition.SUCCESS,
    });

    this.securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc: props.vpc,
      description: 'Used by Martin Service',
      allowAllOutbound: true,
      disableInlineRules: true
    });

    // Create the Fargate service
    new ecs.FargateService(this, 'Service', {
      cluster: props.cluster,
      taskDefinition: taskDefinition,
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
        services: [
          {
            portMappingName: 'http',
            dnsName: props.serviceName,
            port: 8080,
            discoveryName: props.serviceName,
          },
        ],
      },
    });

    // Output the service URL
    new cdk.CfnOutput(this, 'ServiceUrl', {
      value: `http://${props.serviceName}.${props.serviceConnectNamespace}:8080`,
      description: 'URL for the ECS Service (accessible within the VPC)',
    });

    // Output the S3 bucket name
    new cdk.CfnOutput(this, 'ConfigBucketName', {
      value: configBucket.bucketName,
      description: 'Name of the S3 bucket containing the configuration file',
    });
  }
}
