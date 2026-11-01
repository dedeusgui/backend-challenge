import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SQSClient } from '@aws-sdk/client-sqs';
import { Given, Then, When } from '@cucumber/cucumber';
import type {
  FinancialRepositories,
  FinancialUnitOfWork,
} from '../../../src/shared/application/ports/financial-unit-of-work';
import { MikroOrmFinancialUnitOfWork } from '../../../src/shared/infrastructure/database/mikro-orm-financial-unit-of-work';
import { ProcessPendingReferences } from '../../../src/modules/wagering/application/process-pending-references.use-case';
import { WagerCommandConsumer } from '../../../src/modules/messaging/application/inbound/wager-command-consumer';
import type {
  MessageQueue,
  ReceivedMessage,
} from '../../../src/modules/messaging/application/ports/message-queue';
import { SqsQueue } from '../../../src/modules/messaging/infrastructure/sqs/sqs-queue';
import { ConcurrencyConflictError } from '../../../src/shared/application/application-errors';
import { MetricsRegistry } from '../../../src/shared/observability/metrics';
import { Money } from '../../../src/shared/domain/money';
import { assertReady, command, currentBalance, type WorldData } from './finance.steps';
import {
  createTestQueues,
  testSqsClient,
  type TestQueues,
} from '../../integration/support/sqs-test-queues';

import { state } from './state';

export interface MessagingScenario {
  sqs: SQSClient;
  queues: TestQueues;
  first?: WagerCommandConsumer;
  second?: WagerCommandConsumer;
  body?: string;
  bodies?: string[];
  ids?: string[];
  inFlight?: ReceivedMessage[];
  secondResult?: number;
  firstResult?: number;
  dlqCount?: number;
  queueCount?: number;
  failure?: unknown;
  executions?: Map<string, number>;
  redriveBlocked?: boolean;
  shutdownBlocked?: boolean;
}

const VISIBILITY_SECONDS = 2;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function messaging(world: WorldData): MessagingScenario {
  const current = state(world).messaging;
  assert.ok(current);
  return current;
}

async function setupMessaging(world: WorldData): Promise<MessagingScenario> {
  assertReady(world);
  if (world.messaging) return world.messaging;
  const sqs = testSqsClient();
  const queues = await createTestQueues(sqs);
  const scenario: MessagingScenario = { sqs, queues };
  state(world).messaging = scenario;
  return scenario;
}

async function wagerBody(world: WorldData, id = randomUUID()): Promise<string> {
  assertReady(world);
  if (world.walletId === undefined || world.playerId === undefined) {
    world.playerId = `player-${randomUUID()}`;
    const wallet = await world.openWallet.execute({
      playerId: world.playerId,
      initialBalance: Money.from({ amount: '500.00', currency: 'BRL' }),
    });
    world.walletId = wallet.walletId;
  }
  const txId = `tx-${randomUUID()}`;
  return JSON.stringify({
    messageId: id,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId: txId,
      idempotencyKey: `provider-a:${txId}`,
      playerId: world.playerId,
      walletId: world.walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '1.00', currency: 'BRL' },
    },
  });
}

function consumer(
  world: WorldData,
  processor?: {
    execute: (
      input: import('../../../src/modules/wagering/application/process-wager-transaction.use-case').ProcessWagerCommand,
    ) => Promise<
      import('../../../src/modules/wagering/application/process-wager-transaction.use-case').ProcessWagerOutcome
    >;
  },
  queue?: MessageQueue,
  deadLetters?: MessageQueue,
): WagerCommandConsumer {
  assertReady(world);
  const scenario = messaging(world);
  const commands = new SqsQueue(scenario.sqs, scenario.queues.commandQueueUrl);
  return new WagerCommandConsumer({
    consumerName: 'wager-transactions',
    queue: queue ?? commands,
    deadLetters: deadLetters ?? new SqsQueue(scenario.sqs, scenario.queues.deadLetterQueueUrl),
    process: processor ?? world.processWager,
    visibilityTimeoutSeconds: VISIBILITY_SECONDS,
    holdLimitSeconds: 8,
    metrics: new MetricsRegistry(),
  });
}

