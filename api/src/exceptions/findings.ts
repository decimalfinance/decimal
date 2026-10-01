// The exception agent's findings for flags about ONE bill.
//
// The duplicate investigator (briefs.ts) works a pair of bills with a tool
// loop. These flags need less machinery and more certainty, so most of them
// are worked out in code, on every read:
//
//   - looks_like_statement: which of the invoices it lists are already here,
//     and in what state, and which are not;
//   - looks_like_credit_note: which bill it credits;
//   - lines_do_not_sum / total_does_not_reconcile: which figure is off — a
//     misread line, a line counted twice, tax counted twice — or that the
//     document disagrees with itself;
//   - addressed_elsewhere: whether the name it is billed to is this company.
//     That is judgement, so it is one model call, made in the background and
//     remembered on the bill (metadata.addressedCheck) for that name.
//
// A finding is advice: a headline, the evidence, and the resolution it
// recommends with its reason prefilled. A person still clicks; the flag's own
// buttons, and every rule behind them, are unchanged.
import { prisma } from '../infra/prisma.js';
import { config } from '../config.js';
import { logger } from '../infra/logger.js';
import { trackBackgroundWork } from '../infra/background.js';
import { chatCompletionBody } from '../infra/openai-params.js';

export type FindingPoint = { text: string; tone: 'ok' | 'warn' | 'bad'; billId?: string | null; billState?: string | null };

export type FlagFinding = {
  /** running: the model check is still being made (addressed_elsewhere only). */
  status: 'ready' | 'running';
  headline: string;
  points: FindingPoint[];
  /** One of the flag's own resolutions, and the reason to prefill. */
  recommended: { action: string; reason: string } | null;
};

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const STATE_WORDS: Record<string, string> = {
  draft: 'in review', submitted: 'in approval', proposed: 'approved, being paid', executed: 'being paid', settled: 'paid', cancelled: 'closed',
};

// ─── Statement ──────────────────────────────────────────────────────────────

type StatementRow = { reference: string | null; amountUsd: number | null; statedStatus: string | null; held: { paymentOrderId: string; state: string; where: string } | null };

export async function statementFinding(args: {
  organizationId: string;
  billId: string;
  counterpartyId: string | null;
  vendorName: string;
  refs: string[];
  /** The statement's own rows, already joined to our bills (document-reconcile.ts), when it has them. */
  rows?: StatementRow[] | null;
}): Promise<FlagFinding> {
  if (args.rows && args.rows.length > 0) return statementFromRows(args.vendorName, args.rows);
  const refs = [...new Set(args.refs.map((r) => r.trim().toUpperCase()).filter(Boolean))];
  if (refs.length === 0) {
    return {
      status: 'ready',
      headline: `A statement of account from ${args.vendorName}, not an invoice. Close it.`,
      points: [{ text: 'It names itself a statement but lists no invoice numbers I could check.', tone: 'warn' }],
      recommended: { action: 'not_ours', reason: `Statement of account from ${args.vendorName}, not an invoice: pay the individual invoices instead.` },
    };
  }
  const found = await prisma.paymentOrder.findMany({
    where: { organizationId: args.organizationId, paymentOrderId: { not: args.billId }, invoiceNumber: { in: refs, mode: 'insensitive' } },
    select: { paymentOrderId: true, invoiceNumber: true, state: true, amountRaw: true, counterpartyId: true },
  });
  const points: FindingPoint[] = [];
  const missing: string[] = [];
  for (const ref of refs) {
    const hits = found.filter((b) => (b.invoiceNumber ?? '').toUpperCase() === ref);
    // The vendor's own bill first: another vendor's invoice with the same number is not this one.
    const hit = hits.find((b) => b.counterpartyId === args.counterpartyId) ?? hits[0];
    if (!hit) {
      missing.push(ref);
      points.push({ text: `${ref}: not in Decimal yet`, tone: 'warn' });
    } else {
      points.push({
        text: `${ref}: ${money(Number(hit.amountRaw) / 1_000_000)}, ${STATE_WORDS[hit.state] ?? hit.state}`,
        tone: hit.state === 'cancelled' ? 'warn' : 'ok',
        billId: hit.paymentOrderId,
        billState: hit.state,
      });
    }
  }
  const headline = missing.length === 0
    ? `A statement listing ${refs.length} invoice${refs.length === 1 ? '' : 's'}, all already here. Close it; pay them as invoices.`
    : missing.length === refs.length
      ? `A statement listing ${refs.length} invoice${refs.length === 1 ? '' : 's'}, none of which are in Decimal yet. Close it and get the invoices from ${args.vendorName}.`
      : `A statement listing ${refs.length} invoices; ${missing.length} ${missing.length === 1 ? "isn't" : "aren't"} in Decimal yet (${missing.join(', ')}). Close it and get ${missing.length === 1 ? 'that invoice' : 'those'} from ${args.vendorName}.`;
  return {
    status: 'ready',
    headline,
    points,
    recommended: {
      action: 'not_ours',
      reason: `Statement of account from ${args.vendorName} listing ${refs.join(', ')}, not an invoice.${missing.length ? ` Still to receive: ${missing.join(', ')}.` : ''}`,
    },
  };
}

