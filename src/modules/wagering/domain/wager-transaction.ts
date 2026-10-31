import { DomainError } from '../../../shared/domain/domain-error';
import type { LedgerDirection } from '../../../shared/domain/ledger-direction';
import { Money } from '../../../shared/domain/money';
import type { FailureCode } from './failure-code';
import { KIND_RULES, type WagerTransactionKind } from './wager-transaction-kind';
import { MAX_REFERENCE_ATTEMPTS, referenceRetryDelayMs } from './reference-retry-policy';

export type { WagerTransactionKind } from './wager-transaction-kind';

export const WAGER_TRANSACTION_STATUSES = [
  'PENDING',
  'PENDING_REFERENCE',
  'PROCESSED',
  'REJECTED',
  'FAILED',
] as const;

export type WagerTransactionStatus = (typeof WAGER_TRANSACTION_STATUSES)[number];

const TERMINAL_STATUSES: readonly WagerTransactionStatus[] = ['PROCESSED', 'REJECTED', 'FAILED'];

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  /** Balance after a PROCESSED transaction, or the balance observed when it was REJECTED or FAILED. */
  resultingBalance: Money | undefined;
  processedAt: Date | undefined;
  /** Reference lookups that found the reference missing or still pending. */
  referenceAttempts: number;
  referenceNextAttemptAt: Date | undefined;
}

export type CreateWagerTransactionProps = Pick<
  WagerTransactionState,
  | 'id'
  | 'providerId'
  | 'externalTransactionId'
  | 'idempotencyKey'
  | 'payloadHash'
  | 'walletId'
  | 'playerId'
  | 'roundId'
  | 'gameId'
  | 'kind'
  | 'money'
  | 'referenceExternalTransactionId'
  | 'createdAt'
>;

export interface ProcessedTransition {
  referenceTransactionId: string | undefined;
  resultingBalance: Money;
  at: Date;
}

export interface TerminalRejection {
  code: FailureCode;
  observedBalance: Money | undefined;
}

/** What to do with a transaction given the state of its reference. */
export type ReferenceEvaluation =
  { outcome: 'READY' } | { outcome: 'WAIT' } | { outcome: 'REJECT'; code: FailureCode };

/**
 * A provider operation on a round, with its own status state machine.
 *
 * PROCESSED, REJECTED and FAILED are terminal. Any transition out of a terminal
 * state is a programming error and throws INVALID_TRANSACTION_TRANSITION.
 */
