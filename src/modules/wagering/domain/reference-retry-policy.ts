/**
 * How long a transaction may wait for its reference. The limit is explicit: after
 * MAX_REFERENCE_ATTEMPTS misses, the transaction is rejected with REFERENCE_NOT_FOUND.
 * Delays grow exponentially from 1 s and are capped at 5 minutes.
 */
export const MAX_REFERENCE_ATTEMPTS = 6;

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 300_000;

/** Delay before the attempt that follows `missesSoFar` misses. The first attempt uses missesSoFar = 0. */
export function referenceRetryDelayMs(missesSoFar: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** missesSoFar, MAX_DELAY_MS);
}
