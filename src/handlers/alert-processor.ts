import { EventBridgeEvent } from 'aws-lambda';
import { TelemetryObservability } from '../observability/telemetry-logger';
import {
  DynamoDbTelemetryRepository,
  TelemetryRepository
} from '../storage/telemetry-repository';
import { AlertAuditRecord, AlertEventDetail } from '../types/telemetry';

export interface AlertProcessorDependencies {
  repository?: TelemetryRepository;
  observability?: TelemetryObservability;
  ttlDays?: number;
}

export function createAlertProcessorHandler(deps: AlertProcessorDependencies = {}) {
  let repository = deps.repository;
  const observability = deps.observability ?? new TelemetryObservability();
  const ttlDays = deps.ttlDays ?? Number(process.env.ALERT_TTL_DAYS ?? '90');

  const getRepository = (): TelemetryRepository => {
    if (!repository) {
      repository = new DynamoDbTelemetryRepository();
    }
    return repository;
  };

  return async (
    event: EventBridgeEvent<'DeviceAnomalyDetected' | 'DeviceSilentDetected', AlertEventDetail>
  ): Promise<AlertAuditRecord> => {
    const detail = event.detail;
    const detectedDate = new Date(detail.detectedAt);
    const expiresAt = Math.floor(detectedDate.getTime() / 1000) + ttlDays * 86400;

    const summary =
      detail.alertType === 'OUT_OF_RANGE'
        ? `Device ${detail.deviceId} reported ${detail.violations.length} out-of-range metric(s): ${detail.violations.map((v) => v.reason).join('; ')}`
        : `Device ${detail.deviceId} went silent for ${detail.silenceDurationSeconds}s (last seen ${detail.lastSeenAt})`;

    const auditRecord: AlertAuditRecord = {
      PK: `ALERT#${detail.deviceId}`,
      SK: `TS#${detail.detectedAt}#${detail.alertId}`,
      entityType: 'ALERT_AUDIT',
      alertId: detail.alertId,
      alertType: detail.alertType,
      deviceId: detail.deviceId,
      detectedAt: detail.detectedAt,
      severity: detail.severity,
      summary,
      detail,
      expiresAt
    };

    await getRepository().saveAlertAudit(auditRecord);

    observability.warn('ALERT_PROCESSED', summary, {
      correlationId: detail.correlationId,
      deviceId: detail.deviceId,
      rat: detail.rat,
      metadata: {
        alertId: detail.alertId,
        alertType: detail.alertType,
        severity: detail.severity,
        eventSource: event.source,
        detailType: event['detail-type']
      }
    });

    return auditRecord;
  };
}

export const handler = createAlertProcessorHandler();
