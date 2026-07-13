import { Router } from 'express';
import { prisma } from '../infra/prisma.js';
import { config } from '../config.js';

export const healthRouter = Router();

healthRouter.get('/health', async (_req, res, next) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    // fakeChain surfaces ONLY when on (bench) so the test bench can tell at a
    // glance whether the process it's talking to simulates the chain — a
    // process without the flag fails treasury ops with real-chain errors that
    // look like harness bugs (testbench VERIFY-approval-failclosed).
    res.json({ ok: true, ...(config.squadsFakeChain ? { fakeChain: true } : {}) });
  } catch (error) {
    next(error);
  }
});
