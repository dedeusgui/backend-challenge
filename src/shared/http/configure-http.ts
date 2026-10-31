import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * The largest JSON body the API reads. The largest specified request is a few hundred bytes, so
 * 16 kB refuses an oversized body early, before it is parsed or validated.
 */
export const JSON_BODY_LIMIT = '16kb';

/**
 * The HTTP settings that production and the tests share. The application is created without the
 * default body parser, and this function installs the JSON parser with its explicit limit.
 */
export function configureHttp(app: NestExpressApplication): void {
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
}
