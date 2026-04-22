import { Router } from 'express';

export const capabilitiesRouter = Router();

capabilitiesRouter.get('/capabilities', (_req, res) => {
  res.json({
    product: 'axoria',
    version: 1,
    generatedAt: new Date().toISOString(),
    auth: {
      user: 'Authorization: Bearer <sessionToken>',
      internalWorker: 'x-service-token: <CONTROL_PLANE_SERVICE_TOKEN>',
    },
    apiSurface: {
      style: 'resource-oriented-json',
      openApi: 'GET /openapi.json returns the machine-readable OpenAPI 3.1 contract.',
      idempotency: 'Send Idempotency-Key on mutating requests that may be retried.',
      requestTracing: 'Every response includes x-request-id. Clients may provide x-request-id for trace correlation.',
      errors: {
        shape: {
          error: 'string',
          message: 'string',
          code: 'string',
          requestId: 'string',
        },
      },
    },
    workflows: [
      {
        id: 'single_payment',
        summary: 'Create one payment request, promote or create a payment order, submit it, prepare execution, attach signature, reconcile, then export proof.',
        steps: [
          'POST /workspaces/:workspaceId/payment-requests',
          'POST /workspaces/:workspaceId/payment-requests/:paymentRequestId/promote',
          'POST /workspaces/:workspaceId/payment-orders/:paymentOrderId/submit',
          'POST /workspaces/:workspaceId/payment-orders/:paymentOrderId/prepare-execution',
          'POST /workspaces/:workspaceId/payment-orders/:paymentOrderId/attach-signature',
          'GET /workspaces/:workspaceId/payment-orders/:paymentOrderId/proof?format=markdown',
        ],
      },
      {
        id: 'csv_to_payment_run',
        summary: 'Preview CSV rows, import a payment run, prepare one batch USDC transaction, attach signature, reconcile, then export proof.',
        steps: [
          'POST /workspaces/:workspaceId/payment-runs/import-csv/preview',
          'POST /workspaces/:workspaceId/payment-runs/import-csv',
          'POST /workspaces/:workspaceId/payment-runs/:paymentRunId/prepare-execution',
          'POST /workspaces/:workspaceId/payment-runs/:paymentRunId/attach-signature',
          'POST /workspaces/:workspaceId/payment-runs/:paymentRunId/close',
          'GET /workspaces/:workspaceId/payment-runs/:paymentRunId/proof?format=markdown',
        ],
      },
      {
        id: 'collections',
        summary: 'Create expected inbound collections or import a receivables CSV, then let the existing onchain reconciliation layer prove what was collected.',
        steps: [
          'POST /workspaces/:workspaceId/collections',
          'POST /workspaces/:workspaceId/collection-runs/import-csv/preview',
          'POST /workspaces/:workspaceId/collection-runs/import-csv',
          'GET /workspaces/:workspaceId/collections/:collectionRequestId',
          'GET /workspaces/:workspaceId/collection-runs/:collectionRunId',
        ],
      },
      {
        id: 'exception_ops',
        summary: 'List reconciliation exceptions, inspect context, update metadata, add notes, and resolve or reopen.',
        steps: [
          'GET /workspaces/:workspaceId/exceptions',
          'GET /workspaces/:workspaceId/exceptions/:exceptionId',
          'PATCH /workspaces/:workspaceId/exceptions/:exceptionId',
          'POST /workspaces/:workspaceId/exceptions/:exceptionId/notes',
          'POST /workspaces/:workspaceId/exceptions/:exceptionId/actions',
        ],
      },
    ],
    endpointGroups: [
      {
        group: 'setup',
        routes: [
          'POST /auth/login',
          'GET /auth/session',
          'GET /openapi.json',
          'GET /organizations',
          'POST /organizations',
          'GET /workspaces/:workspaceId/treasury-wallets',
          'GET /workspaces/:workspaceId/destinations',
        ],
      },
      {
        group: 'input',
        routes: [
          'GET /workspaces/:workspaceId/payment-requests',
          'POST /workspaces/:workspaceId/payment-requests',
          'POST /workspaces/:workspaceId/payment-requests/import-csv/preview',
          'POST /workspaces/:workspaceId/payment-requests/import-csv',
          'POST /workspaces/:workspaceId/payment-runs/import-csv/preview',
          'POST /workspaces/:workspaceId/payment-runs/import-csv',
          'POST /workspaces/:workspaceId/collections',
          'POST /workspaces/:workspaceId/collections/import-csv/preview',
          'POST /workspaces/:workspaceId/collection-runs/import-csv/preview',
          'POST /workspaces/:workspaceId/collection-runs/import-csv',
        ],
      },
      {
        group: 'control_and_execution',
        routes: [
          'GET /workspaces/:workspaceId/payment-orders',
          'POST /workspaces/:workspaceId/payment-orders',
          'POST /workspaces/:workspaceId/payment-orders/:paymentOrderId/submit',
          'POST /workspaces/:workspaceId/payment-orders/:paymentOrderId/prepare-execution',
          'POST /workspaces/:workspaceId/payment-orders/:paymentOrderId/attach-signature',
          'GET /workspaces/:workspaceId/payment-runs',
          'POST /workspaces/:workspaceId/payment-runs/:paymentRunId/cancel',
          'POST /workspaces/:workspaceId/payment-runs/:paymentRunId/close',
          'POST /workspaces/:workspaceId/payment-runs/:paymentRunId/prepare-execution',
          'POST /workspaces/:workspaceId/payment-runs/:paymentRunId/attach-signature',
          'POST /workspaces/:workspaceId/collections/:collectionRequestId/cancel',
        ],
      },
      {
        group: 'verification_and_proof',
        routes: [
          'GET /workspaces/:workspaceId/reconciliation',
          'GET /workspaces/:workspaceId/reconciliation-queue/:transferRequestId',
          'GET /workspaces/:workspaceId/reconciliation-queue/:transferRequestId/explain',
          'POST /workspaces/:workspaceId/reconciliation-queue/:transferRequestId/refresh',
          'GET /workspaces/:workspaceId/transfers',
          'GET /workspaces/:workspaceId/payment-orders/:paymentOrderId/proof',
          'GET /workspaces/:workspaceId/payment-runs/:paymentRunId/proof',
          'GET /workspaces/:workspaceId/collections',
          'GET /workspaces/:workspaceId/collections/:collectionRequestId',
          'GET /workspaces/:workspaceId/collection-runs',
          'GET /workspaces/:workspaceId/collection-runs/:collectionRunId',
          'GET /workspaces/:workspaceId/audit-log',
          'GET /workspaces/:workspaceId/ops-health',
        ],
      },
      {
        group: 'worker_internal',
        routes: [
          'GET /internal/workspaces',
          'GET /internal/workspaces/:workspaceId/matching-context',
          'GET /internal/matching-index',
          'GET /internal/matching-index/events',
        ],
      },
    ],
    safetyNotes: [
      'The API never accepts or stores private keys.',
      'Prepared execution packets require an external signer or wallet adapter to add a recent blockhash, sign, and submit.',
      'Submitted signatures are validated for Solana base58 signature shape before being stored as execution evidence.',
      'Internal worker routes require CONTROL_PLANE_SERVICE_TOKEN in production.',
    ],
  });
});
