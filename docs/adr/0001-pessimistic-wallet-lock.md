# ADR 0001: Pessimistic row lock on the wallet

**Status:** accepted

## Context

The unit of concurrency is the wallet (challenge §8). Two bets of 80.00 against a
balance of 100.00 must produce one debit, one rejection and a final balance of
20.00, with several instances running.

## Decision

Every financial operation first reads the wallet with `SELECT ... FOR UPDATE`
(`MikroOrmWalletRepository.findForUpdate`, `LockMode.PESSIMISTIC_WRITE`). The
idempotency check of a new operation repeats under that lock, and the balance decision happens there.
A replay of a stored transaction is answered before the lock, because it writes nothing (ARCHITECTURE
section 5). The write
of the new balance is also guarded by `WHERE version = expected`, so a lost lock
is detected instead of silently overwriting.

## Alternatives

- **Optimistic version with bounded retry.** Fewer waits under low contention, but
  under a hot wallet every losing attempt repeats the whole decision. We measured
  this: with the row lock removed and the version guard kept, the mixed hot-wallet
  case exhausts its three attempts and fails with CONCURRENCY_CONFLICT
  (`test/concurrency/hot-wallet.test.ts`). No balance was corrupted.
- **Conditional atomic UPDATE** (`SET balance = balance - ? WHERE balance >= ?`).
  Correct for the balance alone, but the idempotency and ledger decisions would
  still need coordination, so the lock is kept for the whole decision.
- **Redis or another external lock.** Adds a failure mode while PostgreSQL already
  owns consistency (ARCHITECTURE §5).

## Consequences

- Operations on one wallet are serialized. A hot wallet has a throughput ceiling
  set by the transaction time. This is accepted and is the main trade-off.
- Operations on different wallets never block each other (`test/concurrency`).
- Locks are held for the duration of one short transaction. No SQS I/O happens
  inside it (ADR 0004).
- Lock wait time is not yet exported as a metric (`OBS-03` remains partial).

## Evidence

- `test/concurrency/hot-wallet.test.ts`: 80/80 on 100, 50 identical requests, 40
  mixed operations on one wallet, two competing refunds.
- `test/concurrency/three-processes.test.ts`: the same races across three API
  processes and one worker.
- Mutation checks recorded in the commit messages: without the lock and the guard,
  the 80/80 case double-debits.
