import { DomainError } from '../../../../shared/domain/domain-error';
import {
  IntegrationEvent,
  type IntegrationEventContext,
} from '../../../../shared/domain/integration-event';
import type { LedgerDirection } from '../../../../shared/domain/ledger-direction';
import type { MoneyProps } from '../../../../shared/domain/money';
import type { Wallet } from '../wallet';
import type { WalletLedgerEntry } from '../wallet-ledger-entry';

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Published only when a balance actually changes. Aggregate is the wallet, so consumers can order by walletVersion. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    context: IntegrationEventContext,
  ): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) {
      throw new DomainError('INVALID_LEDGER_ENTRY', 'The ledger entry belongs to another wallet');
    }
    return new WalletBalanceChanged({
      ...context,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
