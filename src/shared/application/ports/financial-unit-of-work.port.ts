import type { WalletLedgerRepository } from '../../../modules/wallet/application/wallet-ledger-repository.port';
import type { WalletRepository } from '../../../modules/wallet/application/wallet-repository.port';
import type { WagerTransactionRepository } from '../../../modules/wagering/application/wager-transaction-repository.port';

export interface FinancialRepositories {
  wallets: WalletRepository;
  ledger: WalletLedgerRepository;
  wagers: WagerTransactionRepository;
}

/**
 * Transaction boundary for financial work. Everything done through the
 * repositories inside `work` commits or rolls back together. Nothing outside
 * `work` may observe a partial result.
 */
export interface FinancialUnitOfWork {
  run<T>(work: (repositories: FinancialRepositories) => Promise<T>): Promise<T>;
}
