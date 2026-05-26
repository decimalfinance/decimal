import type { NextFunction, Request, Response } from 'express';
import { config, type LogLevel } from '../config.js';

type LogFields = Record<string, unknown>;

const LEVEL_RANK: Record<Exclude<LogLevel, 'silent'>, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export const logger = {
  debug(message: string, fields?: LogFields) {
    writeLog('debug', message, fields);
  },
  info(message: string, fields?: LogFields) {
    writeLog('info', message, fields);
  },
  warn(message: string, fields?: LogFields) {
    writeLog('warn', message, fields);
  },
  error(message: string, fields?: LogFields) {
    writeLog('error', message, fields);
  },
};

export function requestLoggerMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (shouldSkipRequestLog(req)) {
      next();
      return;
    }

    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const statusCode = res.statusCode;
      const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
      logger[level]('http.request.completed', {
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        contentLength: res.getHeader('content-length') ?? null,
        userId: req.auth?.userId ?? null,
      });
    });

    next();
  };
}

export function errorToLogFields(error: unknown, options: { includeStack?: boolean } = {}): LogFields {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(options.includeStack === false ? {} : { stack: error.stack }),
    };
  }
  return { error: String(error) };
}

function writeLog(level: Exclude<LogLevel, 'silent'>, message: string, fields: LogFields = {}) {
  if (!shouldLog(level)) {
    return;
  }

  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    ...fields,
  };
  const line = JSON.stringify(payload, jsonReplacer);

  if (level === 'error') {
    console.error(line);
    return;
  }
  if (level === 'warn') {
    console.warn(line);
    return;
  }
  console.log(line);
}

function shouldLog(level: Exclude<LogLevel, 'silent'>) {
  if (config.logLevel === 'silent') {
    return false;
  }
  return LEVEL_RANK[level] >= LEVEL_RANK[config.logLevel];
}

function shouldSkipRequestLog(req: Request) {
  return req.path === '/health';
}

function jsonReplacer(_key: string, value: unknown) {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Error) {
    return errorToLogFields(value);
  }
  return value;
}
