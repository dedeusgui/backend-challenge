import type { LedgerDirection } from '../../../shared/domain/ledger-direction';

export const WAGER_TRANSACTION_KINDS = [
  'OPENING',
  'BET',
  'WIN',
  'LOSS',
  'REFUND',
  'ROLLBACK',
] as const;

export type WagerTransactionKind = (typeof WAGER_TRANSACTION_KINDS)[number];

interface ReferenceRule {
  /** Kinds this transaction may reference. */
  readonly kinds: readonly WagerTransactionKind[];
  readonly required: boolean;
  /** Reversals restore the exact referenced amount; a WIN settles an independent amount. */
  readonly amountMustMatch: boolean;
  /**
   * The referenced BET must have no result yet (no PROCESSED WIN or LOSS). A BET settles once,
   * and a REFUND is only for a BET that has no result. ROLLBACK does not check results.
   */
  readonly mustBeUnsettled: boolean;
}

interface KindRules {
  readonly affectsBalance: boolean;
  /** Fixed direction, `'INVERSE_OF_REFERENCE'` for ROLLBACK, or undefined when there is no ledger effect. */
  readonly ledgerDirection: LedgerDirection | 'INVERSE_OF_REFERENCE' | undefined;
  readonly reference: ReferenceRule | undefined;
  readonly externallySubmittable: boolean;
}

/**
 * The specification requires a reference only for REFUND and ROLLBACK (challenge 6.3 and 7).
 * WIN and LOSS name the BET they settle when they can. Without that name a result cannot be
 * tied to its BET, so the one-result rule and the reversal rules apply only to linked results.
 */

/** The business rules of each kind, in one table so that they can be read at a glance. */
export const KIND_RULES: Readonly<Record<WagerTransactionKind, KindRules>> = {
  OPENING: {
    affectsBalance: true,
    ledgerDirection: 'CREDIT',
    reference: undefined,
    externallySubmittable: false,
  },
  BET: {
    affectsBalance: true,
    ledgerDirection: 'DEBIT',
    reference: undefined,
    externallySubmittable: true,
  },
  WIN: {
    affectsBalance: true,
    ledgerDirection: 'CREDIT',
    reference: { kinds: ['BET'], required: false, amountMustMatch: false, mustBeUnsettled: true },
    externallySubmittable: true,
  },
  LOSS: {
    affectsBalance: false,
    ledgerDirection: undefined,
    reference: { kinds: ['BET'], required: false, amountMustMatch: false, mustBeUnsettled: true },
    externallySubmittable: true,
  },
  REFUND: {
    affectsBalance: true,
    ledgerDirection: 'CREDIT',
    reference: { kinds: ['BET'], required: true, amountMustMatch: true, mustBeUnsettled: true },
    externallySubmittable: true,
  },
  /** A ROLLBACK applies in every state of the referenced transaction, with or without a result. */
  ROLLBACK: {
    affectsBalance: true,
    ledgerDirection: 'INVERSE_OF_REFERENCE',
    reference: {
      kinds: ['BET', 'WIN', 'REFUND'],
      required: true,
      amountMustMatch: true,
      mustBeUnsettled: false,
    },
    externallySubmittable: true,
  },
};

/** Narrows an untrusted value to a kind. Anything unknown is undefined, so the caller decides how to refuse it. */
export function parseWagerTransactionKind(value: unknown): WagerTransactionKind | undefined {
  return WAGER_TRANSACTION_KINDS.find((kind) => kind === value);
}
