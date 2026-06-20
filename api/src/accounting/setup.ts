// Zero-config setup. After an org connects QuickBooks, provision sensible
// defaults so they land on a ready Accounting page without having to know what
// a clearing account is or pick among dozens of expense categories:
//   - a dedicated "Decimal USDC Clearing" bank account (stands in for the vault),
//   - a "Decimal Payments" expense bucket (the accountant reclassifies, or we add
//     per-vendor mapping later),
// both mapped. Best-effort + idempotent: only fills mapping fields that aren't
// already set, so it never overrides an operator's manual choices.

import { logger } from '../infra/logger.js';
import { prisma } from '../infra/prisma.js';
import { getQuickBooksForOrg } from './connections.js';
import { qboLiteral, type QuickBooks } from './quickbooks.js';

const PROVIDER = 'quickbooks';
const CLEARING_NAME = 'Decimal USDC Clearing';
const EXPENSE_NAME = 'Decimal Payments';

async function findOrCreateAccount(qb: QuickBooks, name: string, createBody: Record<string, unknown>) {
  const found = (await qb.query(`SELECT * FROM Account WHERE Name = '${qboLiteral(name)}'`)).QueryResponse?.Account?.[0];
  if (found) {
    return found;
  }
  return (await qb.createAccount({ Name: name, ...createBody })).Account;
}

export async function ensureDefaultAccountingSetup(organizationId: string): Promise<void> {
  const qb = await getQuickBooksForOrg(organizationId);
  if (!qb) {
    return;
  }

  const existing = await prisma.accountingAccountMap.findUnique({
    where: { organizationId_provider: { organizationId, provider: PROVIDER } },
  });
  if (existing?.clearingAccountId && existing?.defaultExpenseAccountId) {
    return; // already configured — leave the operator's choices alone
  }

  const clearing = await findOrCreateAccount(qb, CLEARING_NAME, { AccountType: 'Bank' });
  const expense = await findOrCreateAccount(qb, EXPENSE_NAME, { AccountType: 'Expense' });

  const data = {
    clearingAccountId: existing?.clearingAccountId ?? clearing.Id,
    clearingAccountName: existing?.clearingAccountName ?? clearing.Name,
    defaultExpenseAccountId: existing?.defaultExpenseAccountId ?? expense.Id,
    defaultExpenseAccountName: existing?.defaultExpenseAccountName ?? expense.Name,
  };
  await prisma.accountingAccountMap.upsert({
    where: { organizationId_provider: { organizationId, provider: PROVIDER } },
    create: { organizationId, provider: PROVIDER, ...data },
    update: data,
  });
  logger.info('accounting_setup.defaults_provisioned', {
    organizationId,
    clearingAccountId: data.clearingAccountId,
    defaultExpenseAccountId: data.defaultExpenseAccountId,
  });
}
