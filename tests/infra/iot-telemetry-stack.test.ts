import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { IotTelemetryStack } from '../../infra/iot-telemetry-stack';

describe('AWS CDK Infrastructure Tests: IotTelemetryStack', () => {
  const app = new cdk.App();
  const stack = new IotTelemetryStack(app, 'TestIotStack', {
    silenceThresholdSeconds: 300,
    telemetryTtlDays: 30,
    alertTtlDays: 90
  });
  const template = Template.fromStack(stack);

  it('provisions a serverless DynamoDB single-table with PK/SK and TTL (Free-Tier compliant)', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' }
      ],
      TimeToLiveSpecification: {
        AttributeName: 'expiresAt',
        Enabled: true
      }
    });
  });

  it('provisions three ARM64 Node.js 20.x Lambda functions with structured JSON logging and X-Ray tracing', () => {
    // 3 application Lambdas (+ 1 log retention custom resource Lambda created by CDK)
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'handlers/ingest-telemetry.handler',
      Runtime: 'nodejs20.x',
      Architectures: ['arm64'],
      TracingConfig: { Mode: 'Active' },
      LoggingConfig: { LogFormat: 'JSON' }
    });

    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'handlers/silence-watchdog.handler',
      Runtime: 'nodejs20.x',
      Architectures: ['arm64'],
      TracingConfig: { Mode: 'Active' },
      LoggingConfig: { LogFormat: 'JSON' }
    });

    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'handlers/alert-processor.handler',
      Runtime: 'nodejs20.x',
      Architectures: ['arm64'],
      TracingConfig: { Mode: 'Active' },
      LoggingConfig: { LogFormat: 'JSON' }
    });
  });

  it('provisions an EventBridge bus, an alert routing rule for Out-of-Range & Silent devices, and a 5-minute watchdog schedule rule', () => {
    template.resourceCountIs('AWS::Events::EventBus', 1);

    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        source: ['iot.telemetry.ingest', 'iot.telemetry.watchdog'],
        'detail-type': ['DeviceAnomalyDetected', 'DeviceSilentDetected']
      },
      Targets: Match.arrayWith([
        Match.objectLike({
          RetryPolicy: {
            MaximumEventAgeInSeconds: 7200,
            MaximumRetryAttempts: 2
          }
        })
      ])
    });

    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(5 minutes)'
    });
  });

  it('provisions an API Gateway REST API with POST /v1/telemetry and JSON Schema body validation', () => {
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    template.hasResourceProperties('AWS::ApiGateway::RequestValidator', {
      ValidateRequestBody: true,
      ValidateRequestParameters: true
    });
    template.hasResourceProperties('AWS::ApiGateway::Model', {
      ContentType: 'application/json',
      Name: 'TelemetryIngestionRequest'
    });
  });

  it('provisions CloudWatch Alarms and an Observability Dashboard tracking MessagesPerDevice', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);

    const dashboards = template.findResources('AWS::CloudWatch::Dashboard');
    const dashboardBody = JSON.stringify(Object.values(dashboards)[0]);
    expect(dashboardBody).toContain('MessagesPerDevice');
    expect(dashboardBody).toContain('AnomaliesDetected');
    expect(dashboardBody).toContain('SilentDevicesDetected');
  });
});
