import { APIGatewayProxyEvent } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { InMemoryEventBus } from '../../src/events/alert-publisher';
import { createIngestTelemetryHandler } from '../../src/handlers/ingest-telemetry';
import { TelemetryObservability } from '../../src/observability/telemetry-logger';
import { InMemoryTelemetryRepository } from '../../src/storage/telemetry-repository';
import { TelemetryRequestPayload } from '../../src/types/telemetry';
import {
  getTelemetryJsonSchema,
  validateTelemetryContract
} from '../../src/validation/contract-validator';

function buildValidPayload(overrides: Partial<TelemetryRequestPayload> = {}): TelemetryRequestPayload {
  return {
    deviceId: 'iot-se-gbg-001',
    timestamp: '2026-11-02T18:00:00.000Z',
    sequenceNumber: 42,
    firmwareVersion: '2.4.1',
    network: {
      rat: 'LTE-M',
      rssiDbm: -78.5,
      cellId: 'SE-GBG-CELL-09'
    },
    metrics: {
      temperatureC: 4.2,
      humidityPct: 55.0,
      batteryPct: 88.5,
      vibrationG: 0.35
    },
    location: {
      lat: 57.7089,
      lon: 11.9746
    },
    ...overrides
  };
}

describe('API Request Format Contract Tests (POST /v1/telemetry)', () => {
  it('exposes the canonical draft-07 JSON Schema with required properties', () => {
    const schema = getTelemetryJsonSchema();
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(schema.title).toBe('IoTTelemetryIngestionRequest');
    expect(schema.required).toEqual([
      'deviceId',
      'timestamp',
      'sequenceNumber',
      'firmwareVersion',
      'network',
      'metrics'
    ]);
  });

  it.each(['LTE-M', 'NB-IoT', '5G-NR'] as const)(
    'accepts valid cellular IoT telemetry payloads over %s',
    (rat) => {
      const payload = buildValidPayload({
        network: { rat, rssiDbm: -85, cellId: 'SE-STO-104' }
      });

      const result = validateTelemetryContract(payload);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.payload).toEqual(payload);
    }
  );

  it('accepts valid payloads when optional vibrationG and location fields are omitted', () => {
    const payload: TelemetryRequestPayload = {
      deviceId: 'iot-no-osl-019',
      timestamp: '2026-11-02T18:05:10Z',
      sequenceNumber: 1,
      firmwareVersion: 'v1.0.0-rc.1',
      network: {
        rat: 'NB-IoT',
        rssiDbm: -99,
        cellId: 'NO-OSL-001'
      },
      metrics: {
        temperatureC: 19.5,
        humidityPct: 44.2,
        batteryPct: 92.0
      }
    };

    const result = validateTelemetryContract(payload);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects payloads missing required top-level or nested fields', () => {
    const incompletePayload = {
      deviceId: 'iot-se-gbg-001',
      timestamp: '2026-11-02T18:00:00Z',
      network: {
        rat: 'LTE-M'
      },
      metrics: {
        temperatureC: 12.0
      }
    };

    const result = validateTelemetryContract(incompletePayload);
    expect(result.valid).toBe(false);
    const missingFields = result.errors.map((e) => e.field);
    expect(missingFields).toContain('sequenceNumber');
    expect(missingFields).toContain('firmwareVersion');
    expect(missingFields).toContain('network.rssiDbm');
    expect(missingFields).toContain('network.cellId');
    expect(missingFields).toContain('metrics.humidityPct');
    expect(missingFields).toContain('metrics.batteryPct');
  });

  it('rejects invalid deviceId, non-ISO8601 timestamp, and unsupported RAT', () => {
    const invalidPayload = {
      ...buildValidPayload(),
      deviceId: 'ab', // shorter than minimum 4 chars
      timestamp: 'not-a-timestamp',
      sequenceNumber: 0, // must be >= 1
      network: {
        rat: '2G-GPRS', // not in enum
        rssiDbm: -75,
        cellId: 'SE-GBG-01'
      }
    };

    const result = validateTelemetryContract(invalidPayload);
    expect(result.valid).toBe(false);
    const errorFields = result.errors.map((e) => e.field);
    expect(errorFields).toContain('deviceId');
    expect(errorFields).toContain('timestamp');
    expect(errorFields).toContain('sequenceNumber');
    expect(errorFields).toContain('network.rat');
  });

  it('rejects physically impossible sensor values outside contract schema bounds', () => {
    const impossiblePayload = buildValidPayload({
      metrics: {
        temperatureC: 250.0, // > 150 max
        humidityPct: -5.0, // < 0 min
        batteryPct: 110.0 // > 100 max
      }
    });

    const result = validateTelemetryContract(impossiblePayload);
    expect(result.valid).toBe(false);
    const errorFields = result.errors.map((e) => e.field);
    expect(errorFields).toContain('metrics.temperatureC');
    expect(errorFields).toContain('metrics.humidityPct');
    expect(errorFields).toContain('metrics.batteryPct');
  });

  it('rejects undeclared additional properties to prevent schema drift', () => {
    const payloadWithExtra = {
      ...buildValidPayload(),
      unexpectedField: 'should-fail'
    };

    const result = validateTelemetryContract(payloadWithExtra);
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('unexpectedField');
    expect(result.errors[0].keyword).toBe('additionalProperties');
  });

  it('returns HTTP 400 with structured contract error details from the API Gateway handler', async () => {
    const handler = createIngestTelemetryHandler({
      repository: new InMemoryTelemetryRepository(),
      alertPublisher: new InMemoryEventBus(),
      observability: new TelemetryObservability({ sink: () => undefined })
    });

    const badEvent = {
      httpMethod: 'POST',
      body: JSON.stringify({
        deviceId: 'iot-se-gbg-001',
        timestamp: 'invalid-date'
      }),
      headers: { 'x-correlation-id': 'corr-contract-400' }
    } as unknown as APIGatewayProxyEvent;

    const response = await handler(badEvent);
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('CONTRACT_VALIDATION_ERROR');
    expect(body.correlationId).toBe('corr-contract-400');
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details.length).toBeGreaterThan(0);
  });
});
