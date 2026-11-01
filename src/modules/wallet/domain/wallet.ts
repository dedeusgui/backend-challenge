import { DomainError } from '../../../shared/domain/domain-error';
import { LedgerDirection } from '../../../shared/domain/ledger-direction';
import { Money } from '../../../shared/domain/money';
import { WalletLedgerEntry } from './wallet-ledger-entry';

/** The largest balance the database stores: NUMERIC(20,2), with 18 integer digits and 2 fractional ones. */
const MAXIMUM_BALANCE_AMOUNT = '999999999999999999.99';

export interface WalletState {
  id: string;
  playerId: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

interface OpenWalletCommand {
  walletId: string;
  playerId: string;
  initialBalance: Money;
  openingTransactionId: string;
  openingEntryId: string;
  openedAt: Date;
}

interface OpenedWallet {
  wallet: Wallet;
  /** Present only when the initial balance is positive. */
  openingEntry: WalletLedgerEntry | undefined;
}

/** A balance change requested by a transaction. The caller supplies ids and time. */
interface WalletMovement {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

/**
 * Aggregate root for one player's balance in one currency.
 *
 * Every balance change is applied together with the ledger entry that explains
 * it, and bumps `version` exactly once. The class does not persist itself: the
 * application layer saves the wallet and its entries in one transaction.
 */
export class Wallet {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly createdAt: Date;
  private currentBalance: Money;
  private currentVersion: number;
  private lastUpdatedAt: Date;

  private constructor(state: WalletState) {
    this.id = state.id;
    this.playerId = state.playerId;
    this.currency = state.balance.currency;
    this.createdAt = state.createdAt;
    this.currentBalance = state.balance;
    this.currentVersion = state.version;
    this.lastUpdatedAt = state.updatedAt;
  }

  /**
   * Opens a wallet at version 1. An initial balance is part of creation, so it
   * does not bump the version; it is recorded by the returned opening entry.
   */
  static open(command: OpenWalletCommand): OpenedWallet {
    const { initialBalance, openedAt } = command;
    if (initialBalance.isNegative()) {
      throw new DomainError('INVALID_WALLET', 'The initial balance cannot be negative');
    }

    const wallet = new Wallet({
      id: command.walletId,
      playerId: command.playerId,
      balance: initialBalance,
      version: 1,
      createdAt: openedAt,
      updatedAt: openedAt,
    });
    if (initialBalance.isZero()) {
      return { wallet, openingEntry: undefined };
    }

    const openingEntry = WalletLedgerEntry.create({
      id: command.openingEntryId,
      walletId: command.walletId,
      transactionId: command.openingTransactionId,
      direction: 'CREDIT',
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      createdAt: openedAt,
    });
    return { wallet, openingEntry };
  }

  /** Rebuilds persisted state. Does not revalidate transitions, by design. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state);
  }

  get balance(): Money {
    return this.currentBalance;
  }

  get version(): number {
    return this.currentVersion;
  }

  get updatedAt(): Date {
    return this.lastUpdatedAt;
  }

  /** False when the balance cannot cover `money`. Throws only on a currency mismatch. */
  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this.currentBalance.isLessThan(money);
  }

  /** False when the credit would leave the balance above the largest value the database stores. Throws only on a currency mismatch. */
  canCredit(money: Money): boolean {
    this.assertSameCurrency(money);
    const maximum = Money.from({ amount: MAXIMUM_BALANCE_AMOUNT, currency: this.currency });
    return !maximum.isLessThan(this.currentBalance.add(money));
  }

  debit(movement: WalletMovement): WalletLedgerEntry {
    if (!this.canDebit(movement.money)) {
      throw new DomainError('INSUFFICIENT_BALANCE', 'The wallet balance cannot cover this debit');
    }
    return this.apply('DEBIT', movement);
  }

  credit(movement: WalletMovement): WalletLedgerEntry {
    return this.apply('CREDIT', movement);
  }

  private apply(direction: LedgerDirection, movement: WalletMovement): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    const balanceBefore = this.currentBalance;
    const balanceAfter =
      direction === 'CREDIT'
        ? balanceBefore.add(movement.money)
        : balanceBefore.subtract(movement.money);

    // The entry is validated before any state changes, so a rejected entry leaves the wallet untouched.
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore,
      balanceAfter,
      createdAt: movement.at,
    });

    this.currentBalance = balanceAfter;
    this.currentVersion += 1;
    this.lastUpdatedAt = movement.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new DomainError(
        'CURRENCY_MISMATCH',
        `Wallet is in ${this.currency}, operation is in ${money.currency}`,
      );
    }
  }
}