export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly createdAt: Date;
  private currentStatus: WagerTransactionStatus;
  private currentReferenceTransactionId: string | undefined;
  private currentFailureCode: FailureCode | undefined;
  private currentResultingBalance: Money | undefined;
  private currentProcessedAt: Date | undefined;
  private currentReferenceAttempts: number;
  private currentReferenceNextAttemptAt: Date | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAt = state.createdAt;
    this.currentStatus = state.status;
    this.currentReferenceTransactionId = state.referenceTransactionId;
    this.currentFailureCode = state.failureCode;
    this.currentResultingBalance = state.resultingBalance;
    this.currentProcessedAt = state.processedAt;
    this.currentReferenceAttempts = state.referenceAttempts;
    this.currentReferenceNextAttemptAt = state.referenceNextAttemptAt;
  }

  /** Creates a transaction in PENDING after checking its shape against the kind's rules. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const rules = KIND_RULES[props.kind];
    const hasReference = props.referenceExternalTransactionId !== undefined;
    if (rules.reference?.required === true && !hasReference) {
      throw new DomainError('INVALID_TRANSACTION', `${props.kind} requires a reference`);
    }
    if (rules.reference === undefined && hasReference) {
      throw new DomainError('INVALID_TRANSACTION', `${props.kind} must not carry a reference`);
    }
    if (props.money.isNegative()) {
      throw new DomainError('INVALID_TRANSACTION', 'The amount cannot be negative');
    }
    if (rules.affectsBalance && props.money.isZero()) {
      throw new DomainError('INVALID_TRANSACTION', `${props.kind} must move a positive amount`);
    }

    return new WagerTransaction({
      ...props,
      status: 'PENDING',
      referenceTransactionId: undefined,
      failureCode: undefined,
      resultingBalance: undefined,
      processedAt: undefined,
      referenceAttempts: 0,
      referenceNextAttemptAt: undefined,
    });
  }

  /** Rebuilds persisted state. Does not revalidate transitions, by design. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  /** OPENING is internal: wallet creation produces it, providers cannot submit it. */
  static isExternallySubmittable(kind: WagerTransactionKind): boolean {
    return KIND_RULES[kind].externallySubmittable;
  }

  get status(): WagerTransactionStatus {
    return this.currentStatus;
  }

  get referenceTransactionId(): string | undefined {
    return this.currentReferenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this.currentFailureCode;
  }

  get resultingBalance(): Money | undefined {
    return this.currentResultingBalance;
  }

  get processedAt(): Date | undefined {
    return this.currentProcessedAt;
  }

  get referenceAttempts(): number {
    return this.currentReferenceAttempts;
  }

  get referenceNextAttemptAt(): Date | undefined {
    return this.currentReferenceNextAttemptAt;
  }

  affectsBalance(): boolean {
    return KIND_RULES[this.kind].affectsBalance;
  }

  requiresReference(): boolean {
    return KIND_RULES[this.kind].reference?.required === true;
  }

  isReversal(): boolean {
    return this.kind === 'REFUND' || this.kind === 'ROLLBACK';
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.includes(this.currentStatus);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direction of this transaction's ledger entry. A ROLLBACK moves the balance
   * opposite to the transaction it references, so it needs that reference.
   */
  ledgerDirectionFor(reference: WagerTransaction | undefined): LedgerDirection {
    const effect = KIND_RULES[this.kind].ledgerDirection;
    if (effect === undefined) {
      throw new DomainError('INVALID_TRANSACTION', `${this.kind} has no ledger effect`);
    }
    if (effect !== 'INVERSE_OF_REFERENCE') {
      return effect;
    }
    if (reference === undefined) {
      throw new DomainError(
        'INVALID_TRANSACTION',
        'A ROLLBACK needs its reference to pick a direction',
      );
    }
    const referenceDirection = KIND_RULES[reference.kind].ledgerDirection;
    if (referenceDirection === undefined || referenceDirection === 'INVERSE_OF_REFERENCE') {
      throw new DomainError('INVALID_TRANSACTION', `${reference.kind} cannot be rolled back`);
    }
    return referenceDirection === 'DEBIT' ? 'CREDIT' : 'DEBIT';
  }

  /** The wallet must belong to the same player and use the same currency. */
  walletMismatch(wallet: { playerId: string; currency: string }): FailureCode | undefined {
    if (wallet.playerId !== this.playerId) {
      return 'WALLET_PLAYER_MISMATCH';
    }
    if (wallet.currency !== this.money.currency) {
      return 'WALLET_CURRENCY_MISMATCH';
    }
    return undefined;
  }

  /**
   * Decides whether the reference allows this transaction to apply now. Missing
   * or still-pending references wait; a rejected one, or one that breaks the
   * rules, is a business rejection.
   */
  evaluateReference(reference: WagerTransaction | undefined): ReferenceEvaluation {
    if (this.referenceExternalTransactionId === undefined) {
      return { outcome: 'READY' };
    }
    if (reference === undefined) {
      return { outcome: 'WAIT' };
    }
    if (reference.status === 'PENDING' || reference.status === 'PENDING_REFERENCE') {
      return { outcome: 'WAIT' };
    }
    if (reference.status !== 'PROCESSED') {
      return { outcome: 'REJECT', code: 'REFERENCE_NOT_PROCESSED' };
    }
    if (!this.sharesContextWith(reference)) {
      return { outcome: 'REJECT', code: 'REFERENCE_CONTEXT_MISMATCH' };
    }

    const rule = KIND_RULES[this.kind].reference;
    if (rule === undefined) {
      return { outcome: 'READY' };
    }
    if (!rule.kinds.includes(reference.kind)) {
      return { outcome: 'REJECT', code: 'REFERENCE_KIND_NOT_ALLOWED' };
    }
    if (rule.amountMustMatch && !reference.money.equals(this.money)) {
      return { outcome: 'REJECT', code: 'REFERENCE_AMOUNT_MISMATCH' };
    }
    return { outcome: 'READY' };
  }

  /** Holds the transaction until its reference arrives. The first lookup is due at `nextAttemptAt`. */
  markPendingReference(nextAttemptAt: Date): void {
    this.assertTransitionFrom(['PENDING']);
    this.currentStatus = 'PENDING_REFERENCE';
    this.currentReferenceNextAttemptAt = nextAttemptAt;
  }

  /** The reference was still missing. Schedules the next lookup, or reports that the limit is reached. */
  recordReferenceMiss(now: Date): { exhausted: boolean } {
    this.assertTransitionFrom(['PENDING_REFERENCE']);
    this.currentReferenceAttempts += 1;
    if (this.currentReferenceAttempts >= MAX_REFERENCE_ATTEMPTS) {
      return { exhausted: true };
    }
    this.currentReferenceNextAttemptAt = new Date(
      now.getTime() + referenceRetryDelayMs(this.currentReferenceAttempts),
    );
    return { exhausted: false };
  }

  /** Whether a held transaction is due for another reference lookup at `now`. */
  isDueForReferenceLookup(now: Date): boolean {
    return (
      this.currentStatus === 'PENDING_REFERENCE' &&
      this.currentReferenceNextAttemptAt !== undefined &&
      this.currentReferenceNextAttemptAt.getTime() <= now.getTime()
    );
  }

  markProcessed(transition: ProcessedTransition): void {
    this.assertTransitionFrom(['PENDING', 'PENDING_REFERENCE']);
    if (this.requiresReference() && transition.referenceTransactionId === undefined) {
      throw new DomainError(
        'INVALID_TRANSACTION',
        `${this.kind} cannot be processed without its reference`,
      );
    }
    this.currentStatus = 'PROCESSED';
    this.currentReferenceTransactionId = transition.referenceTransactionId;
    this.currentResultingBalance = transition.resultingBalance;
    this.currentProcessedAt = transition.at;
  }

  reject(rejection: TerminalRejection): void {
    this.assertTransitionFrom(['PENDING', 'PENDING_REFERENCE']);
    this.currentStatus = 'REJECTED';
    this.currentFailureCode = rejection.code;
    this.currentResultingBalance = rejection.observedBalance;
  }

  fail(failure: TerminalRejection): void {
    this.assertTransitionFrom(['PENDING', 'PENDING_REFERENCE']);
    this.currentStatus = 'FAILED';
    this.currentFailureCode = failure.code;
    this.currentResultingBalance = failure.observedBalance;
  }

  /** A snapshot suitable for persistence. Money is immutable, so sharing it is safe. */
  toState(): WagerTransactionState {
    return {
      id: this.id,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey,
      payloadHash: this.payloadHash,
      walletId: this.walletId,
      playerId: this.playerId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      money: this.money,
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      createdAt: this.createdAt,
      status: this.currentStatus,
      referenceTransactionId: this.currentReferenceTransactionId,
      failureCode: this.currentFailureCode,
      resultingBalance: this.currentResultingBalance,
      processedAt: this.currentProcessedAt,
      referenceAttempts: this.currentReferenceAttempts,
      referenceNextAttemptAt: this.currentReferenceNextAttemptAt,
    };
  }

  private sharesContextWith(reference: WagerTransaction): boolean {
    return (
      reference.providerId === this.providerId &&
      reference.playerId === this.playerId &&
      reference.walletId === this.walletId &&
      reference.roundId === this.roundId &&
      reference.money.currency === this.money.currency
    );
  }

  private assertTransitionFrom(allowed: readonly WagerTransactionStatus[]): void {
    if (!allowed.includes(this.currentStatus)) {
      throw new DomainError(
        'INVALID_TRANSACTION_TRANSITION',
        `Cannot move ${this.kind} from ${this.currentStatus}`,
      );
    }
  }
}
