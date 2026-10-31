import { describe, expect, test } from 'bun:test';
import { HealthController } from '../../src/health/health.controller';
import type { ReadinessProbe } from '../../src/health/health.service';

/** Liveness does not consult dependencies, so this readiness collaborator must never be called. */
const mustNotBeConsulted: ReadinessProbe = {
  ready: async () => {
    throw new Error('liveness must not check dependencies');
  },
};

describe('HealthController', () => {
  test('reports a live process without consulting any dependency', () => {
    expect(new HealthController(mustNotBeConsulted).live()).toEqual({ status: 'ok' });
  });
});
