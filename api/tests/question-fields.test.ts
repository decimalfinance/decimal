// The closed vocabulary is the safety property here, not the prompt.
//
// A prompt is a request; the filter is the guarantee. If the model returns a
// field that does not exist, highlighting it would point somebody at nothing —
// so anything outside the list is dropped rather than trusted.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HIGHLIGHTABLE_FIELDS, fieldsForQuestion } from '../src/payments/question-fields.js';

test('the vocabulary matches keys the review screen actually renders', () => {
  // These are the keys getBillDraft emits. If a field is renamed there and not
  // here, highlighting silently stops working for it — this is the tripwire.
  for (const key of ['remitTo.street', 'remitTo.city', 'remitTo.state', 'remitTo.zip',
                     'invoiceNumber', 'invoiceDate', 'dueDate', 'terms', 'poNumber',
                     'discount', 'currency', 'total']) {
    assert.ok((HIGHLIGHTABLE_FIELDS as readonly string[]).includes(key), `${key} must be highlightable`);
  }
});

test('with no model configured it returns nothing rather than failing', async () => {
  // Mapping is an enhancement. A question that arrives without one is still a
  // perfectly good question, so the absence of a model must never break asking.
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const { config } = await import('../src/config.js');
    const savedKey = config.openAiApiKey;
    (config as { openAiApiKey: string | null }).openAiApiKey = null;
    assert.deepEqual(await fieldsForQuestion('Can you confirm the vendor details?'), []);
    (config as { openAiApiKey: string | null }).openAiApiKey = savedKey;
  } finally {
    if (previous !== undefined) process.env.OPENAI_API_KEY = previous;
  }
});
