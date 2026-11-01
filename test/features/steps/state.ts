import type { TestApp } from '../../e2e/support/test-app';
import type { ProcessWagerOutcome } from '../../../src/modules/wagering/application/process-wager-transaction.use-case';
import type { ProcessWagerCommand } from '../../../src/modules/wagering/application/process-wager-transaction.use-case';
import type { WalletQueries } from '../../../src/modules/wallet/application/wallet-queries';
import type {
  FinancialRepositories,
  FinancialUnitOfWork,
} from '../../../src/shared/application/ports/financial-unit-of-work';
import type { WorldData } from './finance.steps';
import type { OutboxPublisher } from '../../../src/modules/messaging/application/outbound/outbox-publisher';
import type { OutboxMessage } from '../../../src/modules/messaging/domain/outbox-message';
import type { MessagingScenario } from './mensageria.steps';

export interface ScenarioState {
  outcome?: ProcessWagerOutcome;
  rollback?: ProcessWagerOutcome;
  outcomes?: ProcessWagerOutcome[];
  betId?: string;
  refId?: string;
  referenceId?: string;
  targetId?: string;
  savedBalance?: string;
  errors?: unknown[];
  report?: Awaited<ReturnType<WalletQueries['reconcile']>>;
  version?: number;
  invalidAmounts?: string[];
  moneyFailures?: unknown[];
  api?: TestApp;
  apiStatus?: number;
  apiCode?: string;
  dbRejected?: boolean;
  first?: ProcessWagerOutcome;
  second?: ProcessWagerOutcome;
  error?: unknown;
  original?: ProcessWagerCommand;
  ids: string[];
  referenceIds: string[];
  crash?: FinancialUnitOfWork & { armed: boolean };
  crashRepositories?: FinancialRepositories;
  outboxPublisher?: OutboxPublisher;
  outboxSent?: string[];
  outboxAcceptedMalformed?: boolean;
  outboxAttempts?: number;
  outboxLeaseToken?: string;
  outboxClaimed?: OutboxMessage[];
  outboxStaleComplete?: boolean;
  outboxRows?: Array<{ id: string; attempts: number; published_at: Date | null; payload: unknown }>;
  outboxFirstSend?: string[];
  outboxSecondSend?: string[];
  messaging?: MessagingScenario;
}

const states = new WeakMap<WorldData, ScenarioState>();

export function state(world: WorldData): ScenarioState {
  let current = states.get(world);
  if (!current) {
    current = { ids: [], referenceIds: [] };
    states.set(world, current);
  }
  return current;
}
