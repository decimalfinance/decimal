import { Prisma } from '@prisma/client';

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(message: string, details?: unknown) {
  return new ApiError(400, 'bad_request', message, details);
}

export function forbidden(message = 'Forbidden', details?: unknown) {
  return new ApiError(403, 'forbidden', message, details);
}

export function notFound(message = 'Resource not found', details?: unknown) {
  return new ApiError(404, 'not_found', message, details);
}

export function conflict(message: string, details?: unknown) {
  return new ApiError(409, 'conflict', message, details);
}

export function mapKnownError(error: unknown) {
  if (error instanceof ApiError) {
    return error;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2025') {
      return notFound('Resource not found');
    }
    if (error.code === 'P2002') {
      return conflict('Unique constraint violation', error.meta);
    }
  }

  return null;
}

export function normalizeErrorCode(errorName: string) {
  return errorName
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .toLowerCase();
}
