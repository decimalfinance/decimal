import { Router } from 'express';
import { z } from 'zod';
import { queryClickHouse } from '../clickhouse.js';
import { config } from '../config.js';
import { assertWorkspaceAccess } from '../workspace-access.js';

export const eventsRouter = Router();

const workspaceParamsSchema = z.object({
  workspaceId: z.string().uuid(),
});

const eventParamsSchema = workspaceParamsSchema.extend({
  workspaceEventId: z.string().uuid(),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  eventType: z.string().optional(),
  direction: z.string().optional(),
});

eventsRouter.get('/workspaces/:workspaceId/events', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    await assertWorkspaceAccess(workspaceId, req.auth!.userId);
    const query = listQuerySchema.parse(req.query);

    const clauses = [
      `workspace_id = toUUID('${workspaceId}')`,
    ];

    if (query.eventType) {
      clauses.push(`event_type = '${escapeClickHouseString(query.eventType)}'`);
    }

    if (query.direction) {
      clauses.push(`direction = '${escapeClickHouseString(query.direction)}'`);
    }

    const rows = await queryClickHouse(`
      SELECT
        workspace_event_id,
        canonical_event_id,
        slot,
        signature,
        event_time,
        asset,
        event_type,
        direction,
        amount_raw,
        amount_decimal,
        primary_object_id,
        primary_label,
        summary_text,
        confidence
      FROM ${config.clickhouseDatabase}.workspace_operational_events
      WHERE ${clauses.join(' AND ')}
      ORDER BY event_time DESC
      LIMIT ${query.limit}
      FORMAT JSONEachRow
    `);

    res.json({ items: rows });
  } catch (error) {
    next(error);
  }
});

eventsRouter.get('/workspaces/:workspaceId/reconciliation', async (req, res, next) => {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    await assertWorkspaceAccess(workspaceId, req.auth!.userId);
    const query = listQuerySchema.parse(req.query);

    const rows = await queryClickHouse(`
      SELECT
        reconciliation_row_id,
        workspace_event_id,
        event_time,
        asset,
        amount_raw,
        amount_decimal,
        direction,
        internal_object_key,
        counterparty_name,
        event_type,
        signature,
        token_account,
        notes,
        export_status
      FROM ${config.clickhouseDatabase}.workspace_reconciliation_rows
      WHERE workspace_id = toUUID('${workspaceId}')
      ORDER BY event_time DESC
      LIMIT ${query.limit}
      FORMAT JSONEachRow
    `);

    res.json({ items: rows });
  } catch (error) {
    next(error);
  }
});

eventsRouter.get('/workspaces/:workspaceId/events/:workspaceEventId/participants', async (req, res, next) => {
  try {
    const { workspaceId, workspaceEventId } = eventParamsSchema.parse(req.params);
    await assertWorkspaceAccess(workspaceId, req.auth!.userId);

    const rows = await queryClickHouse(`
      SELECT
        p.participant_id,
        p.role,
        p.address,
        p.workspace_address_id,
        p.workspace_object_id,
        p.direction,
        p.amount_raw,
        p.confidence,
        p.properties_json
      FROM ${config.clickhouseDatabase}.workspace_event_participants AS p
      INNER JOIN ${config.clickhouseDatabase}.workspace_operational_events AS e
        ON p.workspace_id = e.workspace_id
       AND p.canonical_event_id = e.canonical_event_id
      WHERE e.workspace_id = toUUID('${workspaceId}')
        AND e.workspace_event_id = toUUID('${workspaceEventId}')
      ORDER BY p.participant_id ASC
      FORMAT JSONEachRow
    `);

    res.json({ items: rows });
  } catch (error) {
    next(error);
  }
});

function escapeClickHouseString(value: string) {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}
