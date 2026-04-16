import { Router } from 'express';

export const capabilitiesRouter = Router();

capabilitiesRouter.get('/capabilities', (_req, res) => {
  res.json({
    product: 'stablecoin-ops-control-plane',
    version: 1,
    generatedAt: new Date().toISOString(),
    auth: {
      user: 'Authorization: Bearer <sessionToken>',
      internalWorker: 'x-service-token: <CONTROL_PLANE_SERVICE_TOKEN>',
    },
    workflows: [
      {
        id: 'csv_to_payment_run',
        summary: 'Import CSV rows, create payment requests and orders, prepare one batch USDC transaction, attach signature, then reconcile.',
        steps: [
          'POST /workspaces/:workspaceId/payment-runs/import-csv',
          'POST /workspaces/:workspaceId/payment-runs/:paymentRunId/prepare-execution',
          'POST /workspaces/:workspaceId/payment-runs/:paymentRunId/attach-signature',
          'GET /workspaces/:workspaceId/payment-runs/:paymentRunId/proof',
        ],
      },
      {
        id: 'single_payment_order',
        summary: 'Create one payment order, submit through policy, prepare a signer-ready USDC transfer packet, attach execution evidence, then export proof.',
        steps: [
          'POST /workspaces/:workspaceId/payment-orders',
          'POST /workspaces/:workspaceId/payment-orders/:paymentOrderId/submit',
          'POST /workspaces/:workspaceId/payment-orders/:paymentOrderId/prepare-execution',
          'POST /workspaces/:workspaceId/payment-orders/:paymentOrderId/attach-signature',
          'GET /workspaces/:workspaceId/payment-orders/:paymentOrderId/proof',
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
          'GET /organizations',
          'POST /organizations',
          'POST /organizations/:organizationId/demo-workspace',
          'GET /workspaces/:workspaceId/addresses',
          'GET /workspaces/:workspaceId/destinations',
          'GET /workspaces/:workspaceId/payees',
        ],
      },
      {
        group: 'input',
        routes: [
          'GET /workspaces/:workspaceId/payment-requests',
          'POST /workspaces/:workspaceId/payment-requests',
          'POST /workspaces/:workspaceId/payment-requests/import-csv',
          'POST /workspaces/:workspaceId/payment-runs/import-csv',
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
          'POST /workspaces/:workspaceId/payment-runs/:paymentRunId/prepare-execution',
          'POST /workspaces/:workspaceId/payment-runs/:paymentRunId/attach-signature',
        ],
      },
      {
        group: 'verification_and_proof',
        routes: [
          'GET /workspaces/:workspaceId/reconciliation',
          'GET /workspaces/:workspaceId/reconciliation-queue/:transferRequestId',
          'GET /workspaces/:workspaceId/transfers',
          'GET /workspaces/:workspaceId/payment-orders/:paymentOrderId/proof',
          'GET /workspaces/:workspaceId/payment-runs/:paymentRunId/proof',
          'GET /workspaces/:workspaceId/ops-health',
          'GET /workspaces/:workspaceId/exports',
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
