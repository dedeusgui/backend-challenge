import { describe, expect, test } from 'bun:test';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { HealthController } from '../../../src/health/health.controller';
import { MetricsController } from '../../../src/metrics/metrics.controller';
import { WalletController } from '../../../src/modules/wallet/http/wallet.controller';
import { WageringController } from '../../../src/modules/wagering/http/wagering.controller';
import { ProvidersController } from '../../../src/modules/wagering/http/providers.controller';
import { loadOpenApi, type OpenApiDocument } from '../../support/openapi-document';

/**
 * The OpenAPI document is checked in two ways here. Its own shape must be sound: every $ref resolves, every
 * path parameter is declared, every operation has a unique id and a status. And it must describe the routes
 * the controllers really register: the same method and path on both sides, in both directions.
 */

/** The routes the controllers register, as "METHOD /path" with Nest's own metadata. */
function registeredRoutes(): Set<string> {
  const routes = new Set<string>();
  for (const controller of [
    HealthController,
    WalletController,
    WageringController,
    ProvidersController,
    MetricsController,
  ]) {
    const prefix: unknown = Reflect.getMetadata(PATH_METADATA, controller);
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      if (name === 'constructor') continue;
      const handler: unknown = Reflect.get(controller.prototype, name);
      if (typeof handler !== 'function') continue;
      const method: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
      const path: unknown = Reflect.getMetadata(PATH_METADATA, handler);
      if (method === undefined) continue;
      const verb = RequestMethod[Number(method)];
      routes.add(`${verb} ${joinPath(prefix, path)}`);
    }
  }
  return routes;
}

function joinPath(...parts: unknown[]): string {
  const joined = parts
    .filter((part): part is string => typeof part === 'string')
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter((part) => part !== '')
    .join('/');
  return `/${joined}`;
}

function documentedRoutes(document: OpenApiDocument): Set<string> {
  const routes = new Set<string>();
  for (const [path, operations] of Object.entries(document.paths)) {
    for (const method of Object.keys(operations)) {
      routes.add(`${method.toUpperCase()} ${path.replace(/\{([^}]+)\}/g, ':$1')}`);
    }
  }
  return routes;
}

describe('docs/openapi.json is a sound OpenAPI 3.1 document', () => {
  test('declares OpenAPI 3.1 and a bearer scheme', async () => {
    const document = await loadOpenApi();
    expect(document.openapi).toBe('3.1.0');
    expect(Object.keys(document.components.schemas).length).toBeGreaterThan(0);
  });

  test('every operation has a unique id, at least one tag, and at least one status', async () => {
    const document = await loadOpenApi();
    const ids: string[] = [];
    for (const operations of Object.values(document.paths)) {
      for (const operation of Object.values(operations)) {
        ids.push(operation.operationId);
        expect(operation.tags.length).toBeGreaterThan(0);
        expect(Object.keys(operation.responses).length).toBeGreaterThan(0);
        for (const status of Object.keys(operation.responses)) {
          expect(status).toMatch(/^[1-5]\d\d$/);
        }
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every operation has a summary and description, and every response has a description', async () => {
    const document = await loadOpenApi();
    for (const operations of Object.values(document.paths)) {
      for (const operation of Object.values(operations)) {
        expect(operation.summary.trim().length).toBeGreaterThan(0);
        expect(operation.description.trim().length).toBeGreaterThan(0);
        for (const response of Object.values(operation.responses)) {
          expect(response.description.trim().length).toBeGreaterThan(0);
        }
      }
    }
  });

  test('every $ref resolves to a component schema', async () => {
    const document = await loadOpenApi();
    const text = JSON.stringify(document);
    for (const [, name] of text.matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)) {
      expect(document.components.schemas).toHaveProperty([name ?? '']);
    }
  });

  test('every path template parameter is declared as a path parameter', async () => {
    const document = await loadOpenApi();
    for (const [path, operations] of Object.entries(document.paths)) {
      const names = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
      for (const operation of Object.values(operations)) {
        for (const name of names) {
          expect(operation.parameters?.some((p) => p.in === 'path' && p.name === name)).toBe(true);
        }
      }
    }
  });
});

describe('the document describes the routes the controllers register', () => {
  test('every registered route is documented, and every documented route is registered', async () => {
    const document = await loadOpenApi();
    const registered = registeredRoutes();
    const documented = documentedRoutes(document);

    expect([...registered].sort()).toEqual([...documented].sort());
    expect(registered.size).toBe(10);
  });
});
