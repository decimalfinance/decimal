import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { listResponse } from './api-format.js';

export function asyncRoute(handler: (req: Request, res: Response) => Promise<void> | void): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res)).catch(next);
  };
}

export function sendJson(res: Response, body: unknown) {
  res.json(body);
}

export function sendCreated(res: Response, body: unknown) {
  res.status(201).json(body);
}

export function sendList<T>(res: Response, items: T[], meta?: Record<string, unknown>) {
  res.json(listResponse(items, meta));
}

export function unwrapItems<T>(result: { items: T[] }) {
  return result.items;
}

export function listQuerySchema(options: { defaultLimit: number; maxLimit: number }) {
  return z.object({
    limit: z.coerce.number().int().min(1).max(options.maxLimit).default(options.defaultLimit),
  });
}
