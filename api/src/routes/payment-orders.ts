import { Router } from 'express';
import { z } from 'zod';
import {
  attachPaymentOrderSignature,
  cancelPaymentOrder,
  createPaymentOrder,
  createPaymentOrderExecution,
  getPaymentOrderDetail,
  listPaymentOrders,
  preparePaymentOrderExecution,
  updatePaymentOrder,
  submitPaymentOrder,
} from '../payment-orders.js';
import { buildPaymentOrderProofPacket } from '../payment-order-proof.js';
import { isPaymentOrderState } from '../payment-order-state.js';
import { isSolanaSignatureLike } from '../solana.js';
import { assertOrganizationAccess, assertOrganizationAdmin } from '../organization-access.js';
import { actorFromAuth } from '../actor.js';
import { asyncRoute, sendCreated, sendJson, sendList, unwrapItems } from '../route-helpers.js';

export const paymentOrdersRouter = Router();

const organizationParamsSchema = z.object({
  organizationId: z.string().uuid(),
});

const paymentOrderParamsSchema = organizationParamsSchema.extend({
  paymentOrderId: z.string().uuid(),
});

const amountRawSchema = z.union([
  z.string().regex(/^\d+$/),
  z.number().int().nonnegative().transform((value) => value.toString()),
]);

const createPaymentOrderSchema = z.object({
  destinationId: z.string().uuid(),
  sourceTreasuryWalletId: z.string().uuid().optional(),
  amountRaw: amountRawSchema,
  asset: z.string().trim().min(1).max(20).default('usdc'),
  memo: z.string().trim().max(1000).optional(),
  externalReference: z.string().trim().max(200).optional(),
  invoiceNumber: z.string().trim().max(200).optional(),
  attachmentUrl: z.string().trim().max(2000).optional(),
  dueAt: z.string().datetime().optional(),
  sourceBalanceSnapshotJson: z.record(z.any()).default({ status: 'unknown' }),
  metadataJson: z.record(z.any()).default({}),
  submitNow: z.boolean().default(false),
});

const updatePaymentOrderSchema = z.object({
  sourceTreasuryWalletId: z.string().uuid().nullable().optional(),
  memo: z.string().trim().max(1000).nullable().optional(),
  externalReference: z.string().trim().max(200).nullable().optional(),
  invoiceNumber: z.string().trim().max(200).nullable().optional(),
  attachmentUrl: z.string().trim().max(2000).nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  sourceBalanceSnapshotJson: z.record(z.any()).optional(),
  metadataJson: z.record(z.any()).optional(),
});

const listPaymentOrdersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(250).default(100),
  state: z.string().refine((value) => isPaymentOrderState(value), 'Invalid payment order state').optional(),
  paymentRunId: z.string().uuid().optional(),
});

const createExecutionSchema = z.object({
  executionSource: z.string().trim().min(1).max(100).default('manual_signature'),
  externalReference: z.string().trim().max(500).optional(),
  metadataJson: z.record(z.any()).default({}),
});

const prepareExecutionSchema = z.object({
  sourceTreasuryWalletId: z.string().uuid().optional(),
});

const attachSignatureSchema = z.object({
  submittedSignature: z.string().trim().refine(isSolanaSignatureLike, 'Invalid Solana signature').optional(),
  externalReference: z.string().trim().max(500).optional(),
  submittedAt: z.string().datetime().optional(),
  metadataJson: z.record(z.any()).default({}),
}).refine(
  (value) => Boolean(value.submittedSignature || value.externalReference || Object.keys(value.metadataJson).length),
  'A submitted signature, external execution reference, or metadata is required',
);

const proofQuerySchema = z.object({
  format: z.literal('json').default('json'),
});

paymentOrdersRouter.get('/organizations/:organizationId/payment-orders', asyncRoute(async (req, res) => {
    const { organizationId } = organizationParamsSchema.parse(req.params);
    const query = listPaymentOrdersQuerySchema.parse(req.query);
    await assertOrganizationAccess(organizationId, req.auth!);

    const result = await listPaymentOrders(organizationId, {
      limit: query.limit,
      state: query.state,
      paymentRunId: query.paymentRunId,
    });
    sendList(res, unwrapItems(result), {
      limit: query.limit,
      state: query.state ?? null,
      paymentRunId: query.paymentRunId ?? null,
    });
}));

paymentOrdersRouter.post('/organizations/:organizationId/payment-orders', asyncRoute(async (req, res) => {
    const { organizationId } = organizationParamsSchema.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!);
    const input = createPaymentOrderSchema.parse(req.body);
    const actor = actorFromAuth(req.auth!);

    const detail = await createPaymentOrder({
      organizationId,
      ...actor,
      destinationId: input.destinationId,
      sourceTreasuryWalletId: input.sourceTreasuryWalletId,
      amountRaw: input.amountRaw,
      asset: input.asset,
      memo: input.memo,
      externalReference: input.externalReference,
      invoiceNumber: input.invoiceNumber,
      attachmentUrl: input.attachmentUrl,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      sourceBalanceSnapshotJson: input.sourceBalanceSnapshotJson,
      metadataJson: input.metadataJson,
      submitNow: input.submitNow,
    });

    sendCreated(res, detail);
}));

