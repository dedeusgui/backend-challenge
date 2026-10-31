import { describe, expect, test } from 'bun:test';
import { contractErrors, type ContractDocument } from '../../support/json-schema-subset';

/** The checker must fail on each kind of divergence, or a passing contract test proves nothing. */
const document: ContractDocument = {
  components: {
    schemas: {
      Money: {
        type: 'object',
        required: ['amount', 'currency'],
        additionalProperties: false,
        properties: {
          amount: { type: 'string', pattern: '^-?[0-9]{1,18}\\.[0-9]{2}$' },
          currency: { type: 'string', pattern: '^[A-Z]{3}$' },
        },
      },
    },
  },
};
const money = { $ref: '#/components/schemas/Money' };

describe('the contract checker reports each kind of divergence', () => {
  test('a conforming value has no errors', () => {
    expect(contractErrors({ amount: '25.00', currency: 'BRL' }, money, document)).toEqual([]);
  });

  test('a missing required field is reported', () => {
    expect(contractErrors({ amount: '25.00' }, money, document)).toEqual(['$: missing currency']);
  });

  test('an extra field is reported when additional properties are refused', () => {
    expect(contractErrors({ amount: '25.00', currency: 'BRL', extra: 1 }, money, document)).toEqual(
      ['$: unexpected extra'],
    );
  });

  test('a number where a decimal string is required is reported', () => {
    const errors = contractErrors({ amount: 25, currency: 'BRL' }, money, document);
    expect(errors).toEqual(['$.amount: expected string, got integer']);
  });

  test('a value that breaks the pattern is reported', () => {
    expect(contractErrors({ amount: '25.5', currency: 'BRL' }, money, document)).toEqual([
      '$.amount: does not match ^-?[0-9]{1,18}\\.[0-9]{2}$',
    ]);
  });

  test('a malformed uuid and a malformed date-time are reported', () => {
    const schema = {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        at: { type: 'string', format: 'date-time' },
      },
    };
    expect(
      contractErrors({ id: 'not-a-uuid', at: '2026-07-29T15:00:00.000Z' }, schema, document),
    ).toEqual(['$.id: not a uuid']);
    expect(
      contractErrors(
        { id: '0192f291-27dd-7d3f-8071-5f8685deef37', at: 'yesterday' },
        schema,
        document,
      ),
    ).toEqual(['$.at: not a date-time']);
  });

  test('an enum value outside the list is reported, and an array item is checked at its index', () => {
    const schema = { type: 'array', items: { type: 'string', enum: ['DEBIT', 'CREDIT'] } };
    expect(contractErrors(['DEBIT', 'REFUND'], schema, document)).toEqual([
      '$[1]: "REFUND" is not one of the allowed values',
    ]);
  });

  test('a keyword the checker does not know is an error, so it cannot pass by ignoring it', () => {
    expect(contractErrors('x', { type: 'string', multipleOf: 2 }, document)).toEqual([
      '$: schema keyword "multipleOf" is outside the checked subset',
    ]);
  });

  test('an unresolved reference is an error', () => {
    expect(contractErrors({}, { $ref: '#/components/schemas/Missing' }, document)).toEqual([
      '$: unresolved $ref #/components/schemas/Missing',
    ]);
  });

  test('a oneOf with null accepts null and rejects a number', () => {
    const schema = { oneOf: [money, { type: 'null' }] };
    expect(contractErrors(null, schema, document)).toEqual([]);
    expect(contractErrors(7, schema, document)).toEqual(['$: matches none of the allowed shapes']);
  });
});
