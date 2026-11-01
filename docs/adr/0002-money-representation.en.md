# ADR 0002: Money as decimal string, decimal.js arithmetic, NUMERIC(20,2) storage

> English reference copy. The main version, in Portuguese, is [0002-money-representation.md](0002-money-representation.md).

**Status:** accepted, amended (the input scale, see below)

## Context

The contract is a decimal string with two fractional digits and an ISO currency
(challenge §6.1). `number`, `float` and `double` are forbidden for money.

## Decision

- `Money` is an immutable value object over `decimal.js`, with a 40-digit precision
  context (`src/shared/domain/money.ts`). The default context (20 digits) rounds a
  sum of two `NUMERIC(20,2)` operands. A test pins this: `999999999999999999.99 +
0.02` must be `1000000000000000000.01`.
- Input needs exactly 2 fractional digits and no leading zero, and at most 18 integer digits, the
  same bounds as the column. Anything else is rejected, never rounded or normalized.
  An earlier version normalized `"25"` to `"25.00"`. That was withdrawn, because the contract
  fixes the scale and one value must have one representation.
- Storage is `numeric(20,2)` in PostgreSQL, read back as strings and parsed through
  `Money.from`.

## Alternatives

- **Integer minor units (`bigint`).** Exact and simple for two-decimal currencies,
  and needs no dependency. Two of the reference projects use it. We chose
  `decimal.js` as ARCHITECTURE §3 decided. The choice is cheap to reverse: `Money`
  is the only place that knows the representation.

## Consequences

- Arithmetic is exact, and a regression in precision fails a unit test.
- The ledger arithmetic CHECK (`balance_after = balance_before ± amount`) is
  enforced by the database with the same numeric type, so the two sides cannot
  disagree on scale.

## Evidence

- `test/unit/shared/domain/money.test.ts` (43 cases, including the precision and
  overflow boundaries). Mutants on the precision context and the 18-digit bound
  were detected.
- `test/integration/schema/schema-constraints.test.ts`: `NUMERIC(20,2)` overflow
  is refused with SQLSTATE 22003.
