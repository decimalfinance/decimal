import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { config } from '../config.js';
import { normalizeClickHouseDateTime, queryClickHouse } from '../clickhouse.js';
import {
  addExceptionNote,
  applyExceptionAction,
  getExceptionDetail,
  getReconciliationDetail,
  listReconciliationQueue,
  listWorkspaceExceptions,
} from '../reconciliation.js';
import {
  REQUEST_STATUSES,
} from '../transfer-request-lifecycle.js';
import { assertWorkspaceAccess } from '../workspace-access.js';

export const eventsRouter = Router();

const workspaceParamsSchema = z.object({
  workspaceId: z.string().uuid(),
});

const transferRequestParamsSchema = workspaceParamsSchema.extend({
  transferRequestId: z.string().uuid(),
});

const exceptionParamsSchema = workspaceParamsSchema.extend({
  exceptionId: z.string().uuid(),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const reconciliationQueueQuerySchema = listQuerySchema.extend({
  displayState: z.enum(['pending', 'matched', 'partial', 'exception']).optional(),
  requestStatus: z.enum(REQUEST_STATUSES).optional(),
});

const exceptionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  status: z.enum(['open', 'reviewed', 'expected', 'dismissed', 'reopened']).optional(),
  severity: z.string().optional(),
});

const exceptionActionSchema = z.object({
  action: z.enum(['reviewed', 'expected', 'dismissed', 'reopen']),
  note: z.string().trim().min(1).max(5000).optional(),
});

const exceptionNoteSchema = z.object({
  body: z.string().trim().min(1).max(5000),
});

type ObservedTransferRow = {
  transfer_id: string;
  signature: string;
  slot: string | number;
  event_time: string;
  asset: string;
  source_token_account: string | null;
  source_wallet: string | null;
  destination_token_account: string;
  destination_wallet: string | null;
  amount_raw: string;
  amount_decimal: string;
  transfer_kind: string;
  instruction_index: number | string | null;
  inner_instruction_index: number | string | null;
  route_group: string;
  leg_role: string;
  properties_json: string | null;
  created_at: string;
  chain_to_write_ms: string | number;
};

eventsRouter.get('/workspaces/:workspaceId/transfers', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    const query = listQuerySchema.parse(req.query);
    await assertWorkspaceAccess(workspaceId, req.auth!.userId);

    const addresses = await prisma.workspaceAddress.findMany({
      where: { workspaceId, isActive: true },
      select: {
        address: true,
        usdcAtaAddress: true,
      },
    });

    const walletAddresses = uniqueValues(addresses.map((item) => item.address));
    const ataAddresses = uniqueValues(
      addresses.map((item) => item.usdcAtaAddress).filter((value): value is string => Boolean(value)),
    );

    if (!walletAddresses.length && !ataAddresses.length) {
      res.json({ items: [] });
      return;
    }

    const clauses: string[] = [];

    if (walletAddresses.length) {
      const wallets = walletAddresses.map((value) => `'${escapeClickHouseString(value)}'`).join(', ');
      clauses.push(`source_wallet IN (${wallets})`);
      clauses.push(`destination_wallet IN (${wallets})`);
    }

    if (ataAddresses.length) {
      const atas = ataAddresses.map((value) => `'${escapeClickHouseString(value)}'`).join(', ');
      clauses.push(`source_token_account IN (${atas})`);
      clauses.push(`destination_token_account IN (${atas})`);
    }

    const rows = await queryClickHouse<ObservedTransferRow>(`
      SELECT
        transfer_id,
        signature,
        slot,
        event_time,
        asset,
        source_token_account,
        source_wallet,
        destination_token_account,
        destination_wallet,
        amount_raw,
        amount_decimal,
        transfer_kind,
        instruction_index,
        inner_instruction_index,
        route_group,
        leg_role,
        properties_json,
        created_at,
        dateDiff('millisecond', event_time, created_at) AS chain_to_write_ms
      FROM ${config.clickhouseDatabase}.observed_transfers
      WHERE ${clauses.map((clause) => `(${clause})`).join(' OR ')}
      ORDER BY event_time DESC
      LIMIT ${query.limit}
      FORMAT JSONEachRow
    `);

    res.json({
      servedAt: new Date().toISOString(),
      items: rows.map((row) => ({
        transferId: row.transfer_id,
        signature: row.signature,
        slot: Number(row.slot),
        eventTime: normalizeClickHouseDateTime(row.event_time),
        asset: row.asset,
        sourceTokenAccount: row.source_token_account,
        sourceWallet: row.source_wallet,
        destinationTokenAccount: row.destination_token_account,
        destinationWallet: row.destination_wallet,
        amountRaw: row.amount_raw,
        amountDecimal: row.amount_decimal,
        transferKind: row.transfer_kind,
        instructionIndex:
          row.instruction_index === null ? null : Number(row.instruction_index),
        innerInstructionIndex:
          row.inner_instruction_index === null ? null : Number(row.inner_instruction_index),
        routeGroup: row.route_group,
        legRole: row.leg_role,
        propertiesJson: safeJsonParse(row.properties_json),
        createdAt: normalizeClickHouseDateTime(row.created_at),
        chainToWriteMs: Number(row.chain_to_write_ms),
      })),
    });
  } catch (error) {
    next(error);
  }
});

