import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * The largest JSON body the API reads. The largest specified request is a few hundred bytes, so
 * 16 kB refuses an oversized body early, before it is parsed or validated.
 */
const JSON_BODY_LIMIT = '16kb';

/**
 * The HTTP settings that production and the tests share. The application is created without the
 * default body parser, and this function installs the JSON parser with its explicit limit. It also
 * removes the framework's identity header and sets the two headers that every response carries.
 * A subset of what Helmet sets, written here so that no dependency is needed for it.
 */
export function configureHttp(app: NestExpressApplication): void {
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
}

/** A response is never sniffed into another type, and a shared cache never keeps it. */
function securityHeaders(
  _request: unknown,
  response: { setHeader(name: string, value: string): unknown },
  next: () => void,
): void {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('cache-control', 'no-store');
  next();
}
