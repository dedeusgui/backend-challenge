import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';

export const HEALTH_SERVICE = Symbol('HEALTH_SERVICE');

/** The only capability the readiness endpoint needs from its collaborator. */
export interface ReadinessProbe {
  ready(): Promise<ReadinessReport>;
}

export interface ReadinessReport {
  ready: boolean;
  checks: { database: 'up' | 'down'; sqs: 'up' | 'down' };
}

/** Readiness probes the real dependencies. It never reports ready on assumption. */
export class HealthService implements ReadinessProbe {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly commandQueueUrl: string,
  ) {}

  async ready(): Promise<ReadinessReport> {
    const [database, sqs] = await Promise.all([this.databaseIsUp(), this.sqsIsUp()]);
    const checks = {
      database: database ? ('up' as const) : ('down' as const),
      sqs: sqs ? ('up' as const) : ('down' as const),
    };
    return { ready: database && sqs, checks };
  }

  private async databaseIsUp(): Promise<boolean> {
    try {
      await this.orm.em.getConnection().execute('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  private async sqsIsUp(): Promise<boolean> {
    try {
      await this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: this.commandQueueUrl,
          AttributeNames: ['QueueArn'],
        }),
      );
      return true;
    } catch {
      return false;
    }
  }
}