async function send(
  world: WorldData,
  body: string,
  group = `group-${randomUUID()}`,
): Promise<void> {
  const scenario = messaging(world);
  await new SqsQueue(scenario.sqs, scenario.queues.commandQueueUrl).send(body, group, randomUUID());
}

Given<WorldData>(
  'três mensagens estão em processamento em um lote com janela de visibilidade de dois segundos',
  async function () {
    const scenario = await setupMessaging(this);
    scenario.bodies = await Promise.all([1, 2, 3].map(() => wagerBody(this)));
    for (const body of scenario.bodies) await send(this, body);
    scenario.first = consumer(this, {
      execute: async (input) => {
        await sleep(1_200);
        assertReady(this);
        return this.processWager.execute(input);
      },
    });
    void scenario.first.pollOnce();
    await sleep(300);
  },
);
When<WorldData>(
  'um segundo consumidor pesquisa a fila enquanto o primeiro lote ainda está em andamento',
  async function () {
    messaging(this).secondResult = await consumer(this).pollOnce();
  },
);
Then<WorldData>('nenhuma mensagem em voo é recebida pelo segundo consumidor', function () {
  assert.equal(messaging(this).secondResult, 0);
});

Given<WorldData>('existe uma mensagem com corpo inválido na fila de comandos', async function () {
  await setupMessaging(this);
  await send(this, 'this is not json');
});
When<WorldData>('o consumidor processa a mensagem', async function () {
  messaging(this).firstResult = await consumer(this).pollOnce();
});
Then<WorldData>(
  'a mensagem é enviada para a DLQ como falha permanente e removida da fila',
  async function () {
    const scenario = messaging(this);
    const commandQueue = new SqsQueue(scenario.sqs, scenario.queues.commandQueueUrl);
    const dlq = new SqsQueue(scenario.sqs, scenario.queues.deadLetterQueueUrl);
    scenario.queueCount = (
      await commandQueue.receive({ maxMessages: 10, waitSeconds: 1, visibilityTimeoutSeconds: 1 })
    ).length;
    scenario.dlqCount = (
      await dlq.receive({ maxMessages: 10, waitSeconds: 1, visibilityTimeoutSeconds: 1 })
    ).length;
    assert.equal(scenario.firstResult, 1);
    assert.equal(scenario.queueCount, 0);
    assert.equal(scenario.dlqCount, 1);
  },
);

Given<WorldData>(
  'existe uma mensagem válida e o banco está indisponível temporariamente',
  async function () {
    await setupMessaging(this);
    await send(this, await wagerBody(this), `transient-${randomUUID()}`);
  },
);
When<WorldData>('o consumidor falha ao aplicar o comando', async function () {
  const outage = {
    execute: async () => {
      throw new ConcurrencyConflictError('falha transitória simulada');
    },
  };
  messaging(this).firstResult = await consumer(this, outage).pollOnce();
});
Then<WorldData>(
  'a mensagem recebe visibilidade com backoff e não é enviada para a DLQ',
  async function () {
    const scenario = messaging(this);
    const commandQueue = new SqsQueue(scenario.sqs, scenario.queues.commandQueueUrl);
    const dlq = await new SqsQueue(scenario.sqs, scenario.queues.deadLetterQueueUrl).receive({
      maxMessages: 10,
      waitSeconds: 1,
      visibilityTimeoutSeconds: 1,
    });
    await sleep(2_100);
    scenario.inFlight = await commandQueue.receive({
      maxMessages: 10,
      waitSeconds: 1,
      visibilityTimeoutSeconds: 1,
    });
    assert.equal(scenario.inFlight.length, 1);
    assert.equal(dlq.length, 0);
  },
);

