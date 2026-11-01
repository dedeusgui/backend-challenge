import { describe, expect, test } from 'bun:test';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { IS_PUBLIC } from '../../../src/modules/auth/http/access';
import { OpenApiController } from '../../../src/shared/http/openapi.controller';
import { OPENAPI_PATH } from '../../support/openapi-document';

describe('public OpenAPI endpoints', () => {
  test('/openapi.json returns the checked-in contract', async () => {
    const controller = new OpenApiController();
    const document = await controller.document();
    const expected: unknown = JSON.parse(await Bun.file(OPENAPI_PATH).text());

    expect(document).toEqual(expected);
    expect(Reflect.getMetadata(PATH_METADATA, OpenApiController.prototype.document)).toBe(
      'openapi.json',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, OpenApiController.prototype.document)).toBe(
      RequestMethod.GET,
    );
  });

  test('/docs renders Swagger UI without requiring an API key', () => {
    const controller = new OpenApiController();
    const html = controller.docs();

    expect(Reflect.getMetadata(IS_PUBLIC, OpenApiController)).toBe(true);
    expect(Reflect.getMetadata(PATH_METADATA, OpenApiController.prototype.docs)).toBe('docs');
    expect(Reflect.getMetadata(METHOD_METADATA, OpenApiController.prototype.docs)).toBe(
      RequestMethod.GET,
    );
    expect(html).toContain("url: '/openapi.json'");
    expect(html).toContain('swagger-ui-dist@5.17.14');
    expect(html).toContain('integrity="sha384-');
  });
});
