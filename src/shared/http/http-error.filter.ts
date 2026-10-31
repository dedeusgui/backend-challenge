import { type ArgumentsHost, Catch, type ExceptionFilter, Logger } from '@nestjs/common';
import { toErrorResponse } from './error-response';

/** Single place where failures become HTTP responses. Controllers never map errors themselves. */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpErrorFilter');

  catch(error: unknown, host: ArgumentsHost): void {
    const response = toErrorResponse(error);
    if (response.status >= 500) {
      this.logger.error(
        error instanceof Error ? error.message : 'Unknown error',
        error instanceof Error ? error.stack : undefined,
      );
    }

    const reply = host.switchToHttp().getResponse<{
      status(code: number): { json(body: unknown): void };
      setHeader(name: string, value: string): void;
    }>();
    for (const [name, value] of Object.entries(response.headers ?? {})) {
      reply.setHeader(name, value);
    }
    reply.status(response.status).json(response.body);
  }
}
