import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeClickHouseDateTime } from '../src/clickhouse.js';

test('normalizeClickHouseDateTime converts bare ClickHouse UTC timestamps to ISO UTC', () => {
  assert.equal(
    normalizeClickHouseDateTime('2026-04-06 21:48:07.952'),
    '2026-04-06T21:48:07.952Z',
  );
  assert.equal(
    normalizeClickHouseDateTime('2026-04-06 21:48:07'),
    '2026-04-06T21:48:07Z',
  );
});

test('normalizeClickHouseDateTime leaves ISO timestamps and nullish values unchanged', () => {
  assert.equal(
    normalizeClickHouseDateTime('2026-04-06T21:48:07.952Z'),
    '2026-04-06T21:48:07.952Z',
  );
  assert.equal(normalizeClickHouseDateTime(null), null);
  assert.equal(normalizeClickHouseDateTime(undefined), null);
});