/** The statement's rows against our books: what to chase, and what the vendor thinks is paid that we never saw. */
function statementFromRows(vendorName: string, rows: StatementRow[]): FlagFinding {
  const ref = (r: StatementRow) => r.reference ?? 'An unnumbered invoice';
  const amt = (r: StatementRow) => (r.amountUsd == null ? '' : ` (${money(r.amountUsd)})`);
  const toChase = rows.filter((r) => !r.held && r.statedStatus !== 'paid');
  const paidElsewhere = rows.filter((r) => !r.held && r.statedStatus === 'paid');
  const parts = [`Close it: a statement is not a bill.`];
  if (toChase.length > 0) parts.push(`${toChase.length === 1 ? 'One open invoice on it is' : `${toChase.length} open invoices on it are`} not in Decimal yet (${toChase.map((r) => `${ref(r)}${amt(r)}`).join(', ')}): get ${toChase.length === 1 ? 'it' : 'them'} from ${vendorName}.`);
  if (paidElsewhere.length > 0) parts.push(`${vendorName} marks ${paidElsewhere.map(ref).join(', ')} paid, but ${paidElsewhere.length === 1 ? "it isn't" : "they aren't"} in Decimal: check ${paidElsewhere.length === 1 ? 'it was' : 'they were'} paid some other way.`);
  if (toChase.length === 0 && paidElsewhere.length === 0) parts.push('Every invoice on it is already here.');
  return {
    status: 'ready',
    headline: parts.join(' '),
    // The statement's own table, under the flag, already lists every row
    // against our books; repeating it here would be the same thing twice.
    points: [],
    recommended: {
      action: 'not_ours',
      reason: `Statement of account from ${vendorName}, not an invoice.${toChase.length ? ` Still to receive: ${toChase.map(ref).join(', ')}.` : ''}`,
    },
  };
}

// ─── Credit note ────────────────────────────────────────────────────────────

