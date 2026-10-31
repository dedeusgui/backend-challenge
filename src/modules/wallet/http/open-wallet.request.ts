import { Money } from '../../../shared/domain/money';
import {
  expectObject,
  expectOnlyKeys,
  requiredMoney,
  requiredString,
} from '../../../shared/http/request-validation';

export interface OpenWalletRequest {
  playerId: string;
  initialBalance: Money;
}

export function parseOpenWalletRequest(body: unknown): OpenWalletRequest {
  const fields = expectObject(body, 'request body');
  expectOnlyKeys(fields, ['playerId', 'initialBalance']);
  return {
    playerId: requiredString(fields, 'playerId'),
    initialBalance: requiredMoney(fields, 'initialBalance'),
  };
}
