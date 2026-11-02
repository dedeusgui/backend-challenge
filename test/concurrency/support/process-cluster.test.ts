import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { expect, test } from 'bun:test';
import { ormOptions } from '../../../src/shared/infrastructure/database/orm-config';
import { DATABASE_URL } from '../../integration/support/test-database';
import { testSqsClient } from '../../integration/support/sqs-test-queues';
import { ProcessCluster } from './process-cluster';

test('closes its database, queues, and client idempotently', async () => {
  const cluster = await ProcessCluster.create();
  const databaseName = new URL(cluster.database.url).pathname.slice(1);
  const sqs = testSqsClient();
  try {
    await cluster.close();
    await cluster.close();

    await expect(
      sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: cluster.queues.commandQueueUrl,
          AttributeNames: ['QueueArn'],
        }),
      ),
    ).rejects.toThrow();

    const admin = await MikroORM.init(ormOptions(DATABASE_URL));
    try {
      const rows = (await admin.em
        .getConnection()
        .execute('SELECT 1 FROM pg_database WHERE datname = ?', [databaseName])) as unknown[];
      expect(rows).toHaveLength(0);
    } finally {
      await admin.close(true);
    }
  } finally {
    await cluster.close().catch(() => {});
    sqs.destroy();
  }
});
