import { prisma } from '../../src/infra/prisma.js';

// Guard: truncate-based test suites must ONLY run against a *_test database.
// They run `TRUNCATE TABLE ... organizations, users ... CASCADE` in beforeEach,
// so pointing them at usdc_ops_local or usdc_ops would destroy real data.
//
// This exists because exactly that happened: running the suite outside
// `make test-api` (e.g. `npx tsx --test ...`) inherits DATABASE_URL from
// api/.env, which points at usdc_ops_local. `make test-api` overrides it to
// usdc_ops_test — this guard makes the safe path mandatory, not conventional.
export async function requireTestDatabase(): Promise<void> {
  const rows = await prisma.$queryRawUnsafe<Array<{ current_database: string }>>(
    'SELECT current_database() AS current_database',
  );
  const name = rows[0]?.current_database ?? '';
  if (!name.endsWith('_test')) {
    throw new Error(
      `Refusing to run truncate-based tests against non-test database "${name}". ` +
        'Run the suite with `make test-api` (it sets DATABASE_URL to usdc_ops_test).',
    );
  }
}
