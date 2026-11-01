import { KIND_RULES, type WagerTransactionKind } from './wager-transaction-kind';
import type { FailureCode } from './failure-code';

/**
 * The lifecycle of a provider operation, in one place. Two rules live here and nowhere else:
 *
 * 1. Which status changes a transaction may make (`STATUS_TRANSITIONS`). A status that is not listed as a
 *    target of another status is unreachable from it, and a change that is not listed is refused.
 * 2. Whether a new operation may apply, given every result that its referenced transaction already has
 *    (`decideAgainstHistory`). The settlement service asks this question and applies the answer.
 *
 * The database enforces the first rule as well (migration 10, `wager_status_transition_is_allowed`), from
 * the same table. A test reads both and requires them to agree on every pair of statuses.
 */

export const WAGER_TRANSACTION_STATUSES = [
  'PENDING',
  'PENDING_REFERENCE',
  'PROCESSED',
  'REJECTED',
  'FAILED',
] as const;

export type WagerTransactionStatus = (typeof WAGER_TRANSACTION_STATUSES)[number];

/**
 * Every status change a transaction can make. PROCESSED, REJECTED and FAILED are terminal: they have no
 * targets. PENDING_REFERENCE may repeat itself, because each missed reference lookup is recorded as a change.
 */
export const STATUS_TRANSITIONS: Readonly<
  Record<WagerTransactionStatus, readonly WagerTransactionStatus[]>
> = {
  PENDING: ['PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'],
  PENDING_REFERENCE: ['PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'],
  PROCESSED: [],
  REJECTED: [],
  FAILED: [],
};

export function canChangeStatus(from: WagerTransactionStatus, to: WagerTransactionStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

/** The results a referenced transaction already has. `reversed` means a REFUND or ROLLBACK is PROCESSED against it. */
export interface ReferenceHistory {
  readonly settled: boolean;
  readonly reversed: boolean;
}

export type HistoryDecision =
  | { readonly outcome: 'ACCEPT' }
  | {
      readonly outcome: 'REJECT';
      readonly code: Extract<
        FailureCode,
        'REFERENCE_ALREADY_REVERSED' | 'REFERENCE_ALREADY_SETTLED'
      >;
    };

/**
 * Decides whether an operation may apply, given the results its referenced transaction already has.
 *
 * - A referenced transaction is reversed at most once, whatever the kind of reversal, and no operation
 *   applies to a reference that was reversed. So a REFUND or a ROLLBACK after a ROLLBACK is refused, and
 *   so is a WIN, a LOSS or a REFUND after one. A ROLLBACK that undoes a REFUND does not reopen the reference
 *   (the owner's decision D4).
 * - A kind whose rule requires an unsettled reference (WIN, LOSS, REFUND) is refused once a result exists.
 *   ROLLBACK applies in every state of its reference (D2).
 *
 * Called only for a transaction that names a reference. Without a reference there is no history to check.
 */
export function decideAgainstHistory(
  kind: WagerTransactionKind,
  history: ReferenceHistory,
): HistoryDecision {
  if (history.reversed) {
    return { outcome: 'REJECT', code: 'REFERENCE_ALREADY_REVERSED' };
  }
  if (KIND_RULES[kind].reference?.mustBeUnsettled === true && history.settled) {
    return { outcome: 'REJECT', code: 'REFERENCE_ALREADY_SETTLED' };
  }
  return { outcome: 'ACCEPT' };
}
