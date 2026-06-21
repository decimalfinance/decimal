import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { ApiError } from '../infra/api-errors.js';
import { prisma } from '../infra/prisma.js';
import { asyncRoute, sendJson, sendList } from '../infra/route-helpers.js';
import { assertOrganizationAccess, assertOrganizationAdmin } from '../auth/organization-access.js';
import { QuickBooks } from '../accounting/quickbooks.js';
import { disconnect, getConnection, getQuickBooksForOrg, saveConnection } from '../accounting/connections.js';
import { resetSyncForRetry, syncSettledPaymentOrder, syncAllCodedForOrg } from '../accounting/account-sync.js';
import { predictGlCandidates, getCodingInbox, setPaymentOrderGlCoding } from '../accounting/gl-coding.js';
import { ensureDefaultAccountingSetup } from '../accounting/setup.js';
import { logger } from '../infra/logger.js';

const PROVIDER = 'quickbooks';

const orgParams = z.object({ organizationId: z.string().uuid() });
const orgPaymentParams = orgParams.extend({ paymentOrderId: z.string().uuid() });

const accountMapSchema = z.object({
  apAccountId: z.string().nullish(),
  apAccountName: z.string().nullish(),
  clearingAccountId: z.string().min(1),
  clearingAccountName: z.string().nullish(),
  defaultExpenseAccountId: z.string().min(1),
  defaultExpenseAccountName: z.string().nullish(),
});

// ---- signed OAuth state (carries the orgId across the Intuit redirect) ----

function requireStateSecret(): string {
  if (!config.oauthStateSecret) {
    throw new ApiError(501, 'oauth_state_not_configured', 'OAuth state signing is not configured.');
  }
  return config.oauthStateSecret;
}

interface OAuthState {
  organizationId: string;
  frontendOrigin: string | null;
}

// Only redirect back to an origin we trust (an allowed CORS origin, or a
// localhost dev origin outside production) — never an arbitrary URL.
function safeFrontendOrigin(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    const origin = new URL(raw).origin;
    if (config.corsOrigins.includes(origin)) return origin;
    if (!config.isProduction && /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return origin;
    return null;
  } catch {
    return null;
  }
}

