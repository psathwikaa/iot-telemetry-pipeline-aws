import { randomUUID } from 'crypto';
import { ScheduledEvent } from 'aws-lambda';
import {
  AlertEventPublisher,
  EventBridgeAlertPublisher
} from '../events/alert-publisher';
import { TelemetryObservability } from '../observability/telemetry-logger';
import {
  DynamoDbTelemetryRepository,
  TelemetryRepository
} from '../storage/telemetry-repository';
import { DeviceSilentAlertDetail } from '../types/telemetry';

export interface SilenceWatchdogDependencies {
  repository?: TelemetryRepository;
  alertPublisher?: AlertEventPublisher;
  observability?: TelemetryObservability;
  silenceThresholdSeconds?: number;
  nowFn?: () => Date;
}

export interface SilenceWatchdogResult {
  checkedDevices: number;
  newlySilentDevices: string[];
  alertEventIds: string[];
  correlationId: string;
}

export function createSilenceWatchdogHandler(deps: SilenceWatchdogDependencies = {}) {
  let repository = deps.repository;
  let alertPublisher = deps.alertPublisher;
  const observability = deps.observability ?? new TelemetryObservability();
  const silenceThresholdSeconds =
    deps.silenceThresholdSeconds ?? Number(process.env.SILENCE_THRESHOLD_SECONDS ?? '300');
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

  return async (event?: Partial<ScheduledEvent>): Promise<SilenceWatchdogResult> => {
    const correlationId = event?.id ?? randomUUID();
    const now = nowFn();
    const nowIso = now.toISOString();
    const states = await getRepository().listDeviceStates();

    const newlySilentDevices: string[] = [];
    const alertEventIds: string[] = [];

    for (const state of states) {
      const lastSeenMs = new Date(state.lastSeenAt).getTime();
      const elapsedSeconds = Math.floor((now.getTime() - lastSeenMs) / 1000);

      // Raise alert only if elapsed time exceeds threshold and device is not already marked SILENT
      if (elapsedSeconds > silenceThresholdSeconds && state.status !== 'SILENT') {
        const alertDetail: DeviceSilentAlertDetail = {
          alertId: `silent-${randomUUID()}`,
          alertType: 'DEVICE_SILENT',
          deviceId: state.deviceId,
          lastSeenAt: state.lastSeenAt,
          detectedAt: nowIso,
          silenceDurationSeconds: elapsedSeconds,
          thresholdSeconds: silenceThresholdSeconds,
          lastSequenceNumber: state.lastSequenceNumber,
          rat: state.rat,
          cellId: state.cellId,
          severity: 'CRITICAL',
          correlationId
        };

        await getRepository().markDeviceSilent(state.deviceId, nowIso);
        const eventId = await getAlertPublisher().publishSilentDeviceAlert(alertDetail);

        newlySilentDevices.push(state.deviceId);
        alertEventIds.push(eventId);

        observability.warn(
          'DEVICE_SILENT_ALERT_RAISED',
          `Device ${state.deviceId} has been silent for ${elapsedSeconds}s (threshold ${silenceThresholdSeconds}s)`,
          {
            correlationId,
            deviceId: state.deviceId,
            rat: state.rat,
            metadata: {
              lastSeenAt: state.lastSeenAt,
              silenceDurationSeconds: elapsedSeconds,
              thresholdSeconds: silenceThresholdSeconds,
              eventId
            }
          }
        );
      }
    }

    observability.emitSilentWatchdogMetric({
      silentCount: newlySilentDevices.length,
      correlationId,
      timestampMs: now.getTime()
    });

    observability.info(
      'SILENCE_WATCHDOG_COMPLETED',
      `Scanned ${states.length} devices; detected ${newlySilentDevices.length} newly silent devices`,
      {
        correlationId,
        metadata: {
          checkedDevices: states.length,
          newlySilentDevices
        }
      }
    );

    return {
      checkedDevices: states.length,
      newlySilentDevices,
      alertEventIds,
      correlationId
    };
  };
}

export const handler = createSilenceWatchdogHandler();
