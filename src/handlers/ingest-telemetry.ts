import { randomUUID } from 'crypto';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  AlertEventPublisher,
  EventBridgeAlertPublisher
} from '../events/alert-publisher';
import { TelemetryObservability } from '../observability/telemetry-logger';
import {
  DEFAULT_TELEMETRY_THRESHOLDS,
  evaluateTelemetryAnomalies
} from '../rules/anomaly-evaluator';
import {
  DynamoDbTelemetryRepository,
  TelemetryRepository
} from '../storage/telemetry-repository';
import {
  DeviceAnomalyAlertDetail,
  DeviceStateRecord,
  TelemetryHistoryRecord,
  TelemetryThresholdConfig
} from '../types/telemetry';
import { validateTelemetryContract } from '../validation/contract-validator';

export interface IngestHandlerDependencies {
  repository?: TelemetryRepository;
  alertPublisher?: AlertEventPublisher;
  observability?: TelemetryObservability;
  thresholds?: TelemetryThresholdConfig;
  ttlDays?: number;
  nowFn?: () => Date;
}

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload'
};

export function createIngestTelemetryHandler(deps: IngestHandlerDependencies = {}) {
  let repository = deps.repository;
  let alertPublisher = deps.alertPublisher;
  const observability = deps.observability ?? new TelemetryObservability();
  const thresholds = deps.thresholds ?? DEFAULT_TELEMETRY_THRESHOLDS;
  const ttlDays = deps.ttlDays ?? Number(process.env.TELEMETRY_TTL_DAYS ?? '30');
  const nowFn = deps.nowFn ?? (() => new Date());

  const getRepository = (): TelemetryRepository => {
    if (!repository) {
      repository = new DynamoDbTelemetryRepository();
    }
    return repository;
  };

  const getAlertPublisher = (): AlertEventPublisher => {
    if (!alertPublisher) {
      alertPublisher = new EventBridgeAlertPublisher();
    }
    return alertPublisher;
  };

  return async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const startMs = performance.now();
    const correlationId =
      event.headers?.['x-correlation-id'] ??
      event.headers?.['X-Correlation-Id'] ??
      event.requestContext?.requestId ??
      randomUUID();

    // Support GET /v1/devices/{deviceId}/telemetry for querying recent device history
    if (event.httpMethod === 'GET') {
      const deviceId = event.pathParameters?.deviceId;
      if (!deviceId) {
        return {
          statusCode: 400,
          headers: JSON_HEADERS,
          body: JSON.stringify({
            error: 'BAD_REQUEST',
            message: 'Missing deviceId path parameter',
            correlationId
          })
        };
      }

      const history = await getRepository().getDeviceTelemetryHistory(deviceId, 20);
      const alerts = await getRepository().getDeviceAlerts(deviceId);
      return {
        statusCode: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({
          deviceId,
          count: history.length,
          telemetry: history,
          alerts,
          correlationId
        })
      };
    }

    if (!event.body) {
      observability.warn('EMPTY_REQUEST_BODY', 'Rejected request with empty body', {
        correlationId
      });
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({
          error: 'INVALID_JSON',
          message: 'Request body is required',
          correlationId
        })
      };
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(event.body);
    } catch {
      observability.warn('MALFORMED_JSON', 'Rejected request with malformed JSON payload', {
        correlationId
      });
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({
          error: 'INVALID_JSON',
          message: 'Request body must be valid JSON',
          correlationId
        })
      };
    }

    const contractValidation = validateTelemetryContract(parsedBody);
    if (!contractValidation.valid || !contractValidation.payload) {
      observability.warn('CONTRACT_VALIDATION_FAILED', 'Telemetry payload failed API contract check', {
        correlationId,
        metadata: { errors: contractValidation.errors }
      });
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({
          error: 'CONTRACT_VALIDATION_ERROR',
          message: 'Payload does not conform to the IoT Telemetry API contract',
          details: contractValidation.errors,
          correlationId
        })
      };
    }

    const payload = contractValidation.payload;
    const now = nowFn();
    const ingestedAt = now.toISOString();
    const expiresAt = Math.floor(now.getTime() / 1000) + ttlDays * 86400;

    try {
      const evaluation = evaluateTelemetryAnomalies(payload, thresholds);
      const status = evaluation.isAnomalous ? 'ANOMALY' : 'HEALTHY';

      const historyRecord: TelemetryHistoryRecord = {
        PK: `DEVICE#${payload.deviceId}`,
        SK: `TS#${payload.timestamp}#SEQ#${String(payload.sequenceNumber).padStart(10, '0')}`,
        entityType: 'TELEMETRY_EVENT',
        deviceId: payload.deviceId,
        timestamp: payload.timestamp,
        ingestedAt,
        sequenceNumber: payload.sequenceNumber,
        firmwareVersion: payload.firmwareVersion,
        network: payload.network,
        metrics: payload.metrics,
        ...(payload.location ? { location: payload.location } : {}),
        status,
        violations: evaluation.violations,
        expiresAt
      };

      const stateRecord: DeviceStateRecord = {
        PK: 'DEVICE_STATE',
        SK: `DEVICE#${payload.deviceId}`,
        entityType: 'DEVICE_STATE',
        deviceId: payload.deviceId,
        lastSeenAt: payload.timestamp,
        lastIngestedAt: ingestedAt,
        lastSequenceNumber: payload.sequenceNumber,
        firmwareVersion: payload.firmwareVersion,
        rat: payload.network.rat,
        cellId: payload.network.cellId,
        rssiDbm: payload.network.rssiDbm,
        latestMetrics: payload.metrics,
        status
      };

      await getRepository().saveTelemetryAndDeviceState(historyRecord, stateRecord);

      let alertEventId: string | undefined;
      if (evaluation.isAnomalous && evaluation.highestSeverity !== 'NONE') {
        const alertDetail: DeviceAnomalyAlertDetail = {
          alertId: `alert-${randomUUID()}`,
          alertType: 'OUT_OF_RANGE',
          deviceId: payload.deviceId,
          timestamp: payload.timestamp,
          detectedAt: ingestedAt,
          sequenceNumber: payload.sequenceNumber,
          rat: payload.network.rat,
          cellId: payload.network.cellId,
          severity: evaluation.highestSeverity,
          violations: evaluation.violations,
          metrics: payload.metrics,
          correlationId
        };

        alertEventId = await getAlertPublisher().publishAnomalyAlert(alertDetail);

        observability.warn(
          'OUT_OF_RANGE_ALERT_RAISED',
          `Out-of-range telemetry detected for device ${payload.deviceId}`,
          {
            correlationId,
            deviceId: payload.deviceId,
            rat: payload.network.rat,
            metadata: {
              alertEventId,
              severity: evaluation.highestSeverity,
              violations: evaluation.violations
            }
          }
        );
      }

      const latencyMs = performance.now() - startMs;

      observability.emitDeviceIngestionMetric({
        deviceId: payload.deviceId,
        rat: payload.network.rat,
        anomalyCount: evaluation.violations.length,
        latencyMs,
        correlationId,
        timestampMs: now.getTime()
      });

      observability.info(
        'TELEMETRY_INGESTED',
        `Stored telemetry frame #${payload.sequenceNumber} for ${payload.deviceId}`,
        {
          correlationId,
          deviceId: payload.deviceId,
          rat: payload.network.rat,
          metadata: {
            sequenceNumber: payload.sequenceNumber,
            status,
            anomalyCount: evaluation.violations.length,
            latencyMs: Number(latencyMs.toFixed(2))
          }
        }
      );

      return {
        statusCode: 202,
        headers: {
          ...JSON_HEADERS,
          'X-Correlation-Id': correlationId
        },
        body: JSON.stringify({
          status: 'ACCEPTED',
          deviceId: payload.deviceId,
          sequenceNumber: payload.sequenceNumber,
          healthStatus: status,
          anomalyDetected: evaluation.isAnomalous,
          violations: evaluation.violations,
          ...(alertEventId ? { alertEventId } : {}),
          correlationId
        })
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown ingestion failure';
      observability.error('INGESTION_ERROR', errorMessage, {
        correlationId,
        deviceId: payload.deviceId,
        rat: payload.network.rat
      });

      return {
        statusCode: 500,
        headers: JSON_HEADERS,
        body: JSON.stringify({
          error: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to process device telemetry',
          correlationId
        })
      };
    }
  };
}

export const handler = createIngestTelemetryHandler();
