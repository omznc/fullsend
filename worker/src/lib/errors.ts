// Errors in the Resend shape: { statusCode, name, message }.

export type ErrorName =
  | "invalid_idempotency_key"
  | "validation_error"
  | "missing_api_key"
  | "restricted_api_key"
  | "invalid_api_key"
  | "not_found"
  | "method_not_allowed"
  | "invalid_idempotent_request"
  | "concurrent_idempotent_requests"
  | "invalid_attachment"
  | "invalid_from_address"
  | "invalid_parameter"
  | "missing_required_field"
  | "rate_limit_exceeded"
  | "application_error";

export interface ErrorBody {
  statusCode: number;
  name: ErrorName;
  message: string;
}

export class ApiError extends Error {
  readonly statusCode: number;
  readonly errorName: ErrorName;

  constructor(statusCode: number, name: ErrorName, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.errorName = name;
  }

  toBody(): ErrorBody {
    return {
      statusCode: this.statusCode,
      name: this.errorName,
      message: this.message,
    };
  }
}

export const notFound = (what: string) =>
  new ApiError(404, "not_found", `${what} not found`);

export const validation = (message: string) =>
  new ApiError(422, "validation_error", message);

export function errorResponse(err: ApiError, headers?: HeadersInit): Response {
  return Response.json(err.toBody(), { status: err.statusCode, headers });
}
