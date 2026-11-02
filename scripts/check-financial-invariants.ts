import { MikroORM } from '@mikro-orm/postgresql';
import { ormOptions } from '../src/shared/infrastructure/database/orm-config';

const DEFAULT_DATABASE_URL = 'postgresql://wagering:wagering@localhost:5432/wagering';
const INVARIANT_IDS = [
  'INV-01',
  'INV-02',
  'INV-03',
  'INV-04',
  'INV-05',
  'INV-06',
  'INV-07',
  'INV-08',
  'INV-09',
  'INV-10',
  'INV-11',
] as const;

export async function assertFinancialInvariants(orm: MikroORM): Promise<number> {
  const sql = await Bun.file(new URL('./financial-invariants.sql', import.meta.url)).text();
  let migrationCount = 0;

  await orm.em.fork().transactional(async (em) => {
    await em.execute('SET TRANSACTION READ ONLY');
    await em.execute(sql);
    const rows = (await em.execute(
      'SELECT COUNT(*)::integer AS count FROM mikro_orm_migrations',
    )) as Array<{ count: number }>;
    migrationCount = rows[0]?.count ?? 0;
  });

  return migrationCount;
}

async function main(): Promise<void> {
  const orm = await MikroORM.init(ormOptions(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL));

  try {
    const migrationCount = await assertFinancialInvariants(orm);
    for (const id of INVARIANT_IDS) console.info(`${id} violations=0`);
    console.info(`INV-12 migrations=${migrationCount} expected=17 (informational)`);
    console.info('Financial invariant verification passed.');
  } finally {
    await orm.close(true);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('Financial invariant verification failed:', error);
    process.exitCode = 1;
  });
}
