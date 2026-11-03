import {
  AnomalyEvaluationResult,
  AnomalySeverity,
  MetricViolation,
  TelemetryRequestPayload,
  TelemetryThresholdConfig,
  ThresholdBounds
} from '../types/telemetry';

export const DEFAULT_TELEMETRY_THRESHOLDS: TelemetryThresholdConfig = {
  temperatureC: {
    min: -25.0,
    max: 45.0,
    criticalMin: -35.0,
    criticalMax: 55.0,
    unit: '°C'
  },
  humidityPct: {
    min: 10.0,
    max: 90.0,
    criticalMin: 5.0,
    criticalMax: 95.0,
    unit: '%'
  },
  batteryPct: {
    min: 15.0,
    max: 100.0,
    criticalMin: 7.0,
    unit: '%'
  },
  vibrationG: {
    min: 0.0,
    max: 4.0,
    criticalMax: 8.0,
    unit: 'g'
  },
  rssiDbm: {
    min: -115.0,
    max: -30.0,
    criticalMin: -125.0,
    unit: 'dBm'
  }
};

function checkBound(
  metric: MetricViolation['metric'],
  observed: number,
  bounds: ThresholdBounds
): MetricViolation | null {
  if (observed >= bounds.min && observed <= bounds.max) {
    return null;
  }

  let severity: AnomalySeverity = 'WARNING';
  if (
    (bounds.criticalMin !== undefined && observed < bounds.criticalMin) ||
    (bounds.criticalMax !== undefined && observed > bounds.criticalMax)
  ) {
    severity = 'CRITICAL';
  }

  const direction = observed < bounds.min ? 'below minimum' : 'above maximum';
  const limitValue = observed < bounds.min ? bounds.min : bounds.max;

  return {
    metric,
    observed,
    minAllowed: bounds.min,
    maxAllowed: bounds.max,
    unit: bounds.unit,
    severity,
    reason: `${metric} (${observed}${bounds.unit}) is ${direction} threshold (${limitValue}${bounds.unit})`
  };
}

export function evaluateTelemetryAnomalies(
  payload: TelemetryRequestPayload,
  thresholds: TelemetryThresholdConfig = DEFAULT_TELEMETRY_THRESHOLDS
): AnomalyEvaluationResult {
  const violations: MetricViolation[] = [];

  const tempViolation = checkBound(
    'temperatureC',
    payload.metrics.temperatureC,
    thresholds.temperatureC
  );
  if (tempViolation) violations.push(tempViolation);

  const humidityViolation = checkBound(
    'humidityPct',
    payload.metrics.humidityPct,
    thresholds.humidityPct
  );
  if (humidityViolation) violations.push(humidityViolation);

  const batteryViolation = checkBound(
    'batteryPct',
    payload.metrics.batteryPct,
    thresholds.batteryPct
  );
  if (batteryViolation) violations.push(batteryViolation);

  if (payload.metrics.vibrationG !== undefined) {
    const vibrationViolation = checkBound(
      'vibrationG',
      payload.metrics.vibrationG,
      thresholds.vibrationG
    );
    if (vibrationViolation) violations.push(vibrationViolation);
  }

  const rssiViolation = checkBound(
    'rssiDbm',
    payload.network.rssiDbm,
    thresholds.rssiDbm
  );
  if (rssiViolation) violations.push(rssiViolation);

  const hasCritical = violations.some((v) => v.severity === 'CRITICAL');
  const highestSeverity =
    violations.length === 0 ? 'NONE' : hasCritical ? 'CRITICAL' : 'WARNING';

  return {
    isAnomalous: violations.length > 0,
    highestSeverity,
    violations
  };
}
