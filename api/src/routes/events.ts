import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { queryClickHouse } from '../clickhouse.js';
import { config } from '../config.js';
import { assertWorkspaceAccess } from '../workspace-access.js';

export const eventsRouter = Router();

const workspaceParamsSchema = z.object({
  workspaceId: z.string().uuid(),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const exceptionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  status: z.string().optional(),
  severity: z.string().optional(),
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

type SettlementMatchRow = {
  transfer_request_id: string;
  signature: string | null;
  observed_transfer_id: string | null;
  match_status: string;
  confidence_score: number | string;
  confidence_band: string;
  matched_amount_raw: string;
  amount_variance_raw: string;
  destination_match_type: string;
  time_delta_seconds: string | number;
  match_rule: string;
  candidate_count: number | string;
  explanation: string;
  observed_event_time: string | null;
  matched_at: string | null;
  updated_at: string;
  chain_to_match_ms: string | number | null;
};

type ExceptionRow = {
  exception_id: string;
  transfer_request_id: string | null;
  signature: string | null;
  observed_transfer_id: string | null;
  exception_type: string;
  severity: string;
  status: string;
  explanation: string;
  properties_json: string | null;
  observed_event_time: string | null;
  processed_at: string | null;
  created_at: string;
  updated_at: string;
  chain_to_process_ms: string | number | null;
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
        eventTime: row.event_time,
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
        createdAt: row.created_at,
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
    const query = listQuerySchema.parse(req.query);
    await assertWorkspaceAccess(workspaceId, req.auth!.userId);

    const [transferRequests, matches, exceptions] = await Promise.all([
      prisma.transferRequest.findMany({
        where: {
          workspaceId,
          asset: 'usdc',
        },
        include: {
          destinationWorkspaceAddress: true,
          sourceWorkspaceAddress: true,
          requestedByUser: true,
        },
        orderBy: { requestedAt: 'desc' },
        take: query.limit,
      }),
      queryClickHouse<SettlementMatchRow>(`
        SELECT
          transfer_request_id,
          signature,
          observed_transfer_id,
          match_status,
          confidence_score,
          confidence_band,
          matched_amount_raw,
          amount_variance_raw,
          destination_match_type,
          time_delta_seconds,
          match_rule,
          candidate_count,
          explanation,
          observed_event_time,
          matched_at,
          if(isNull(observed_event_time) OR isNull(matched_at), NULL, dateDiff('millisecond', observed_event_time, matched_at)) AS chain_to_match_ms,
          updated_at
        FROM ${config.clickhouseDatabase}.settlement_matches FINAL
        WHERE workspace_id = toUUID('${workspaceId}')
        FORMAT JSONEachRow
      `),
      queryClickHouse<ExceptionRow>(`
        SELECT
          exception_id,
          transfer_request_id,
          signature,
          observed_transfer_id,
          exception_type,
          severity,
          status,
          explanation,
          properties_json,
          observed_event_time,
          processed_at,
          if(isNull(observed_event_time) OR isNull(processed_at), NULL, dateDiff('millisecond', observed_event_time, processed_at)) AS chain_to_process_ms,
          created_at,
          updated_at
        FROM ${config.clickhouseDatabase}.exceptions FINAL
        WHERE workspace_id = toUUID('${workspaceId}')
        FORMAT JSONEachRow
      `),
    ]);

    const matchesByRequestId = new Map(matches.map((row) => [row.transfer_request_id, row] as const));
    const exceptionsByRequestId = new Map<string, ExceptionRow[]>();

    for (const exception of exceptions) {
      if (!exception.transfer_request_id) continue;
      const bucket = exceptionsByRequestId.get(exception.transfer_request_id) ?? [];
      bucket.push(exception);
      exceptionsByRequestId.set(exception.transfer_request_id, bucket);
    }

    const nowMs = Date.now();
    const windowMs = 24 * 60 * 60 * 1000;

    res.json({
      servedAt: new Date().toISOString(),
      items: transferRequests.map((request) => {
        const bestMatch = matchesByRequestId.get(request.transferRequestId) ?? null;
        const requestExceptions = exceptionsByRequestId.get(request.transferRequestId) ?? [];
        const derivedStatus = bestMatch
          ? bestMatch.match_status
          : nowMs - request.requestedAt.getTime() > windowMs
            ? 'unmatched_expired'
            : 'unmatched_pending';

        return {
          transferRequestId: request.transferRequestId,
          workspaceId: request.workspaceId,
          sourceWorkspaceAddressId: request.sourceWorkspaceAddressId,
          destinationWorkspaceAddressId: request.destinationWorkspaceAddressId,
          requestType: request.requestType,
          asset: request.asset,
          amountRaw: request.amountRaw.toString(),
          status: request.status,
          requestedAt: request.requestedAt,
          dueAt: request.dueAt,
          reason: request.reason,
          externalReference: request.externalReference,
          requestedByUser: request.requestedByUser
            ? {
                userId: request.requestedByUser.userId,
                email: request.requestedByUser.email,
                displayName: request.requestedByUser.displayName,
              }
            : null,
          sourceWorkspaceAddress: request.sourceWorkspaceAddress
            ? serializeWorkspaceAddress(request.sourceWorkspaceAddress)
            : null,
          destinationWorkspaceAddress: request.destinationWorkspaceAddress
            ? serializeWorkspaceAddress(request.destinationWorkspaceAddress)
            : null,
          match: bestMatch
            ? {
                signature: bestMatch.signature,
                observedTransferId: bestMatch.observed_transfer_id,
                matchStatus: bestMatch.match_status,
                confidenceScore: Number(bestMatch.confidence_score),
                confidenceBand: bestMatch.confidence_band,
                matchedAmountRaw: bestMatch.matched_amount_raw,
                amountVarianceRaw: bestMatch.amount_variance_raw,
                destinationMatchType: bestMatch.destination_match_type,
                timeDeltaSeconds: Number(bestMatch.time_delta_seconds),
                matchRule: bestMatch.match_rule,
                candidateCount: Number(bestMatch.candidate_count),
                explanation: bestMatch.explanation,
                observedEventTime: bestMatch.observed_event_time,
                matchedAt: bestMatch.matched_at ?? bestMatch.updated_at,
                updatedAt: bestMatch.updated_at,
                chainToMatchMs:
                  bestMatch.chain_to_match_ms === null ? null : Number(bestMatch.chain_to_match_ms),
              }
            : null,
          reconciliationStatus: derivedStatus,
          exceptions: requestExceptions.map(serializeException),
        };
      }),
    });
  } catch (error) {
    next(error);
  }
});

