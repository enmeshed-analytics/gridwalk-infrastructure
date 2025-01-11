import { Construct } from 'constructs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';

export interface NetworkProps {
  cidr: string;
  hostedZones: route53.IPublicHostedZone[];
}

export class Network extends Construct {
  public readonly vpc: ec2.Vpc;
  public readonly subnetGroup: rds.SubnetGroup; 
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly httpsListener: elbv2.ApplicationListener; 

  constructor(scope: Construct, id: string, props: NetworkProps) {
    super(scope, id);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(props.cidr),
      maxAzs: 3,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'PublicSubnet',
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    const publicSubnets = this.vpc.publicSubnets;
    const selectedSubnet = publicSubnets[0];
    this.vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      subnets: {
        subnets: [selectedSubnet],
      },
      privateDnsEnabled: true,
    })

    this.subnetGroup = new rds.SubnetGroup(this, 'SubnetGroupAll', {
      vpc: this.vpc,
      description: 'Subnet Group with all subnets',
      vpcSubnets: {
        subnets: this.vpc.publicSubnets,
      }
    });

    this.alb = new elbv2.ApplicationLoadBalancer(this, 'ApplicationLoadBalancer', {
      vpc: this.vpc,
      internetFacing: true,
    });

    interface certDictionary {
      [key: string]: acm.Certificate;
    }

    let certificates: certDictionary = {};
    for (let hostedZone of props.hostedZones) {
      certificates[hostedZone.zoneName] = new acm.Certificate(this, `${hostedZone.zoneName}Certificate`, {
        domainName: hostedZone.zoneName,
        subjectAlternativeNames: [`*.${hostedZone.zoneName}`],
        validation: acm.CertificateValidation.fromDns(hostedZone),
      });

      new route53.ARecord(this, `${hostedZone.zoneName}Route53AlbRecord`, {
        zone: hostedZone,
        target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(this.alb)),
      })

      new route53.ARecord(this, `${hostedZone.zoneName}Route53AlbRecordSubDomain`, {
        zone: hostedZone,
        target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(this.alb)),
        recordName: '*'
      })
    }

    this.alb.addListener('Listener80', {
      port: 80,
      open: true,
      defaultAction: elbv2.ListenerAction.redirect({
        port: '443',
        protocol: 'HTTPS',
        permanent: true,
      })
    });

    this.httpsListener = this.alb.addListener('Listener443', {
      port: 443,
      certificates: [Object.entries(certificates)[0][1]],
      open: true,
      defaultAction: elbv2.ListenerAction.fixedResponse(404),
    });
  }
}
