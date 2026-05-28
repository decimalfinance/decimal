import { Router } from 'express';
import { z } from 'zod';
import {
  cancelPaymentOrder,
  clearPaymentOrderReview,
  createPaymentOrder,
  getPaymentOrderDetail,
  listPaymentOrders,
  updatePaymentOrder,
} from '../payments/orders.js';
import { importPaymentOrdersFromCsv, previewPaymentOrdersCsv } from '../payments/csv-intake.js';
import { tryAdvancePaymentOrderWithAgent } from '../agents/payment-automation.js';
import { buildPaymentOrderProofPacket } from '../payments/order-proof.js';
import { isPaymentOrderState } from '../payments/order-state.js';
import { assertOrganizationAccess, assertOrganizationAdmin } from '../auth/organization-access.js';
import { actorFromAuth } from '../auth/actor.js';
import { asyncRoute, sendCreated, sendJson, sendList, unwrapItems } from '../infra/route-helpers.js';

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
  counterpartyWalletId: z.string().uuid(),
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
  autoAdvance: z.boolean().default(false),
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
  inputBatchId: z.string().uuid().optional(),
});

const batchCsvSchema = z.object({
  csv: z.string().min(1),
  sourceTreasuryWalletId: z.string().uuid().optional().nullable(),
  batchLabel: z.string().trim().max(200).optional().nullable(),
  autoAdvance: z.boolean().default(true),
});

const proofQuerySchema = z.object({
  format: z.literal('json').default('json'),
});

const clearReviewSchema = z.object({
  reviewNote: z.string().trim().max(2000).optional().nullable(),
  trustCounterpartyWallet: z.boolean().default(true),
  autoAdvance: z.boolean().default(true),
});

const agentAdvanceSchema = z.object({
  sourceTreasuryWalletId: z.string().uuid().optional().nullable(),
});

paymentOrdersRouter.get('/organizations/:organizationId/payment-orders', asyncRoute(async (req, res) => {
    const { organizationId } = organizationParamsSchema.parse(req.params);
    const query = listPaymentOrdersQuerySchema.parse(req.query);
    await assertOrganizationAccess(organizationId, req.auth!);

    const result = await listPaymentOrders(organizationId, {
      limit: query.limit,
      state: query.state,
      inputBatchId: query.inputBatchId,
    });
    sendList(res, unwrapItems(result), {
      limit: query.limit,
      state: query.state ?? null,
      inputBatchId: query.inputBatchId ?? null,
    });
}));

paymentOrdersRouter.post('/organizations/:organizationId/payment-orders', asyncRoute(async (req, res) => {
    const { organizationId } = organizationParamsSchema.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!);
    const input = createPaymentOrderSchema.parse(req.body);
    const actor = actorFromAuth(req.auth!);

    const created = await createPaymentOrder({
      organizationId,
      ...actor,
      counterpartyWalletId: input.counterpartyWalletId,
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
    });
    const automation = input.autoAdvance
      ? await tryAdvancePaymentOrderWithAgent({
          organizationId,
          paymentOrderId: created.paymentOrderId,
          actorUserId: req.auth!.userId,
          sourceTreasuryWalletId: input.sourceTreasuryWalletId,
        })
      : null;
    const detail = input.autoAdvance
      ? await getPaymentOrderDetail(organizationId, created.paymentOrderId)
      : created;

    sendCreated(res, automation ? { ...detail, automation } : detail);
}));

paymentOrdersRouter.post('/organizations/:organizationId/payment-orders/batch-csv/preview', asyncRoute(async (req, res) => {
    const { organizationId } = organizationParamsSchema.parse(req.params);
    await assertOrganizationAccess(organizationId, req.auth!);
    const input = batchCsvSchema.pick({ csv: true }).parse(req.body);
    sendJson(res, await previewPaymentOrdersCsv({
      organizationId,
      csv: input.csv,
    }));
}));

paymentOrdersRouter.post('/organizations/:organizationId/payment-orders/batch-csv', asyncRoute(async (req, res) => {
    const { organizationId } = organizationParamsSchema.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!);
    const input = batchCsvSchema.parse(req.body);
    const result = await importPaymentOrdersFromCsv({
      organizationId,
      actorUserId: req.auth!.userId,
      csv: input.csv,
      sourceTreasuryWalletId: input.sourceTreasuryWalletId,
      batchLabel: input.batchLabel,
    });
    const automation = input.autoAdvance
      ? await Promise.all(result.paymentOrders.map((item) =>
          tryAdvancePaymentOrderWithAgent({
            organizationId,
            paymentOrderId: item.paymentOrder.paymentOrderId,
            actorUserId: req.auth!.userId,
            sourceTreasuryWalletId: input.sourceTreasuryWalletId,
          }),
        ))
      : [];
    sendCreated(res, {
      ...result,
      automation,
    });
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

paymentOrdersRouter.post('/organizations/:organizationId/payment-orders/:paymentOrderId/clear-review', asyncRoute(async (req, res) => {
    const { organizationId, paymentOrderId } = paymentOrderParamsSchema.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!);
    const input = clearReviewSchema.parse(req.body);
    const actor = actorFromAuth(req.auth!);

    await clearPaymentOrderReview({
      organizationId,
      paymentOrderId,
      ...actor,
      reviewNote: input.reviewNote,
      trustCounterpartyWallet: input.trustCounterpartyWallet,
    });
    const automation = input.autoAdvance
      ? await tryAdvancePaymentOrderWithAgent({
          organizationId,
          paymentOrderId,
          actorUserId: req.auth!.userId,
        })
      : null;
    const detail = await getPaymentOrderDetail(organizationId, paymentOrderId);
    sendJson(res, {
      ...detail,
      automation,
    });
}));

paymentOrdersRouter.post('/organizations/:organizationId/payment-orders/:paymentOrderId/agent/advance', asyncRoute(async (req, res) => {
    const { organizationId, paymentOrderId } = paymentOrderParamsSchema.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!);
    const input = agentAdvanceSchema.parse(req.body);

    sendJson(res, await tryAdvancePaymentOrderWithAgent({
      organizationId,
      paymentOrderId,
      actorUserId: req.auth!.userId,
      sourceTreasuryWalletId: input.sourceTreasuryWalletId,
    }));
}));

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
