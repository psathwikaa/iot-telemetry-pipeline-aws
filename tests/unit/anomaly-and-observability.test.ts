import { APIGatewayProxyEvent } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import {
  EventBridgeAlertPublisher,
  InMemoryEventBus
} from '../../src/events/alert-publisher';
import { createIngestTelemetryHandler } from '../../src/handlers/ingest-telemetry';
import {
  CloudWatchEmfDocument,
  StructuredLogEntry,
  TelemetryObservability
} from '../../src/observability/telemetry-logger';
import { evaluateTelemetryAnomalies } from '../../src/rules/anomaly-evaluator';
import {
  DynamoDbTelemetryRepository,
  InMemoryTelemetryRepository
} from '../../src/storage/telemetry-repository';
import { TelemetryRequestPayload } from '../../src/types/telemetry';

function samplePayload(overrides: Partial<TelemetryRequestPayload> = {}): TelemetryRequestPayload {
  return {
    deviceId: 'iot-se-gbg-001',
    timestamp: '2026-11-02T18:10:00.000Z',
    sequenceNumber: 10,
    firmwareVersion: '2.4.1',
    network: {
      rat: 'LTE-M',
      rssiDbm: -80,
      cellId: 'SE-GBG-01'
    },
    metrics: {
      temperatureC: 18.0,
      humidityPct: 45.0,
      batteryPct: 82.0,
      vibrationG: 0.4
    },
    ...overrides
  };
}

describe('Unit Tests: Out-of-Range Anomaly Rule Evaluator', () => {
  it('returns HEALTHY (isAnomalous = false) when all metrics are within operating bounds', () => {
    const result = evaluateTelemetryAnomalies(samplePayload());
    expect(result.isAnomalous).toBe(false);
    expect(result.highestSeverity).toBe('NONE');
    expect(result.violations).toHaveLength(0);
  });

  it('classifies moderate threshold breaches as WARNING severity', () => {
    const payload = samplePayload({
      metrics: {
        temperatureC: 48.5, // above 45 max, below 55 criticalMax
        humidityPct: 50.0,
        batteryPct: 12.0 // below 15 min, above 7 criticalMin
      }
    });

    const result = evaluateTelemetryAnomalies(payload);
    expect(result.isAnomalous).toBe(true);
    expect(result.highestSeverity).toBe('WARNING');
    expect(result.violations).toHaveLength(2);
    expect(result.violations.map((v) => v.metric)).toEqual(['temperatureC', 'batteryPct']);
  });

  it('escalates highestSeverity to CRITICAL when any metric breaches a critical bound', () => {
    const payload = samplePayload({
      network: {
        rat: 'NB-IoT',
        rssiDbm: -128.0, // below -125 criticalMin
        cellId: 'SE-MMX-04'
      },
      metrics: {
        temperatureC: -38.0, // below -35 criticalMin
        humidityPct: 97.0, // above 95 criticalMax
        batteryPct: 5.0, // below 7 criticalMin
        vibrationG: 9.5 // above 8 criticalMax
      }
    });

    const result = evaluateTelemetryAnomalies(payload);
    expect(result.isAnomalous).toBe(true);
    expect(result.highestSeverity).toBe('CRITICAL');
    expect(result.violations).toHaveLength(5);
    expect(result.violations.every((v) => v.severity === 'CRITICAL')).toBe(true);
  });
});

describe('Unit Tests: Structured JSON Logging & CloudWatch EMF Metrics', () => {
  it('emits valid CloudWatch Embedded Metric Format (EMF) documents with MessagesPerDevice = 1', () => {
    const capturedLines: string[] = [];
    const obs = new TelemetryObservability({
      serviceName: 'iot-telemetry-test',
      metricNamespace: 'IotTelemetryPipeline',
      sink: (line) => capturedLines.push(line)
    });

    const emf = obs.emitDeviceIngestionMetric({
      deviceId: 'iot-se-gbg-007',
      rat: 'LTE-M',
      anomalyCount: 2,
      latencyMs: 14.378,
      correlationId: 'corr-emf-001',
      timestampMs: 1793643000000
    });

    expect(capturedLines).toHaveLength(1);
    const parsed = JSON.parse(capturedLines[0]) as CloudWatchEmfDocument;
    expect(parsed).toEqual(emf);
    expect(parsed.MessagesPerDevice).toBe(1);
    expect(parsed.DeviceId).toBe('iot-se-gbg-007');
    expect(parsed.AnomaliesDetected).toBe(2);
    expect(parsed.IngestionLatencyMs).toBe(14.38);
    expect(parsed._aws.CloudWatchMetrics[0].Namespace).toBe('IotTelemetryPipeline');
    expect(parsed._aws.CloudWatchMetrics[0].Dimensions).toContainEqual(['Service', 'DeviceId']);
    expect(parsed._aws.CloudWatchMetrics[0].Metrics).toContainEqual({
      Name: 'MessagesPerDevice',
      Unit: 'Count'
    });
  });

  it('emits structured JSON log entries for INFO, WARN, and ERROR levels', () => {
    const capturedLines: string[] = [];
    const obs = new TelemetryObservability({
      serviceName: 'iot-telemetry-test',
      sink: (line) => capturedLines.push(line)
    });

    obs.info('INGEST_OK', 'Processed frame', {
      correlationId: 'corr-1',
      deviceId: 'iot-se-gbg-001',
      rat: 'LTE-M',
      metadata: { seq: 1 }
    });
    obs.warn('ANOMALY', 'High temp', { correlationId: 'corr-2', deviceId: 'iot-se-gbg-001' });
    obs.error('DB_ERR', 'Write failed', { correlationId: 'corr-3' });

    expect(capturedLines).toHaveLength(3);
    const entries = capturedLines.map((l) => JSON.parse(l) as StructuredLogEntry);
    expect(entries.map((e) => e.level)).toEqual(['INFO', 'WARN', 'ERROR']);
    expect(entries[0].deviceId).toBe('iot-se-gbg-001');
    expect(entries[0].metadata).toEqual({ seq: 1 });
  });
});

