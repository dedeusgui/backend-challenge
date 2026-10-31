import {
  createParamDecorator,
  ForbiddenException,
  SetMetadata,
  type ExecutionContext,
} from '@nestjs/common';
import { canOperateFor, type Principal } from '../domain/principal';

export const IS_PUBLIC = 'auth:public';
export const OPERATOR_ONLY = 'auth:operator-only';

/** The route needs no key. Used by the health probes only. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Only an OPERATOR key may call the route. */
export const OperatorOnly = () => SetMetadata(OPERATOR_ONLY, true);

/** The caller, as authenticated by the guard. */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal =>
    context.switchToHttp().getRequest<{ principal: Principal }>().principal,
);

/** Refuses a caller that may not act for this provider. Operators may act for any provider. */
export function requireProviderScope(principal: Principal, providerId: string): void {
  if (!canOperateFor(principal, providerId)) {
    throw new ForbiddenException('This API key may not act for this provider');
  }
}
