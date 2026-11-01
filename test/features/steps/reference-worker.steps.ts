import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Given, Then, When } from '@cucumber/cucumber';
import type {
  FinancialRepositories,
  FinancialUnitOfWork,
} from '../../../src/shared/application/ports/financial-unit-of-work';
import { MikroOrmFinancialUnitOfWork } from '../../../src/shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { ProcessPendingReferences } from '../../../src/modules/wagering/application/process-pending-references.use-case';
import { Money } from '../../../src/shared/domain/money';
import { assertReady, command, currentBalance, type WorldData } from './finance.steps';

import { state } from './state';

async function pendingRefund(world: WorldData, amount = '1.00'): Promise<string> {
  assertReady(world);
  if (world.walletId === undefined || world.playerId === undefined) {
    world.playerId = `player-${randomUUID()}`;
    const wallet = await world.openWallet.execute({
      playerId: world.playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    world.walletId = wallet.walletId;
  }
  const transactionId = `refund-${randomUUID()}`;
  const referenceId = `bet-${randomUUID()}`;
  const result = await world.processWager.execute(
    command(world, 'REFUND', amount, {
      externalTransactionId: transactionId,
      idempotencyKey: `provider-a:${transactionId}`,
      referenceExternalTransactionId: referenceId,
    }),
  );
  assert.equal(result.transaction.status, 'PENDING_REFERENCE');
  state(world).ids.push(transactionId);
  state(world).referenceIds.push(referenceId);
  return transactionId;
}

async function rowStatus(world: WorldData, id: string): Promise<string> {
  assertReady(world);
  const rows = await world.database.orm.em
    .getConnection()
    .execute('SELECT status FROM wager_transactions WHERE external_transaction_id = ?', [id]);
  const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : undefined;
  assert.ok(row && typeof row === 'object' && 'status' in row && typeof row.status === 'string');
  return row.status;
}

async function markDue(world: WorldData): Promise<void> {
  assertReady(world);
  await world.database.orm.em.getConnection().execute(
    `UPDATE wager_transactions SET reference_next_attempt_at = now() - interval '1 hour'
      WHERE status = 'PENDING_REFERENCE'`,
  );
}

async function markFuture(world: WorldData): Promise<void> {
  assertReady(world);
  await world.database.orm.em.getConnection().execute(
    `UPDATE wager_transactions SET reference_next_attempt_at = now() + interval '1 hour'
      WHERE status = 'PENDING_REFERENCE'`,
  );
}

function worker(
  world: WorldData,
  offsetMs = 0,
  unitOfWork?: FinancialUnitOfWork,
): ProcessPendingReferences {
  assertReady(world);
  return new ProcessPendingReferences({
    unitOfWork: unitOfWork ?? new MikroOrmFinancialUnitOfWork(world.database.orm),
    clock: () => new Date(Date.now() + offsetMs),
    newId: randomUUID,
  });
}

class CrashBeforeCommit implements FinancialUnitOfWork {
  armed = false;
  constructor(private readonly inner: FinancialUnitOfWork) {}
  run<T>(work: (repositories: FinancialRepositories) => Promise<T>): Promise<T> {
    return this.inner.run(async (repositories) => {
      const result = await work(repositories);
      if (this.armed) {
        this.armed = false;
        throw new Error('falha injetada antes do commit');
      }
      return result;
    });
  }
}

Given<WorldData>('existe uma referência pendente vencida para processamento', async function () {
  await pendingRefund(this);
  const referenceId = state(this).referenceIds[0];
  assertReady(this);
  assert.ok(referenceId);
  await this.processWager.execute(
    command(this, 'BET', '1.00', {
      externalTransactionId: referenceId,
      idempotencyKey: `provider-a:${referenceId}`,
    }),
  );
  await markDue(this);
});
When<WorldData>('dois workers resolvem a referência em paralelo', async function () {
  await Promise.all([worker(this).runOnce(), worker(this).runOnce()]);
});
Then<WorldData>('o efeito da transação é aplicado uma única vez', async function () {
  const id = state(this).ids[0];
  assert.ok(id);
  assert.equal(await rowStatus(this, id), 'PROCESSED');
  assert.equal(await currentBalance(this), '100.00');
  assertReady(this);
  const rows = await this.database.orm.em
    .getConnection()
    .execute(
      "SELECT COUNT(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'CREDIT'",
      [this.walletId],
    );
  const first = Array.isArray(rows) && rows.length > 0 ? rows[0] : undefined;
  const count = first && typeof first === 'object' && 'count' in first ? first.count : undefined;
  assert.equal(count, 2);
});

Given<WorldData>('existem seis estornos pendentes para a mesma wallet', async function () {
  for (let index = 0; index < 6; index += 1) await pendingRefund(this);
  const ids = state(this).referenceIds;
  assertReady(this);
  for (const referenceId of ids) {
    const bet = command(this, 'BET', '1.00', {
      externalTransactionId: referenceId,
      idempotencyKey: `provider-a:${referenceId}`,
    });
    await this.processWager.execute(bet);
  }
  await markDue(this);
});
When<WorldData>('seis workers resolvem os estornos em paralelo', async function () {
  await Promise.all(Array.from({ length: 6 }, () => worker(this).runOnce()));
});
Then<WorldData>('cada estorno é aplicado uma única vez', async function () {
  for (const id of state(this).ids) assert.equal(await rowStatus(this, id), 'PROCESSED');
  assert.equal(await currentBalance(this), '100.00');
});

Given<WorldData>(
  'existem referências pendentes com próximas tentativas persistidas',
  async function () {
    await pendingRefund(this);
    await markFuture(this);
  },
);
When<WorldData>('o worker de referências é reiniciado e executa novamente', async function () {
  assert.equal(await worker(this).runOnce(), 0);
  const referenceId = state(this).referenceIds[0];
  assertReady(this);
  assert.ok(referenceId);
  await this.processWager.execute(
    command(this, 'BET', '1.00', {
      externalTransactionId: referenceId,
      idempotencyKey: `provider-a:${referenceId}`,
    }),
  );
  await markDue(this);
  await worker(this).runOnce();
});
Then<WorldData>('as tentativas agendadas continuam sendo processadas', async function () {
  const id = state(this).ids[0];
  assert.ok(id);
  assert.equal(await rowStatus(this, id), 'PROCESSED');
  assert.equal(await currentBalance(this), '100.00');
});

When<WorldData>('o worker falha durante a resolução antes do commit', async function () {
  assertReady(this);
  const crash = new CrashBeforeCommit(new MikroOrmFinancialUnitOfWork(this.database.orm));
  crash.armed = true;
  state(this).crash = crash;
  await assert.rejects(worker(this, 0, crash).runOnce(), /falha injetada antes do commit/);
});
Then<WorldData>(
  'a alteração é revertida e uma tentativa posterior pode aplicá-la',
  async function () {
    const id = state(this).ids[0];
    assert.ok(id);
    assert.equal(await rowStatus(this, id), 'PENDING_REFERENCE');
    assert.equal(await currentBalance(this), '99.00');
    await worker(this).runOnce();
    assert.equal(await rowStatus(this, id), 'PROCESSED');
    assert.equal(await currentBalance(this), '100.00');
  },
);

Given<WorldData>('existe uma referência pendente com próxima tentativa futura', async function () {
  await pendingRefund(this);
  await markFuture(this);
});
When<WorldData>('o worker busca referências antes do prazo', async function () {
  assert.equal(await worker(this).runOnce(), 0);
});
Then<WorldData>('nenhuma tentativa é executada antes do prazo', async function () {
  const id = state(this).ids[0];
  assert.ok(id);
  assert.equal(await rowStatus(this, id), 'PENDING_REFERENCE');
  assertReady(this);
  const rows = await this.database.orm.em
    .getConnection()
    .execute(
      'SELECT reference_attempts FROM wager_transactions WHERE external_transaction_id = ?',
      [id],
    );
  const first = Array.isArray(rows) && rows.length > 0 ? rows[0] : undefined;
  const attempts =
    first && typeof first === 'object' && 'reference_attempts' in first
      ? first.reference_attempts
      : undefined;
  assert.equal(attempts, 0);
});

Given<WorldData>(
  'existem referências pendentes com prazo definido pelo relógio do banco',
  async function () {
    await pendingRefund(this);
    await markFuture(this);
  },
);
When<WorldData>(
  'workers com relógios separados por uma hora verificam as referências',
  async function () {
    const ahead = await worker(this, 3_600_000).runOnce();
    assert.equal(ahead, 0);
    await markDue(this);
    const behind = await worker(this, -3_600_000).runOnce();
    assert.equal(behind, 1);
  },
);
Then<WorldData>('ambos respeitam a mesma decisão de vencimento do banco', async function () {
  const id = state(this).ids[0];
  assert.ok(id);
  assert.equal(await rowStatus(this, id), 'PENDING_REFERENCE');
  assertReady(this);
  const rows = await this.database.orm.em
    .getConnection()
    .execute(
      'SELECT reference_attempts FROM wager_transactions WHERE external_transaction_id = ?',
      [id],
    );
  const first = Array.isArray(rows) && rows.length > 0 ? rows[0] : undefined;
  const attempts =
    first && typeof first === 'object' && 'reference_attempts' in first
      ? first.reference_attempts
      : undefined;
  assert.equal(attempts, 1);
});

Given<WorldData>('existem quarenta e cinco referências pendentes', async function () {
  for (let index = 0; index < 45; index += 1) await pendingRefund(this);
});
When<WorldData>(
  'o worker executa três passagens respeitando seu limite de lote',
  async function () {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await markDue(this);
      let examined: number;
      do {
        examined = await worker(this).runOnce();
      } while (examined > 0);
    }
  },
);
Then<WorldData>(
  'as referências atingem o limite de tentativas e são rejeitadas por referência não encontrada',
  async function () {
    for (const id of state(this).ids) assert.equal(await rowStatus(this, id), 'REJECTED');
    assert.equal(await currentBalance(this), '100.00');
  },
);
