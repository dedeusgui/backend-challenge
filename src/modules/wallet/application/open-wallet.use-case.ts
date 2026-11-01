import type { ApplicationContext } from '../../../shared/application/application-context';
import type { FinancialRepositories } from '../../../shared/application/ports/financial-unit-of-work';
import { DomainError } from '../../../shared/domain/domain-error';
import { Money } from '../../../shared/domain/money';
import { WalletBalanceChanged } from '../domain/events/wallet-balance-changed.event';
import { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { WagerTransaction } from '../../wagering/domain/wager-transaction';
import { WagerTransactionProcessed } from '../../wagering/domain/events/wager-transaction-processed.event';
import { hashOf } from '../../wagering/domain/wager-payload';

export interface OpenWalletInput {
  playerId: string;
  initialBalance: Money;
}

export interface OpenWalletOutcome {
  walletId: string;
  balance: Money;
  version: number;
}

/** Internal provider id for transactions the system creates itself (the OPENING credit). */
const SYSTEM_PROVIDER_ID = 'system';

/**
 * Creates a wallet. A positive initial balance is recorded as an internal OPENING
 * transaction and a CREDIT entry, all in the same transaction as the wallet.
 */
export class OpenWallet {
  constructor(private readonly context: ApplicationContext) {}

  async execute(input: OpenWalletInput): Promise<OpenWalletOutcome> {
    if (input.initialBalance.isNegative()) {
      throw new DomainError('INVALID_WALLET', 'The initial balance cannot be negative');
    }
    const walletId = this.context.newId();
    const openedAt = this.context.clock();
    const { wallet, openingEntry } = Wallet.open({
      walletId,
      playerId: input.playerId,
      initialBalance: input.initialBalance,
      openingTransactionId: this.context.newId(),
      openingEntryId: this.context.newId(),
      openedAt,
    });

    await this.context.unitOfWork.run(async (repositories) => {
      // The wallet row must exist before the OPENING transaction, which references it.
      await repositories.wallets.insert(wallet);
      if (openingEntry === undefined) {
        return;
      }
      await this.recordOpeningBalance(repositories, wallet, openingEntry, input, openedAt);
    });

    return { walletId, balance: wallet.balance, version: wallet.version };
  }

  private async recordOpeningBalance(
    repositories: FinancialRepositories,
    wallet: Wallet,
    openingEntry: WalletLedgerEntry,
    input: OpenWalletInput,
    openedAt: Date,
  ): Promise<void> {
    const opening = this.openingTransaction(wallet.id, input, openingEntry.transactionId, openedAt);
    await repositories.wagers.insert(opening);
    await repositories.ledger.append(openingEntry);

    const context = {
      eventId: this.context.newId(),
      correlationId: wallet.id,
      occurredAt: openedAt,
    };
    await repositories.outbox.enqueue(
      WagerTransactionProcessed.from(opening, context),
      WalletBalanceChanged.from(wallet, openingEntry, {
        ...context,
        eventId: this.context.newId(),
      }),
    );
  }

  private openingTransaction(
    walletId: string,
    input: OpenWalletInput,
    transactionId: string,
    at: Date,
  ): WagerTransaction {
    const money = input.initialBalance;
    const payloadHash = hashOf({
      providerId: SYSTEM_PROVIDER_ID,
      externalTransactionId: `opening-${walletId}`,
      playerId: input.playerId,
      walletId,
      roundId: 'opening',
      gameId: 'opening',
      kind: 'OPENING',
      money,
      referenceExternalTransactionId: undefined,
    });
    const opening = WagerTransaction.create({
      id: transactionId,
      providerId: SYSTEM_PROVIDER_ID,
      externalTransactionId: `opening-${walletId}`,
      idempotencyKey: `opening-${walletId}`,
      payloadHash,
      walletId,
      playerId: input.playerId,
      roundId: 'opening',
      gameId: 'opening',
      kind: 'OPENING',
      money,
      referenceExternalTransactionId: undefined,
      createdAt: at,
    });
    opening.markProcessed({ referenceTransactionId: undefined, resultingBalance: money, at });
    return opening;
  }
}
