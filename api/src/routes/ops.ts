import { Router, type Response } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { queryClickHouse } from '../clickhouse.js';
import { config } from '../config.js';
import {
  getReconciliationDetail,
  listReconciliationQueue,
  listWorkspaceExceptions,
} from '../reconciliation.js';
import { prisma } from '../prisma.js';
import { assertWorkspaceAccess } from '../workspace-access.js';
import { listWorkspaceAuditLog } from '../workspace-audit-log.js';
import { listRouteMetrics, listWorkerStageMetrics } from '../ops-metrics.js';

export const opsRouter = Router();

const workspaceParamsSchema = z.object({
  workspaceId: z.string().uuid(),
});

const auditParamsSchema = workspaceParamsSchema.extend({
  transferRequestId: z.string().uuid(),
});

const exportQuerySchema = z.object({
  format: z.enum(['csv', 'json']).default('csv'),
  displayState: z.enum(['pending', 'matched', 'partial', 'exception']).optional(),
  requestStatus: z.string().optional(),
  status: z.enum(['open', 'reviewed', 'expected', 'dismissed', 'reopened']).optional(),
  severity: z.string().optional(),
  assigneeUserId: z.string().uuid().optional(),
  reasonCode: z.string().optional(),
});

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const auditLogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(250).default(100),
  entityType: z.enum(['payment_order', 'transfer_request', 'approval', 'execution', 'exception', 'export']).optional(),
});

type TxHealthRow = {
  observed_count: string | number;
  latest_slot: string | number | null;
  latest_event_time: string | null;
  latest_worker_received_at: string | null;
  latest_tx_write_at: string | null;
  p50_yellowstone_to_worker_ms: string | number | null;
  p95_yellowstone_to_worker_ms: string | number | null;
  p50_event_to_write_ms: string | number | null;
  p95_event_to_write_ms: string | number | null;
};

type MatchHealthRow = {
  match_count: string | number;
  latest_match_at: string | null;
  p50_chain_to_match_ms: string | number | null;
  p95_chain_to_match_ms: string | number | null;
};

opsRouter.get('/workspaces/:workspaceId/members', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    const access = await assertWorkspaceAccess(workspaceId, req.auth!);

    const items = await prisma.organizationMembership.findMany({
      where: {
        organizationId: access.workspace.organizationId,
        status: 'active',
      },
      include: {
        user: {
          select: {
            userId: true,
            email: true,
            displayName: true,
          },
        },
      },
      orderBy: [
        { role: 'asc' },
        { createdAt: 'asc' },
      ],
    });

    res.json({
      items: items.map((membership) => ({
        membershipId: membership.membershipId,
        role: membership.role,
        status: membership.status,
        user: membership.user,
      })),
    });
  } catch (error) {
    next(error);
  }
});

