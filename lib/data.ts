import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface DatabaseProps {
  network: {
    vpc: ec2.IVpc;
    subnetGroup: rds.SubnetGroup;
  };
  databaseName: string;
  schemaName: string;
  allocatedStorage: number;
}

export class Database extends Construct {
  public readonly instance: rds.DatabaseInstance
  public readonly databaseSecurityGroup: ec2.SecurityGroup;
  public readonly appSecret: secretsmanager.ISecret;
  public readonly readSecret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: DatabaseProps) {
    super(scope, id);

    this.databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc: props.network.vpc,
      description: 'Used by RDS',
      allowAllOutbound: true,
      disableInlineRules: true
    });

    const parameterGroup = new rds.ParameterGroup(this, 'PostGISVectorTilesParameterGroup', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }), // Specify your Postgres version
      parameters: {
        // Vector tile specific
        'statement_timeout': '60000',             // Limit long-running queries (60 seconds)
        'idle_in_transaction_session_timeout': '60000', // Timeout idle sessions (60 seconds)
        'autovacuum_vacuum_scale_factor': '0.05', // More aggressive autovacuum
        'autovacuum_analyze_scale_factor': '0.02', // More aggressive autoanalyze

        // Logging (keep some basic logging)
        'log_min_duration_statement': '1000',     // Log queries taking more than 1 second
        'log_statement': 'ddl',                   // Log data definition statements
        'log_connections': '1',
        'log_disconnections': '1',
      },
    });

    this.instance = new rds.DatabaseInstance(this, 'Database', {
      engine: rds.DatabaseInstanceEngine.POSTGRES,
      databaseName: props.databaseName,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.M6G, ec2.InstanceSize.LARGE),
      allocatedStorage: props.allocatedStorage,
      credentials: rds.Credentials.fromGeneratedSecret('postgres'),
      vpc: props.network.vpc,
      securityGroups: [this.databaseSecurityGroup],
      subnetGroup: props.network.subnetGroup,
      storageEncrypted: true,
      caCertificate: rds.CaCertificate.RDS_CA_RDS2048_G1,
      parameterGroup: parameterGroup,
    });

    this.readSecret = new secretsmanager.Secret(this, "Read", {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: "read",
          database: props.databaseName,
          host: this.instance.dbInstanceEndpointAddress,
          port: this.instance.dbInstanceEndpointPort,
        }),
        generateStringKey: 'password',
        passwordLength: 30,
        excludeCharacters: '"@/\\\'',
      },
      description: `Read only access to the ${props.databaseName} geodatabase`
    });


    const gisadminSecret = new secretsmanager.Secret(this, "Gisadmin", {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: "gis_admin",
          database: props.databaseName,
          host: this.instance.dbInstanceEndpointAddress,
          port: this.instance.dbInstanceEndpointPort,
        }),
        generateStringKey: 'password',
        passwordLength: 30,
        excludeCharacters: '"@/\\\'',
      },
      description: `GIS Admin user for the ${props.databaseName} geodatabase`
    });

    this.appSecret = new secretsmanager.Secret(this, "App", {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: "write",
          database: props.databaseName,
          host: this.instance.dbInstanceEndpointAddress,
          port: this.instance.dbInstanceEndpointPort,
        }),
        generateStringKey: 'password',
        passwordLength: 30,
        excludeCharacters: '"@/\\\'',
      },
      description: "Write access to the database for use by the application"
    });

    const databaseInitSecurityGroup = new ec2.SecurityGroup(this, 'InitSecurityGroup', {
      vpc: props.network.vpc,
      description: 'Used by the Database Init Lambda Function',
      allowAllOutbound: true,
      disableInlineRules: true
    });

    // Function to initialize database
    const databaseInit = new nodejs.NodejsFunction(this, 'DatabaseInit', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(10),
      /* eslint-disable no-undef */
      projectRoot: path.join(__dirname, 'init-db'),
      depsLockFilePath: path.join(__dirname, 'init-db', 'package-lock.json'),
      entry: path.join(__dirname, 'init-db', 'index.ts'),
      /* eslint-enable no-undef */
      bundling: {
        nodeModules: ['pg'],
        commandHooks: {
          afterBundling: (inputDir: string, outputDir: string): string[] => [
            `cp ${inputDir}/global-bundle.pem ${outputDir}/global-bundle.pem`,
          ],
          // eslint-disable-next-line
          beforeBundling: (inputDir: string, outputDir: string): string[] => [],
          // eslint-disable-next-line
          beforeInstall: (inputDir: string, outputDir: string): string[] => [],
        },
      },
      environment: {
        DB_NAME: props.databaseName,
        SCHEMA_NAME: props.schemaName,
        MASTER_SECRET_NAME: this.instance.secret!.secretName,
        DB_READ_SECRET_NAME: this.readSecret.secretName,
        DB_GISADMIN_SECRET_NAME: gisadminSecret.secretName,
        DB_APP_SECRET_NAME: this.appSecret.secretName
      },
      vpc: props.network.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      allowPublicSubnet: true,
      securityGroups: [databaseInitSecurityGroup]
    });

    // Grant access to secrets from function
    this.instance.secret!.grantRead(databaseInit);
    this.readSecret.grantRead(databaseInit);
    gisadminSecret.grantRead(databaseInit);
    this.appSecret.grantRead(databaseInit);

    this.databaseSecurityGroup.addIngressRule(
      databaseInitSecurityGroup,
      ec2.Port.tcp(5432),
      "Allow inbound to database from init function"
    );
  }
}
