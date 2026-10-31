import { Body, Controller, Post } from '@nestjs/common';
import { OpenWallet } from '../application/open-wallet.use-case';
import { parseOpenWalletRequest } from './open-wallet.request';

export interface WalletResponse {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

@Controller('wallets')
export class WalletController {
  constructor(private readonly openWallet: OpenWallet) {}

  @Post()
  async open(@Body() body: unknown): Promise<WalletResponse> {
    const request = parseOpenWalletRequest(body);
    const outcome = await this.openWallet.execute({
      playerId: request.playerId,
      initialBalance: request.initialBalance,
    });
    return {
      id: outcome.walletId,
      playerId: request.playerId,
      balance: outcome.balance.toJSON(),
      version: outcome.version,
    };
  }
}