opsRouter.get('/workspaces/:workspaceId/export-jobs', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    const { limit } = historyQuerySchema.parse(req.query);
    await assertWorkspaceAccess(workspaceId, req.auth!);

    const items = await prisma.exportJob.findMany({
      where: { workspaceId },
      include: {
        requestedByUser: {
          select: {
            userId: true,
            email: true,
            displayName: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    res.json({
      items: items.map((item) => ({
        exportJobId: item.exportJobId,
        workspaceId: item.workspaceId,
        requestedByUserId: item.requestedByUserId,
        exportKind: item.exportKind,
        format: item.format,
        status: item.status,
        rowCount: item.rowCount,
        filterJson: item.filterJson,
        createdAt: item.createdAt,
        completedAt: item.completedAt,
        requestedByUser: item.requestedByUser,
      })),
    });
  } catch (error) {
    next(error);
  }
});

opsRouter.get('/workspaces/:workspaceId/audit-log', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    const query = auditLogQuerySchema.parse(req.query);
    await assertWorkspaceAccess(workspaceId, req.auth!);

    res.json(await listWorkspaceAuditLog({
      workspaceId,
      limit: query.limit,
      entityType: query.entityType,
    }));
  } catch (error) {
    next(error);
  }
});

opsRouter.get('/workspaces/:workspaceId/exports/reconciliation', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    const query = exportQuerySchema.parse(req.query);
    await assertWorkspaceAccess(workspaceId, req.auth!);

    const items = await listReconciliationQueue(workspaceId, {
      limit: 5000,
      displayState: query.displayState,
      requestStatus: query.requestStatus,
    });

    const rows = items.map((item) => ({
      transfer_request_id: item.transferRequestId,
      source_wallet: item.sourceWorkspaceAddress?.displayName ?? item.sourceWorkspaceAddress?.address ?? '',
      destination: item.destination?.label ?? item.destinationWorkspaceAddress?.displayName ?? item.destinationWorkspaceAddress?.address ?? '',
      counterparty: item.destination?.counterparty?.displayName ?? '',
      amount_raw: item.amountRaw,
      amount_usdc: formatRawUsdc(item.amountRaw),
      request_status: item.status,
      approval_state: item.approvalState,
      execution_state: item.executionState,
      settlement_state: item.requestDisplayState,
      linked_signature: item.linkedSignature ?? '',
      match_status: item.match?.matchStatus ?? '',
      exception_reason_codes: item.exceptions.map((exception) => exception.reasonCode).join('|'),
      requested_at: item.requestedAt,
    }));

    await recordExportJob({
      workspaceId,
      requestedByUserId: req.auth!.userId,
      exportKind: 'reconciliation',
      format: query.format,
      rowCount: rows.length,
      filterJson: {
        displayState: query.displayState ?? null,
        requestStatus: query.requestStatus ?? null,
      },
    });

    respondWithExport(res, {
      format: query.format,
      fileName: 'reconciliation-export',
      items: rows,
    });
  } catch (error) {
    next(error);
  }
});

opsRouter.get('/workspaces/:workspaceId/exports/exceptions', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    const query = exportQuerySchema.parse(req.query);
    await assertWorkspaceAccess(workspaceId, req.auth!);

    const items = await listWorkspaceExceptions({
      workspaceId,
      limit: 5000,
      status: query.status,
      severity: query.severity,
      assigneeUserId: query.assigneeUserId,
      reasonCode: query.reasonCode,
    });

    const rows = items.map((item) => ({
      exception_id: item.exceptionId,
      transfer_request_id: item.transferRequestId ?? '',
      reason_code: item.reasonCode,
      severity: item.severity,
      status: item.status,
      resolution_code: item.resolutionCode ?? '',
      assignee_email: item.assignedToUser?.email ?? '',
      assignee_name: item.assignedToUser?.displayName ?? '',
      signature: item.signature ?? '',
      observed_transfer_id: item.observedTransferId ?? '',
      explanation: item.explanation,
      observed_event_time: item.observedEventTime ?? '',
      updated_at: item.updatedAt,
    }));

    await recordExportJob({
      workspaceId,
      requestedByUserId: req.auth!.userId,
      exportKind: 'exceptions',
      format: query.format,
      rowCount: rows.length,
      filterJson: {
        status: query.status ?? null,
        severity: query.severity ?? null,
        assigneeUserId: query.assigneeUserId ?? null,
        reasonCode: query.reasonCode ?? null,
      },
    });

    respondWithExport(res, {
      format: query.format,
      fileName: 'exceptions-export',
      items: rows,
    });
  } catch (error) {
    next(error);
  }
});

opsRouter.get('/workspaces/:workspaceId/exports/audit/:transferRequestId', async (req, res, next) => {
  try {
    const { workspaceId, transferRequestId } = auditParamsSchema.parse(req.params);
    const query = exportQuerySchema.parse(req.query);
    await assertWorkspaceAccess(workspaceId, req.auth!);

    const detail = await getReconciliationDetail(workspaceId, transferRequestId);
    const rows = detail.timeline.map((item) => ({
      created_at: item.createdAt,
      timeline_type: item.timelineType,
      title: getTimelineExportTitle(item),
      body: getTimelineExportBody(item),
      linked_signature:
        'linkedSignature' in item && item.linkedSignature
          ? item.linkedSignature
          : '',
    }));

    await recordExportJob({
      workspaceId,
      requestedByUserId: req.auth!.userId,
      exportKind: 'audit',
      format: query.format,
      rowCount: rows.length,
      filterJson: {
        transferRequestId,
      },
    });

    respondWithExport(res, {
      format: query.format,
      fileName: `audit-${transferRequestId}`,
      items: rows,
    });
  } catch (error) {
    next(error);
  }
});

