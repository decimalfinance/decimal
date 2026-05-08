import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { prisma } from './prisma.js';

const IDEMPOTENCY_TTL_HOURS = 24;
const IDEMPOTENT_METHODS = new Set(['POST', 'PATCH', 'DELETE']);

export function idempotencyMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!IDEMPOTENT_METHODS.has(req.method) || !req.auth) {
        next();
        return;
      }

      const key = req.header('idempotency-key')?.trim();
      if (!key) {
        next();
        return;
      }

      if (key.length > 200) {
        res.status(400).json({
          error: 'InvalidIdempotencyKey',
          code: 'invalid_idempotency_key',
          message: 'Idempotency-Key must be 200 characters or fewer',
          requestId: req.requestId,
        });
        return;
      }

      const actorType = req.auth.actorType;
      const actorId = req.auth.actorId;
      const requestHash = hashRequestBody(req.body);
      const existing = await prisma.idempotencyRecord.findUnique({
        where: {
          actorType_actorId_requestMethod_requestPath_key: {
            actorType,
            actorId,
            requestMethod: req.method,
            requestPath: req.path,
            key,
          },
        },
      });

      if (existing) {
        if (existing.requestHash !== requestHash) {
          res.status(409).json({
            error: 'IdempotencyConflict',
            code: 'idempotency_conflict',
            message: 'This Idempotency-Key was already used for a different request body',
            requestId: req.requestId,
          });
          return;
        }

        if (existing.status === 'completed' && existing.statusCode && existing.responseBodyJson !== null) {
          res.setHeader('Idempotency-Replayed', 'true');
          res.status(existing.statusCode).json(existing.responseBodyJson);
          return;
        }

        res.status(409).json({
          error: 'IdempotencyInProgress',
          code: 'idempotency_in_progress',
          message: 'An identical request with this Idempotency-Key is still processing',
          requestId: req.requestId,
        });
        return;
      }

      const record = await prisma.idempotencyRecord.create({
        data: {
          key,
          actorType,
          actorId,
          requestMethod: req.method,
          requestPath: req.path,
          requestHash,
          expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000),
        },
      });

      const originalJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          void prisma.idempotencyRecord.update({
            where: { idempotencyRecordId: record.idempotencyRecordId },
            data: {
              status: 'completed',
              statusCode: res.statusCode,
              responseBodyJson: JSON.parse(JSON.stringify(body ?? null)),
            },
          })
            .then(() => originalJson(body))
            .catch(() => originalJson(body));
          return res;
        }

        return originalJson(body);
      }) as Response['json'];

      next();
    } catch (error) {
      next(error);
    }
  };
}

function hashRequestBody(body: unknown) {
  return crypto
    .createHash('sha256')
    .update(stableStringify(body ?? null))
    .digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}