export async function creditNoteFinding(args: {
  organizationId: string;
  billId: string;
  counterpartyId: string | null;
  vendorName: string;
  invoiceNumber: string | null;
  credit: number;
  /** Where a referenced invoice number might be printed: line descriptions, notes, references. */
  texts: string[];
}): Promise<FlagFinding> {
  const credit = Math.abs(args.credit);
  const label = `${args.invoiceNumber ?? 'This credit note'} for ${money(credit)}`;
  const vendorBills = args.counterpartyId
    ? await prisma.paymentOrder.findMany({
      where: { organizationId: args.organizationId, counterpartyId: args.counterpartyId, paymentOrderId: { not: args.billId }, state: { not: 'cancelled' } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { paymentOrderId: true, invoiceNumber: true, state: true, amountRaw: true },
    })
    : [];
  // A bill the document names, if it names one: look for the vendor's real
  // invoice numbers in its text, rather than guess what an invoice number
  // looks like.
  const text = ` ${args.texts.join(' ').toUpperCase()} `;
  const mentions = (n: string) => new RegExp(`(^|[^A-Z0-9])${n.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Z0-9]|$)`).test(text);
  const byName = vendorBills.find((b) => b.invoiceNumber && b.invoiceNumber.toUpperCase() !== (args.invoiceNumber ?? '').toUpperCase() && mentions(b.invoiceNumber));
  // Otherwise: bills from the vendor big enough to take the credit, newest first.
  const candidates = byName ? [byName] : vendorBills.filter((b) => Number(b.amountRaw) / 1_000_000 >= credit && b.state !== 'settled').slice(0, 3);

  const points: FindingPoint[] = [{ text: `${money(credit)} back from ${args.vendorName}: money they owe you, not a bill to pay.`, tone: 'ok' }];
  if (byName) {
    points.push({ text: `It credits ${byName.invoiceNumber}: ${money(Number(byName.amountRaw) / 1_000_000)}, ${STATE_WORDS[byName.state] ?? byName.state}`, tone: 'ok', billId: byName.paymentOrderId, billState: byName.state });
  } else if (candidates.length > 0) {
    for (const c of candidates) points.push({ text: `Could apply to ${c.invoiceNumber ?? 'a bill'}: ${money(Number(c.amountRaw) / 1_000_000)}, ${STATE_WORDS[c.state] ?? c.state}`, tone: 'warn', billId: c.paymentOrderId, billState: c.state });
  } else {
    points.push({ text: `No open bill from ${args.vendorName} is in Decimal to apply it to.`, tone: 'warn' });
  }
  const against = byName ?? (candidates.length === 1 ? candidates[0] : null);
  return {
    status: 'ready',
    headline: against
      ? `A credit note: ${label} against ${against.invoiceNumber}. Close it and take ${money(credit)} off what you pay on ${against.invoiceNumber}.`
      : `A credit note: ${label}. Close it, and apply it against ${args.vendorName}'s next bill.`,
    points,
    recommended: {
      action: 'not_ours',
      reason: `Credit note ${label} from ${args.vendorName}, not a bill to pay.${against ? ` Apply it against ${against.invoiceNumber}.` : ''}`,
    },
  };
}

// ─── Arithmetic ─────────────────────────────────────────────────────────────

type Line = { description: string; quantity: number | null; unitPrice: number | null; amount: number | null };
const near = (a: number, b: number) => Math.abs(a - b) <= 0.01;

export function arithmeticFinding(args: {
  kind: 'lines_do_not_sum' | 'total_does_not_reconcile';
  vendorName: string;
  lines: Line[];
  subtotal: number | null;
  tax: number | null;
  total: number | null;
}): FlagFinding | null {
  const lines = args.lines.filter((l) => typeof l.amount === 'number');
  const linesTotal = Math.round(lines.reduce((s, l) => s + (l.amount ?? 0), 0) * 100) / 100;
  const tax = args.tax ?? 0;

  // A line whose own quantity × price disagrees with its amount was misread,
  // or mistyped on the document. Either way it is the place to look.
  const misread = lines.filter((l) => l.quantity !== null && l.unitPrice !== null && !near(l.quantity * l.unitPrice, l.amount!));
  const points: FindingPoint[] = misread.map((l) => ({
    text: `"${l.description}": ${l.quantity} × ${money(l.unitPrice!)} is ${money(l.quantity! * l.unitPrice!)}, but the line reads ${money(l.amount!)}.`,
    tone: 'bad' as const,
  }));
  if (misread.length === 0 && lines.length > 0) {
    points.push({ text: `Every line checks out (quantity × price), and they add up to ${money(linesTotal)}.`, tone: 'ok' });
  }

  if (args.kind === 'lines_do_not_sum') {
    const against = args.subtotal ?? (args.total !== null ? args.total - tax : null);
    if (against === null) return null;
    const gap = Math.round((against - linesTotal) * 100) / 100;
    if (misread.length === 1) {
      const l = misread[0]!;
      const fixed = linesTotal - l.amount! + l.quantity! * l.unitPrice!;
      const explains = near(fixed, against);
      return {
        status: 'ready',
        headline: explains
          ? `One line was misread: "${l.description}" should be ${money(l.quantity! * l.unitPrice!)}. With that, the lines add up to the document's ${money(against)}.`
          : `"${l.description}" doesn't add up on its own, and the lines are ${money(Math.abs(gap))} ${gap > 0 ? 'short of' : 'over'} the document's ${money(against)}.`,
        points,
        recommended: { action: 'fix_fields', reason: `"${l.description}": ${l.quantity} × ${money(l.unitPrice!)} = ${money(l.quantity! * l.unitPrice!)}, not ${money(l.amount!)}.` },
      };
    }
    // A gap the size of one line: that line is missing from the reading, or counted twice.
    const twin = lines.find((l) => near(Math.abs(gap), l.amount!));
    if (twin) {
      points.push({ text: `The gap, ${money(Math.abs(gap))}, is exactly "${twin.description}".`, tone: 'warn' });
      return {
        status: 'ready',
        headline: gap > 0
          ? `The lines are ${money(gap)} short, the exact amount of "${twin.description}". A line like it may have been missed. Check the document's lines.`
          : `The lines are ${money(-gap)} over, the exact amount of "${twin.description}". It may have been read twice.`,
        points,
        recommended: { action: 'fix_fields', reason: `Lines differ from the document by ${money(Math.abs(gap))}, the amount of "${twin.description}".` },
      };
    }
    if (tax > 0 && near(Math.abs(gap), tax)) {
      points.push({ text: `The gap, ${money(Math.abs(gap))}, is exactly the tax.`, tone: 'warn' });
      return {
        status: 'ready',
        headline: `The gap is the tax (${money(tax)}): the figures read as the subtotal may already include it. Check which total is before tax.`,
        points,
        recommended: { action: 'fix_fields', reason: `Lines and subtotal differ by exactly the tax, ${money(tax)}.` },
      };
    }
    points.push({ text: `The document says ${money(against)}: ${money(Math.abs(gap))} ${gap > 0 ? 'more' : 'less'} than its lines, with no line, tax or fee that explains it.`, tone: 'bad' });
    return {
      status: 'ready',
      headline: misread.length === 0
        ? `The document disagrees with itself: its lines add up to ${money(linesTotal)}, its total says ${money(against + tax)}. Nothing was misread. Ask ${args.vendorName} which is right.`
        : `${misread.length} lines don't add up on their own, and the lines are ${money(Math.abs(gap))} off the document. Check them against the original.`,
      points,
      recommended: misread.length === 0
        ? { action: 'ask_someone', reason: `On the bill from ${args.vendorName}, the lines add up to ${money(linesTotal)}, but the total says ${money(against + tax)}. Which is right?` }
        : { action: 'fix_fields', reason: misread.map((l) => `"${l.description}" reads ${money(l.amount!)}`).join('; ') },
    };
  }

  // total_does_not_reconcile: subtotal + tax against the total.
  if (args.subtotal === null || args.total === null) return null;
  const expected = Math.round((args.subtotal + tax) * 100) / 100;
  const gap = Math.round((args.total - expected) * 100) / 100;
  const linesAgree = lines.length > 0 && near(linesTotal, args.subtotal);
  points.push({ text: `${money(args.subtotal)} + ${money(tax)} tax = ${money(expected)}; the total reads ${money(args.total)} (${money(Math.abs(gap))} ${gap > 0 ? 'more' : 'less'}).`, tone: 'bad' });
  if (linesAgree) points.push({ text: `The lines agree with the subtotal, so the total is the odd one out.`, tone: 'ok' });
  if (tax > 0 && near(Math.abs(gap), tax)) {
    return {
      status: 'ready',
      headline: `The total is off by exactly the tax (${money(tax)}): it was ${gap > 0 ? 'added twice' : 'left out'}. The right total is likely ${money(expected)}.`,
      points,
      recommended: { action: 'fix_fields', reason: `${money(args.subtotal)} + ${money(tax)} tax = ${money(expected)}; the total reads ${money(args.total)}.` },
    };
  }
  return {
    status: 'ready',
    headline: linesAgree
      ? `The total doesn't match: ${money(args.subtotal)} + ${money(tax)} tax is ${money(expected)}, but it says ${money(args.total)}. The lines back the ${money(expected)}. Ask ${args.vendorName}, or pay the lines.`
      : `The total doesn't match: ${money(args.subtotal)} + ${money(tax)} tax is ${money(expected)}, but it says ${money(args.total)}. Check the figures against the original.`,
    points,
    recommended: linesAgree
      ? { action: 'ask_someone', reason: `On the bill from ${args.vendorName}, ${money(args.subtotal)} + ${money(tax)} tax = ${money(expected)}, but the total says ${money(args.total)}. Which is right?` }
      : { action: 'fix_fields', reason: `${money(args.subtotal)} + ${money(tax)} tax = ${money(expected)}; the total reads ${money(args.total)}.` },
  };
}

// ─── Addressed elsewhere ────────────────────────────────────────────────────

export type AddressedVerdict = { billToName: string; verdict: 'same' | 'different' | 'unsure'; reason: string; at: string };
type Checker = (args: { billToName: string; billToAddress: string | null; ours: string[] }) => Promise<{ verdict: AddressedVerdict['verdict']; reason: string } | null>;

let checkerOverride: Checker | null = null;
/** Tests replace the model call. */
export function setAddressedCheckForTests(fn: Checker | null) { checkerOverride = fn; }

const askModel: Checker = async ({ billToName, billToAddress, ours }) => {
  if (!config.openAiApiKey) return null;
  const prompt =
    `An invoice is addressed to: ${JSON.stringify(billToName)}${billToAddress ? `, at ${JSON.stringify(billToAddress)}` : ''}.\n` +
    `Our company is ${JSON.stringify(ours[0])}${ours.length > 1 ? `, also trading as ${ours.slice(1).map((n) => JSON.stringify(n)).join(', ')}` : ''}.\n\n` +
    `Is the invoice addressed to us? Judge the company, not the spelling: a legal suffix (Inc., LLC, Ltd), punctuation, an abbreviation or a typo of our name is us. A different company name is not us, however similar the industry.\n` +
    `Return JSON only: { "verdict": "same" | "different" | "unsure", "reason": "one short sentence a person can check" }`;
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openAiApiKey}` },
    body: JSON.stringify(chatCompletionBody({
      model: config.openAiModel,
      max_tokens: 200,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You check whether an invoice is addressed to a given company. Respond with JSON only.' },
        { role: 'user', content: prompt },
      ],
    })),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
  const raw = JSON.parse(body.choices?.[0]?.message?.content ?? '{}') as { verdict?: unknown; reason?: unknown };
  const verdict = raw.verdict === 'same' || raw.verdict === 'different' ? raw.verdict : 'unsure';
  return { verdict, reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 240) : '' };
};

const running = new Set<string>();

/** Make the check in the background, once per bill and name, and remember it on the bill. */
export function startAddressedCheck(args: { organizationId: string; billId: string; billToName: string; billToAddress: string | null; ours: string[] }) {
  const key = `${args.billId}:${args.billToName}`;
  if (running.has(key)) return;
  running.add(key);
  trackBackgroundWork((async () => {
    try {
      const result = await (checkerOverride ?? askModel)({ billToName: args.billToName, billToAddress: args.billToAddress, ours: args.ours });
      const verdict: AddressedVerdict = result
        ? { billToName: args.billToName, verdict: result.verdict, reason: result.reason, at: new Date().toISOString() }
        : { billToName: args.billToName, verdict: 'unsure', reason: '', at: new Date().toISOString() };
      const order = await prisma.paymentOrder.findFirst({ where: { organizationId: args.organizationId, paymentOrderId: args.billId }, select: { metadataJson: true } });
      const meta = order?.metadataJson && typeof order.metadataJson === 'object' && !Array.isArray(order.metadataJson) ? order.metadataJson as Record<string, unknown> : {};
      await prisma.paymentOrder.update({ where: { paymentOrderId: args.billId }, data: { metadataJson: { ...meta, addressedCheck: verdict } as never } });
    } catch (error) {
      logger.warn('addressed_check.failed', { billId: args.billId, ...(error instanceof Error ? { message: error.message } : {}) });
    } finally {
      running.delete(key);
    }
  })());
}

export function addressedFinding(args: { billToName: string; ours: string[]; cached: AddressedVerdict | null }): FlagFinding {
  const usName = args.ours[0] ?? 'your organization';
  // The model's sentence, without its full stop: it is quoted inside ours.
  if (!args.cached || args.cached.billToName !== args.billToName) {
    return { status: 'running', headline: `Checking whether "${args.billToName}" is ${usName}…`, points: [], recommended: null };
  }
  const verdict = args.cached.verdict;
  const reason = args.cached.reason.trim().replace(/[.\s]+$/, '');
  if (verdict === 'same') {
    return {
      status: 'ready',
      headline: `"${args.billToName}" is ${usName}, written differently. Record it as a name you trade under.`,
      points: reason ? [{ text: `${reason}.`, tone: 'ok' }] : [],
      recommended: { action: 'this_is_us', reason: `"${args.billToName}" is ${usName}: ${reason || 'the same company, written differently'}.` },
    };
  }
  if (verdict === 'different') {
    return {
      status: 'ready',
      headline: `"${args.billToName}" is a different company from ${usName}. Close this bill: it isn't yours to pay.`,
      points: reason ? [{ text: `${reason}.`, tone: 'bad' }] : [],
      recommended: { action: 'not_ours', reason: `Addressed to "${args.billToName}", a different company: ${reason || 'not ours to pay'}.` },
    };
  }
  return {
    status: 'ready',
    headline: `I can't tell whether "${args.billToName}" is ${usName}. Ask someone who knows the company's names.`,
    points: reason ? [{ text: `${reason}.`, tone: 'warn' }] : [],
    recommended: { action: 'ask_someone', reason: `Is "${args.billToName}" one of our company's names?` },
  };
}
