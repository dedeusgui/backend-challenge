# Public implementation review

Reviewed on 2026-10-31 by reading the three public repositories (shallow clones
at the default branch), grepping their code, and reading their architecture
documents. The reference suites were **not executed**, so no claim here rests on
their test results. These projects are references for trade-offs. Nothing was
copied from them.

Every observation below cites the file that supports it. Claims that could not be
verified are listed at the end and are not used in any decision.

## 1. AndreLopes30/junglegaming-backend-challenge

- **Locking:** the wallet is read with `LockMode.PESSIMISTIC_WRITE`
  (`src/infrastructure/persistence/repositories/wallet.repository.ts`). The outbox
  claim uses `PESSIMISTIC_PARTIAL_WRITE`, which is `FOR UPDATE SKIP LOCKED`
  (`outbox.repository.ts`).
- **Money:** the domain holds `bigint` minor units (`src/domain/money/money.ts`).
  Persistence stores `numeric` as a string, converted with `replace('.', '')`.
- **Outbox during I/O:** the architecture document states that the outbox keeps a
  row lock and a connection open while it calls SQS (section 15). This design
  trades simplicity for long transactions. We do not adopt it.
- **Entrypoints:** `src/main.ts` and `src/worker.ts` are separate. The document
  states that no entrypoint runs migrations.
- **Reconciliation:** documented as diagnostic only; it never corrects a balance or
  bumps a version. We adopt the same rule.
- **Metrics:** per-process counters, with DLQ and lag read from shared
  infrastructure. Stated as a limitation.
- **Auth:** a no-op guard as the extension point. Same decision as ours.

## 2. paulovitorlr/jungle-gaming-challenge

- **Optimistic versioning:** the pending-reference reprocessor reads
  `wallet.version` and calls `walletRepository.update(wallet, expectedVersion)`
  (`src/modules/wagering/application/use-cases/reprocess-pending-references.use-case.ts`).
  The wallet is not locked pessimistically on that path.
- **Leases:** the outbox publisher takes a lease with a configured duration
  (`src/modules/messaging/infrastructure/outbox/outbox-publisher.service.ts`), and
  claims use `FOR UPDATE SKIP LOCKED`. The send happens outside the claim
  transaction. This is the design we adopt.
- **Mappers:** explicit mapper files exist for each persistence entity
  (`wager-transaction.mapper.ts`, `wallet.mapper.ts`).
- **Money:** `decimal.js` value object (`src/shared/domain/value-objects/money.vo.ts`),
  with `numeric(20, 2)` columns. This matches our choice.

## 3. eriksonwilliam/jungle-gaming-wagering

- **Locking:** `LockMode.PESSIMISTIC_WRITE` on the wallet
  (`src/infrastructure/persistence/mikro-orm/repositories/wallet.repository.ts`),
  and `PESSIMISTIC_PARTIAL_WRITE` on the outbox.
- **Money:** `bigint` minor units in the ledger and wager repositories, through
  `toMinorUnits()` and `BigInt(...)`.
- **Operations:** a Keycloak JWT verifier and guard, a Prometheus metrics adapter,
  and a Grafana dashboard are present. The challenge gives no points for these.
  We do not adopt them, as `docs/REFERENCE_REVIEW.md` previously recommended.

## What this changed in our decisions

- **Wallet lock:** all three use a pessimistic row lock. Our own mutation
  evidence adds one fact they do not establish: without the row lock, the version
  guard still prevents corruption, but a hot wallet exhausts its retries under
  load (`test/concurrency/hot-wallet.test.ts`). The lock is kept for
  availability, not only for correctness. See `docs/adr/0001-pessimistic-wallet-lock.md`.
- **Money representation:** two references use minor units in the domain. We use
  `decimal.js` with `NUMERIC(20,2)`, as the architecture document decided. Minor
  units are a simpler exact representation for two-decimal currencies, and we
  would reconsider the choice if the domain grew beyond that. Recorded in
  `docs/adr/0002-money-representation.md`.
- **Outbox I/O:** we keep the send outside any transaction, following
  `paulovitorlr`. The send-inside-transaction design in `AndreLopes30` is
  rejected: it holds a connection and a row lock for the whole broker call.
- **Reconciliation:** diagnostic only, as in `AndreLopes30`.

## Not verified, not used

- Test counts and pass or fail status of the reference suites.
- `paulovitorlr`'s "some entities under a catch-all shared area" claim, which
  the previous review made without evidence.
- Any behaviour under concurrency or failure in the reference code. We did not
  run it, so no conclusion about correctness is drawn.
