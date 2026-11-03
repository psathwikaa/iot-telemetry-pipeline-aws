import { APIGatewayProxyEvent, EventBridgeEvent } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import {
  InMemoryEventBus,
  IOT_EVENT_DETAIL_TYPES,
  IOT_EVENT_SOURCES
} from '../../src/events/alert-publisher';
import { createAlertProcessorHandler } from '../../src/handlers/alert-processor';
import { createIngestTelemetryHandler } from '../../src/handlers/ingest-telemetry';
import { createSilenceWatchdogHandler } from '../../src/handlers/silence-watchdog';
import {
  CloudWatchEmfDocument,
  TelemetryObservability
} from '../../src/observability/telemetry-logger';
import { InMemoryTelemetryRepository } from '../../src/storage/telemetry-repository';
import { AlertEventDetail, TelemetryRequestPayload } from '../../src/types/telemetry';

describe('Integration Tests: End-to-End Serverless IoT Telemetry Pipeline', () => {
  it('ingests telemetry into DynamoDB, emits MessagesPerDevice metrics, and routes Out-of-Range & Silent-Device EventBridge alerts', async () => {
    const repository = new InMemoryTelemetryRepository();
    const eventBus = new InMemoryEventBus('IotTelemetryEventBus');
    const logLines: string[] = [];
    const observability = new TelemetryObservability({
      serviceName: 'iot-telemetry-pipeline',
      metricNamespace: 'IotTelemetryPipeline',
      sink: (line) => logLines.push(line)
    });

    let currentClock = new Date('2026-11-02T18:00:00.000Z');

    const alertProcessor = createAlertProcessorHandler({
      repository,
      observability
    });

    // Wire EventBridge Rule matching Out-of-Range and Silent-Device events to AlertProcessor
    eventBus.registerRule({
      ruleName: 'OutOfRangeAndSilentAlertRule',
      sources: [IOT_EVENT_SOURCES.INGEST, IOT_EVENT_SOURCES.WATCHDOG],
      detailTypes: [
        IOT_EVENT_DETAIL_TYPES.ANOMALY_DETECTED,
        IOT_EVENT_DETAIL_TYPES.SILENT_DETECTED
      ],
      target: async (envelope) => {
        const ebEvent: EventBridgeEvent<
          'DeviceAnomalyDetected' | 'DeviceSilentDetected',
          AlertEventDetail
        > = {
          version: '0',
          id: envelope.id,
          'detail-type': envelope.detailType as 'DeviceAnomalyDetected' | 'DeviceSilentDetected',
          source: envelope.source,
          account: '111122223333',
          time: envelope.time,
          region: 'eu-north-1',
          resources: [],
          detail: envelope.detail
        };
        await alertProcessor(ebEvent);
      }
    });

    const ingestHandler = createIngestTelemetryHandler({
      repository,
      alertPublisher: eventBus,
      observability,
      nowFn: () => currentClock
    });

    const watchdogHandler = createSilenceWatchdogHandler({
      repository,
      alertPublisher: eventBus,
      observability,
      silenceThresholdSeconds: 300,
      nowFn: () => currentClock
    });

    const makePostEvent = (payload: TelemetryRequestPayload): APIGatewayProxyEvent =>
      ({
        httpMethod: 'POST',
        body: JSON.stringify(payload),
        headers: { 'x-correlation-id': `corr-${payload.deviceId}-${payload.sequenceNumber}` }
      }) as unknown as APIGatewayProxyEvent;

    // Step 1: Two devices send normal telemetry at T = 18:00:00Z
    const normalDeviceA: TelemetryRequestPayload = {
      deviceId: 'iot-se-gbg-001',
      timestamp: '2026-11-02T18:00:00.000Z',
      sequenceNumber: 1,
      firmwareVersion: '2.4.1',
      network: { rat: 'LTE-M', rssiDbm: -76, cellId: 'SE-GBG-01' },
      metrics: { temperatureC: 4.5, humidityPct: 52.0, batteryPct: 91.0, vibrationG: 0.2 }
    };

    const silentCandidateDeviceB: TelemetryRequestPayload = {
      deviceId: 'iot-no-osl-002',
      timestamp: '2026-11-02T18:00:00.000Z',
      sequenceNumber: 1,
      firmwareVersion: '2.4.1',
      network: { rat: 'NB-IoT', rssiDbm: -92, cellId: 'NO-OSL-07' },
      metrics: { temperatureC: 6.1, humidityPct: 48.5, batteryPct: 79.0 }
    };

    const resA1 = await ingestHandler(makePostEvent(normalDeviceA));
    const resB1 = await ingestHandler(makePostEvent(silentCandidateDeviceB));

    expect(resA1.statusCode).toBe(202);
    expect(resB1.statusCode).toBe(202);
    expect(eventBus.getPublishedEvents()).toHaveLength(0);

    // Step 2: At T = 18:03:00Z, Device A reports an OUT-OF-RANGE temperature spike (61.2°C) and low battery (6.4%)
    currentClock = new Date('2026-11-02T18:03:00.000Z');
    const anomalousDeviceA: TelemetryRequestPayload = {
      ...normalDeviceA,
      timestamp: '2026-11-02T18:03:00.000Z',
      sequenceNumber: 2,
      metrics: {
        temperatureC: 61.2, // critical out-of-range (> 55°C)
        humidityPct: 54.0,
        batteryPct: 6.4, // critical low battery (< 7%)
        vibrationG: 5.5 // warning vibration (> 4.0g)
      }
    };

    const resA2 = await ingestHandler(makePostEvent(anomalousDeviceA));
    expect(resA2.statusCode).toBe(202);
    const bodyA2 = JSON.parse(resA2.body);
    expect(bodyA2.anomalyDetected).toBe(true);
    expect(bodyA2.healthStatus).toBe('ANOMALY');
    expect(bodyA2.violations).toHaveLength(3);
    expect(bodyA2.alertEventId).toBeDefined();

    // Verify EventBridge published DeviceAnomalyDetected and AlertProcessor saved the audit record
    const deviceAAlerts = await repository.getDeviceAlerts('iot-se-gbg-001');
    expect(deviceAAlerts).toHaveLength(1);
    expect(deviceAAlerts[0].alertType).toBe('OUT_OF_RANGE');
    expect(deviceAAlerts[0].severity).toBe('CRITICAL');

    // Step 3: At T = 18:07:00Z (420s since Device B's last message at 18:00:00Z > 300s threshold),
    // Device A sends another heartbeat at 18:06:30Z, while Device B has gone completely silent.
    currentClock = new Date('2026-11-02T18:06:30.000Z');
    await ingestHandler(
      makePostEvent({
        ...normalDeviceA,
        timestamp: '2026-11-02T18:06:30.000Z',
        sequenceNumber: 3
      })
    );

    currentClock = new Date('2026-11-02T18:07:00.000Z');
    const watchdogResult = await watchdogHandler({ id: 'scheduled-check-1' });
    expect(watchdogResult.checkedDevices).toBe(2);
    expect(watchdogResult.newlySilentDevices).toEqual(['iot-no-osl-002']);

    // Verify EventBridge routed DeviceSilentDetected to AlertProcessor
    const deviceBAlerts = await repository.getDeviceAlerts('iot-no-osl-002');
    expect(deviceBAlerts).toHaveLength(1);
    expect(deviceBAlerts[0].alertType).toBe('DEVICE_SILENT');
    expect(deviceBAlerts[0].severity).toBe('CRITICAL');
    expect(deviceBAlerts[0].summary).toContain('went silent for 420s');

    // Verify idempotency: running the watchdog again 1 minute later does not re-alert on the already-silent device
    currentClock = new Date('2026-11-02T18:08:00.000Z');
    const secondWatchdogResult = await watchdogHandler({ id: 'scheduled-check-2' });
    expect(secondWatchdogResult.newlySilentDevices).toHaveLength(0);

    // Step 4: Verify GET /v1/devices/{deviceId}/telemetry returns history and alerts
    const getResponse = await ingestHandler({
      httpMethod: 'GET',
      pathParameters: { deviceId: 'iot-se-gbg-001' },
      headers: {}
    } as unknown as APIGatewayProxyEvent);
    expect(getResponse.statusCode).toBe(200);
    const getBody = JSON.parse(getResponse.body);
    expect(getBody.count).toBe(3);
    expect(getBody.alerts).toHaveLength(1);

    // Step 5: Verify CloudWatch EMF metrics emitted MessagesPerDevice for every ingested message
    const emfDocs = logLines
      .map((l) => JSON.parse(l) as Partial<CloudWatchEmfDocument>)
      .filter((obj) => obj._aws !== undefined && obj.MessagesPerDevice === 1);
    expect(emfDocs).toHaveLength(4); // 3 from Device A + 1 from Device B
    const deviceAMetrics = emfDocs.filter((d) => d.DeviceId === 'iot-se-gbg-001');
    expect(deviceAMetrics).toHaveLength(3);
  });
});
