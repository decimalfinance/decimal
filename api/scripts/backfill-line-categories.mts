/**
 * Give existing bills a category per line item.
 *
 * Every line used to inherit one bill-level suggestion, so an invoice with
 * ocean freight and a documentation fee coded both as freight. New bills get a
 * per-line hint from extraction; bills already in the database have none, and
 * re-running extraction on them would cost a vision call per bill to recover
 * information we can get from the line descriptions we already stored.
 *
 * So: one cheap text call per bill, over the descriptions, returning a category
 * per line. Idempotent and additive — it only fills lineItems[].categoryHint
 * where it is missing, and never touches an amount, a total or a coded account
 * somebody has already confirmed.
 *
 *   npx tsx scripts/backfill-line-categories.mts          # report only
 *   npx tsx scripts/backfill-line-categories.mts --apply
 */
import { prisma } from '../src/infra/prisma.js';
import { config } from '../src/config.js';

const apply = process.argv.includes('--apply');
// The first version wrote free-text hints the picker does not recognise, which
// look filled in and resolve to nothing. --redo re-categorises those against
// the chart rather than skipping them for already having a value.
const redo = process.argv.includes('--redo');
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

async function categorise(descriptions: string[], chart: string[]): Promise<(string | null)[]> {
  if (!config.openAiApiKey) return descriptions.map(() => null);
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${config.openAiApiKey}` },
    body: JSON.stringify({
      model: config.openAiModel,
      max_tokens: 400,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          // The count is stated and the lines numbered because the model
          // collapsed two similar lines into one answer otherwise. A category on
          // the wrong line is worse than none, so the caller rejects any
          // response whose length does not match — this makes it comply instead.
          content: 'Give each numbered invoice line its own short 2-5 word spend category, judged on its own. '
            + 'Lines on one invoice often belong in different categories — freight and a documentation fee '
            + 'are not the same expense. Never merge or skip lines, even if two look similar. '
            + 'Choose ONLY from this list, copied exactly:\n'
            + chart.map((c) => `- ${c}`).join('\n') + '\n'
            + 'Free text is useless here — the picker only recognises these names, so anything else '
            + 'is discarded and the line silently keeps the invoice-level guess. '
            + `Respond with JSON: {"categories": [...]} containing exactly ${descriptions.length} strings, `
            + 'in the same order as the numbered lines.',
        },
        {
          role: 'user',
          content: `Categorise these ${descriptions.length} lines as JSON:\n`
            + descriptions.map((d, i) => `${i + 1}. ${d}`).join('\n'),
        },
      ],
    }),
  });
  if (!res.ok) return descriptions.map(() => null);
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
  try {
    const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? '{}') as { categories?: unknown };
    const out = Array.isArray(parsed.categories) ? parsed.categories : [];
    // One per line, in order, or we cannot trust the alignment — a category on
    // the wrong line is worse than none.
    if (out.length !== descriptions.length) return descriptions.map(() => null);
    const allowed = new Map(chart.map((c) => [c.toLowerCase(), c]));
    // Enforced here, not asked for in the prompt: a name the picker does not
    // know is the same as no answer.
    return out.map((c) => (typeof c === 'string' ? allowed.get(c.trim().toLowerCase()) ?? null : null));
  } catch {
    return descriptions.map(() => null);
  }
}

const orders = await prisma.paymentOrder.findMany({ orderBy: { createdAt: 'desc' } });
type Target = { id: string; lines: Record<string, unknown>[]; metadata: Record<string, unknown> };
const targets: Target[] = [];

for (const o of orders) {
  const metadata = isRecord(o.metadataJson) ? o.metadataJson : {};
  const agent = isRecord(metadata.agent) ? metadata.agent : null;
  const extracted = agent && isRecord(agent.extracted) ? agent.extracted : null;
  const lines = extracted && Array.isArray(extracted.lineItems) ? extracted.lineItems.filter(isRecord) : [];
  if (lines.length === 0) continue;
  if (!redo && lines.every((l) => typeof l.categoryHint === 'string' && l.categoryHint)) continue;
  targets.push({ id: o.paymentOrderId, lines, metadata });
}

console.log(`${orders.length} bill(s); ${targets.length} without per-line categories.`);
for (const t of targets) console.log(`  ${t.id.slice(0, 8)}  ${t.lines.length} line(s)`);
if (targets.length === 0 || !apply) {
  if (targets.length > 0) console.log('\nReport only. Re-run with --apply.');
  await prisma.$disconnect();
  process.exit(0);
}

// The picker's own vocabulary. Categorising into anything else produces a
// label the review screen cannot use, which is how the first attempt at this
// silently changed nothing.
// Taken from getBillReview, which is what the picker actually renders.
// listChartOfAccounts is the QuickBooks chart and is empty without QBO
// connected — using it produced an empty vocabulary and rejected every answer,
// silently, which looked exactly like the model failing.
const { getBillReview } = await import('../src/payments/bills.js');
const sample = await prisma.paymentOrder.findFirstOrThrow({ select: { organizationId: true, paymentOrderId: true } });
const sampleReview = await getBillReview(sample.organizationId, sample.paymentOrderId);
const chart = (sampleReview?.categoryOptions ?? []).map((c: { value: string }) => c.value).filter(Boolean);
console.log(`\nchart: ${chart.length} accounts`);

let done = 0;
for (const t of targets) {
  const descriptions = t.lines.map((l) => String(l.description ?? '').trim()).map((d) => d || 'unlabelled line');
  const categories = await categorise(descriptions, chart);
  if (categories.every((c) => c === null)) { console.log(`  --   ${t.id.slice(0, 8)}  no categories returned`); continue; }

  const agent = isRecord(t.metadata.agent) ? { ...t.metadata.agent } : {};
  const extracted = isRecord(agent.extracted) ? { ...agent.extracted } : {};
  // --redo overwrites; without it an existing hint wins. The first version of
  // this script wrote free text the picker cannot use, so "already has a value"
  // is not the same as "already done".
  extracted.lineItems = t.lines.map((l, i) => ({
    ...l,
    categoryHint: redo ? (categories[i] ?? l.categoryHint) : (l.categoryHint ?? categories[i]),
  }));
  agent.extracted = extracted;

  await prisma.paymentOrder.update({
    where: { paymentOrderId: t.id },
    data: { metadataJson: { ...t.metadata, agent } as never },
  });
  console.log(`  ok   ${t.id.slice(0, 8)}  ${descriptions.map((d, i) => `${d.slice(0, 28)} → ${categories[i] ?? '-'}`).join(' | ')}`);
  done += 1;
}
console.log(`\n${done}/${targets.length} backfilled.`);
await prisma.$disconnect();
