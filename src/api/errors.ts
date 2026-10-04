export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function notFound(message: string): ApiError {
  return new ApiError(404, 'NOT_FOUND', message);
}

export function badRequest(message: string): ApiError {
  return new ApiError(400, 'BAD_REQUEST', message);
}

export function rateLimited(message = 'Too many requests'): ApiError {
  return new ApiError(429, 'RATE_LIMITED', message);
}
