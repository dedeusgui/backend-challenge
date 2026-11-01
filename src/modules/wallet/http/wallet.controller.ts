import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { OperatorOnly } from '../../auth/http/access';
import { parseLedgerLimit } from './ledger-query.request';
import { OpenWallet } from '../application/open-wallet.use-case';
import { WalletQueries, DEFAULT_LEDGER_PAGE, MAX_LEDGER_PAGE } from '../application/wallet-queries';
import { parseOpenWalletRequest } from './open-wallet.request';
import {
  presentLedgerPage,
  presentOpenedWallet,
  presentReconciliation,
  presentWallet,
  type WalletResponse,
} from './wallet.presenters';
import { expectUuid } from '../../../shared/validation/request-validation';

@OperatorOnly()
@Controller('wallets')
export class WalletController {
  constructor(
    private readonly openWallet: OpenWallet,
    private readonly queries: WalletQueries,
  ) {}

  @Post()
  async open(@Body() body: unknown): Promise<WalletResponse> {
    const request = parseOpenWalletRequest(body);
    const outcome = await this.openWallet.execute({
      playerId: request.playerId,
      initialBalance: request.initialBalance,
    });
    return presentOpenedWallet(outcome, request.playerId);
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    return presentWallet(await this.queries.getWallet(expectUuid(walletId, 'walletId')));
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ) {
    const page = await this.queries.listLedger(expectUuid(walletId, 'walletId'), {
      cursor,
      limit: parseLedgerLimit(limit, DEFAULT_LEDGER_PAGE, MAX_LEDGER_PAGE),
    });
    return presentLedgerPage(page);
  }

  /** A reconciliation reads and reports; it creates no resource, so the status is 200. */
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string) {
    return presentReconciliation(await this.queries.reconcile(expectUuid(walletId, 'walletId')));
  }
}
