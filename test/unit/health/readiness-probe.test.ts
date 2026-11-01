import { describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { HealthService } from '../../../src/health/health.service';

/**
 * Readiness reports each dependency on its own. A probe that fails must say so for that dependency, and the
 * report is ready only when both answer. The fakes below answer or refuse, and nothing else is simulated.
 */

function ormAnswering(answers: boolean): MikroORM {
  return {
    em: {
      getConnection: () => ({
        execute: async () => {
          if (!answers) {
            throw new Error('connection refused');
          }
          return [];
        },
      }),
    },
  } as unknown as MikroORM;
}

function sqsAnswering(answers: boolean): SQSClient {
  return {
    send: async () => {
      if (!answers) {
        throw new Error('endpoint unreachable');
      }
      return {};
    },
  } as unknown as SQSClient;
}

describe('the readiness probe', () => {
  test('is ready when the database and the queue both answer', async () => {
    const report = await new HealthService(
      ormAnswering(true),
      sqsAnswering(true),
      'http://q',
    ).ready();
    expect(report).toEqual({ ready: true, checks: { database: 'up', sqs: 'up' } });
  });

  test('names the database as down, and is not ready, when only the database refuses', async () => {
    const report = await new HealthService(
      ormAnswering(false),
      sqsAnswering(true),
      'http://q',
    ).ready();
    expect(report).toEqual({ ready: false, checks: { database: 'down', sqs: 'up' } });
  });

  test('names the queue as down, and is not ready, when only the queue refuses', async () => {
    const report = await new HealthService(
      ormAnswering(true),
      sqsAnswering(false),
      'http://q',
    ).ready();
    expect(report).toEqual({ ready: false, checks: { database: 'up', sqs: 'down' } });
  });

  test('is down for both when both refuse, and the reasons are not reported', async () => {
    const report = await new HealthService(
      ormAnswering(false),
      sqsAnswering(false),
      'http://q',
    ).ready();
    expect(JSON.stringify(report)).not.toContain('refused');
    expect(report).toEqual({ ready: false, checks: { database: 'down', sqs: 'down' } });
  });
});
