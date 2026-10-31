import type { FinancialUnitOfWork } from './ports/financial-unit-of-work.port';

/**
 * Collaborators every financial use case receives. Time and identifiers are
 * injected so that tests are deterministic and no use case reads the wall clock.
 */
export interface ApplicationContext {
  unitOfWork: FinancialUnitOfWork;
  clock: () => Date;
  newId: () => string;
}