paymentOrdersRouter.get('/organizations/:organizationId/payment-orders/:paymentOrderId', asyncRoute(async (req, res) => {
    const { organizationId, paymentOrderId } = paymentOrderParamsSchema.parse(req.params);
    await assertOrganizationAccess(organizationId, req.auth!);
    sendJson(res, await getPaymentOrderDetail(organizationId, paymentOrderId));
}));

paymentOrdersRouter.patch('/organizations/:organizationId/payment-orders/:paymentOrderId', async (req, res, next) => {
  try {
    const { organizationId, paymentOrderId } = paymentOrderParamsSchema.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!);
    const input = updatePaymentOrderSchema.parse(req.body);
    const actor = actorFromAuth(req.auth!);

    res.json(await updatePaymentOrder({
      organizationId,
      paymentOrderId,
      ...actor,
      input: {
        ...input,
        dueAt: input.dueAt === undefined ? undefined : input.dueAt ? new Date(input.dueAt) : null,
      },
    }));
  } catch (error) {
    next(error);
  }
});

paymentOrdersRouter.post('/organizations/:organizationId/payment-orders/:paymentOrderId/submit', async (req, res, next) => {
  try {
    const { organizationId, paymentOrderId } = paymentOrderParamsSchema.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!);
    const actor = actorFromAuth(req.auth!);

    res.json(await submitPaymentOrder({
      organizationId,
      paymentOrderId,
      ...actor,
    }));
  } catch (error) {
    next(error);
  }
});

paymentOrdersRouter.post('/organizations/:organizationId/payment-orders/:paymentOrderId/cancel', async (req, res, next) => {
  try {
    const { organizationId, paymentOrderId } = paymentOrderParamsSchema.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!);
    const actor = actorFromAuth(req.auth!);

    res.json(await cancelPaymentOrder({
      organizationId,
      paymentOrderId,
      ...actor,
    }));
  } catch (error) {
    next(error);
  }
});

paymentOrdersRouter.post(
  '/organizations/:organizationId/payment-orders/:paymentOrderId/prepare-execution',
  async (req, res, next) => {
    try {
      const { organizationId, paymentOrderId } = paymentOrderParamsSchema.parse(req.params);
      await assertOrganizationAdmin(organizationId, req.auth!);
      const input = prepareExecutionSchema.parse(req.body);
      const actor = actorFromAuth(req.auth!);

      const prepared = await preparePaymentOrderExecution({
        organizationId,
        paymentOrderId,
        ...actor,
        sourceTreasuryWalletId: input.sourceTreasuryWalletId,
      });

      res.status(201).json(prepared);
    } catch (error) {
      next(error);
    }
  },
);

paymentOrdersRouter.post(
  '/organizations/:organizationId/payment-orders/:paymentOrderId/create-execution',
  async (req, res, next) => {
    try {
      const { organizationId, paymentOrderId } = paymentOrderParamsSchema.parse(req.params);
      await assertOrganizationAdmin(organizationId, req.auth!);
      const input = createExecutionSchema.parse(req.body);
      const actor = actorFromAuth(req.auth!);

      const executionRecord = await createPaymentOrderExecution({
        organizationId,
        paymentOrderId,
        ...actor,
        executionSource: input.executionSource,
        externalReference: input.externalReference,
        metadataJson: input.metadataJson,
      });

      res.status(201).json(executionRecord);
    } catch (error) {
      next(error);
    }
  },
);

paymentOrdersRouter.post(
  '/organizations/:organizationId/payment-orders/:paymentOrderId/attach-signature',
  async (req, res, next) => {
    try {
      const { organizationId, paymentOrderId } = paymentOrderParamsSchema.parse(req.params);
      await assertOrganizationAdmin(organizationId, req.auth!);
      const input = attachSignatureSchema.parse(req.body);
      const actor = actorFromAuth(req.auth!);

      const executionRecord = await attachPaymentOrderSignature({
        organizationId,
        paymentOrderId,
        ...actor,
        submittedSignature: input.submittedSignature,
        externalReference: input.externalReference,
        submittedAt: input.submittedAt ? new Date(input.submittedAt) : null,
        metadataJson: input.metadataJson,
      });

      res.json(executionRecord);
    } catch (error) {
      next(error);
    }
  },
);

paymentOrdersRouter.get(
  '/organizations/:organizationId/payment-orders/:paymentOrderId/proof',
  async (req, res, next) => {
    try {
      const { organizationId, paymentOrderId } = paymentOrderParamsSchema.parse(req.params);
      const query = proofQuerySchema.parse(req.query);
      await assertOrganizationAccess(organizationId, req.auth!);
      const proof = await buildPaymentOrderProofPacket(organizationId, paymentOrderId);
      void query;
      sendJson(res, proof);
    } catch (error) {
      next(error);
    }
  },
);
