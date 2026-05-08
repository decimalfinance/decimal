import { Router } from 'express';
import { prisma } from '../infra/prisma.js';

export const healthRouter = Router();

healthRouter.get('/health', async (_req, res, next) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

