/**
 * The database's own clock. A time that decides whether held work is due, or when it is next due, is read from
 * here, so the clocks of the workers do not decide either.
 */
export interface DatabaseClock {
  /** The time at which the current transaction started, as the database reads it. */
  now(): Promise<Date>;
}
