/**
 * Application-level failures. They are not HTTP concepts: the HTTP and queue
 * adapters decide how each one is reported or retried.
 */

/** Another writer changed the row after it was read. The unit of work rolled back. */
export class ConcurrencyConflictError extends Error {
  readonly code = 'CONCURRENCY_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'ConcurrencyConflictError';
  }
}
