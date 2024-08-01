#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { GridwalkInfrastructureStack } from '../lib/gridwalk-infrastructure-stack';

const prod  = { account: '017820660020', region: 'us-east-1' };

const app = new cdk.App();
new GridwalkInfrastructureStack(app, 'GridwalkInfrastructureProd', { env: prod });