opsRouter.get('/workspaces/:workspaceId/ops-health', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    await assertWorkspaceAccess(workspaceId, req.auth!);

    await prisma.$queryRaw`SELECT 1`;

    const [txRows, matchRows, exceptionRows] = await Promise.all([
      queryClickHouse<TxHealthRow>(`
        WITH recent AS (
          SELECT slot, event_time, worker_received_at, yellowstone_created_at, created_at
          FROM ${config.clickhouseDatabase}.observed_transactions
          ORDER BY created_at DESC
          LIMIT 200
        )
        SELECT
          count() AS observed_count,
          max(slot) AS latest_slot,
          max(event_time) AS latest_event_time,
          max(worker_received_at) AS latest_worker_received_at,
          max(created_at) AS latest_tx_write_at,
          quantileTDigestIf(0.5)(
            dateDiff('millisecond', yellowstone_created_at, worker_received_at),
            NOT isNull(yellowstone_created_at) AND NOT isNull(worker_received_at)
          ) AS p50_yellowstone_to_worker_ms,
          quantileTDigestIf(0.95)(
            dateDiff('millisecond', yellowstone_created_at, worker_received_at),
            NOT isNull(yellowstone_created_at) AND NOT isNull(worker_received_at)
          ) AS p95_yellowstone_to_worker_ms,
          quantileTDigestIf(0.5)(
            dateDiff('millisecond', event_time, created_at),
            NOT isNull(event_time) AND NOT isNull(created_at)
          ) AS p50_event_to_write_ms,
          quantileTDigestIf(0.95)(
            dateDiff('millisecond', event_time, created_at),
            NOT isNull(event_time) AND NOT isNull(created_at)
          ) AS p95_event_to_write_ms
        FROM recent
        FORMAT JSONEachRow
      `),
      queryClickHouse<MatchHealthRow>(`
        WITH recent AS (
          SELECT observed_event_time, matched_at, updated_at
          FROM ${config.clickhouseDatabase}.settlement_matches
          WHERE workspace_id = toUUID('${workspaceId}')
          ORDER BY updated_at DESC
          LIMIT 200
        )
        SELECT
          count() AS match_count,
          max(updated_at) AS latest_match_at,
          quantileTDigestIf(0.5)(
            dateDiff('millisecond', observed_event_time, matched_at),
            NOT isNull(observed_event_time) AND NOT isNull(matched_at)
          ) AS p50_chain_to_match_ms,
          quantileTDigestIf(0.95)(
            dateDiff('millisecond', observed_event_time, matched_at),
            NOT isNull(observed_event_time) AND NOT isNull(matched_at)
          ) AS p95_chain_to_match_ms
        FROM recent
        FORMAT JSONEachRow
      `),
      listWorkspaceExceptions({ workspaceId, limit: 5000 }),
    ]);

    const tx = txRows[0] ?? null;
    const match = matchRows[0] ?? null;
    const latestWorkerReceivedAt = normalizeClickHouseDateTime(tx?.latest_worker_received_at ?? null);
    const workerFreshnessMs = latestWorkerReceivedAt
      ? Date.now() - new Date(latestWorkerReceivedAt).getTime()
      : null;

    res.json({
      postgres: 'ok',
      workerStatus: deriveWorkerStatus(workerFreshnessMs),
      latestSlot: tx?.latest_slot === null || tx?.latest_slot === undefined ? null : Number(tx.latest_slot),
      latestEventTime: normalizeClickHouseDateTime(tx?.latest_event_time ?? null),
      latestWorkerReceivedAt,
      latestTxWriteAt: normalizeClickHouseDateTime(tx?.latest_tx_write_at ?? null),
      latestMatchAt: normalizeClickHouseDateTime(match?.latest_match_at ?? null),
      workerFreshnessMs,
      observedTransactionCount: Number(tx?.observed_count ?? 0),
      matchCount: Number(match?.match_count ?? 0),
      openExceptionCount: exceptionRows.filter((item) => item.status !== 'dismissed').length,
      routeErrors: listRouteMetrics().filter((metric) => metric.statusClass.startsWith('5')),
      workerStageErrors: listWorkerStageMetrics().filter((metric) => metric.status === 'error'),
      latencies: {
        yellowstoneToWorkerMs: {
          p50: numberOrNull(tx?.p50_yellowstone_to_worker_ms),
          p95: numberOrNull(tx?.p95_yellowstone_to_worker_ms),
        },
        chainToWriteMs: {
          p50: numberOrNull(tx?.p50_event_to_write_ms),
          p95: numberOrNull(tx?.p95_event_to_write_ms),
        },
        chainToMatchMs: {
          p50: numberOrNull(match?.p50_chain_to_match_ms),
          p95: numberOrNull(match?.p95_chain_to_match_ms),
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

function respondWithExport(
  res: Response,
  args: {
    format: 'csv' | 'json';
    fileName: string;
    items: Record<string, unknown>[];
  },
) {
  if (args.format === 'json') {
    res.json({ items: args.items });
    return;
  }

  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="${args.fileName}.csv"`);
  res.send(toCsv(args.items));
}

async function recordExportJob(args: {
  workspaceId: string;
  requestedByUserId: string;
  exportKind: string;
  format: 'csv' | 'json';
  rowCount: number;
  filterJson: Record<string, unknown>;
}) {
  await prisma.exportJob.create({
    data: {
      workspaceId: args.workspaceId,
      requestedByUserId: args.requestedByUserId,
      exportKind: args.exportKind,
      format: args.format,
      rowCount: args.rowCount,
      filterJson: args.filterJson as Prisma.InputJsonValue,
      completedAt: new Date(),
    },
  });
}

function toCsv(items: Record<string, unknown>[]) {
  if (!items.length) {
    return '';
  }

  const columns = [...new Set(items.flatMap((item) => Object.keys(item)))];
  const lines = [
    columns.join(','),
    ...items.map((item) => columns.map((column) => escapeCsv(item[column])).join(',')),
  ];

  return lines.join('\n');
}

function escapeCsv(value: unknown) {
  const stringValue = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replaceAll('"', '""')}"`;
  }
  return stringValue;
}

function normalizeClickHouseDateTime(value: string | null) {
  return value ? `${value.replace(' ', 'T')}Z` : null;
}

function numberOrNull(value: string | number | null | undefined) {
  return value === null || value === undefined ? null : Number(value);
}

function deriveWorkerStatus(workerFreshnessMs: number | null) {
  if (workerFreshnessMs === null) {
    return 'offline';
  }
  if (workerFreshnessMs < 30_000) {
    return 'healthy';
  }
  if (workerFreshnessMs < 120_000) {
    return 'degraded';
  }
  return 'stale';
}

function formatRawUsdc(amountRaw: string) {
  const negative = amountRaw.startsWith('-');
  const digits = negative ? amountRaw.slice(1) : amountRaw;
  const padded = digits.padStart(7, '0');
  const whole = padded.slice(0, -6) || '0';
  const fraction = padded.slice(-6);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

function getTimelineExportTitle(
  item: Awaited<ReturnType<typeof getReconciliationDetail>>['timeline'][number],
) {
  switch (item.timelineType) {
    case 'request_event':
      return item.eventType;
    case 'request_note':
      return 'request_note';
    case 'approval_decision':
      return item.action;
    case 'execution_record':
      return item.state;
    case 'observed_execution':
      return 'observed_execution';
    case 'match_result':
      return item.matchStatus;
    case 'exception':
      return item.reasonCode;
  }
}

function getTimelineExportBody(
  item: Awaited<ReturnType<typeof getReconciliationDetail>>['timeline'][number],
) {
  switch (item.timelineType) {
    case 'request_event':
      return item.beforeState && item.afterState ? `${item.beforeState} -> ${item.afterState}` : item.eventSource;
    case 'request_note':
      return item.body;
    case 'approval_decision':
      return item.comment ?? item.action;
    case 'execution_record':
      return item.submittedSignature ?? item.executionSource;
    case 'observed_execution':
      return `${item.signature} // ${item.status}`;
    case 'match_result':
      return item.explanation;
    case 'exception':
      return item.explanation;
  }
}
