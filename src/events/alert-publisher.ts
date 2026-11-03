import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import {
  AlertEventDetail,
  DeviceAnomalyAlertDetail,
  DeviceSilentAlertDetail
} from '../types/telemetry';

export const IOT_EVENT_SOURCES = {
  INGEST: 'iot.telemetry.ingest',
  WATCHDOG: 'iot.telemetry.watchdog'
} as const;

export const IOT_EVENT_DETAIL_TYPES = {
  ANOMALY_DETECTED: 'DeviceAnomalyDetected',
  SILENT_DETECTED: 'DeviceSilentDetected'
} as const;

export interface PublishedEventEnvelope {
  id: string;
  source: string;
  detailType: string;
  eventBusName: string;
  time: string;
  detail: AlertEventDetail;
}

export interface AlertEventPublisher {
  publishAnomalyAlert(detail: DeviceAnomalyAlertDetail): Promise<string>;
  publishSilentDeviceAlert(detail: DeviceSilentAlertDetail): Promise<string>;
}

export class EventBridgeAlertPublisher implements AlertEventPublisher {
  private readonly client: EventBridgeClient;
  private readonly eventBusName: string;

  constructor(eventBusName?: string, client?: EventBridgeClient) {
    this.eventBusName =
      eventBusName ?? process.env.ALERT_EVENT_BUS_NAME ?? 'IotTelemetryEventBus';
    this.client = client ?? new EventBridgeClient({});
  }

  public async publishAnomalyAlert(detail: DeviceAnomalyAlertDetail): Promise<string> {
    const response = await this.client.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: this.eventBusName,
            Source: IOT_EVENT_SOURCES.INGEST,
            DetailType: IOT_EVENT_DETAIL_TYPES.ANOMALY_DETECTED,
            Time: new Date(detail.detectedAt),
            Detail: JSON.stringify(detail)
          }
        ]
      })
    );

    const entry = response.Entries?.[0];
    if (response.FailedEntryCount && response.FailedEntryCount > 0) {
      throw new Error(
        `Failed to publish DeviceAnomalyDetected to EventBridge: ${entry?.ErrorCode ?? 'Unknown'} - ${entry?.ErrorMessage ?? ''}`
      );
    }

    return entry?.EventId ?? detail.alertId;
  }

  public async publishSilentDeviceAlert(detail: DeviceSilentAlertDetail): Promise<string> {
    const response = await this.client.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: this.eventBusName,
            Source: IOT_EVENT_SOURCES.WATCHDOG,
            DetailType: IOT_EVENT_DETAIL_TYPES.SILENT_DETECTED,
            Time: new Date(detail.detectedAt),
            Detail: JSON.stringify(detail)
          }
        ]
      })
    );

    const entry = response.Entries?.[0];
    if (response.FailedEntryCount && response.FailedEntryCount > 0) {
      throw new Error(
        `Failed to publish DeviceSilentDetected to EventBridge: ${entry?.ErrorCode ?? 'Unknown'} - ${entry?.ErrorMessage ?? ''}`
      );
    }

    return entry?.EventId ?? detail.alertId;
  }
}

export interface EventBridgeRulePattern {
  ruleName: string;
  sources: string[];
  detailTypes: string[];
  target: (envelope: PublishedEventEnvelope) => Promise<void>;
}

export class InMemoryEventBus implements AlertEventPublisher {
  private readonly eventBusName: string;
  private readonly publishedEvents: PublishedEventEnvelope[] = [];
  private readonly rules: EventBridgeRulePattern[] = [];

  constructor(eventBusName = 'IotTelemetryEventBus') {
    this.eventBusName = eventBusName;
  }

  public registerRule(rule: EventBridgeRulePattern): void {
    this.rules.push(rule);
  }

  public async publishAnomalyAlert(detail: DeviceAnomalyAlertDetail): Promise<string> {
    return this.dispatch({
      id: detail.alertId,
      source: IOT_EVENT_SOURCES.INGEST,
      detailType: IOT_EVENT_DETAIL_TYPES.ANOMALY_DETECTED,
      eventBusName: this.eventBusName,
      time: detail.detectedAt,
      detail
    });
  }

  public async publishSilentDeviceAlert(detail: DeviceSilentAlertDetail): Promise<string> {
    return this.dispatch({
      id: detail.alertId,
      source: IOT_EVENT_SOURCES.WATCHDOG,
      detailType: IOT_EVENT_DETAIL_TYPES.SILENT_DETECTED,
      eventBusName: this.eventBusName,
      time: detail.detectedAt,
      detail
    });
  }

  private async dispatch(envelope: PublishedEventEnvelope): Promise<string> {
    this.publishedEvents.push(structuredClone(envelope));

    for (const rule of this.rules) {
      const sourceMatch = rule.sources.includes(envelope.source);
      const detailTypeMatch = rule.detailTypes.includes(envelope.detailType);
      if (sourceMatch && detailTypeMatch) {
        await rule.target(structuredClone(envelope));
      }
    }

    return envelope.id;
  }

  public getPublishedEvents(): PublishedEventEnvelope[] {
    return structuredClone(this.publishedEvents);
  }
}
