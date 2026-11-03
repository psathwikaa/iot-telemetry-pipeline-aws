import Ajv, { ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';
import telemetrySchema from '../../contracts/telemetry-request.schema.json';
import { TelemetryRequestPayload } from '../types/telemetry';

export interface ContractValidationError {
  field: string;
  message: string;
  keyword: string;
}

export interface ContractValidationResult {
  valid: boolean;
  payload?: TelemetryRequestPayload;
  errors: ContractValidationError[];
}

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  allowUnionTypes: true
});
addFormats(ajv);

const validateFn = ajv.compile<TelemetryRequestPayload>(telemetrySchema);

function formatAjvErrors(errors: ErrorObject[] | null | undefined): ContractValidationError[] {
  if (!errors || errors.length === 0) {
    return [];
  }

  return errors.map((err) => {
    let field = err.instancePath ? err.instancePath.replace(/^\//, '').replace(/\//g, '.') : 'root';
    if (err.keyword === 'required' && typeof err.params.missingProperty === 'string') {
      field = field === 'root' ? err.params.missingProperty : `${field}.${err.params.missingProperty}`;
    } else if (
      err.keyword === 'additionalProperties' &&
      typeof err.params.additionalProperty === 'string'
    ) {
      field =
        field === 'root'
          ? err.params.additionalProperty
          : `${field}.${err.params.additionalProperty}`;
    }

    return {
      field,
      message: err.message ?? 'Contract validation failed',
      keyword: err.keyword
    };
  });
}

export function validateTelemetryContract(input: unknown): ContractValidationResult {
  const isValid = validateFn(input);
  if (isValid) {
    return {
      valid: true,
      payload: input as TelemetryRequestPayload,
      errors: []
    };
  }

  return {
    valid: false,
    errors: formatAjvErrors(validateFn.errors)
  };
}

export function getTelemetryJsonSchema(): Record<string, unknown> {
  return telemetrySchema as Record<string, unknown>;
}
