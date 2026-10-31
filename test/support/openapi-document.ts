import { fileURLToPath } from 'node:url';
import type { ContractDocument } from './json-schema-subset';

/** docs/openapi.json, narrowed field by field. A missing or mistyped part is an error at load, not a later surprise. */

export const OPENAPI_PATH = fileURLToPath(new URL('../../docs/openapi.json', import.meta.url));

export interface OperationSpec {
  operationId: string;
  tags: string[];
  responses: Record<string, { content?: Record<string, { schema?: unknown }> }>;
  parameters?: Array<{ name: string; in: string }>;
}

export interface OpenApiDocument extends ContractDocument {
  openapi: string;
  paths: Record<string, Record<string, OperationSpec>>;
}

export async function loadOpenApi(): Promise<OpenApiDocument> {
  const parsed: unknown = JSON.parse(await Bun.file(OPENAPI_PATH).text());
  return asOpenApiDocument(parsed);
}

export function asOpenApiDocument(value: unknown): OpenApiDocument {
  if (!isObject(value) || typeof value.openapi !== 'string') {
    throw new Error('docs/openapi.json has no openapi version');
  }
  const { paths, components } = value;
  if (!isObject(paths) || !isObject(components) || !isObject(components.schemas)) {
    throw new Error('docs/openapi.json has no paths or no component schemas');
  }
  const narrowedPaths: Record<string, Record<string, OperationSpec>> = {};
  for (const [path, operations] of Object.entries(paths)) {
    if (!isObject(operations)) throw new Error(`${path} is not a path item`);
    narrowedPaths[path] = Object.fromEntries(
      Object.entries(operations).map(([method, operation]) => [
        method,
        asOperation(method, operation),
      ]),
    );
  }
  return {
    openapi: value.openapi,
    paths: narrowedPaths,
    components: { schemas: components.schemas },
  };
}

function asOperation(method: string, value: unknown): OperationSpec {
  if (
    !isObject(value) ||
    typeof value.operationId !== 'string' ||
    !Array.isArray(value.tags) ||
    !isObject(value.responses)
  ) {
    throw new Error(`${method} has no operationId, tags or responses`);
  }
  const tags = value.tags.filter((tag): tag is string => typeof tag === 'string');
  const parameters = Array.isArray(value.parameters)
    ? value.parameters.flatMap((parameter) =>
        isObject(parameter) &&
        typeof parameter.name === 'string' &&
        typeof parameter.in === 'string'
          ? [{ name: parameter.name, in: parameter.in }]
          : [],
      )
    : undefined;
  return {
    operationId: value.operationId,
    tags,
    responses: asResponses(value.responses),
    parameters,
  };
}

function asResponses(value: Record<string, unknown>): OperationSpec['responses'] {
  return Object.fromEntries(
    Object.entries(value).map(([status, response]) => {
      const content = isObject(response) && isObject(response.content) ? response.content : {};
      const narrowed: Record<string, { schema?: unknown }> = {};
      for (const [media, entry] of Object.entries(content)) {
        narrowed[media] = { schema: isObject(entry) ? entry.schema : undefined };
      }
      return [status, { content: narrowed }];
    }),
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
