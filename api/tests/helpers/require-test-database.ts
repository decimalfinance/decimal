import { prisma } from '../../src/infra/prisma.js';

// Second check, at query time: truncate-based suites must ONLY run against a
// *_test database. They run `TRUNCATE TABLE ... organizations, users ... CASCADE`
// in beforeEach, so pointing them at usdc_ops_local or usdc_ops would destroy
// real data. The first check is assertTestDatabase() in src/infra/prisma.ts,
// which refuses a non-test DATABASE_URL in any test process before a client is
// made; this one asks the server which database the connection really reached.
export async function requireTestDatabase(): Promise<void> {
  const rows = await prisma.$queryRawUnsafe<Array<{ current_database: string }>>(
    'SELECT current_database() AS current_database',
  );
  const name = rows[0]?.current_database ?? '';
  if (!name.endsWith('_test')) {
    throw new Error(
      `Refusing to run truncate-based tests against non-test database "${name}". ` +
        'Use `make test`, or `make test-one FILE=tests/<name>.test.ts` for one file.',
    );
  }
}