describe('Unit Tests: Handler Edge Cases & AWS SDK Adapters', () => {
  it('handles empty and malformed JSON request bodies with HTTP 400', async () => {
    const handler = createIngestTelemetryHandler({
      repository: new InMemoryTelemetryRepository(),
      alertPublisher: new InMemoryEventBus(),
      observability: new TelemetryObservability({ sink: () => undefined })
    });

    const emptyResp = await handler({
      httpMethod: 'POST',
      body: null
    } as unknown as APIGatewayProxyEvent);
    expect(emptyResp.statusCode).toBe(400);

    const malformedResp = await handler({
      httpMethod: 'POST',
      body: '{invalid-json'
    } as unknown as APIGatewayProxyEvent);
    expect(malformedResp.statusCode).toBe(400);
    expect(JSON.parse(malformedResp.body).error).toBe('INVALID_JSON');
  });

  it('returns HTTP 500 when the underlying storage repository throws an error', async () => {
    const failingRepo = new InMemoryTelemetryRepository();
    vi.spyOn(failingRepo, 'saveTelemetryAndDeviceState').mockRejectedValueOnce(
      new Error('Simulated DynamoDB throughput error')
    );

    const handler = createIngestTelemetryHandler({
      repository: failingRepo,
      alertPublisher: new InMemoryEventBus(),
      observability: new TelemetryObservability({ sink: () => undefined })
    });

    const response = await handler({
      httpMethod: 'POST',
      body: JSON.stringify(samplePayload())
    } as unknown as APIGatewayProxyEvent);

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body).error).toBe('INTERNAL_SERVER_ERROR');
  });

  it('verifies DynamoDbTelemetryRepository and EventBridgeAlertPublisher SDK commands', async () => {
    const sendMock = vi.fn().mockResolvedValue({ Items: [] });
    const fakeDocClient = { send: sendMock } as unknown as ConstructorParameters<
      typeof DynamoDbTelemetryRepository
    >[1];
    const repo = new DynamoDbTelemetryRepository('TestTable', fakeDocClient);

    await repo.getDeviceTelemetryHistory('iot-se-gbg-001', 5);
    await repo.listDeviceStates();
    await repo.markDeviceSilent('iot-se-gbg-001', '2026-11-02T19:00:00Z');
    await repo.getDeviceAlerts('iot-se-gbg-001');
    expect(sendMock).toHaveBeenCalledTimes(4);

    const ebSendMock = vi.fn().mockResolvedValue({
      FailedEntryCount: 0,
      Entries: [{ EventId: 'eb-event-123' }]
    });
    const fakeEbClient = { send: ebSendMock } as unknown as ConstructorParameters<
      typeof EventBridgeAlertPublisher
    >[1];
    const publisher = new EventBridgeAlertPublisher('TestBus', fakeEbClient);

    const eventId = await publisher.publishSilentDeviceAlert({
      alertId: 'silent-1',
      alertType: 'DEVICE_SILENT',
      deviceId: 'iot-se-gbg-001',
      lastSeenAt: '2026-11-02T18:00:00Z',
      detectedAt: '2026-11-02T18:10:00Z',
      silenceDurationSeconds: 600,
      thresholdSeconds: 300,
      lastSequenceNumber: 4,
      rat: 'LTE-M',
      cellId: 'SE-GBG-01',
      severity: 'CRITICAL',
      correlationId: 'corr-eb-1'
    });
    expect(eventId).toBe('eb-event-123');
  });
});
