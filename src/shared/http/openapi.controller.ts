import { Controller, Get, Header } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Public } from '../../modules/auth/http/access';

const OPENAPI_FILE = fileURLToPath(new URL('../../../docs/openapi.json', import.meta.url));

const SWAGGER_HTML = `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>API HTTP — Swagger UI</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui.css" integrity="sha384-wxLW6kwyHktdDGr6Pv1zgm/VGJh99lfUbzSn6HNHBENZlCN7W602k9VkGdxuFvPn" crossorigin="anonymous">
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui-bundle.js" integrity="sha384-wmyclcVGX/WhUkdkATwhaK1X1JtiNrr2EoYJ+diV3vj4v6OC5yCeSu+yW13SYJep" crossorigin="anonymous"></script>
    <script>window.onload = () => SwaggerUIBundle({ url: '/openapi.json', dom_id: '#swagger-ui', deepLinking: true });</script>
  </body>
</html>`;

@Public()
@Controller()
export class OpenApiController {
  @Get('openapi.json')
  @Header('Content-Type', 'application/json; charset=utf-8')
  async document(): Promise<unknown> {
    const document: unknown = JSON.parse(await readFile(OPENAPI_FILE, 'utf8'));
    return document;
  }

  @Get('docs')
  @Header('Content-Type', 'text/html; charset=utf-8')
  docs(): string {
    return SWAGGER_HTML;
  }
}
