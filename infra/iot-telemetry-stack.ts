import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import {
  IOT_EVENT_DETAIL_TYPES,
  IOT_EVENT_SOURCES
} from '../src/events/alert-publisher';

export interface IotTelemetryStackProps extends cdk.StackProps {
  silenceThresholdSeconds?: number;
  telemetryTtlDays?: number;
  alertTtlDays?: number;
  metricNamespace?: string;
}

export class IotTelemetryStack extends cdk.Stack {
  public readonly telemetryTable: dynamodb.Table;
  public readonly eventBus: events.EventBus;
  public readonly ingestFunction: lambda.Function;
  public readonly silenceWatchdogFunction: lambda.Function;
  public readonly alertProcessorFunction: lambda.Function;
  public readonly alertRule: events.Rule;
  public readonly watchdogScheduleRule: events.Rule;
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: IotTelemetryStackProps = {}) {
    super(scope, id, props);

    const silenceThresholdSeconds = props.silenceThresholdSeconds ?? 300;
    const telemetryTtlDays = props.telemetryTtlDays ?? 30;
    const alertTtlDays = props.alertTtlDays ?? 90;
    const metricNamespace = props.metricNamespace ?? 'IotTelemetryPipeline';
    const serviceName = 'iot-telemetry-pipeline';

    // 1. DynamoDB Single-Table for Telemetry History, Device Heartbeat State, and Alert Audit (100% Free-Tier friendly)
    this.telemetryTable = new dynamodb.Table(this, 'IotTelemetryTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // 2. Custom EventBridge Bus for IoT Telemetry & Watchdog Alerts
    this.eventBus = new events.EventBus(this, 'IotTelemetryEventBus', {
      eventBusName: `${this.stackName}-TelemetryBus`
    });

    // 3. Dead-Letter Queue for failed EventBridge Alert Deliveries
    const alertDlq = new sqs.Queue(this, 'AlertEventDlq', {
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED
    });

    const commonLambdaEnvironment: Record<string, string> = {
      SERVICE_NAME: serviceName,
      METRIC_NAMESPACE: metricNamespace,
      TELEMETRY_TABLE_NAME: this.telemetryTable.tableName,
      ALERT_EVENT_BUS_NAME: this.eventBus.eventBusName,
      SILENCE_THRESHOLD_SECONDS: String(silenceThresholdSeconds),
      TELEMETRY_TTL_DAYS: String(telemetryTtlDays),
      ALERT_TTL_DAYS: String(alertTtlDays),
      NODE_OPTIONS: '--enable-source-maps'
    };

    const bundledLambdaDir = path.join(__dirname, '../dist/lambda');
    const codeAsset = lambda.Code.fromAsset(
      fs.existsSync(bundledLambdaDir) ? bundledLambdaDir : path.join(__dirname, '../src')
    );

    // 4. Ingestion Lambda Function (POST /v1/telemetry & GET /v1/devices/{deviceId}/telemetry)
    this.ingestFunction = new lambda.Function(this, 'IngestTelemetryFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handlers/ingest-telemetry.handler',
      code: codeAsset,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      tracing: lambda.Tracing.ACTIVE,
      loggingFormat: lambda.LoggingFormat.JSON,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: commonLambdaEnvironment,
      description:
        'Validates cellular IoT telemetry payloads, stores records in DynamoDB, emits MessagesPerDevice metrics, and publishes out-of-range alerts to EventBridge'
    });

    // 5. Silent Device Watchdog Lambda Function (Scheduled every 5 minutes)
    this.silenceWatchdogFunction = new lambda.Function(this, 'SilenceWatchdogFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handlers/silence-watchdog.handler',
      code: codeAsset,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      tracing: lambda.Tracing.ACTIVE,
      loggingFormat: lambda.LoggingFormat.JSON,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: commonLambdaEnvironment,
      description:
        'Scans device heartbeat states in DynamoDB and raises a DeviceSilentDetected alert on EventBridge when a device goes silent'
    });

    // 6. Alert Processor Lambda Function (Triggered by EventBridge Out-of-Range & Silent Alerts)
    this.alertProcessorFunction = new lambda.Function(this, 'AlertProcessorFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handlers/alert-processor.handler',
      code: codeAsset,
      memorySize: 256,
      timeout: cdk.Duration.seconds(15),
      tracing: lambda.Tracing.ACTIVE,
      loggingFormat: lambda.LoggingFormat.JSON,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: commonLambdaEnvironment,
      description:
        'Processes out-of-range and silent-device EventBridge alerts and persists immutable audit records in DynamoDB'
    });

    // Least-privilege IAM permissions
    this.telemetryTable.grantReadWriteData(this.ingestFunction);
    this.telemetryTable.grantReadWriteData(this.silenceWatchdogFunction);
    this.telemetryTable.grantWriteData(this.alertProcessorFunction);

    this.eventBus.grantPutEventsTo(this.ingestFunction);
    this.eventBus.grantPutEventsTo(this.silenceWatchdogFunction);

    // 7. EventBridge Rule: Out-of-Range Telemetry OR Silent Device -> Alert Processor Lambda
    this.alertRule = new events.Rule(this, 'OutOfRangeAndSilentAlertRule', {
      eventBus: this.eventBus,
      ruleName: `${this.stackName}-DeviceAlertRule`,
      description:
        'Routes DeviceAnomalyDetected (out-of-range telemetry) and DeviceSilentDetected (silent device) events to AlertProcessorFunction',
      eventPattern: {
        source: [IOT_EVENT_SOURCES.INGEST, IOT_EVENT_SOURCES.WATCHDOG],
        detailType: [
          IOT_EVENT_DETAIL_TYPES.ANOMALY_DETECTED,
          IOT_EVENT_DETAIL_TYPES.SILENT_DETECTED
        ]
      }
    });

    this.alertRule.addTarget(
      new targets.LambdaFunction(this.alertProcessorFunction, {
        deadLetterQueue: alertDlq,
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(2)
      })
    );

    // 8. EventBridge Scheduled Rule: Run Silence Watchdog every 5 minutes
    this.watchdogScheduleRule = new events.Rule(this, 'SilenceWatchdogScheduleRule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      description: 'Periodically triggers SilenceWatchdogFunction to detect devices that have gone silent'
    });
    this.watchdogScheduleRule.addTarget(
      new targets.LambdaFunction(this.silenceWatchdogFunction, {
        deadLetterQueue: alertDlq,
        retryAttempts: 2
      })
    );

    // 9. API Gateway REST API with Request Validation
    this.api = new apigateway.RestApi(this, 'IotTelemetryApi', {
      restApiName: 'IoT-Telemetry-Ingestion-API',
      description: 'Serverless API Gateway for cellular IoT device telemetry ingestion',
      deployOptions: {
        stageName: 'v1',
        tracingEnabled: true,
        metricsEnabled: true,
        throttlingRateLimit: 500,
        throttlingBurstLimit: 1000
      }
    });

    const requestValidator = new apigateway.RequestValidator(this, 'TelemetryRequestValidator', {
      restApi: this.api,
      validateRequestBody: true,
      validateRequestParameters: true
    });

    const telemetryModel = new apigateway.Model(this, 'TelemetryRequestModel', {
      restApi: this.api,
      contentType: 'application/json',
      modelName: 'TelemetryIngestionRequest',
      schema: {
        schema: apigateway.JsonSchemaVersion.DRAFT4,
        title: 'TelemetryIngestionRequest',
        type: apigateway.JsonSchemaType.OBJECT,
        required: [
          'deviceId',
          'timestamp',
          'sequenceNumber',
          'firmwareVersion',
          'network',
          'metrics'
        ],
        properties: {
          deviceId: { type: apigateway.JsonSchemaType.STRING, minLength: 4, maxLength: 64 },
          timestamp: { type: apigateway.JsonSchemaType.STRING },
          sequenceNumber: { type: apigateway.JsonSchemaType.INTEGER, minimum: 1 },
          firmwareVersion: { type: apigateway.JsonSchemaType.STRING },
          network: {
            type: apigateway.JsonSchemaType.OBJECT,
            required: ['rat', 'rssiDbm', 'cellId'],
            properties: {
              rat: {
                type: apigateway.JsonSchemaType.STRING,
                enum: ['LTE-M', 'NB-IoT', '5G-NR']
              },
              rssiDbm: { type: apigateway.JsonSchemaType.NUMBER },
              cellId: { type: apigateway.JsonSchemaType.STRING }
            }
          },
          metrics: {
            type: apigateway.JsonSchemaType.OBJECT,
            required: ['temperatureC', 'humidityPct', 'batteryPct'],
            properties: {
              temperatureC: { type: apigateway.JsonSchemaType.NUMBER },
              humidityPct: { type: apigateway.JsonSchemaType.NUMBER },
              batteryPct: { type: apigateway.JsonSchemaType.NUMBER },
              vibrationG: { type: apigateway.JsonSchemaType.NUMBER }
            }
          }
        }
      }
    });

    const ingestIntegration = new apigateway.LambdaIntegration(this.ingestFunction, {
      proxy: true
    });

    const v1Resource = this.api.root.addResource('v1');
    const telemetryResource = v1Resource.addResource('telemetry');
    telemetryResource.addMethod('POST', ingestIntegration, {
      requestValidator,
      requestModels: {
        'application/json': telemetryModel
      }
    });

    const devicesResource = v1Resource.addResource('devices');
    const deviceResource = devicesResource.addResource('{deviceId}');
    const deviceTelemetryResource = deviceResource.addResource('telemetry');
    deviceTelemetryResource.addMethod('GET', ingestIntegration);

    // 10. CloudWatch Metrics, Alarms, and Dashboard (MessagesPerDevice + Anomalies + Silent Devices)
    const messagesPerDeviceMetric = new cloudwatch.Metric({
      namespace: metricNamespace,
      metricName: 'MessagesPerDevice',
      dimensionsMap: { Service: serviceName },
      statistic: 'Sum',
      period: cdk.Duration.minutes(1)
    });

    const anomaliesDetectedMetric = new cloudwatch.Metric({
      namespace: metricNamespace,
      metricName: 'AnomaliesDetected',
      dimensionsMap: { Service: serviceName },
      statistic: 'Sum',
      period: cdk.Duration.minutes(5)
    });

    const silentDevicesMetric = new cloudwatch.Metric({
      namespace: metricNamespace,
      metricName: 'SilentDevicesDetected',
      dimensionsMap: { Service: serviceName },
      statistic: 'Sum',
      period: cdk.Duration.minutes(5)
    });

    new cloudwatch.Alarm(this, 'HighAnomalyCountAlarm', {
      metric: anomaliesDetectedMetric,
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription: 'Triggers when 5 or more out-of-range device telemetry anomalies occur within 5 minutes'
    });

    new cloudwatch.Alarm(this, 'SilentDeviceDetectedAlarm', {
      metric: silentDevicesMetric,
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription: 'Triggers immediately when one or more cellular IoT devices go silent'
    });

    const dashboard = new cloudwatch.Dashboard(this, 'IotTelemetryDashboard', {
      dashboardName: `${this.stackName}-Observability`
    });

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Messages Per Device & Total Ingested',
        left: [messagesPerDeviceMetric],
        width: 12
      }),
      new cloudwatch.GraphWidget({
        title: 'Out-of-Range Anomalies & Silent Devices',
        left: [anomaliesDetectedMetric, silentDevicesMetric],
        width: 12
      })
    );

    // CloudFormation Stack Outputs
    new cdk.CfnOutput(this, 'ApiEndpointOutput', {
      value: this.api.url,
      description: 'API Gateway base URL for IoT telemetry ingestion'
    });

    new cdk.CfnOutput(this, 'TelemetryTableNameOutput', {
      value: this.telemetryTable.tableName,
      description: 'DynamoDB table storing device telemetry, heartbeats, and alert audits'
    });

    new cdk.CfnOutput(this, 'AlertEventBusNameOutput', {
      value: this.eventBus.eventBusName,
      description: 'Custom EventBridge bus receiving out-of-range and silent-device alerts'
    });
  }
}
