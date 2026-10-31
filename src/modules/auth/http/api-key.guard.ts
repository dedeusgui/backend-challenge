import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthenticateApiKey } from '../application/authenticate-api-key.use-case';
import { isOperator, type Principal } from '../domain/principal';
import { METRICS_REGISTRY, type MetricsSink } from '../../../shared/observability/metrics';
import { IS_PUBLIC, OPERATOR_ONLY } from './access';

/**
 * Every route needs a valid key, unless it is marked public. Authentication happens here, once
 * per request, before the controller runs. Scope checks that need the body or the record happen
 * in the controller, through requireProviderScope.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authenticate: AuthenticateApiKey,
    @Inject(METRICS_REGISTRY) private readonly metrics: MetricsSink,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, targets) === true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{
      headers: { authorization?: string };
      principal?: Principal;
    }>();
    const authStarted = performance.now();
    const principal = await this.authenticate.execute(request.headers.authorization);
    this.metrics.observe('auth_ms', performance.now() - authStarted);
    if (principal === undefined) {
      throw new UnauthorizedException('A valid API key is required');
    }
    const operatorOnly =
      this.reflector.getAllAndOverride<boolean | undefined>(OPERATOR_ONLY, targets) === true;
    if (operatorOnly && !isOperator(principal)) {
      throw new ForbiddenException('Only an operator key may call this route');
    }
    request.principal = principal;
    return true;
  }
}
