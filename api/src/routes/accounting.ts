import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { ApiError } from '../infra/api-errors.js';
import { prisma } from '../infra/prisma.js';
import { asyncRoute, sendJson, sendList } from '../infra/route-helpers.js';
import { assertOrganizationAccess, assertOrganizationAdmin } from '../auth/organization-access.js';
import { QuickBooks } from '../accounting/quickbooks.js';
import { disconnect, getConnection, getQuickBooksForOrg, saveConnection } from '../accounting/connections.js';
import { resetSyncForRetry, syncBillNow } from '../accounting/account-sync.js';
import { noteDisconnected, noteSignedIn, noteSignInFailed } from '../integrations/setup/service.js';
import { callbackRedirectUri, safeFrontendOrigin, signState, verifyState, type OAuthState } from '../accounting/oauth-state.js';

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

// ---- signed OAuth state (carries the orgId across the Intuit redirect): oauth-state.ts ----

const CALLBACK_PATH = '/accounting/quickbooks/callback';
const callbackUri = (req: import('express').Request) => callbackRedirectUri(req, CALLBACK_PATH, config.quickbooksRedirectUri);

function finishCallback(
  res: import('express').Response,
  status: string,
  ctx: { organizationId?: string; frontendOrigin?: string | null; setupScreen?: string | null },
  detail?: string,
) {
  const base = ctx.frontendOrigin || config.publicFrontendUrl;
  // Back to the setup the sign-in came from, while one is live: its conversation says how it went.
  if (base && ctx.setupScreen) {
    res.redirect(`${base}${ctx.setupScreen}`);
    return;
  }
  // Otherwise the Accounting page, on success.
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

/** The setup screen, while a setup is live for the organisation. */
async function setupScreenFor(organizationId: string): Promise<string | null> {
  const setup = await prisma.integrationSetup.findFirst({ where: { organizationId, system: PROVIDER }, select: { setupId: true } });
  return setup ? `/organizations/${organizationId}/integrations/${PROVIDER}` : null;
}

// ---- public callback (Intuit redirects here; no auth header) ----

export const publicAccountingRouter = Router();

publicAccountingRouter.get(
  CALLBACK_PATH,
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
    // Another system's sign-in is not this one's to finish.
    if (state && state.system !== PROVIDER) state = null;
    const ctx = {
      organizationId: state?.organizationId,
      frontendOrigin: state?.frontendOrigin ?? null,
      setupScreen: state ? await setupScreenFor(state.organizationId) : null,
    };

    if (req.query.error) {
      if (state) await noteSignInFailed(state.organizationId, PROVIDER, String(req.query.error));
      finishCallback(res, 'error', ctx, String(req.query.error));
      return;
    }
    const code = String(req.query.code ?? '');
    const realmId = String(req.query.realmId ?? '');
    if (!code || !realmId || !state) {
      finishCallback(res, 'error', ctx, 'missing_parameters');
      return;
    }
    const tokens = await QuickBooks.exchangeCode(code, realmId, state?.redirectUri ?? callbackUri(req) ?? undefined);
    // Only the tokens. Signing in writes nothing to the customer's books.
    await saveConnection(state.organizationId, tokens);
    await noteSignedIn(state.organizationId, PROVIDER, tokens.realmId);
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
    const redirectUri = callbackUri(req);
    sendJson(res, { authorizeUrl: QuickBooks.authorizeUrl(signState(organizationId, frontendOrigin, redirectUri, PROVIDER), redirectUri ?? undefined) });
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
      postingEnabledAt: conn?.postingEnabledAt ?? null,
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
    await noteDisconnected(organizationId, PROVIDER);
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
      // The number the bookkeeper knows the account by ("7410 Accounting").
      acctNum: a.AcctNum ?? null,
      // Sub-accounts render as "Utilities:Internet" — the unambiguous name.
      fullyQualifiedName: a.FullyQualifiedName ?? a.Name,
      accountType: a.AccountType,
      accountSubType: a.AccountSubType ?? null,
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

// Sync history — bills Decimal has posted to QuickBooks (newest first).
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
          // Posted at approval; the payment is recorded against it when paid.
          paid: Boolean(r.externalBillPaymentId),
          syncedAt: r.syncedAt,
        };
      }),
    );
  }),
);

// Post one bill now (the sweep does this automatically): the bill at approval,
// the payment once paid. Doubles as the retry action — resets a maxed-out
// attempt counter first.
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
    const outcome = await syncBillNow(paymentOrderId);
    sendJson(res, { outcome });
  }),
);
