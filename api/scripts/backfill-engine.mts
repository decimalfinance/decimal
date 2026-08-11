/**
 * Put bills that predate the engine-at-intake change into the approval engine.
 *
 * Bills used to enter the engine only when someone confirmed them. They now
 * enter at intake, which is what gives a flagged bill a task — something to ask
 * about, delegate or escalate. Bills ingested before that change have no
 * approvable, so they sit in review with no actions and no owner: not broken,
 * just stranded on the far side of a behaviour change.
 *
 * Idempotent and additive. It only INSERTS an approvable for a bill that has
 * none, and skips anything already in the engine or in a terminal state. It
 * deletes nothing and edits no existing row.
 *
 *   npx tsx scripts/backfill-engine.mts          # report only
 *   npx tsx scripts/backfill-engine.mts --apply  # do it
 */
import { prisma } from '../src/infra/prisma.js';
import { submitInvoiceForApproval } from '../src/approvals/wiring.js';

const apply = process.argv.includes('--apply');

const orders = await prisma.paymentOrder.findMany({
  where: { state: { notIn: ['cancelled', 'settled', 'failed'] } },
  select: {
    paymentOrderId: true, organizationId: true, amountRaw: true, memo: true,
    counterpartyId: true, counterpartyWalletId: true, createdByUserId: true, state: true,
    counterpartyWallet: { select: { walletAddress: true } },
  },
  orderBy: { createdAt: 'asc' },
});

const stranded: typeof orders = [];
for (const o of orders) {
  const [{ n }] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM approval.approvables
    WHERE organization_id = ${o.organizationId}::uuid
      AND attributes->>'paymentOrderId' = ${o.paymentOrderId}`;
  if (Number(n) === 0) stranded.push(o);
}

console.log(`${orders.length} live bill(s); ${stranded.length} not in the engine.`);
if (stranded.length === 0) { await prisma.$disconnect(); process.exit(0); }
for (const o of stranded) console.log(`  ${o.paymentOrderId.slice(0, 8)}  ${o.state}  ${(Number(o.amountRaw) / 1e6).toFixed(2)} USD`);

if (!apply) {
  console.log('\nReport only. Re-run with --apply to submit these.');
  await prisma.$disconnect();
  process.exit(0);
}

let done = 0;
for (const o of stranded) {
  if (!o.createdByUserId) { console.log(`  skip ${o.paymentOrderId.slice(0, 8)}: no creating user to attribute it to`); continue; }
  try {
    const r = await submitInvoiceForApproval({
      organizationId: o.organizationId,
      requesterUserId: o.createdByUserId,
      totalMinorBase: o.amountRaw,
      vendorId: o.counterpartyId,
      attributes: {
        paymentOrderId: o.paymentOrderId,
        inputSource: 'invoice_upload',
        backfilled: true, // so the audit trail says where this came from
        approvedDestination: {
          counterpartyWalletId: o.counterpartyWalletId,
          walletAddress: o.counterpartyWallet.walletAddress,
        },
      },
      lines: [{ amountMinor: o.amountRaw, currency: 'USD', description: o.memo }],
    });
    console.log(`  ok   ${o.paymentOrderId.slice(0, 8)} -> approvable ${r.approvableId.slice(0, 8)} (${r.macroState})`);
    done += 1;
  } catch (error) {
    console.log(`  FAIL ${o.paymentOrderId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(`\n${done}/${stranded.length} submitted.`);
await prisma.$disconnect();