eventsRouter.get('/workspaces/:workspaceId/exceptions', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    const query = exceptionsQuerySchema.parse(req.query);
    await assertWorkspaceAccess(workspaceId, req.auth!.userId);

    const clauses = [`workspace_id = toUUID('${workspaceId}')`];
    if (query.status) clauses.push(`status = '${escapeClickHouseString(query.status)}'`);
    if (query.severity) clauses.push(`severity = '${escapeClickHouseString(query.severity)}'`);

    const rows = await queryClickHouse<ExceptionRow>(`
      SELECT
        exception_id,
        transfer_request_id,
        signature,
        observed_transfer_id,
        exception_type,
        severity,
        status,
        explanation,
        properties_json,
        created_at,
        updated_at
      FROM ${config.clickhouseDatabase}.exceptions FINAL
      WHERE ${clauses.join(' AND ')}
      ORDER BY updated_at DESC
      LIMIT ${query.limit}
      FORMAT JSONEachRow
    `);

    res.json({
      servedAt: new Date().toISOString(),
      items: rows.map(serializeException),
    });
  } catch (error) {
    next(error);
  }
});

function serializeWorkspaceAddress(address: {
  workspaceAddressId: string;
  address: string;
  usdcAtaAddress: string | null;
  addressKind: string;
  displayName: string | null;
  notes: string | null;
}) {
  return {
    workspaceAddressId: address.workspaceAddressId,
    address: address.address,
    usdcAtaAddress: address.usdcAtaAddress,
    addressKind: address.addressKind,
    displayName: address.displayName,
    notes: address.notes,
  };
}

function serializeException(exception: ExceptionRow) {
  return {
    exceptionId: exception.exception_id,
    transferRequestId: exception.transfer_request_id,
    signature: exception.signature,
    observedTransferId: exception.observed_transfer_id,
    exceptionType: exception.exception_type,
    severity: exception.severity,
    status: exception.status,
    explanation: exception.explanation,
    propertiesJson: safeJsonParse(exception.properties_json),
    observedEventTime: exception.observed_event_time,
    processedAt: exception.processed_at ?? exception.updated_at,
    createdAt: exception.created_at,
    updatedAt: exception.updated_at,
    chainToProcessMs:
      exception.chain_to_process_ms === null ? null : Number(exception.chain_to_process_ms),
  };
}

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
