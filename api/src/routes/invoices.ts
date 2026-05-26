import { Router } from 'express';
import { z } from 'zod';
import { assertOrganizationAdmin } from '../auth/organization-access.js';
import { asyncRoute, sendCreated } from '../infra/route-helpers.js';
import { tryAdvancePaymentOrderWithAgent } from '../agents/payment-automation.js';
import { uploadInvoiceToPaymentOrders } from '../payments/invoice-intake.js';

export const invoicesRouter = Router();

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

const organizationParamsSchema = z.object({
  organizationId: z.string().uuid(),
});

const uploadInvoiceSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(100),
  dataBase64: z.string().min(1),
  sourceTreasuryWalletId: z.string().uuid().optional().nullable(),
  autoAdvance: z.boolean().default(true),
});

invoicesRouter.post('/organizations/:organizationId/invoices/upload', asyncRoute(async (req, res) => {
  const { organizationId } = organizationParamsSchema.parse(req.params);
  await assertOrganizationAdmin(organizationId, req.auth!);
  const input = uploadInvoiceSchema.parse(req.body);
  const fileBytes = Buffer.from(input.dataBase64, 'base64');
  if (fileBytes.length > MAX_DOCUMENT_BYTES) {
    throw new Error(`Document exceeds ${MAX_DOCUMENT_BYTES / (1024 * 1024)}MB limit`);
  }

  const result = await uploadInvoiceToPaymentOrders({
    organizationId,
    actorUserId: req.auth!.userId,
    fileBytes,
    filename: input.filename,
    mimeType: input.mimeType,
    sourceTreasuryWalletId: input.sourceTreasuryWalletId,
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
