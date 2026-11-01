import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Given, Then, When } from '@cucumber/cucumber';
import { OutboxPublisher } from '../../../src/modules/messaging/application/outbound/outbox-publisher';
import type {
  OutboxTransport,
  OutboxTransportFailure,
  OutboxTransportMessage,
} from '../../../src/modules/messaging/application/ports/outbox-transport';
import { MikroOrmOutboxStore } from '../../../src/modules/messaging/infrastructure/mikro-orm-outbox.store';
import type { OutboxStore } from '../../../src/modules/messaging/application/ports/outbox-store';
import { Money } from '../../../src/shared/domain/money';
import { assertReady, command, type WorldData } from './finance.steps';
import { state } from './state';

const LEASE_MS = 30_000;

class RecordingTransport implements OutboxTransport {
  readonly sent: string[] = [];
  async publish(
    messages: readonly OutboxTransportMessage[],
  ): Promise<readonly OutboxTransportFailure[]> {
    this.sent.push(...messages.map((message) => message.id));
    return [];
  }
}

class RefusingTransport implements OutboxTransport {
  async publish(
    messages: readonly OutboxTransportMessage[],
  ): Promise<readonly OutboxTransportFailure[]> {
    return messages.map((message) => ({ id: message.id, error: new Error('broker indisponível') }));
  }
}

class PartialTransport implements OutboxTransport {
  async publish(
    messages: readonly OutboxTransportMessage[],
  ): Promise<readonly OutboxTransportFailure[]> {
    return messages
      .filter((_, index) => index % 2 === 1)
      .map((message) => ({
        id: message.id,
        error: new Error('broker recusou'),
      }));
  }
}

class CrashBeforeComplete implements OutboxStore {
  constructor(private readonly inner: OutboxStore) {}
  claimDue(request: Parameters<OutboxStore['claimDue']>[0]) {
    return this.inner.claimDue(request);
  }
  complete(): Promise<readonly string[]> {
    return Promise.reject(new Error('falha antes da confirmação'));
  }
  reschedule(message: Parameters<OutboxStore['reschedule']>[0], token: string) {
    return this.inner.reschedule(message, token);
  }
}

class CollectTransport implements OutboxTransport {
  constructor(private readonly sent: string[]) {}
  async publish(
    messages: readonly OutboxTransportMessage[],
  ): Promise<readonly OutboxTransportFailure[]> {
    this.sent.push(...messages.map((message) => message.id));
    return [];
  }
}

async function enqueueEvents(world: WorldData, count = 1): Promise<void> {
  assertReady(world);
  const playerId = `player-${randomUUID()}`;
  const { walletId } = await world.openWallet.execute({
    playerId,
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
  });
  world.playerId = playerId;
  world.walletId = walletId;
  for (let index = 0; index < count; index += 1) {
    const id = `bet-${randomUUID()}`;
    await world.processWager.execute(
      command(world, 'BET', '1.00', {
        playerId,
        walletId,
        externalTransactionId: id,
        idempotencyKey: `provider-a:${id}`,
      }),
    );
  }
}

function publisher(world: WorldData, transport: OutboxTransport, batchSize = 50): OutboxPublisher {
  assertReady(world);
  return new OutboxPublisher({
    store: new MikroOrmOutboxStore(world.database.orm),
    transport,
    clock: () => new Date(),
    newLeaseToken: randomUUID,
    leaseDurationMs: LEASE_MS,
    batchSize,
  });
}

