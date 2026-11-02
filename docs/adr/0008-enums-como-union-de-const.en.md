# ADR 0008: Enums as const union types

> English reference copy. The main version, in Portuguese, is [0008-enums-como-union-de-const.md](0008-enums-como-union-de-const.md).

**Status:** accepted

## Context

The domain contains finite sets of states and roles: transaction statuses (`WagerTransactionStatus`), operation kinds (`WagerTransactionKind`), API client roles (`ApiClientRole`), ledger movement directions (`LedgerDirection`), and failure codes (`FailureCode`). These values travel as strings in JSON payloads across network boundaries (HTTP and SQS) and are persisted in PostgreSQL in `text` columns (such as `kind` and `status` in `src/modules/wagering/infrastructure/wager-transaction.record.ts:17,22`, `direction` in `src/modules/wallet/infrastructure/wallet-ledger-entry.record.ts:12`, and `role` in `src/modules/auth/infrastructure/api-client.record.ts:10`).

## Decision

Represent finite sets using immutable literal arrays annotated with `as const`, deriving union types via `(typeof ARRAY)[number]`. Do not use TypeScript's `enum` keyword.

No runtime object is emitted by the compiler: the in-memory value, the database-stored value, and the serialized JSON string are identical, eliminating reverse mapping steps. The literal array acts as a runtime catalog for input and infrastructure validators.

## Alternatives

- **TypeScript numeric `enum`.** Rejected: emits a bidirectional object at runtime with reverse name-to-number mapping, incompatible with text literals expected in JSON and database `text` columns.
- **TypeScript string `enum`.** Rejected: generates object code during the JavaScript build and requires helper functions such as `Object.values` to iterate over valid values.
- **Classes with static constants.** Rejected: verbose syntax, generates unnecessary runtime constructs, and lacks direct derivation of closed union types.

## Consequences

- Absence of a runtime enum namespace. Operations requiring value iteration or inspection rely directly on the underlying immutable array.
- Cases in the codebase directly utilizing the array: generating error messages during input validation (`src/modules/wagering/application/wager-command-fields.ts:75` with `WAGER_TRANSACTION_KINDS.join(', ')`, and `src/auth.ts:44` with `API_CLIENT_ROLES.join(', ')`), and database narrowing with `oneOf` (`src/shared/infrastructure/database/stored-values.ts:5`).

## Evidence

- The TypeScript compiler (`bun run typecheck`, `tsc --noEmit`) rejects assignments outside the union set across domain and application layers.
- The TypeScript `enum` count in the codebase is 0 (confirmed with `grep -rn "^\s*\(export \)\?enum " src test`).
- Unit test for narrowing stored values: `test/unit/shared/validation-and-errors.test.ts:161-167` proves that `oneOf` rejects values outside the allowed list and names the unrecognized value.
