import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { assertTestDatabase } from '../src/infra/prisma.js';

// The test suites TRUNCATE every table. Running one outside `make test` once
// wiped the dev database, because importing @prisma/client loads api/.env and
// that points at usdc_ops_local. assertTestDatabase() in src/infra/prisma.ts
// makes every test process refuse a non-test database before a client exists.
// These tests prove each way of starting a test is caught, and that an
// ordinary process (the API itself) is left alone.

const API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSX = path.join(API, 'node_modules/.bin/tsx');
const PRISMA_MODULE = path.join(API, 'src/infra/prisma.ts');
// Port 1 never answers, so even a broken guard could not touch a real database.
const DEV_URL = 'postgresql://nobody:nothing@127.0.0.1:1/usdc_ops_local?schema=public';
const TEST_URL = 'postgresql://nobody:nothing@127.0.0.1:1/usdc_ops_test?schema=public';

test('a test process with a non-test database is refused', () => {
  for (const env of [{ NODE_ENV: 'test' }, { NODE_TEST_CONTEXT: 'child-v8' }]) {
    assert.throws(() => assertTestDatabase({ ...env, DATABASE_URL: DEV_URL }, '/x/server.ts'), /usdc_ops_local/);
  }
  assert.throws(() => assertTestDatabase({ DATABASE_URL: DEV_URL }, '/x/tests/approval-engine.test.ts'), /make test-one/);
  assert.throws(() => assertTestDatabase({ NODE_ENV: 'test' }, '/x/src/index.ts'), /\(none\)/);
  assert.throws(() => assertTestDatabase({ NODE_ENV: 'test', DATABASE_URL: 'not a url' }, '/x/src/index.ts'), /\(none\)/);
});

test('a test process on a *_test database, and any non-test process, pass', () => {
  assert.doesNotThrow(() => assertTestDatabase({ NODE_ENV: 'test', DATABASE_URL: TEST_URL }, '/x/a.test.ts'));
  assert.doesNotThrow(() => assertTestDatabase({ DATABASE_URL: DEV_URL }, '/x/src/index.ts'));
  assert.doesNotThrow(() => assertTestDatabase({ NODE_ENV: 'development', DATABASE_URL: DEV_URL }, '/x/src/index.ts'));
});

// The real thing: a fresh process imports the client module, as a test file
// would. The environment is built from nothing so this suite's own NODE_ENV
// and NODE_TEST_CONTEXT don't leak in.
function importClient(extraEnv: Record<string, string>, entryName: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'db-guard-'));
  try {
    const entry = path.join(dir, entryName);
    writeFileSync(entry, `import ${JSON.stringify(PRISMA_MODULE)};\nconsole.log('client module loaded');\n`);
    return spawnSync(TSX, [entry], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...extraEnv },
      encoding: 'utf8',
      timeout: 30_000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('every way of starting a test refuses the dev database before a client is made', () => {
  const cases: Array<[string, Record<string, string>, string]> = [
    ['NODE_ENV=test (npm test)', { NODE_ENV: 'test', DATABASE_URL: DEV_URL }, 'probe.ts'],
    ['the test runner child (tsx --test)', { NODE_TEST_CONTEXT: 'child-v8', DATABASE_URL: DEV_URL }, 'probe.ts'],
    ['a test file run directly (tsx x.test.ts)', { DATABASE_URL: DEV_URL }, 'probe.test.ts'],
  ];
  for (const [how, env, entryName] of cases) {
    const run = importClient(env, entryName);
    assert.notEqual(run.status, 0, `${how}: the process should have refused, but exited 0`);
    assert.match(run.stderr, /Refusing to run tests against database "usdc_ops_local"/, `${how}: ${run.stderr}`);
    assert.doesNotMatch(run.stdout, /client module loaded/, how);
  }
});

test('the API process itself still starts on the dev database', () => {
  const run = importClient({ DATABASE_URL: DEV_URL }, 'server.ts');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /client module loaded/);
});
