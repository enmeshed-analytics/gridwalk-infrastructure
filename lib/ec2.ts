import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface InstanceProps {
  network: {
    vpc: ec2.IVpc;
  };
}

export class Instance extends Construct {
  public readonly instance: ec2.Instance;
  public readonly instanceRole: iam.Role;
  public readonly instanceSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: InstanceProps) {
    super(scope, id);

    // Create an IAM role for the EC2 instance
    this.instanceRole = new iam.Role(this, 'EC2Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Role for EC2',
    });

    // Add the AmazonSSMManagedInstanceCore managed policy to the role
    this.instanceRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));

    this.instanceSecurityGroup = new ec2.SecurityGroup(this, 'InstanceSecurityGroup', {
      vpc: props.network.vpc,
      description: 'Used by RDS',
      allowAllOutbound: true,
      disableInlineRules: true
    });

    // Find the latest Ubuntu image
    const ubuntu = ec2.MachineImage.lookup({
      name: 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*',
      owners: ['099720109477'], // Debian's official AWS account ID
    });

    this.instance = new ec2.Instance(this, 'Instance', {
      vpc: props.network.vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ubuntu,
      role: this.instanceRole,
      securityGroup: this.instanceSecurityGroup,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC
      }
    });   
  }
}
