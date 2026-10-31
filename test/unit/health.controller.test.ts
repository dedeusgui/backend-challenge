import { describe, expect, test } from 'bun:test';
import { HealthController } from '../../src/health/health.controller';

describe('HealthController', () => {
  test('reports a live process', () => {
    expect(new HealthController().live()).toEqual({ status: 'ok' });
  });
});
