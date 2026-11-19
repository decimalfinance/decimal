import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __prisma__: PrismaClient | undefined;
}

// A test process only ever reaches a *_test database. The suites TRUNCATE
// every table, and a test run outside `make test` once wiped the dev database:
// importing @prisma/client loads api/.env, which points at usdc_ops_local.
// Checked here, where the one client is made, so no test file can forget it.
// A test process is any of: NODE_ENV=test (npm test, make), the test runner's
// own child (`tsx --test`), or a *.test.ts file run directly (`tsx x.test.ts`).
export function assertTestDatabase(
  env: NodeJS.ProcessEnv = process.env,
  entry: string | undefined = process.argv[1],
): void {
  const underTest =
    env.NODE_ENV === 'test' || Boolean(env.NODE_TEST_CONTEXT) || /\.test\.[cm]?[jt]s$/.test(entry ?? '');
  if (!underTest) return;
  let database = '';
  try {
    database = new URL(env.DATABASE_URL ?? '').pathname.replace(/^\//, '');
  } catch {
    // Missing or unparsable: refused below like any other non-test database.
  }
  if (!database.endsWith('_test')) {
    throw new Error(
      `Refusing to run tests against database "${database || '(none)'}": tests only run on a *_test database. ` +
        'Use `make test`, or `make test-one FILE=tests/<name>.test.ts` for one file.',
    );
  }
}

assertTestDatabase();

export const prisma =
  global.__prisma__ ??
  new PrismaClient({
    log: ['error', 'warn'],
  });

if (process.env.NODE_ENV !== 'production') {
  global.__prisma__ = prisma;
}
