import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand
} from '@aws-sdk/lib-dynamodb';
import {
  AlertAuditRecord,
  DeviceHealthStatus,
  DeviceStateRecord,
  TelemetryHistoryRecord
} from '../types/telemetry';

export interface TelemetryRepository {
  saveTelemetryAndDeviceState(
    historyRecord: TelemetryHistoryRecord,
    stateRecord: DeviceStateRecord
  ): Promise<void>;
  getDeviceTelemetryHistory(deviceId: string, limit?: number): Promise<TelemetryHistoryRecord[]>;
  listDeviceStates(): Promise<DeviceStateRecord[]>;
  markDeviceSilent(deviceId: string, alertedAtIso: string): Promise<void>;
  saveAlertAudit(alertRecord: AlertAuditRecord): Promise<void>;
  getDeviceAlerts(deviceId: string): Promise<AlertAuditRecord[]>;
}

export class DynamoDbTelemetryRepository implements TelemetryRepository {
  private readonly docClient: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(tableName?: string, docClient?: DynamoDBDocumentClient) {
    this.tableName = tableName ?? process.env.TELEMETRY_TABLE_NAME ?? 'IotTelemetryTable';
    if (docClient) {
      this.docClient = docClient;
    } else {
      const client = new DynamoDBClient({});
      this.docClient = DynamoDBDocumentClient.from(client, {
        marshallOptions: { removeUndefinedValues: true }
      });
    }
  }

  public async saveTelemetryAndDeviceState(
    historyRecord: TelemetryHistoryRecord,
    stateRecord: DeviceStateRecord
  ): Promise<void> {
    await Promise.all([
      this.docClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: historyRecord
        })
      ),
      this.docClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: stateRecord
        })
      )
    ]);
  }

  public async getDeviceTelemetryHistory(
    deviceId: string,
    limit = 20
  ): Promise<TelemetryHistoryRecord[]> {
    const response = await this.docClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': `DEVICE#${deviceId}`,
          ':skPrefix': 'TS#'
        },
        ScanIndexForward: false,
        Limit: limit
      })
    );

    return (response.Items ?? []) as TelemetryHistoryRecord[];
  }

  public async listDeviceStates(): Promise<DeviceStateRecord[]> {
    const response = await this.docClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': 'DEVICE_STATE',
          ':skPrefix': 'DEVICE#'
        }
      })
    );

    return (response.Items ?? []) as DeviceStateRecord[];
  }

  public async markDeviceSilent(deviceId: string, alertedAtIso: string): Promise<void> {
    await this.docClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: {
          PK: 'DEVICE_STATE',
          SK: `DEVICE#${deviceId}`
        },
        UpdateExpression: 'SET #status = :status, lastAlertedSilentAt = :alertedAt',
        ExpressionAttributeNames: {
          '#status': 'status'
        },
        ExpressionAttributeValues: {
          ':status': 'SILENT' satisfies DeviceHealthStatus,
          ':alertedAt': alertedAtIso
        }
      })
    );
  }

  public async saveAlertAudit(alertRecord: AlertAuditRecord): Promise<void> {
    await this.docClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: alertRecord
      })
    );
  }

  public async getDeviceAlerts(deviceId: string): Promise<AlertAuditRecord[]> {
    const response = await this.docClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': `ALERT#${deviceId}`,
          ':skPrefix': 'TS#'
        },
        ScanIndexForward: false
      })
    );

    return (response.Items ?? []) as AlertAuditRecord[];
  }
}

export class InMemoryTelemetryRepository implements TelemetryRepository {
  private readonly historyByDevice = new Map<string, TelemetryHistoryRecord[]>();
  private readonly statesByDevice = new Map<string, DeviceStateRecord>();
  private readonly alertsByDevice = new Map<string, AlertAuditRecord[]>();

  public async saveTelemetryAndDeviceState(
    historyRecord: TelemetryHistoryRecord,
    stateRecord: DeviceStateRecord
  ): Promise<void> {
    const existing = this.historyByDevice.get(historyRecord.deviceId) ?? [];
    existing.push(structuredClone(historyRecord));
    existing.sort((a, b) => b.SK.localeCompare(a.SK));
    this.historyByDevice.set(historyRecord.deviceId, existing);

    this.statesByDevice.set(stateRecord.deviceId, structuredClone(stateRecord));
  }

  public async getDeviceTelemetryHistory(
    deviceId: string,
    limit = 20
  ): Promise<TelemetryHistoryRecord[]> {
    const list = this.historyByDevice.get(deviceId) ?? [];
    return structuredClone(list.slice(0, limit));
  }

  public async listDeviceStates(): Promise<DeviceStateRecord[]> {
    return Array.from(this.statesByDevice.values()).map((s) => structuredClone(s));
  }

  public async markDeviceSilent(deviceId: string, alertedAtIso: string): Promise<void> {
    const current = this.statesByDevice.get(deviceId);
    if (current) {
      current.status = 'SILENT';
      current.lastAlertedSilentAt = alertedAtIso;
      this.statesByDevice.set(deviceId, current);
    }
  }

  public async saveAlertAudit(alertRecord: AlertAuditRecord): Promise<void> {
    const existing = this.alertsByDevice.get(alertRecord.deviceId) ?? [];
    existing.push(structuredClone(alertRecord));
    existing.sort((a, b) => b.SK.localeCompare(a.SK));
    this.alertsByDevice.set(alertRecord.deviceId, existing);
  }

  public async getDeviceAlerts(deviceId: string): Promise<AlertAuditRecord[]> {
    return structuredClone(this.alertsByDevice.get(deviceId) ?? []);
  }

  public getAllAlerts(): AlertAuditRecord[] {
    const all: AlertAuditRecord[] = [];
    for (const records of this.alertsByDevice.values()) {
      all.push(...structuredClone(records));
    }
    return all;
  }
}
