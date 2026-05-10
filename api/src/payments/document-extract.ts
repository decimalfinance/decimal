/**
 * Doc-to-proposal pipeline: invoice/expense PDF or image → structured
 * payment rows that drop into the existing CSV import flow.
 *
 * Pipeline:
 *   1. If PDF, render the first page to PNG via macOS `sips` (zero deps).
 *   2. Send the image to a vision-capable model on OpenRouter.
 *   3. Parse the JSON response, validate with Zod, return rows.
 *
 * Wallet addresses are NOT extracted — destination registry lookup
 * happens at the call site (importPaymentRunFromDocument). Each row
 * matches the CSV import shape: counterparty, amount, currency,
 * reference, due_date, notes.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Free, vision-capable, 30B reasoning. JSON-in-text mode (most free
// OpenRouter models don't honor OpenAI's tool_choice). Verified
// 3/3 deterministic on the spike test invoice. Fallbacks if it 429s:
//   - 'nvidia/nemotron-nano-12b-v2-vl:free' (smaller, weaker)
//   - 'google/gemma-4-31b-it:free' (heavily contested)
//   - 'openrouter/free' (auto-route, non-deterministic quality)
const MODEL = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';

const SYSTEM_PROMPT = `You parse vendor invoices into payment rows for a B2B stablecoin payouts platform that *sends* money. Each row represents money LEAVING our platform and going TO a vendor.

OUTPUT FORMAT — return ONLY a JSON object with this exact shape, nothing else (no prose, no markdown fences):

{
  "rows": [
    {
      "counterparty": "string — vendor / payee name (the entity being paid)",
      "amount": number,
      "currency": "string — e.g. USD, EUR, USDC",
      "reference": "string or null — invoice number / reference id",
      "due_date": "string YYYY-MM-DD or null",
      "wallet_address": "string or null — Solana wallet address (base58, 32-44 chars) if printed on the invoice, else null",
      "notes": "string or null — operator-relevant note like 'partial payment'"
    }
  ]
}

CRITICAL RULES:

1. **counterparty = the entity we are PAYING (the BILLER, the FROM/VENDOR side of the invoice).** This is the party that *issued* the invoice and is *waiting to be paid*. Look for "From:", "Vendor:", "Bill from:", "Remit to:", a company name with a logo at the top, or the "billing@..." email. NEVER the recipient/buyer/customer side (which is *our* platform/company that owes them money).

   Example invoice excerpt:
     From: Acme Corp                           To: Decimal Labs Inc.
     1234 Market St                            Attn: Accounts Payable
     billing@acmecorp.com                      contact@decimal.finance

   Correct counterparty: "Acme Corp" — they sent the bill, they get paid.
   WRONG: "Decimal Labs Inc." — that's the buyer/customer, who is paying.

2. **One invoice = ONE row, regardless of how many line items it has.** Five line items totaling $9,928.50 → emit ONE row with amount=9928.50, not five rows. Use TOTAL DUE / GRAND TOTAL (after tax and discounts), not the subtotal or per-item amounts.

3. **Multiple separate invoices in one document = one row per invoice.** A multi-page PDF with 3 distinct invoices from 3 vendors emits 3 rows.

4. **wallet_address: only emit a Solana wallet address if it is printed on the invoice itself** (in a "Remit to:" / "Pay to wallet:" / "Solana address:" footer, or similar). Solana addresses are 32-44 base58 characters (no zero, capital O, capital I, lowercase L). If you can't see one, return null — never guess. Do NOT extract bank account numbers or IBANs as wallet addresses.

5. Be faithful. Never invent fields. Use null if missing.

6. Return ONLY the JSON object. No prose, no explanation, no markdown.`;

const ExtractedRowSchema = z.object({
  counterparty: z.string().min(1),
  amount: z.number().positive(),
  currency: z.string().min(1),
  reference: z.string().nullable(),
  due_date: z.string().nullable(),
  wallet_address: z.string().nullable(),
  notes: z.string().nullable(),
});

const ExtractedRowsSchema = z.object({
  rows: z.array(ExtractedRowSchema),
});

export type ExtractedRow = z.infer<typeof ExtractedRowSchema>;

const SUPPORTED_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

export function isDocumentExtractionConfigured() {
  return Boolean(config.openRouterApiKey);
}

export async function extractPaymentRowsFromDocument(args: {
  fileBytes: Buffer;
  filename: string;
  mimeType: string;
}): Promise<{ rows: ExtractedRow[]; modelLatencyMs: number }> {
  if (!isDocumentExtractionConfigured()) {
    throw new Error('OPEN_ROUTER_API_KEY is not configured on the server.');
  }

  const ext = inferExtension(args.filename, args.mimeType);
  const { imageBytes, imageMime } = await ensureImage(args.fileBytes, ext);
  const dataUrl = `data:${imageMime};base64,${imageBytes.toString('base64')}`;

  const t0 = Date.now();
  const response = await fetch(OPENROUTER_BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.openRouterApiKey}`,
      'HTTP-Referer': 'https://decimal.finance',
      'X-Title': 'Decimal Doc-to-Proposal',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: dataUrl } },
            {
              type: 'text',
              text: 'Extract every payment in this document. Return ONLY the JSON object.',
            },
          ],
        },
      ],
    }),
  });
  const latencyMs = Date.now() - t0;

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`OpenRouter ${response.status}: ${detail.slice(0, 500)}`);
  }
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = body.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('OpenRouter returned an empty completion');
  }

  const jsonText = extractJsonObject(content);
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    throw new Error(`Model response was not valid JSON. Got: ${content.slice(0, 500)}`);
  }
  const parsed = ExtractedRowsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Extracted rows failed schema validation: ${parsed.error.message}`);
  }
  return { rows: parsed.data.rows, modelLatencyMs: latencyMs };
}

async function ensureImage(fileBytes: Buffer, ext: string): Promise<{ imageBytes: Buffer; imageMime: string }> {
  if (SUPPORTED_IMAGE_EXTS.has(ext)) {
    return { imageBytes: fileBytes, imageMime: imageMimeFromExt(ext) };
  }
  if (ext !== 'pdf') {
    throw new Error(`Unsupported file type: .${ext}. Supported: PDF, PNG, JPG, JPEG, WEBP, GIF.`);
  }

  if (process.platform !== 'darwin') {
    throw new Error('PDF extraction currently requires macOS sips. Convert to PNG client-side first.');
  }

  // sips needs filesystem paths; write the input + read the output via a
  // temp dir we clean up on the way out.
  const dir = await mkdtemp(join(tmpdir(), 'doc2prop-'));
  try {
    const inPath = join(dir, 'input.pdf');
    const outPath = join(dir, 'input.png');
    await writeFile(inPath, fileBytes);
    await execFileAsync('sips', ['-s', 'format', 'png', inPath, '--out', outPath]);
    const imageBytes = await readFile(outPath);
    return { imageBytes, imageMime: 'image/png' };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function inferExtension(filename: string, mimeType: string): string {
  const dot = filename.lastIndexOf('.');
  const fromName = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
  if (fromName) return fromName;
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('image/')) return mimeType.slice('image/'.length);
  return '';
}

function imageMimeFromExt(ext: string): string {
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  return `image/${ext}`;
}

/** Pull the first {...} JSON object out of a possibly-fenced response. */
function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  if (fenceMatch) return fenceMatch[1]!.trim();
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    return trimmed.slice(first, last + 1);
  }
  return trimmed;
}
