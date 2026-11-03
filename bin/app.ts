#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { IotTelemetryStack } from '../infra/iot-telemetry-stack';

const app = new cdk.App();

new IotTelemetryStack(app, 'IotTelemetryPipelineStack', {
  description:
    'Serverless cellular IoT telemetry ingestion, out-of-range anomaly alerting, and silent-device monitoring stack',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT ?? '267900015216',
    region: process.env.CDK_DEFAULT_REGION ?? 'eu-north-1'
  },
  tags: {
    Project: 'iot-telemetry-pipeline-aws',
    Environment: process.env.STAGE ?? 'production',
    ManagedBy: 'aws-cdk'
  }
});
