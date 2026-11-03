import { CellularRat } from '../types/telemetry';

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

export interface StructuredLogEntry {
  level: LogLevel;
  timestamp: string;
  service: string;
  event: string;
  correlationId: string;
  deviceId?: string;
  rat?: CellularRat;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface CloudWatchEmfDocument {
  _aws: {
    Timestamp: number;
    CloudWatchMetrics: Array<{
      Namespace: string;
      Dimensions: string[][];
      Metrics: Array<{
        Name: string;
        Unit: 'Count' | 'Milliseconds';
      }>;
    }>;
  };
  Service: string;
  DeviceId?: string;
  Rat?: CellularRat;
  MessagesPerDevice?: number;
  AnomaliesDetected?: number;
  IngestionLatencyMs?: number;
  SilentDevicesDetected?: number;
  correlationId: string;
}

export type LogSink = (serializedJson: string) => void;

export class TelemetryObservability {
  private readonly serviceName: string;
  private readonly metricNamespace: string;
  private readonly sink: LogSink;

  constructor(options?: {
    serviceName?: string;
    metricNamespace?: string;
    sink?: LogSink;
  }) {
    this.serviceName = options?.serviceName ?? process.env.SERVICE_NAME ?? 'iot-telemetry-pipeline';
    this.metricNamespace =
      options?.metricNamespace ?? process.env.METRIC_NAMESPACE ?? 'IotTelemetryPipeline';
    this.sink = options?.sink ?? ((line: string) => console.log(line));
  }

  public log(entry: Omit<StructuredLogEntry, 'timestamp' | 'service'>): StructuredLogEntry {
    const fullEntry: StructuredLogEntry = {
      timestamp: new Date().toISOString(),
      service: this.serviceName,
      ...entry
    };
    this.sink(JSON.stringify(fullEntry));
    return fullEntry;
  }

  public info(
    event: string,
    message: string,
    context: {
      correlationId: string;
      deviceId?: string;
      rat?: CellularRat;
      metadata?: Record<string, unknown>;
    }
  ): StructuredLogEntry {
    return this.log({
      level: 'INFO',
      event,
      message,
      ...context
    });
  }

  public warn(
    event: string,
    message: string,
    context: {
      correlationId: string;
      deviceId?: string;
      rat?: CellularRat;
      metadata?: Record<string, unknown>;
    }
  ): StructuredLogEntry {
    return this.log({
      level: 'WARN',
      event,
      message,
      ...context
    });
  }

  public error(
    event: string,
    message: string,
    context: {
      correlationId: string;
      deviceId?: string;
      rat?: CellularRat;
      metadata?: Record<string, unknown>;
    }
  ): StructuredLogEntry {
    return this.log({
      level: 'ERROR',
      event,
      message,
      ...context
    });
  }

  /**
   * Emits a CloudWatch Embedded Metric Format (EMF) payload recording:
   * - MessagesPerDevice (Count = 1, dimensioned by [Service, DeviceId] and [Service])
   * - AnomaliesDetected (Count)
   * - IngestionLatencyMs (Milliseconds)
   */
  public emitDeviceIngestionMetric(params: {
    deviceId: string;
    rat: CellularRat;
    anomalyCount: number;
    latencyMs: number;
    correlationId: string;
    timestampMs?: number;
  }): CloudWatchEmfDocument {
    const doc: CloudWatchEmfDocument = {
      _aws: {
        Timestamp: params.timestampMs ?? Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: this.metricNamespace,
            Dimensions: [
              ['Service', 'DeviceId'],
              ['Service', 'Rat'],
              ['Service']
            ],
            Metrics: [
              { Name: 'MessagesPerDevice', Unit: 'Count' },
              { Name: 'AnomaliesDetected', Unit: 'Count' },
              { Name: 'IngestionLatencyMs', Unit: 'Milliseconds' }
            ]
          }
        ]
      },
      Service: this.serviceName,
      DeviceId: params.deviceId,
      Rat: params.rat,
      MessagesPerDevice: 1,
      AnomaliesDetected: params.anomalyCount,
      IngestionLatencyMs: Math.max(0, Number(params.latencyMs.toFixed(2))),
      correlationId: params.correlationId
    };

    this.sink(JSON.stringify(doc));
    return doc;
  }

  /**
   * Emits a CloudWatch EMF metric for silent device watchdog checks.
   */
  public emitSilentWatchdogMetric(params: {
    silentCount: number;
    correlationId: string;
    timestampMs?: number;
  }): CloudWatchEmfDocument {
    const doc: CloudWatchEmfDocument = {
      _aws: {
        Timestamp: params.timestampMs ?? Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: this.metricNamespace,
            Dimensions: [['Service']],
            Metrics: [{ Name: 'SilentDevicesDetected', Unit: 'Count' }]
          }
        ]
      },
      Service: this.serviceName,
      SilentDevicesDetected: params.silentCount,
      correlationId: params.correlationId
    };

    this.sink(JSON.stringify(doc));
    return doc;
  }
}
