import * as fs from 'fs';
import * as path from 'path';
import { APIGatewayProxyEvent, EventBridgeEvent } from 'aws-lambda';
import {
  InMemoryEventBus,
  IOT_EVENT_DETAIL_TYPES,
  IOT_EVENT_SOURCES
} from './events/alert-publisher';
import { createAlertProcessorHandler } from './handlers/alert-processor';
import { createIngestTelemetryHandler } from './handlers/ingest-telemetry';
import { createSilenceWatchdogHandler } from './handlers/silence-watchdog';
import { TelemetryObservability } from './observability/telemetry-logger';
import { InMemoryTelemetryRepository } from './storage/telemetry-repository';
import { AlertEventDetail, TelemetryRequestPayload } from './types/telemetry';

interface SimulatedFrame {
  round: number;
  injectedAnomaly: boolean;
  contractValid: boolean;
  payload: TelemetryRequestPayload;
}

interface SimulationRunReport {
  total_devices: number;
  rounds: number;
  messages_sent: number;
  frames: SimulatedFrame[];
}

export async function runLocalPipelineFromSimulation(
  simulationReportPath: string,
  outputDir: string
): Promise<void> {
  const rawSim = fs.readFileSync(simulationReportPath, 'utf-8');
  const simData = JSON.parse(rawSim) as SimulationRunReport;

  const repository = new InMemoryTelemetryRepository();
  const eventBus = new InMemoryEventBus('IotTelemetryEventBus');
  const observabilityLines: string[] = [];

  const observability = new TelemetryObservability({
    serviceName: 'iot-telemetry-pipeline',
    metricNamespace: 'IotTelemetryPipeline',
    sink: (line) => observabilityLines.push(line)
  });

  let currentClock = new Date('2026-11-02T18:00:00.000Z');

  const alertProcessor = createAlertProcessorHandler({
    repository,
    observability
  });

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

  const apiResponses: Array<{ statusCode: number; body: unknown }> = [];

  for (const frame of simData.frames) {
    currentClock = new Date(frame.payload.timestamp);
    const event = {
      httpMethod: 'POST',
      body: JSON.stringify(frame.payload),
      headers: {
        'x-correlation-id': `sim-${frame.payload.deviceId}-seq-${frame.payload.sequenceNumber}`
      }
    } as unknown as APIGatewayProxyEvent;

    const response = await ingestHandler(event);
    apiResponses.push({
      statusCode: response.statusCode,
      body: JSON.parse(response.body)
    });
  }

  // Advance clock 60s past final round and run the Silence Watchdog
  currentClock = new Date(currentClock.getTime() + 60 * 1000);
  const watchdogResult = await watchdogHandler({ id: 'watchdog-post-simulation' });

  const deviceStates = await repository.listDeviceStates();
  const alerts = repository.getAllAlerts();
  const publishedEvents = eventBus.getPublishedEvents();

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, 'cloudwatch_logs_and_emf.jsonl'),
    observabilityLines.join('\n') + '\n',
    'utf-8'
  );

  const summaryReport = {
    executedAt: currentClock.toISOString(),
    totalFramesIngested: apiResponses.length,
    http202Accepted: apiResponses.filter((r) => r.statusCode === 202).length,
    deviceStates,
    watchdogResult,
    eventBridgeEventsPublished: publishedEvents.length,
    alertsPersisted: alerts
  };

  fs.writeFileSync(
    path.join(outputDir, 'pipeline_execution_report.json'),
    JSON.stringify(summaryReport, null, 2),
    'utf-8'
  );
}

if (require.main === module) {
  const simPath = path.resolve(process.cwd(), 'reports/simulation_run.json');
  const outDir = path.resolve(process.cwd(), 'reports');
  runLocalPipelineFromSimulation(simPath, outDir).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
