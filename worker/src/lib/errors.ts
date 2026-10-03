// Errors in the Resend shape: { statusCode, name, message }. ErrorName has
// each name in the type of the `resend` SDK (RESEND_ERROR_CODE_KEY).

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
  | "invalid_access"
  | "invalid_parameter"
  | "invalid_region"
  | "missing_required_field"
  | "monthly_quota_exceeded"
  | "daily_quota_exceeded"
  | "rate_limit_exceeded"
  | "security_error"
  | "application_error"
  | "internal_server_error";

export interface ErrorBody {
  statusCode: number;
  name: ErrorName;
  message: string;
}

export class ApiError extends Error {
  readonly statusCode: number;
  readonly errorName: ErrorName;
  // Extra response headers, for example `retry-after`.
  readonly headers: Record<string, string>;

  constructor(
    statusCode: number,
    name: ErrorName,
    message: string,
    headers: Record<string, string> = {},
  ) {
    super(message);
    this.statusCode = statusCode;
    this.errorName = name;
    this.headers = headers;
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
  const merged = new Headers(err.headers);

  for (const [name, value] of new Headers(headers)) merged.set(name, value);

  return Response.json(err.toBody(), {
    status: err.statusCode,
    headers: merged,
  });
}
