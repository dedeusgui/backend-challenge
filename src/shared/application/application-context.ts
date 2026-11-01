import type { MetricsSink } from '../observability/metrics';
import type { FinancialUnitOfWork } from './ports/financial-unit-of-work';

/**
 * Collaborators every financial use case receives. Time and identifiers are injected
 * so that tests are deterministic and no use case reads the wall clock.
 */
export interface ApplicationContext {
  unitOfWork: FinancialUnitOfWork;
  clock: () => Date;
  newId: () => string;
  /** Optional: when absent, instrumentation records nothing. */
  metrics?: MetricsSink;
}