function signState(organizationId: string, frontendOrigin: string | null): string {
  const secret = requireStateSecret();
  const payload = Buffer.from(
    JSON.stringify({ organizationId, frontendOrigin, n: crypto.randomBytes(8).toString('hex') }),
    'utf8',
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest();
  return `${payload}.${sig.toString('base64url')}`;
}

function verifyState(raw: string): OAuthState {
  const secret = requireStateSecret();
  const [payload, sig] = (raw ?? '').split('.');
  if (!payload || !sig) {
    throw new ApiError(400, 'invalid_oauth_state', 'OAuth state is invalid.');
  }
  const expected = crypto.createHmac('sha256', secret).update(payload).digest();
  const actual = Buffer.from(sig, 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new ApiError(400, 'invalid_oauth_state', 'OAuth state signature is invalid.');
  }
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (typeof decoded?.organizationId !== 'string') {
    throw new ApiError(400, 'invalid_oauth_state', 'OAuth state payload is invalid.');
  }
  return {
    organizationId: decoded.organizationId,
    frontendOrigin: typeof decoded.frontendOrigin === 'string' ? decoded.frontendOrigin : null,
  };
}

function finishCallback(
  res: import('express').Response,
  status: string,
  ctx: { organizationId?: string; frontendOrigin?: string | null },
  detail?: string,
) {
  const base = ctx.frontendOrigin || config.publicFrontendUrl;
  // Land the operator back on the Accounting page on success.
  if (base && ctx.organizationId && status === 'connected') {
    res.redirect(`${base}/organizations/${ctx.organizationId}/accounting?quickbooks=connected`);
    return;
  }
  if (base) {
    const url = new URL(base);
    url.searchParams.set('quickbooks', status);
    if (detail) url.searchParams.set('detail', detail);
    res.redirect(url.toString());
    return;
  }
  res
    .status(status === 'connected' ? 200 : 400)
    .type('html')
    .send(`<p>QuickBooks ${status}${detail ? `: ${detail}` : ''}. You can close this tab.</p>`);
}

// ---- public callback (Intuit redirects here; no auth header) ----

export const publicAccountingRouter = Router();

publicAccountingRouter.get(
  '/accounting/quickbooks/callback',
  asyncRoute(async (req, res) => {
    const rawState = String(req.query.state ?? '');
    // Recover the redirect target (org + frontend origin) from state, even on
    // error, so we bounce back to the right place.
    let state: OAuthState | null = null;
    if (rawState) {
      try {
        state = verifyState(rawState);
      } catch {
        state = null;
      }
    }
    const ctx = { organizationId: state?.organizationId, frontendOrigin: state?.frontendOrigin ?? null };

    if (req.query.error) {
      finishCallback(res, 'error', ctx, String(req.query.error));
      return;
    }
    const code = String(req.query.code ?? '');
    const realmId = String(req.query.realmId ?? '');
    if (!code || !realmId || !state) {
      finishCallback(res, 'error', ctx, 'missing_parameters');
      return;
    }
    const tokens = await QuickBooks.exchangeCode(code, realmId);
    await saveConnection(state.organizationId, tokens);
    // Provision sensible defaults (clearing + expense accounts, mapped) so the
    // operator lands on a ready page. Best-effort: never block the connection.
    await ensureDefaultAccountingSetup(state.organizationId).catch((e) =>
      logger.warn('accounting_setup.failed', {
        organizationId: state.organizationId,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    finishCallback(res, 'connected', ctx);
  }),
);

// ---- authed routes ----

export const accountingRouter = Router();

// Start the connect flow — returns the Intuit authorize URL for the browser.
accountingRouter.get(
  '/organizations/:organizationId/accounting/quickbooks/connect',
  asyncRoute(async (req, res) => {
    const { organizationId } = orgParams.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!);
    if (!config.quickbooksClientId) {
      throw new ApiError(501, 'quickbooks_not_configured', 'QuickBooks is not configured.');
    }
    const frontendOrigin = safeFrontendOrigin(
      typeof req.query.frontendOrigin === 'string' ? req.query.frontendOrigin : req.get('origin'),
    );
    sendJson(res, { authorizeUrl: QuickBooks.authorizeUrl(signState(organizationId, frontendOrigin)) });
  }),
);

// Connection + mapping status.
accountingRouter.get(
  '/organizations/:organizationId/accounting/quickbooks/status',
  asyncRoute(async (req, res) => {
    const { organizationId } = orgParams.parse(req.params);
    await assertOrganizationAccess(organizationId, req.auth!);
    const conn = await getConnection(organizationId);
    const map = await prisma.accountingAccountMap.findUnique({
      where: { organizationId_provider: { organizationId, provider: PROVIDER } },
    });
    const counts = await prisma.accountingSync.groupBy({
      by: ['status'],
      where: { organizationId, provider: PROVIDER },
      _count: { _all: true },
    });
    const syncCounts = { synced: 0, pending: 0, error: 0 };
    for (const c of counts) {
      if (c.status in syncCounts) {
        syncCounts[c.status as keyof typeof syncCounts] = c._count._all;
      }
    }
    sendJson(res, {
      connected: Boolean(conn && conn.status === 'connected'),
      needsReauth: conn?.status === 'needs_reauth',
      syncCounts,
      status: conn?.status ?? 'disconnected',
      realmId: conn?.realmId ?? null,
      environment: conn?.environment ?? config.quickbooksEnvironment,
      accountMap: map
        ? {
            apAccountId: map.apAccountId,
            apAccountName: map.apAccountName,
            clearingAccountId: map.clearingAccountId,
            clearingAccountName: map.clearingAccountName,
            defaultExpenseAccountId: map.defaultExpenseAccountId,
            defaultExpenseAccountName: map.defaultExpenseAccountName,
          }
        : null,
      mappingComplete: Boolean(map?.clearingAccountId && map?.defaultExpenseAccountId),
    });
  }),
);

// Disconnect.
accountingRouter.delete(
  '/organizations/:organizationId/accounting/quickbooks',
  asyncRoute(async (req, res) => {
    const { organizationId } = orgParams.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!);
    await disconnect(organizationId);
    res.status(204).end();
  }),
);

// Pull the chart of accounts (for the mapping UI).
accountingRouter.get(
  '/organizations/:organizationId/accounting/quickbooks/accounts',
  asyncRoute(async (req, res) => {
    const { organizationId } = orgParams.parse(req.params);
    await assertOrganizationAccess(organizationId, req.auth!);
    const qb = await getQuickBooksForOrg(organizationId);
    if (!qb) {
      throw new ApiError(409, 'quickbooks_not_connected', 'QuickBooks is not connected.');
    }
    const resp = await qb.query('SELECT * FROM Account WHERE Active = true MAXRESULTS 1000');
    const accounts = (resp.QueryResponse?.Account ?? []).map((a: any) => ({
      id: a.Id,
      name: a.Name,
      accountType: a.AccountType,
      classification: a.Classification,
    }));
    sendList(res, accounts);
  }),
);

// Save the account map.
accountingRouter.patch(
  '/organizations/:organizationId/accounting/quickbooks/account-map',
  asyncRoute(async (req, res) => {
    const { organizationId } = orgParams.parse(req.params);
    await assertOrganizationAdmin(organizationId, req.auth!);
    const input = accountMapSchema.parse(req.body);
    const data = { provider: PROVIDER, ...input };
    await prisma.accountingAccountMap.upsert({
      where: { organizationId_provider: { organizationId, provider: PROVIDER } },
      create: { organizationId, ...data },
      update: data,
    });
    sendJson(res, { ok: true });
  }),
);

// Failed syncs that need attention — drives the Accounting page error list.
accountingRouter.get(
  '/organizations/:organizationId/accounting/quickbooks/failed-syncs',
  asyncRoute(async (req, res) => {
    const { organizationId } = orgParams.parse(req.params);
    await assertOrganizationAccess(organizationId, req.auth!);
    const rows = await prisma.accountingSync.findMany({
      where: { organizationId, provider: PROVIDER, status: 'error' },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      include: {
        paymentOrder: {
          select: {
            paymentOrderId: true,
            amountRaw: true,
            invoiceNumber: true,
            counterparty: { select: { displayName: true } },
            counterpartyWallet: { select: { label: true } },
          },
        },
      },
    });
    sendList(
      res,
      rows.map((r) => ({
        paymentOrderId: r.paymentOrderId,
        vendor: r.paymentOrder.counterparty?.displayName ?? r.paymentOrder.counterpartyWallet.label,
        amountRaw: r.paymentOrder.amountRaw.toString(),
        invoiceNumber: r.paymentOrder.invoiceNumber,
        error: r.error,
        attempts: r.attempts,
      })),
    );
  }),
);

// Sync history — settled payments Decimal has posted to QuickBooks (newest first).
accountingRouter.get(
  '/organizations/:organizationId/accounting/quickbooks/synced',
  asyncRoute(async (req, res) => {
    const { organizationId } = orgParams.parse(req.params);
    await assertOrganizationAccess(organizationId, req.auth!);
    const rows = await prisma.accountingSync.findMany({
      where: { organizationId, provider: PROVIDER, status: 'synced' },
      orderBy: { syncedAt: 'desc' },
      take: 100,
      include: {
        paymentOrder: {
          select: {
            paymentOrderId: true,
            amountRaw: true,
            invoiceNumber: true,
            counterparty: { select: { displayName: true } },
            counterpartyWallet: { select: { label: true } },
            glCoding: { select: { codedExpenseAccountName: true, lines: true } },
          },
        },
      },
    });
    sendList(
      res,
      rows.map((r) => {
        const lines = Array.isArray(r.paymentOrder.glCoding?.lines)
          ? (r.paymentOrder.glCoding!.lines as Array<{ accountName?: string | null }>)
          : [];
        const account =
          lines.length > 1 ? `${lines.length} lines` : r.paymentOrder.glCoding?.codedExpenseAccountName ?? lines[0]?.accountName ?? null;
        return {
          paymentOrderId: r.paymentOrderId,
          vendor: r.paymentOrder.counterparty?.displayName ?? r.paymentOrder.counterpartyWallet.label,
          amountRaw: r.paymentOrder.amountRaw.toString(),
          invoiceNumber: r.paymentOrder.invoiceNumber,
          account,
          billId: r.externalBillId,
          syncedAt: r.syncedAt,
        };
      }),
    );
  }),
);

// Manually sync one settled payment order (the agent does this automatically).
// Doubles as the retry action — resets a maxed-out attempt counter first.
accountingRouter.post(
  '/organizations/:organizationId/payment-orders/:paymentOrderId/accounting/sync',
  asyncRoute(async (req, res) => {
    const { organizationId, paymentOrderId } = orgPaymentParams.parse(req.params);
    await assertOrganizationAccess(organizationId, req.auth!);
    const order = await prisma.paymentOrder.findFirst({
      where: { paymentOrderId, organizationId },
      select: { paymentOrderId: true },
    });
    if (!order) {
      throw new ApiError(404, 'payment_order_not_found', 'Payment order not found.');
    }
    await resetSyncForRetry(paymentOrderId);
    const outcome = await syncSettledPaymentOrder(paymentOrderId);
    sendJson(res, { outcome });
  }),
);

const setGlCodingSchema = z
  .object({
    lines: z
      .array(
        z.object({
          accountId: z.string().min(1),
          accountName: z.string().nullish(),
          amount: z.number(),
          description: z.string().nullish(),
        }),
      )
      .optional(),
    codedExpenseAccountId: z.string().min(1).optional(),
    codedExpenseAccountName: z.string().nullish(),
    predictedAccountId: z.string().nullish(),
    predictedAccountName: z.string().nullish(),
    predictionSource: z.string().nullish(),
    confidenceScore: z.number().nullish(),
    billHeader: z
      .object({
        vendorName: z.string().nullish(),
        invoiceNumber: z.string().nullish(),
        billDate: z.string().nullish(),
      })
      .optional(),
  })
  .refine((d) => (d.lines && d.lines.length > 0) || d.codedExpenseAccountId, {
    message: 'A coding needs at least one account.',
  });

// Up to 3 candidate expense accounts to offer for a payment (no pre-fill).
accountingRouter.get(
  '/organizations/:organizationId/payment-orders/:paymentOrderId/gl-coding/candidates',
  asyncRoute(async (req, res) => {
    const { organizationId, paymentOrderId } = orgPaymentParams.parse(req.params);
    await assertOrganizationAccess(organizationId, req.auth!);
    const result = await predictGlCandidates(organizationId, paymentOrderId);
    sendJson(res, result);
  }),
);

// The coding inbox: settled payments not yet in QuickBooks, each with its candidates.
accountingRouter.get(
  '/organizations/:organizationId/accounting/quickbooks/coding-inbox',
  asyncRoute(async (req, res) => {
    const { organizationId } = orgParams.parse(req.params);
    await assertOrganizationAccess(organizationId, req.auth!);
    const items = await getCodingInbox(organizationId);
    sendList(res, items);
  }),
);

// Sync every coded payment for the org at once (the "Sync coded" button).
accountingRouter.post(
  '/organizations/:organizationId/accounting/quickbooks/sync-coded',
  asyncRoute(async (req, res) => {
    const { organizationId } = orgParams.parse(req.params);
    await assertOrganizationAccess(organizationId, req.auth!);
    const summary = await syncAllCodedForOrg(organizationId);
    sendJson(res, summary);
  }),
);

// Set (or change) the GL expense account a payment will post to. The sync reads this.
accountingRouter.post(
  '/organizations/:organizationId/payment-orders/:paymentOrderId/gl-coding',
  asyncRoute(async (req, res) => {
    const { organizationId, paymentOrderId } = orgPaymentParams.parse(req.params);
    await assertOrganizationAccess(organizationId, req.auth!);
    const order = await prisma.paymentOrder.findFirst({ where: { paymentOrderId, organizationId }, select: { paymentOrderId: true } });
    if (!order) {
      throw new ApiError(404, 'payment_order_not_found', 'Payment order not found.');
    }
    const input = setGlCodingSchema.parse(req.body);
    const coding = await setPaymentOrderGlCoding(organizationId, paymentOrderId, input, req.auth!.userId ?? null);
    sendJson(res, {
      codedExpenseAccountId: coding.codedExpenseAccountId,
      codedExpenseAccountName: coding.codedExpenseAccountName,
      predictionSource: coding.predictionSource,
      confidenceScore: coding.confidenceScore ? Number(coding.confidenceScore) : null,
      wasOverridden: coding.wasOverridden,
    });
  }),
);