eventsRouter.get('/workspaces/:workspaceId/reconciliation', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    const query = reconciliationQueueQuerySchema.parse(req.query);
    await assertWorkspaceAccess(workspaceId, req.auth!.userId);

    const items = await listReconciliationQueue(workspaceId, {
      limit: query.limit,
      displayState: query.displayState,
      requestStatus: query.requestStatus,
    });

    res.json({
      servedAt: new Date().toISOString(),
      items,
    });
  } catch (error) {
    next(error);
  }
});

eventsRouter.get('/workspaces/:workspaceId/reconciliation-queue', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    const query = reconciliationQueueQuerySchema.parse(req.query);
    await assertWorkspaceAccess(workspaceId, req.auth!.userId);

    const items = await listReconciliationQueue(workspaceId, {
      limit: query.limit,
      displayState: query.displayState,
      requestStatus: query.requestStatus,
    });

    res.json({
      servedAt: new Date().toISOString(),
      items,
    });
  } catch (error) {
    next(error);
  }
});

eventsRouter.get(
  '/workspaces/:workspaceId/reconciliation-queue/:transferRequestId',
  async (req, res, next) => {
    try {
      const { workspaceId, transferRequestId } = transferRequestParamsSchema.parse(req.params);
      await assertWorkspaceAccess(workspaceId, req.auth!.userId);
      const detail = await getReconciliationDetail(workspaceId, transferRequestId);
      res.json(detail);
    } catch (error) {
      next(error);
    }
  },
);

eventsRouter.get('/workspaces/:workspaceId/exceptions', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    const query = exceptionsQuerySchema.parse(req.query);
    await assertWorkspaceAccess(workspaceId, req.auth!.userId);

    const items = await listWorkspaceExceptions({
      workspaceId,
      limit: query.limit,
      status: query.status,
      severity: query.severity,
    });

    res.json({
      servedAt: new Date().toISOString(),
      items,
    });
  } catch (error) {
    next(error);
  }
});

eventsRouter.get('/workspaces/:workspaceId/exceptions/:exceptionId', async (req, res, next) => {
  try {
    const { workspaceId, exceptionId } = exceptionParamsSchema.parse(req.params);
    await assertWorkspaceAccess(workspaceId, req.auth!.userId);
    const detail = await getExceptionDetail(workspaceId, exceptionId);
    res.json(detail);
  } catch (error) {
    next(error);
  }
});

eventsRouter.post('/workspaces/:workspaceId/exceptions/:exceptionId/actions', async (req, res, next) => {
  try {
    const { workspaceId, exceptionId } = exceptionParamsSchema.parse(req.params);
    await assertWorkspaceAccess(workspaceId, req.auth!.userId);
    const input = exceptionActionSchema.parse(req.body);

    const updated = await applyExceptionAction({
      workspaceId,
      exceptionId,
      action: input.action,
      actorUserId: req.auth!.userId,
      note: input.note,
    });

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

eventsRouter.post('/workspaces/:workspaceId/exceptions/:exceptionId/notes', async (req, res, next) => {
  try {
    const { workspaceId, exceptionId } = exceptionParamsSchema.parse(req.params);
    await assertWorkspaceAccess(workspaceId, req.auth!.userId);
    const input = exceptionNoteSchema.parse(req.body);

    const note = await addExceptionNote({
      workspaceId,
      exceptionId,
      actorUserId: req.auth!.userId,
      body: input.body,
    });

    res.status(201).json(note);
  } catch (error) {
    next(error);
  }
});

function safeJsonParse(value: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function uniqueValues(values: string[]) {
  return [...new Set(values)];
}

function escapeClickHouseString(value: string) {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}
