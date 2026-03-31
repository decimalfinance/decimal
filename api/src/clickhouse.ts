import { config } from './config.js';

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
