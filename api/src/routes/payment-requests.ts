import { Router } from 'express';
import { z } from 'zod';
import {
  cancelPaymentRequest,
  createPaymentRequest,
  getPaymentRequestDetail,
  importPaymentRequestsFromCsv,
  isPaymentRequestState,
  listPaymentRequests,
  promotePaymentRequestToOrder,
} from '../payment-requests.js';
import { assertWorkspaceAccess, assertWorkspaceAdmin } from '../workspace-access.js';

export const paymentRequestsRouter = Router();

const workspaceParamsSchema = z.object({
  workspaceId: z.string().uuid(),
});

const paymentRequestParamsSchema = workspaceParamsSchema.extend({
  paymentRequestId: z.string().uuid(),
});

const amountRawSchema = z.union([
  z.string().regex(/^\d+$/),
  z.number().int().nonnegative().transform((value) => value.toString()),
]);

const listPaymentRequestsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(250).default(100),
  state: z.string().refine((value) => isPaymentRequestState(value), 'Invalid payment request state').optional(),
});

const createPaymentRequestSchema = z.object({
  payeeId: z.string().uuid().optional(),
  destinationId: z.string().uuid(),
  amountRaw: amountRawSchema,
  asset: z.string().trim().min(1).max(20).default('usdc'),
  reason: z.string().trim().min(1).max(1000),
  externalReference: z.string().trim().max(200).optional(),
  dueAt: z.string().datetime().optional(),
  metadataJson: z.record(z.any()).default({}),
  createOrderNow: z.boolean().default(false),
  sourceWorkspaceAddressId: z.string().uuid().optional(),
  submitOrderNow: z.boolean().default(false),
});

const importPaymentRequestsCsvSchema = z.object({
  csv: z.string().min(1),
  createOrderNow: z.boolean().default(true),
  sourceWorkspaceAddressId: z.string().uuid().optional(),
  submitOrderNow: z.boolean().default(false),
});

const promotePaymentRequestSchema = z.object({
  sourceWorkspaceAddressId: z.string().uuid().optional(),
  submitNow: z.boolean().default(false),
});

paymentRequestsRouter.get('/workspaces/:workspaceId/payment-requests', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    const query = listPaymentRequestsQuerySchema.parse(req.query);
    await assertWorkspaceAccess(workspaceId, req.auth!.userId);

    const result = await listPaymentRequests(workspaceId, {
      limit: query.limit,
      state: query.state,
    });
    res.json({ servedAt: new Date().toISOString(), ...result });
  } catch (error) {
    next(error);
  }
});

paymentRequestsRouter.post('/workspaces/:workspaceId/payment-requests', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    await assertWorkspaceAdmin(workspaceId, req.auth!.userId);
    const input = createPaymentRequestSchema.parse(req.body);

    const detail = await createPaymentRequest({
      workspaceId,
      actorUserId: req.auth!.userId,
      payeeId: input.payeeId,
      destinationId: input.destinationId,
      amountRaw: input.amountRaw,
      asset: input.asset,
      reason: input.reason,
      externalReference: input.externalReference,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      metadataJson: input.metadataJson,
      createOrderNow: input.createOrderNow,
      sourceWorkspaceAddressId: input.sourceWorkspaceAddressId,
      submitOrderNow: input.submitOrderNow,
    });

    res.status(201).json(detail);
  } catch (error) {
    next(error);
  }
});

paymentRequestsRouter.post('/workspaces/:workspaceId/payment-requests/import-csv', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    await assertWorkspaceAdmin(workspaceId, req.auth!.userId);
    const input = importPaymentRequestsCsvSchema.parse(req.body);

    res.status(201).json(await importPaymentRequestsFromCsv({
      workspaceId,
      actorUserId: req.auth!.userId,
      csv: input.csv,
      createOrderNow: input.createOrderNow,
      sourceWorkspaceAddressId: input.sourceWorkspaceAddressId,
      submitOrderNow: input.submitOrderNow,
    }));
  } catch (error) {
    next(error);
  }
});

paymentRequestsRouter.get('/workspaces/:workspaceId/payment-requests/:paymentRequestId', async (req, res, next) => {
  try {
    const { workspaceId, paymentRequestId } = paymentRequestParamsSchema.parse(req.params);
    await assertWorkspaceAccess(workspaceId, req.auth!.userId);

    res.json(await getPaymentRequestDetail(workspaceId, paymentRequestId));
  } catch (error) {
    next(error);
  }
});

paymentRequestsRouter.post(
  '/workspaces/:workspaceId/payment-requests/:paymentRequestId/promote',
  async (req, res, next) => {
    try {
      const { workspaceId, paymentRequestId } = paymentRequestParamsSchema.parse(req.params);
      await assertWorkspaceAdmin(workspaceId, req.auth!.userId);
      const input = promotePaymentRequestSchema.parse(req.body);

      res.status(201).json(await promotePaymentRequestToOrder({
        workspaceId,
        paymentRequestId,
        actorUserId: req.auth!.userId,
        sourceWorkspaceAddressId: input.sourceWorkspaceAddressId,
        submitNow: input.submitNow,
      }));
    } catch (error) {
      next(error);
    }
  },
);

paymentRequestsRouter.post(
  '/workspaces/:workspaceId/payment-requests/:paymentRequestId/cancel',
  async (req, res, next) => {
    try {
      const { workspaceId, paymentRequestId } = paymentRequestParamsSchema.parse(req.params);
      await assertWorkspaceAdmin(workspaceId, req.auth!.userId);

      res.json(await cancelPaymentRequest({
        workspaceId,
        paymentRequestId,
      }));
    } catch (error) {
      next(error);
    }
  },
);
