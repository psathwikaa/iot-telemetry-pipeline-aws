export type CellularRat = 'LTE-M' | 'NB-IoT' | '5G-NR';

export interface NetworkMetadata {
  rat: CellularRat;
  rssiDbm: number;
  cellId: string;
}

export interface TelemetryMetrics {
  temperatureC: number;
  humidityPct: number;
  batteryPct: number;
  vibrationG?: number;
}

export interface GeoLocation {
  lat: number;
  lon: number;
}

export interface TelemetryRequestPayload {
  deviceId: string;
  timestamp: string;
  sequenceNumber: number;
  firmwareVersion: string;
  network: NetworkMetadata;
  metrics: TelemetryMetrics;
  location?: GeoLocation;
}

export type AnomalySeverity = 'WARNING' | 'CRITICAL';

export interface MetricViolation {
  metric: keyof TelemetryMetrics | 'rssiDbm';
  observed: number;
  minAllowed: number;
  maxAllowed: number;
  unit: string;
  severity: AnomalySeverity;
  reason: string;
}

export interface AnomalyEvaluationResult {
  isAnomalous: boolean;
  highestSeverity: 'NONE' | AnomalySeverity;
  violations: MetricViolation[];
}

export interface ThresholdBounds {
  min: number;
  max: number;
  criticalMin?: number;
  criticalMax?: number;
  unit: string;
}

export interface TelemetryThresholdConfig {
  temperatureC: ThresholdBounds;
  humidityPct: ThresholdBounds;
  batteryPct: ThresholdBounds;
  vibrationG: ThresholdBounds;
  rssiDbm: ThresholdBounds;
}

export type DeviceHealthStatus = 'HEALTHY' | 'ANOMALY' | 'SILENT';

export interface TelemetryHistoryRecord {
  PK: string; // DEVICE#<deviceId>
  SK: string; // TS#<timestamp>#SEQ#<sequenceNumber>
  entityType: 'TELEMETRY_EVENT';
  deviceId: string;
  timestamp: string;
  ingestedAt: string;
  sequenceNumber: number;
  firmwareVersion: string;
  network: NetworkMetadata;
  metrics: TelemetryMetrics;
  location?: GeoLocation;
  status: 'HEALTHY' | 'ANOMALY';
  violations: MetricViolation[];
  expiresAt: number; // Unix epoch seconds for DynamoDB TTL
}

export interface DeviceStateRecord {
  PK: string; // DEVICE_STATE
  SK: string; // DEVICE#<deviceId>
  entityType: 'DEVICE_STATE';
  deviceId: string;
  lastSeenAt: string; // Device sample ISO timestamp or server ingest timestamp
  lastIngestedAt: string;
  lastSequenceNumber: number;
  firmwareVersion: string;
  rat: CellularRat;
  cellId: string;
  rssiDbm: number;
  latestMetrics: TelemetryMetrics;
  status: DeviceHealthStatus;
  lastAlertedSilentAt?: string;
}

export interface DeviceAnomalyAlertDetail {
  alertId: string;
  alertType: 'OUT_OF_RANGE';
  deviceId: string;
  timestamp: string;
  detectedAt: string;
  sequenceNumber: number;
  rat: CellularRat;
  cellId: string;
  severity: AnomalySeverity;
  violations: MetricViolation[];
  metrics: TelemetryMetrics;
  correlationId: string;
}

export interface DeviceSilentAlertDetail {
  alertId: string;
  alertType: 'DEVICE_SILENT';
  deviceId: string;
  lastSeenAt: string;
  detectedAt: string;
  silenceDurationSeconds: number;
  thresholdSeconds: number;
  lastSequenceNumber: number;
  rat: CellularRat;
  cellId: string;
  severity: 'CRITICAL';
  correlationId: string;
}

export type AlertEventDetail = DeviceAnomalyAlertDetail | DeviceSilentAlertDetail;

export interface AlertAuditRecord {
  PK: string; // ALERT#<deviceId>
  SK: string; // TS#<detectedAt>#<alertId>
  entityType: 'ALERT_AUDIT';
  alertId: string;
  alertType: 'OUT_OF_RANGE' | 'DEVICE_SILENT';
  deviceId: string;
  detectedAt: string;
  severity: AnomalySeverity;
  summary: string;
  detail: AlertEventDetail;
  expiresAt: number;
}