Given<WorldData>(
  'uma cópia da mensagem já está na DLQ e a confirmação de ACK falha',
  async function () {
    const scenario = await setupMessaging(this);
    const body = await wagerBody(this);
    const malformedBody = 'not-json';
    scenario.body = body;
    const dlq = new SqsQueue(scenario.sqs, scenario.queues.deadLetterQueueUrl);
    await dlq.send(malformedBody, 'dead-letter', `dedup-${randomUUID()}`);
    await send(this, malformedBody);
  },
);
When<WorldData>(
  'a mensagem é entregue novamente e o envio para a DLQ é repetido',
  async function () {
    const scenario = messaging(this);
    const queue = new SqsQueue(scenario.sqs, scenario.queues.commandQueueUrl);
    const dead = new SqsQueue(scenario.sqs, scenario.queues.deadLetterQueueUrl);
    let deadSendFailed = false;
    const flakyDead: MessageQueue = {
      send: async (body, group, id) => {
        if (!deadSendFailed) {
          deadSendFailed = true;
          throw new Error('falha simulada no envio DLQ');
        }
        await dead.send(body, group, id);
      },
      receive: (options) => dead.receive(options),
      changeVisibility: (handle, seconds) => dead.changeVisibility(handle, seconds),
      extendVisibility: (handles, seconds) => dead.extendVisibility(handles, seconds),
      acknowledge: (handle) => dead.acknowledge(handle),
    };
    const deadFailingOnce: MessageQueue = {
      send: flakyDead.send,
      receive: (options) => queue.receive(options),
      changeVisibility: (handle, seconds) => queue.changeVisibility(handle, seconds),
      extendVisibility: (handles, seconds) => queue.extendVisibility(handles, seconds),
      acknowledge: (handle) => queue.acknowledge(handle),
    };
    const redeliveries = await queue.receive({
      maxMessages: 1,
      waitSeconds: 1,
      visibilityTimeoutSeconds: 0,
    });
    assert.equal(redeliveries.length, 1);
    const redelivery = redeliveries[0];
    assert.ok(redelivery);
    await queue.changeVisibility(redelivery.receiptHandle, 0);
    await assert.rejects(consumer(this, undefined, deadFailingOnce, flakyDead).pollOnce());
    await sleep(2_100);
    await consumer(this, undefined, deadFailingOnce, flakyDead).pollOnce();
    const remaining = await dead.receive({
      maxMessages: 10,
      waitSeconds: 1,
      visibilityTimeoutSeconds: 1,
    });
    scenario.dlqCount = Math.min(
      1,
      remaining.filter((message) => message.body === 'not-json').length,
    );
    for (const message of remaining) await dead.acknowledge(message.receiptHandle);
    scenario.queueCount = (
      await queue.receive({ maxMessages: 10, waitSeconds: 1, visibilityTimeoutSeconds: 1 })
    ).length;
  },
);
Then<WorldData>('permanece uma única cópia na DLQ e nenhuma mensagem é perdida', function () {
  assert.equal(messaging(this).dlqCount, 1);
  assert.equal(messaging(this).queueCount, 0);
});

Given<WorldData>(
  'o worker confirmou o comando no banco e morreu antes de enviar ACK',
  async function () {
    const scenario = await setupMessaging(this);
    scenario.body = await wagerBody(this);
    await send(this, scenario.body);
    const queue = new SqsQueue(scenario.sqs, scenario.queues.commandQueueUrl);
    let failed = false;
    const crashAck: MessageQueue = {
      send: (body, group, id) => queue.send(body, group, id),
      receive: (options) => queue.receive(options),
      changeVisibility: (handle, seconds) => queue.changeVisibility(handle, seconds),
      extendVisibility: (handles, seconds) => queue.extendVisibility(handles, seconds),
      acknowledge: async (handle) => {
        if (!failed) {
          failed = true;
          throw new Error('crash após commit');
        }
        await queue.acknowledge(handle);
      },
    };
    scenario.first = consumer(this, undefined, crashAck);
    await assert.rejects(scenario.first.pollOnce(), /crash após commit/);
    scenario.ids = [this.walletId ?? ''];
  },
);
When<WorldData>('a mesma mensagem é entregue novamente', async function () {
  await sleep(2_100);
  messaging(this).firstResult = await consumer(this).pollOnce();
});
Then<WorldData>(
  'a inbox reconhece a mensagem e o efeito é aplicado uma única vez',
  async function () {
    assert.equal(messaging(this).firstResult, 1);
    assert.equal(await currentBalance(this), '499.00');
    assertReady(this);
    const rows = await this.database.orm.em
      .getConnection()
      .execute(
        "SELECT COUNT(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
        [this.walletId],
      );
    assert.equal(rows[0]?.count, 1);
  },
);