Given<WorldData>('o banco de teste está pronto para gravar eventos no outbox', async function () {
  await enqueueEvents(this);
});
When<WorldData>('tento gravar um envelope malformado no outbox', async function () {
  assertReady(this);
  try {
    await this.database.orm.em.getConnection().execute(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
       VALUES (?, ?, ?, ?::jsonb, now(), now())`,
      [randomUUID(), randomUUID(), 'Broken', JSON.stringify({ eventType: 'Broken' })],
    );
    state(this).outboxAcceptedMalformed = true;
  } catch {
    state(this).outboxAcceptedMalformed = false;
  }
  const transport = new RecordingTransport();
  state(this).outboxPublisher = publisher(this, transport);
  state(this).outboxSent = transport.sent;
});
Then<WorldData>(
  'a escrita é recusada e o publicador continua processando os demais eventos',
  async function () {
    assert.equal(state(this).outboxAcceptedMalformed, false);
    const outboxPublisher = state(this).outboxPublisher;
    assert.ok(outboxPublisher);
    assert.ok((await outboxPublisher.publishOnce()) > 0);
    assert.ok((state(this).outboxSent?.length ?? 0) > 0);
  },
);

Given<WorldData>('existem eventos pendentes no outbox', async function () {
  await enqueueEvents(this, 1);
});

Given<WorldData>('um publicador mantém um evento sob lease', async function () {
  await enqueueEvents(this, 1);
  assertReady(this);
  const token = randomUUID();
  const claimed = await new MikroOrmOutboxStore(this.database.orm).claimDue({
    token,
    leaseMs: 30_000,
    limit: 50,
  });
  assert.ok(claimed.length > 0);
  state(this).outboxLeaseToken = token;
  state(this).outboxClaimed = claimed;
});
When<WorldData>('o lease expira e outro publicador assume o evento', async function () {
  assertReady(this);
  await this.database.orm.em
    .getConnection()
    .execute(
      "UPDATE outbox_messages SET lease_expires_at = now() - interval '1 second' WHERE lease_token = ?",
      [state(this).outboxLeaseToken],
    );
  const successor = await new MikroOrmOutboxStore(this.database.orm).claimDue({
    token: randomUUID(),
    leaseMs: 30_000,
    limit: 50,
  });
  assert.ok(successor.length > 0);
  const claimed = state(this).outboxClaimed;
  const token = state(this).outboxLeaseToken;
  assert.ok(claimed && token);
  state(this).outboxStaleComplete =
    (await new MikroOrmOutboxStore(this.database.orm).complete(claimed, token, new Date()))
      .length === 0;
});
Then<WorldData>('a conclusão do publicador lento é recusada', function () {
  assert.equal(state(this).outboxStaleComplete, true);
});

Given<WorldData>('há um lote de eventos pendentes no outbox', async function () {
  await enqueueEvents(this, 2);
});
When<WorldData>('o broker aceita parte do lote e recusa os demais', async function () {
  await publisher(this, new PartialTransport()).publishOnce();
});
Then<WorldData>('somente os eventos recusados são reagendados', async function () {
  assertReady(this);
  const value: unknown = await this.database.orm.em
    .getConnection()
    .execute(
      'SELECT id, attempts, published_at, payload FROM outbox_messages ORDER BY occurred_at',
    );
  assert.ok(Array.isArray(value));
  const parsed: Array<{
    id: string;
    attempts: number;
    published_at: Date | null;
    payload: unknown;
  }> = [];
  for (const row of value) {
    assert.ok(typeof row === 'object' && row !== null);
    assert.ok('id' in row && typeof row.id === 'string');
    assert.ok('attempts' in row && typeof row.attempts === 'number');
    assert.ok('published_at' in row);
    assert.ok('payload' in row);
    const publishedAt = row.published_at;
    parsed.push({
      id: row.id,
      attempts: row.attempts,
      published_at:
        publishedAt === null
          ? null
          : publishedAt instanceof Date || typeof publishedAt === 'string'
            ? new Date(publishedAt)
            : null,
      payload: row.payload,
    });
  }
  state(this).outboxRows = parsed;
  const rows = state(this).outboxRows;
  assert.ok(rows && rows.length > 0);
  const expectedFailed = Math.floor(rows.length / 2);
  assert.equal(
    rows.filter((row) => row.published_at !== null).length,
    rows.length - expectedFailed,
  );
  assert.equal(rows.filter((row) => row.attempts === 1).length, expectedFailed);
});

Given<WorldData>(
  'um evento foi aceito pelo broker antes da confirmação no outbox',
  async function () {
    await enqueueEvents(this);
  },
);
When<WorldData>(
  'o publicador falha antes de marcar o evento como publicado e tenta novamente',
  async function () {
    assertReady(this);
    const ids: string[] = [];
    const store = new CrashBeforeComplete(new MikroOrmOutboxStore(this.database.orm));
    const crashing = new OutboxPublisher({
      store,
      transport: new CollectTransport(ids),
      clock: () => new Date(),
      newLeaseToken: randomUUID,
      leaseDurationMs: 30_000,
      batchSize: 50,
    });
    await assert.rejects(crashing.publishOnce(), /falha antes da confirmação/);
    await this.database.orm.em
      .getConnection()
      .execute("UPDATE outbox_messages SET lease_expires_at = now() - interval '1 second'");
    await publisher(this, new CollectTransport(ids)).publishOnce();
    state(this).outboxSent = ids;
  },
);
Then<WorldData>('o evento é republicado com o mesmo identificador', function () {
  const sent = state(this).outboxSent;
  assert.ok(sent);
  assert.ok(sent.length > 0 && sent.length % 2 === 0);
  const half = sent.length / 2;
  assert.deepEqual([...sent.slice(0, half)].sort(), [...sent.slice(half)].sort());
});

Given<WorldData>('há eventos de versões sucessivas da mesma wallet no outbox', async function () {
  await enqueueEvents(this, 1);
});
When<WorldData>('dois publicadores enviam esses eventos em paralelo', async function () {
  const first: string[] = [];
  const second: string[] = [];
  await Promise.all([
    publisher(this, new CollectTransport(first), 1).publishOnce(),
    publisher(this, new CollectTransport(second), 1).publishOnce(),
  ]);
  state(this).outboxFirstSend = first;
  state(this).outboxSecondSend = second;
});
Then<WorldData>(
  'a ordem de envio não é garantida e cada evento mantém sua versão da wallet',
  async function () {
    assertReady(this);
    const sent = [...(state(this).outboxFirstSend ?? []), ...(state(this).outboxSecondSend ?? [])];
    assert.equal(sent.length, 2);
    assert.equal(new Set(sent).size, 2);
    const rows: unknown = await this.database.orm.em
      .getConnection()
      .execute('SELECT id, payload FROM outbox_messages WHERE id IN (?, ?)', sent);
    assert.ok(Array.isArray(rows));
    for (const row of rows) {
      assert.ok(typeof row === 'object' && row !== null && 'payload' in row);
      const payload: unknown = row.payload;
      assert.ok(typeof payload === 'object' && payload !== null && 'version' in payload);
      assert.ok(typeof payload.version === 'number' && payload.version > 0);
    }
  },
);

Given<WorldData>('um evento está sob lease ativo no relógio do banco', async function () {
  await enqueueEvents(this);
  assertReady(this);
  const held = new RecordingTransport();
  const publisherHolding = publisher(this, held, 1);
  // The claim is made directly so it remains held while the other publisher runs.
  const token = randomUUID();
  const claimed = await new MikroOrmOutboxStore(this.database.orm).claimDue({
    token,
    leaseMs: 30_000,
    limit: 50,
  });
  assert.ok(claimed.length > 0);
  state(this).outboxLeaseToken = token;
  state(this).outboxClaimed = claimed;
  state(this).outboxPublisher = publisherHolding;
});
When<WorldData>(
  'outro publicador com relógio uma hora adiantado tenta reivindicá-lo',
  async function () {
    assertReady(this);
    const transport = new RecordingTransport();
    const ahead = new OutboxPublisher({
      store: new MikroOrmOutboxStore(this.database.orm),
      transport,
      clock: () => new Date(Date.now() + 3_600_000),
      newLeaseToken: randomUUID,
      leaseDurationMs: 30_000,
      batchSize: 50,
    });
    state(this).outboxAttempts = await ahead.publishOnce();
    state(this).outboxSent = transport.sent;
  },
);
Then<WorldData>('o lease ativo não é roubado', function () {
  assert.equal(state(this).outboxAttempts, 0);
  assert.deepEqual(state(this).outboxSent, []);
});
When<WorldData>('dois publicadores reivindicam eventos em paralelo', async function () {
  const firstTransport = new RecordingTransport();
  const secondTransport = new RecordingTransport();
  const results = await Promise.all([
    publisher(this, firstTransport, 1).publishOnce(),
    publisher(this, secondTransport, 1).publishOnce(),
  ]);
  assert.equal(
    results.reduce((sum, result) => sum + result, 0),
    2,
  );
  state(this).outboxSent = [...firstTransport.sent, ...secondTransport.sent];
});
Then<WorldData>('cada evento é enviado uma única vez', function () {
  const sent = state(this).outboxSent;
  assert.ok(sent);
  assert.equal(sent.length, 2);
  assert.equal(new Set(sent).size, sent.length);
});

Given<WorldData>('um evento recusado pelo broker foi reagendado com backoff', async function () {
  await enqueueEvents(this);
  await publisher(this, new RefusingTransport()).publishOnce();
});
When<WorldData>(
  'um publicador com relógio atrasado tenta processá-lo antes do prazo',
  async function () {
    assertReady(this);
    const transport = new RefusingTransport();
    const behind = new OutboxPublisher({
      store: new MikroOrmOutboxStore(this.database.orm),
      transport,
      clock: () => new Date(Date.now() - 3_600_000),
      newLeaseToken: randomUUID,
      leaseDurationMs: LEASE_MS,
      batchSize: 50,
    });
    const processed = await behind.publishOnce();
    state(this).outboxAttempts = processed;
  },
);
Then<WorldData>(
  'o evento permanece aguardando o prazo calculado pelo relógio do banco',
  async function () {
    assert.equal(state(this).outboxAttempts, 0);
    assertReady(this);
    const rows: unknown = await this.database.orm.em.getConnection().execute(
      `SELECT attempts, EXTRACT(EPOCH FROM (next_attempt_at - now()))::text AS seconds_until_next
         FROM outbox_messages WHERE published_at IS NULL ORDER BY occurred_at LIMIT 1`,
    );
    assert.ok(Array.isArray(rows));
    const first: unknown = rows[0];
    assert.ok(typeof first === 'object' && first !== null);
    assert.ok('attempts' in first && first.attempts === 1);
    assert.ok('seconds_until_next' in first && typeof first.seconds_until_next === 'string');
    assert.ok(Number(first.seconds_until_next) > 0);
  },
);
