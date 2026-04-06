import { config } from './config.js';

const CLICKHOUSE_DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/;

export async function queryClickHouse<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const response = await fetch(
    `${config.clickhouseUrl}/?query=${encodeURIComponent(query)}`,
    {
      method: 'POST',
      body: '\n',
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ClickHouse query failed: ${response.status} ${body}`);
  }

  const text = await response.text();

  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export async function executeClickHouse(query: string, body = '\n') {
  const response = await fetch(
    `${config.clickhouseUrl}/?query=${encodeURIComponent(query)}`,
    {
      method: 'POST',
      body,
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ClickHouse query failed: ${response.status} ${text}`);
  }

  return response.text();
}

export async function insertClickHouseRows(table: string, rows: Array<Record<string, unknown>>) {
  if (!rows.length) {
    return;
  }

  const payload = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  await executeClickHouse(
    `INSERT INTO ${config.clickhouseDatabase}.${table} FORMAT JSONEachRow`,
    payload,
  );
}

export function normalizeClickHouseDateTime(
  value: string | null | undefined,
): string | null {
  if (!value) {
    return null;
  }

  if (CLICKHOUSE_DATETIME_PATTERN.test(value)) {
    return `${value.replace(' ', 'T')}Z`;
  }

  return value;
}