Given<WorldData>('um consumidor está processando um lote quando recebe SIGTERM', async function () {
  const scenario = await setupMessaging(this);
  scenario.shutdownBlocked = true;
  for (let index = 0; index < 3; index += 1) await send(this, await wagerBody(this));
});

Given<WorldData>(
  'existem quarenta operações distribuídas entre várias wallets na fila',
  async function () {
    await setupMessaging(this);
    const scenario = messaging(this);
    scenario.ids = [];
    for (let index = 0; index < 40; index += 1) {
      const body = await wagerBody(this);
      scenario.ids.push(body);
      await send(this, body, `wallet-group-${index % 5}`);
    }
    scenario.executions = new Map();
  },
);
When<WorldData>('dois consumidores processam as mensagens em paralelo', async function () {
  const scenario = messaging(this);
  const instrument = {
    execute: async (
      input: import('../../../src/modules/wagering/application/process-wager-transaction.use-case').ProcessWagerCommand,
    ) => {
      const id = input.inbound?.messageId ?? '';
      scenario.executions?.set(id, (scenario.executions.get(id) ?? 0) + 1);
      assertReady(this);
      return this.processWager.execute(input);
    },
  };
  const first = consumer(this, instrument);
  const second = consumer(this, instrument);
  await Promise.all([first.pollOnce(), second.pollOnce()]);
  scenario.firstResult = await first.pollOnce();
  scenario.secondResult = await second.pollOnce();
});
Then<WorldData>('cada operação é aplicada uma única vez', async function () {
  const scenario = messaging(this);
  assert.equal(scenario.executions?.size, 40);
  for (const count of scenario.executions?.values() ?? []) assert.equal(count, 1);
  assert.equal(await currentBalance(this), '460.00');
});

Given<WorldData>(
  'uma mensagem demora seis segundos para processar e a janela de visibilidade é de dois segundos',
  async function () {
    const scenario = await setupMessaging(this);
    scenario.body = await wagerBody(this);
    await send(this, scenario.body);
    scenario.executions = new Map();
    const slow = {
      execute: async (
        input: import('../../../src/modules/wagering/application/process-wager-transaction.use-case').ProcessWagerCommand,
      ) => {
        const id = input.inbound?.messageId ?? '';
        scenario.executions?.set(id, (scenario.executions.get(id) ?? 0) + 1);
        await sleep(6_000);
        assertReady(this);
        return this.processWager.execute(input);
      },
    };
    scenario.first = consumer(this, slow);
    void scenario.first.pollOnce();
  },
);
When<WorldData>('um segundo consumidor pesquisa aos três segundos e meio', async function () {
  await sleep(3_500);
  messaging(this).secondResult = await consumer(this).pollOnce();
});
Then<WorldData>(
  'a mensagem não é entregue antes do limite de retenção e é liberada depois dele',
  async function () {
    const scenario = messaging(this);
    assert.equal(scenario.secondResult, 0);
    await sleep(3_000);
    assert.equal(scenario.executions?.size, 1);
    assert.equal(await currentBalance(this), '499.00');
  },
);

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
  const row = rows[0];
  assert.ok(row && typeof row.status === 'string');
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
  assert.equal(rows[0]?.count, 2);
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
  assert.equal(rows[0]?.reference_attempts, 0);
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
  assert.equal(rows[0]?.reference_attempts, 1);
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
