/**
 * The part of JSON Schema that docs/openapi.json uses: types, required, properties, additionalProperties,
 * items, enum, oneOf, pattern, lengths, bounds, the uuid and date-time formats, and local $ref. Written here,
 * so the contract is checked without a new dependency. A schema keyword outside this list is an error, so
 * the check cannot pass by ignoring what it does not understand.
 */

const SUPPORTED_KEYWORDS = new Set([
  '$ref',
  'type',
  'enum',
  'oneOf',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'format',
  'description',
  'example',
  'default',
  'title',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export interface ContractDocument {
  components: { schemas: Record<string, unknown> };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeNames(value: unknown): string[] {
  if (value === null) return ['null'];
  if (Array.isArray(value)) return ['array'];
  if (typeof value === 'number')
    return Number.isInteger(value) ? ['integer', 'number'] : ['number'];
  return [typeof value];
}

/** Every error found, each with the JSON path it is at. An empty list means the value conforms. */
export function contractErrors(
  value: unknown,
  schema: unknown,
  document: ContractDocument,
  path = '$',
): string[] {
  if (!isRecord(schema)) {
    return [`${path}: the schema is not an object`];
  }
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      return [`${path}: schema keyword "${keyword}" is outside the checked subset`];
    }
  }
  if (typeof schema.$ref === 'string') {
    const name = /^#\/components\/schemas\/(.+)$/.exec(schema.$ref)?.[1];
    const target = name === undefined ? undefined : document.components.schemas[name];
    if (target === undefined) {
      return [`${path}: unresolved $ref ${schema.$ref}`];
    }
    return contractErrors(value, target, document, path);
  }
  if (Array.isArray(schema.oneOf)) {
    const branches = schema.oneOf.map((branch) => contractErrors(value, branch, document, path));
    return branches.some((errors) => errors.length === 0)
      ? []
      : [`${path}: matches none of the allowed shapes`];
  }

  const errors: string[] = [];
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeNames(value);
    if (!allowed.some((type) => typeof type === 'string' && actual.includes(type))) {
      return [`${path}: expected ${allowed.join(' or ')}, got ${actual[0]}`];
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of the allowed values`);
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength)
      errors.push(`${path}: shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength)
      errors.push(`${path}: longer than ${schema.maxLength}`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value))
      errors.push(`${path}: does not match ${schema.pattern}`);
    if (schema.format === 'uuid' && !UUID.test(value)) errors.push(`${path}: not a uuid`);
    if (
      schema.format === 'date-time' &&
      !(DATE_TIME.test(value) && !Number.isNaN(Date.parse(value)))
    )
      errors.push(`${path}: not a date-time`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum)
      errors.push(`${path}: below ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum)
      errors.push(`${path}: above ${schema.maximum}`);
  }
  if (Array.isArray(value) && isRecord(schema.items)) {
    value.forEach((item, index) =>
      errors.push(...contractErrors(item, schema.items, document, `${path}[${index}]`)),
    );
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === 'string' && !(key in value)) errors.push(`${path}: missing ${key}`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (key in properties) {
        errors.push(...contractErrors(child, properties[key], document, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: unexpected ${key}`);
      } else if (isRecord(schema.additionalProperties)) {
        errors.push(
          ...contractErrors(child, schema.additionalProperties, document, `${path}.${key}`),
        );
      }
    }
  }
  return errors;
}
