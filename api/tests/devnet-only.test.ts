import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DEVNET_RPC_URL, config } from '../src/config.js';
import { USDC_MINT } from '../src/solana.js';

// This product runs on devnet and only devnet. Before this existed the code's
// actual default was MAINNET — getSolanaNetwork() fell back to it whenever
// SOLANA_NETWORK was unset, and USDC_MINT is resolved at module load, so a
// forgotten env var silently pointed every transfer at real-money
// infrastructure. These tests exist so that cannot come back by accident.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const MAINNET_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

test('the only USDC mint is the devnet one', () => {
  assert.equal(USDC_MINT.toBase58(), '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
});

test('every configured RPC endpoint is devnet', () => {
  assert.equal(DEVNET_RPC_URL, 'https://api.devnet.solana.com');
  for (const url of [config.solanaRpcUrl, config.solanaAirdropRpcUrl]) {
    assert.doesNotMatch(url, /mainnet/i, `configured RPC points at mainnet: ${url}`);
  }
});

test('a mainnet RPC URL is refused at boot, not quietly accepted', async () => {
  const previous = process.env.SOLANA_RPC_URL;
  process.env.SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';
  try {
    // Fresh module instance: config is built once at import time.
    await assert.rejects(
      () => import(`../src/config.js?devnet-guard=${Date.now()}`),
      /devnet-only/i,
      'a mainnet RPC URL must stop the process',
    );
  } finally {
    if (previous === undefined) delete process.env.SOLANA_RPC_URL;
    else process.env.SOLANA_RPC_URL = previous;
  }
});

test('a paid devnet endpoint is still accepted', async () => {
  const previous = process.env.SOLANA_RPC_URL;
  process.env.SOLANA_RPC_URL = 'https://solana-devnet.g.alchemy.com/v2/some-key';
  try {
    const fresh = await import(`../src/config.js?devnet-guard-ok=${Date.now()}`);
    assert.equal(fresh.config.solanaRpcUrl, 'https://solana-devnet.g.alchemy.com/v2/some-key');
  } finally {
    if (previous === undefined) delete process.env.SOLANA_RPC_URL;
    else process.env.SOLANA_RPC_URL = previous;
  }
});

// --- source guard -------------------------------------------------------------

// Keyed on concrete mainnet ARTIFACTS rather than the word "mainnet": prose
// explaining why there is no mainnet path is welcome, a mainnet mint address or
// endpoint is not.
const FORBIDDEN: Array<{ pattern: RegExp; what: string }> = [
  { pattern: new RegExp(MAINNET_USDC_MINT), what: "the mainnet USDC mint" },
  { pattern: /api\.mainnet-beta\.solana\.com/, what: 'the mainnet RPC endpoint' },
  { pattern: /['"`]mainnet['"`]/, what: "'mainnet' as a value" },
];

const SEARCH_ROOTS = ['api/src', 'frontend/src', 'config', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

function sourceFiles(dir: string): string[] {
  const absolute = path.join(ROOT, dir);
  let entries: string[];
  try {
    entries = readdirSync(absolute);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const relative = path.join(dir, entry);
    if (statSync(path.join(ROOT, relative)).isDirectory()) {
      found.push(...sourceFiles(relative));
    } else if (/\.(ts|tsx|js|mjs|json|sh)$/.test(entry)) {
      found.push(relative);
    }
  }
  return found;
}

test('mainnet cannot reappear in the source', () => {
  const offences: string[] = [];
  for (const relative of SEARCH_ROOTS.flatMap(sourceFiles)) {
    // This file necessarily names the things it forbids.
    if (relative.endsWith('devnet-only.test.ts')) continue;
    const contents = readFileSync(path.join(ROOT, relative), 'utf8');
    for (const { pattern, what } of FORBIDDEN) {
      if (pattern.test(contents)) {
        offences.push(`${relative}: contains ${what}`);
      }
    }
  }
  assert.deepEqual(
    offences,
    [],
    `Decimal is devnet-only. Reintroducing mainnet is a deliberate decision — if that is what you mean to do, delete this test in the same commit.\n${offences.join('\n')}`,
  );
});
