/**
 * Map questions asked before field-highlighting existed.
 *
 * The mapping runs when a question is asked, so questions that predate it have
 * an empty list and highlight nothing — the feature appears not to work on
 * exactly the questions someone already cares about.
 *
 * Idempotent and additive: only touches rows whose highlight_fields is empty,
 * and only ever writes that column. Unanswered questions first, since those are
 * the ones still on someone's screen.
 *
 *   npx tsx scripts/backfill-question-fields.mts          # report only
 *   npx tsx scripts/backfill-question-fields.mts --apply
 */
import { prisma } from '../src/infra/prisma.js';
import { fieldsForQuestion } from '../src/payments/question-fields.js';

const apply = process.argv.includes('--apply');

const rows = await prisma.billQuestion.findMany({
  orderBy: [{ answeredAt: 'asc' }, { createdAt: 'desc' }],
});
const unmapped = rows.filter((r) => !Array.isArray(r.highlightFields) || (r.highlightFields as unknown[]).length === 0);

console.log(`${rows.length} question(s); ${unmapped.length} without a field mapping.`);
if (unmapped.length === 0) { await prisma.$disconnect(); process.exit(0); }
for (const r of unmapped) console.log(`  ${r.billQuestionId.slice(0, 8)}  ${r.answeredAt ? 'answered' : 'OPEN'}  "${r.question.slice(0, 70)}"`);

if (!apply) {
  console.log('\nReport only. Re-run with --apply to map these.');
  await prisma.$disconnect();
  process.exit(0);
}

let mapped = 0;
for (const r of unmapped) {
  const fields = await fieldsForQuestion(r.question);
  if (fields.length === 0) {
    // Not every question is about a field. "Is this ours to pay?" maps to
    // nothing, and that is the correct answer rather than a failure.
    console.log(`  --   ${r.billQuestionId.slice(0, 8)}  no fields (not a field question)`);
    continue;
  }
  await prisma.billQuestion.update({
    where: { billQuestionId: r.billQuestionId },
    data: { highlightFields: fields },
  });
  console.log(`  ok   ${r.billQuestionId.slice(0, 8)}  -> ${fields.join(', ')}`);
  mapped += 1;
}
console.log(`\n${mapped}/${unmapped.length} mapped.`);
await prisma.$disconnect();
