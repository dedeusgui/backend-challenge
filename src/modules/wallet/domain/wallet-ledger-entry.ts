import { DomainError } from '../../../shared/domain/domain-error';
import { Money } from '../../../shared/domain/money';

export type LedgerDirection = 'DEBIT' | 'CREDIT';

export interface WalletLedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type CreateLedgerEntryProps = WalletLedgerEntryState;

/**
 * Immutable record of one balance change. Entries are append-only: the class
 * has no transition methods, and PostgreSQL rejects UPDATE, DELETE and TRUNCATE.
 */
export class WalletLedgerEntry {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt: Date;

  private constructor(state: WalletLedgerEntryState) {
    this.id = state.id;
    this.walletId = state.walletId;
    this.transactionId = state.transactionId;
    this.direction = state.direction;
    this.money = state.money;
    this.balanceBefore = state.balanceBefore;
    this.balanceAfter = state.balanceAfter;
    this.createdAt = state.createdAt;
    Object.freeze(this);
  }

  /** Validates that the entry is positive, currency-consistent, non-negative and arithmetically balanced. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(props);
    if (!entry.money.isPositive()) {
      throw new DomainError('INVALID_LEDGER_ENTRY', 'A ledger entry must move a positive amount');
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new DomainError('INVALID_LEDGER_ENTRY', 'Ledger balances cannot be negative');
    }
    if (!entry.isBalanced()) {
      throw new DomainError('INVALID_LEDGER_ENTRY', 'Ledger arithmetic does not balance');
    }
    return entry;
  }

  static rehydrate(state: WalletLedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(state);
  }

  /** True when balanceBefore ± money equals balanceAfter for the entry's direction. */
  isBalanced(): boolean {
    const expected =
      this.direction === 'CREDIT'
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
