# Flow matrix

> **Appendix.** A reference for a reviewer who traces one operation through the code. The overview is in
> [ARCHITECTURE.md](../ARCHITECTURE.md), sections 1 and 5.

One document for the flow of data through the system: which entity each step touches, which
function does it, what the step decides, and what response or record each outcome leaves behind.
The graphs are coloured by outcome, so a reader can follow one request from its entry point to
the response, and see which entities that outcome writes.

It replaces the earlier entity map. The inventory was generated from `src/`, and each function
name was checked against its file.

## How to read it

1. **Colours.** Every terminal outcome has a colour. The same colour is used for the entities
   that outcome writes.
2. **Response table.** Each outcome maps to one HTTP status and one failure code, or to one queue
   disposition.
3. **Graphs.** Diamonds are decisions. Boxes are steps. Coloured boxes are outcomes.
4. **Matrix.** Rows are functions, in the order they run. Columns are the entities. A cell says
   what the function does to that entity.
5. **Entities.** Each entity has its table, its record class, its repository, its domain class, and
   the functions that write and read it.

| Colour        | Outcome                                                         | Style in the graphs |
| ------------- | --------------------------------------------------------------- | ------------------- |
| Green         | applied: the balance, the ledger and the outbox changed         | `applied`           |
| Blue          | replay: the stored result came back, nothing changed            | `replay`            |
| Amber         | held: waiting for a reference, nothing changed yet              | `held`              |
| Red           | rejected by a business rule: a row is written, no balance moves | `rejected`          |
| Purple        | conflict: the same key with another payload, nothing written    | `conflict`          |
| Grey          | denied before the domain: authentication, scope or validation   | `denied`            |
| Dark red      | infrastructure failure: the transaction rolls back              | `failure`           |
| White, dashed | an entity this outcome does not touch                           | `untouched`         |

## Response table

| Outcome                          | Colour   | HTTP status             | Body code or failure code                                                                                                                                                                                                                                                                                                    | Queue disposition (SQS)          | Written                                      |
| -------------------------------- | -------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------- |
| Applied                          | green    | `201`                   | `status: PROCESSED`                                                                                                                                                                                                                                                                                                          | ACK after commit                 | wallet, ledger, wager row, two outbox events |
| Replay                           | blue     | `200`                   | `idempotentReplay: true`                                                                                                                                                                                                                                                                                                     | ACK after commit (the inbox row) | nothing                                      |
| Held for a reference             | amber    | `202`                   | `status: PENDING_REFERENCE`                                                                                                                                                                                                                                                                                                  | ACK after commit                 | wager row (held), one outbox event           |
| Rejected by a business rule      | red      | `422`                   | `failureCode`: `INSUFFICIENT_BALANCE`, `REVERSAL_WOULD_OVERDRAW`, `REFERENCE_NOT_FOUND`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_CONTEXT_MISMATCH`, `REFERENCE_KIND_NOT_ALLOWED`, `REFERENCE_AMOUNT_MISMATCH`, `REFERENCE_ALREADY_REVERSED`, `REFERENCE_ALREADY_SETTLED`, `WALLET_PLAYER_MISMATCH`, `WALLET_CURRENCY_MISMATCH` | ACK after commit                 | wager row (rejected), one outbox event       |
| Same key, other payload          | purple   | `409`                   | `IDEMPOTENCY_CONFLICT`                                                                                                                                                                                                                                                                                                       | dead-lettered (permanent)        | nothing                                      |
| No valid bearer key              | grey     | `401`                   | `UNAUTHENTICATED`, with `WWW-Authenticate`                                                                                                                                                                                                                                                                                   | not applicable                   | nothing                                      |
| Key may not act for the provider | grey     | `403`                   | `FORBIDDEN`                                                                                                                                                                                                                                                                                                                  | not applicable                   | nothing                                      |
| Invalid body, or missing key     | grey     | `400`                   | `INVALID_REQUEST`, `IDEMPOTENCY_KEY_REQUIRED`, `INVALID_TRANSACTION` (OPENING, zero amount, negative amount, missing reference)                                                                                                                                                                                              | dead-lettered (permanent)        | nothing                                      |
| Unknown wallet or transaction    | grey     | `404`                   | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND`                                                                                                                                                                                                                                                                                  | dead-lettered (permanent)        | nothing                                      |
| Wallet already exists            | purple   | `409`                   | `WALLET_ALREADY_EXISTS`                                                                                                                                                                                                                                                                                                      | not applicable                   | nothing                                      |
| Lost lock race, retries used up  | dark red | `503`, `retry-after: 1` | `CONCURRENCY_CONFLICT`                                                                                                                                                                                                                                                                                                       | retried with backoff             | nothing (rolled back)                        |
| Anything unexpected              | dark red | `500`                   | `INTERNAL_ERROR`, no message                                                                                                                                                                                                                                                                                                 | retried with backoff             | nothing (rolled back)                        |
| Readiness, a dependency is down  | dark red | `503`                   | `checks` names the failing dependency                                                                                                                                                                                                                                                                                        | not applicable                   | nothing                                      |

The status mapping lives in `src/modules/wagering/http/wagering.controller.ts` (`statusOf`) and
`src/shared/http/error-response.ts` (`toErrorResponse`). A test asserts each row.

## Graph 1: a BET over HTTP, coloured by outcome

Rendered as an image: [`docs/diagrams/bet-over-http.svg`](diagrams/bet-over-http.svg), so it can be shown without GitHub.

```mermaid
flowchart TD
  START(["POST /wagering/transactions"]) --> AUTH{"Valid bearer key?"}
  AUTH -- no --> D401["401 UNAUTHENTICATED"]:::denied
  AUTH -- yes --> SCOPE{"Key may act for this provider?"}
  SCOPE -- no --> D403["403 FORBIDDEN, nothing written"]:::denied
  SCOPE -- yes --> BODY{"Body valid, kind not OPENING, Idempotency-Key present?"}
  BODY -- no --> D400["400 INVALID_REQUEST, IDEMPOTENCY_KEY_REQUIRED or INVALID_TRANSACTION"]:::denied
  BODY -- yes --> LOCK["Lock the wallet row: FOR UPDATE"]:::step
  LOCK --> IDEM{"This key seen before?"}
  IDEM -- "same payload" --> REPLAY["200 replay, stored result"]:::replay
  IDEM -- "other payload" --> CONFLICT["409 IDEMPOTENCY_CONFLICT"]:::conflict
  IDEM -- new --> NEEDS{"Kind needs a BET reference?"}
  NEEDS -- no --> BAL{"Balance covers the movement?"}
  NEEDS -- yes --> FOUND{"Reference found?"}
  FOUND -- no --> HELD["202 PENDING_REFERENCE, held and announced"]:::held
  FOUND -- yes --> PROC{"Reference processed, same provider, wallet, round?"}
  PROC -- no --> REJ1["422 REFERENCE_NOT_PROCESSED or REFERENCE_CONTEXT_MISMATCH"]:::rejected
  PROC -- yes --> REV{"Already reversed, or already settled?"}
  REV -- yes --> REJ2["422 REFERENCE_ALREADY_REVERSED or REFERENCE_ALREADY_SETTLED"]:::rejected
  REV -- no --> BAL
  BAL -- no --> REJ3["422 INSUFFICIENT_BALANCE or REVERSAL_WOULD_OVERDRAW"]:::rejected
  BAL -- yes --> APP["201 PROCESSED: wallet, ledger, wager row, outbox"]:::applied

  classDef applied fill:#c8e6c9,stroke:#2e7d32,color:#000
  classDef replay fill:#bbdefb,stroke:#1565c0,color:#000
  classDef held fill:#ffe0b2,stroke:#ef6c00,color:#000
  classDef rejected fill:#ffcdd2,stroke:#c62828,color:#000
  classDef conflict fill:#e1bee7,stroke:#6a1b9a,color:#000
  classDef denied fill:#e0e0e0,stroke:#616161,color:#000
  classDef step fill:#ffffff,stroke:#455a64,color:#000
```

## Graph 2: a queued command, and the same path

Rendered as an image: [`docs/diagrams/queued-command.svg`](diagrams/queued-command.svg), so it can be shown without GitHub.

The queue reaches the same decision code as HTTP, from the lock onwards. Only the entry and the
acknowledgement differ.

```mermaid
flowchart TD
  Q[("wager-transactions.fifo")] --> RCV["Receive up to 10, long poll 1 s"]:::step
  RCV --> PARSE{"Body parses as WagerTransactionRequested?"}
  PARSE -- no --> DEAD["DEAD: send to the dead-letter queue, then ACK"]:::failure
  PARSE -- yes --> SAME["Same path as HTTP: lock, inbox check, settle"]:::step
  SAME --> OUT{"Outcome of the transaction"}
  OUT -- "applied, held, replayed or rejected" --> ACK["APPLIED: ACK after the commit"]:::applied
  OUT -- "permanent: validation, unknown wallet, payload conflict" --> DEAD
  OUT -- "transient: lost race, database or queue unavailable" --> RETRY["RETRY: visibility 2 s, doubling, max 300 s"]:::held
  RETRY --> REDO["Redelivered later. The inbox row says whether it was applied"]:::step
  REDO --> SAME
  DEAD -. "after 10 deliveries, the broker moves it" .-> DLQ[("wager-transactions-dlq.fifo")]:::failure

  classDef applied fill:#c8e6c9,stroke:#2e7d32,color:#000
  classDef held fill:#ffe0b2,stroke:#ef6c00,color:#000
  classDef failure fill:#ef9a9a,stroke:#b71c1c,color:#000
  classDef denied fill:#e0e0e0,stroke:#616161,color:#000
  classDef step fill:#ffffff,stroke:#455a64,color:#000
```

A replay from the queue is an APPLIED disposition too: the inbox row shows the message was seen,
and the stored result is returned without a second effect.

## Graph 3: which entities each outcome writes

Rendered as an image: [`docs/diagrams/outcome-entities.svg`](diagrams/outcome-entities.svg), so it can be shown without GitHub.

```mermaid
flowchart LR
  APPLIED(("Applied")):::applied --> W1[("wallets: balance and version")]:::applied
  APPLIED --> L1[("wallet_ledger_entries: one entry")]:::applied
  APPLIED --> T1[("wager_transactions: PROCESSED")]:::applied
  APPLIED --> O1[("outbox_messages: two events")]:::applied

  REJECTED(("Rejected by a rule")):::rejected --> T2[("wager_transactions: REJECTED, with its code")]:::rejected
  REJECTED --> O2[("outbox_messages: one event")]:::rejected
  REJECTED -.-> W2[("wallets: not written")]:::untouched
  REJECTED -.-> L2[("wallet_ledger_entries: not written")]:::untouched

  HELD(("Held for a reference")):::held --> T3[("wager_transactions: PENDING_REFERENCE")]:::held
  HELD --> O3[("outbox_messages: one event, pending reference")]:::held
  HELD -.-> W3[("wallets: not written")]:::untouched

  REPLAY(("Replay")):::replay -.-> T4[("wager_transactions: read only")]:::replay
  REPLAY -.-> W4[("wallets: not written")]:::untouched

  CONFLICT(("Conflict")):::conflict -.-> ALL[("no table written")]:::conflict

  FAIL(("Infrastructure failure")):::failure -.-> ROLL[("every write in the transaction rolled back")]:::failure
  FAIL -.-> MSG[("queue message redelivered")]:::failure

  classDef applied fill:#c8e6c9,stroke:#2e7d32,color:#000
  classDef rejected fill:#ffcdd2,stroke:#c62828,color:#000
  classDef held fill:#ffe0b2,stroke:#ef6c00,color:#000
  classDef replay fill:#bbdefb,stroke:#1565c0,color:#000
  classDef conflict fill:#e1bee7,stroke:#6a1b9a,color:#000
  classDef failure fill:#ef9a9a,stroke:#b71c1c,color:#000
  classDef untouched fill:#ffffff,stroke:#9e9e9e,stroke-dasharray: 4 3,color:#616161
```

## Matrix: functions against entities

Legend: **L** the wallet row lock, **R** read, **W** write (insert or update), **C** created in
memory and returned, **E** enqueued in the outbox in the same transaction, **—** not touched.

| #   | Function (in run order)                                                                             | Wallet                     | Ledger | Wager transaction | Inbox | Outbox                     | API client                | Event | Flow                      |
| --- | --------------------------------------------------------------------------------------------------- | -------------------------- | ------ | ----------------- | ----- | -------------------------- | ------------------------- | ----- | ------------------------- |
| 1   | `ApiKeyGuard.canActivate` → `AuthenticateApiKey.execute`                                            | —                          | —      | —                 | —     | —                          | R (`findActiveByKeyHash`) | —     | HTTP                      |
| 2   | `WageringController.submit` → `requireProviderScope`                                                | —                          | —      | —                 | —     | —                          | —                         | —     | HTTP                      |
| 3   | `parseProcessWagerRequest` (or `parseWagerCommandMessage`)                                          | —                          | —      | —                 | —     | —                          | —                         | —     | HTTP, queue               |
| 4   | `ProcessWagerTransaction.execute` → `WagerTransaction.create`                                       | —                          | —      | C                 | —     | —                          | —                         | —     | HTTP, queue               |
| 5   | `process` → `MikroOrmWalletRepository.findForUpdate`                                                | L                          | —      | —                 | —     | —                          | —                         | —     | HTTP, queue, reference    |
| 6   | `isInboundRecorded` → `MikroOrmInboxRepository.find`                                                | —                          | —      | —                 | R     | —                          | —                         | —     | queue                     |
| 7   | `MikroOrmWagerTransactionRepository.findByIdempotencyKey`                                           | —                          | —      | R                 | —     | —                          | —                         | —     | HTTP, queue               |
| 8   | `replay` (when the key was seen)                                                                    | —                          | —      | R                 | —     | —                          | —                         | —     | HTTP, queue               |
| 9   | `TransactionSettlement.settle` → `findByExternalId` (reference)                                     | —                          | —      | R                 | —     | —                          | —                         | —     | HTTP, queue, reference    |
| 10  | `WagerTransaction.walletMismatch`, `WagerTransaction.evaluateReference`                             | —                          | —      | —                 | —     | —                          | —                         | —     | all                       |
| 11  | `hasProcessedReversal`, `hasProcessedResult`                                                        | —                          | —      | R                 | —     | —                          | —                         | —     | all                       |
| 12  | `Wallet.canDebit`, `Wallet.debit` or `Wallet.credit`                                                | —                          | C      | —                 | —     | —                          | —                         | —     | all                       |
| 13  | `WagerTransaction.markProcessed`, `reject`, `markPendingReference`                                  | —                          | —      | C (state)         | —     | —                          | —                         | —     | all                       |
| 14  | `save` → `MikroOrmWagerTransactionRepository.insert` or `update`                                    | —                          | —      | W                 | —     | —                          | —                         | —     | all                       |
| 15  | `save` → `MikroOrmWalletRepository.save` (guarded by version)                                       | W                          | —      | —                 | —     | —                          | —                         | —     | all with a balance change |
| 16  | `save` → `MikroOrmWalletLedgerRepository.append`                                                    | —                          | W      | —                 | —     | —                          | —                         | —     | all with a balance change |
| 17  | `repositories.outbox.enqueue` (events built from the state)                                         | —                          | —      | —                 | —     | E                          | —                         | C     | all                       |
| 18  | `recordInbound` → `MikroOrmInboxRepository.insert`                                                  | —                          | —      | —                 | W     | —                          | —                         | —     | queue                     |
| 19  | Commit of the unit of work                                                                          | all of the above, together |        |                   |       |                            |                           |       | all                       |
| 20  | `OutboxPublisher.publishOnce` → `claimDue`                                                          | —                          | —      | —                 | —     | W (lease)                  | —                         | —     | after commit              |
| 21  | `SqsEventTransport.publish` → `SqsQueue.send`                                                       | —                          | —      | —                 | —     | R                          | —                         | sent  | after commit              |
| 22  | `OutboxPublisher.deliver` → `complete` or `reschedule`                                              | —                          | —      | —                 | —     | W (guarded by lease token) | —                         | —     | after commit              |
| 23  | `WalletQueries.reconcile` → `findForShare`, `summarize`                                             | S                          | R      | —                 | —     | —                          | —                         | —     | reconciliation            |
| 24  | `WalletQueries.listLedger` → `listPageAfter`                                                        | —                          | R      | —                 | —     | —                          | —                         | —     | ledger                    |
| 25  | `ProcessPendingReferences.runOnce` → `findDueForReferenceLookup`                                    | —                          | —      | R                 | —     | —                          | —                         | —     | reference                 |
| 26  | `ProcessPendingReferences.resolveOne` → `findForUpdate`, `findById`, then `settle(existing = true)` | L, R                       | —      | R, W              | —     | E                          | —                         | —     | reference                 |

Row 19 is the point of atomicity. A failure at any row before it leaves no write behind, which is
why a crashed transaction shows nothing in any table.

`S` in row 23 is a shared lock: it lets reads through, and makes a debit wait.

## Entities

| Entity                | Table                   | Record class              | Repository                                                            | Domain class                                                                                        |
| --------------------- | ----------------------- | ------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `Wallet`              | `wallets`               | `WalletRecord`            | `MikroOrmWalletRepository`                                            | `Wallet`                                                                                            |
| `WalletLedgerEntry`   | `wallet_ledger_entries` | `WalletLedgerEntryRecord` | `MikroOrmWalletLedgerRepository`                                      | `WalletLedgerEntry`                                                                                 |
| `WagerTransaction`    | `wager_transactions`    | `WagerTransactionRecord`  | `MikroOrmWagerTransactionRepository`                                  | `WagerTransaction`                                                                                  |
| `InboxMessage`        | `inbox_messages`        | `InboxMessageRecord`      | `MikroOrmInboxRepository`                                             | `InboxMessage`                                                                                      |
| `OutboxMessage`       | `outbox_messages`       | `OutboxMessageRecord`     | `MikroOrmOutboxRepository` (enqueue), `MikroOrmOutboxStore` (publish) | `OutboxMessage`                                                                                     |
| `ApiClient`           | `api_clients`           | `ApiClientRecord`         | `MikroOrmApiClientRepository`                                         | `Principal`, `api-key` functions                                                                    |
| Integration events    | in `outbox_messages`    | none                      | `MikroOrmOutboxRepository.enqueue`                                    | `IntegrationEvent` and its four subclasses                                                          |
| Commands and messages | none                    | none                      | none                                                                  | `ProcessWagerCommand`, `OpenWalletInput`, `CreateApiClientInput`, `ReceivedMessage`                 |
| Values and policies   | none                    | none                      | none                                                                  | `Money`, `KIND_RULES`, `FAILURE_CODES`, `referenceRetryDelayMs`, `wagerPayloadHash`, `LedgerCursor` |
| Errors                | none                    | none                      | none                                                                  | `DomainError`, application errors, `RequestValidationError`                                         |

Six tables hold everything. The rest is passed in memory, or in a message.

### Wallet

| Method                  | Caller                                     | Effect                                         |
| ----------------------- | ------------------------------------------ | ---------------------------------------------- |
| `findForUpdate`         | `process`, `resolveOne`                    | the wallet lock, `FOR UPDATE`                  |
| `findForShare`          | `WalletQueries.reconcile`                  | `FOR SHARE`, so a debit waits for the read     |
| `findById`              | `WalletQueries.getWallet`, `resolveOne`    | read, without a lock                           |
| `insert`                | `OpenWallet.execute`                       | one row                                        |
| `save(wallet, version)` | `TransactionSettlement.applyBalanceChange` | `UPDATE ... WHERE version = expected`, one row |

`Wallet.open` creates the wallet. It returns the opening ledger entry only for a positive balance.
`Wallet.debit` and `Wallet.credit` return the new state and an entry, and bump `version` once.

### WalletLedgerEntry

| Method                            | Caller                                     | Effect                                            |
| --------------------------------- | ------------------------------------------ | ------------------------------------------------- |
| `append`                          | `OpenWallet.execute`, `applyBalanceChange` | one `INSERT`; a trigger refuses update and delete |
| `summarize(walletId, currency)`   | `WalletQueries.reconcile`                  | the sum and whether the chain is intact           |
| `listPageAfter(walletId, seq, n)` | `WalletQueries.listLedger`                 | keyset page                                       |
| `listByWallet`                    | diagnostics and tests                      | all entries, in order                             |

### WagerTransaction

| Method                      | Caller                                   | Effect                                              |
| --------------------------- | ---------------------------------------- | --------------------------------------------------- |
| `findByIdempotencyKey`      | `process`                                | the replay check                                    |
| `findByExternalId`          | `settle`, `WagerQueries.getByExternalId` | the reference, or a lookup by provider id           |
| `findById`                  | `WagerQueries.getById`, `resolveOne`     | one row                                             |
| `findDueForReferenceLookup` | `ProcessPendingReferences.runOnce`       | held rows whose lookup is due, at most 20           |
| `hasProcessedReversal`      | `settle`                                 | REFUND or ROLLBACK already applied to the reference |
| `hasProcessedResult`        | `settle`                                 | WIN or LOSS already applied to the BET              |
| `insert`, `update`          | `save`, `holdOrRecordMiss`               | one row                                             |

### InboxMessage and OutboxMessage

| Method                             | Caller                         | Effect                                              |
| ---------------------------------- | ------------------------------ | --------------------------------------------------- |
| `MikroOrmInboxRepository.find`     | `isInboundRecorded`            | was this message applied, and with which payload    |
| `MikroOrmInboxRepository.insert`   | `recordInbound`                | one row, primary key `(consumer_name, message_id)`  |
| `MikroOrmOutboxRepository.enqueue` | `settle`, `OpenWallet.execute` | one row, in the same transaction                    |
| `MikroOrmOutboxStore.claimDue`     | `publishOnce`                  | `FOR UPDATE SKIP LOCKED`, sets the lease            |
| `MikroOrmOutboxStore.complete`     | `deliver`                      | marks published, only while the lease token matches |
| `MikroOrmOutboxStore.reschedule`   | `deliver`                      | a failed send, with the next attempt                |

### ApiClient

| Method                | Caller                       | Effect                                         |
| --------------------- | ---------------------------- | ---------------------------------------------- |
| `findActiveByKeyHash` | `AuthenticateApiKey.execute` | the client that holds the hash, if not revoked |
| `insert`              | `CreateApiClient.execute`    | one row, with the hash of the key              |
| `revoke`              | `auth:revoke`                | sets `revoked_at` once                         |

## Sequence diagrams

### A BET over HTTP

```mermaid
sequenceDiagram
  participant P as Provider
  participant G as ApiKeyGuard
  participant C as WageringController
  participant U as ProcessWagerTransaction
  participant S as TransactionSettlement
  participant DB as PostgreSQL
  P->>G: POST /wagering/transactions, bearer key, Idempotency-Key
  G->>DB: api_clients by key hash
  G->>C: principal
  C->>C: requireProviderScope, parse the body
  C->>U: execute(command)
  U->>DB: SELECT wallets FOR UPDATE
  U->>DB: SELECT wager_transactions by idempotency key
  alt key seen before
    U-->>C: stored result
    C-->>P: 200 replay
  else new
    U->>S: settle
    S->>DB: reference, reversal and result checks
    S->>S: Wallet.debit, WagerTransaction.markProcessed
    S->>DB: INSERT wager_transactions
    S->>DB: UPDATE wallets WHERE version
    S->>DB: INSERT wallet_ledger_entries
    S->>DB: INSERT outbox_messages, twice
    S-->>U: outcome
    C-->>P: 201, or 202 or 422 by outcome
  end
```

### A command from the queue

```mermaid
sequenceDiagram
  participant Q as SQS command queue
  participant C as WagerCommandConsumer
  participant U as ProcessWagerTransaction
  participant DB as PostgreSQL
  C->>Q: receive, up to 10, long poll 1 s
  Q-->>C: messages
  loop each message
    C->>U: execute, the same path as HTTP
    U->>DB: lock wallet, inbox check, settle, INSERT inbox_messages
    U-->>C: APPLIED, DEAD or RETRY
  end
  alt APPLIED
    C->>Q: DeleteMessage, after the commit
  else DEAD
    C->>Q: send to the dead-letter queue, then delete
  else RETRY
    C->>Q: ChangeMessageVisibility, 2 s doubling, max 300 s
  end
```

### An event, from commit to the events queue

```mermaid
sequenceDiagram
  participant T as Transaction
  participant DB as PostgreSQL
  participant P as OutboxPublisher
  participant E as SqsEventTransport
  participant EQ as SQS events queue
  T->>DB: INSERT outbox_messages, in the same commit
  Note over T,DB: nothing is published before the commit
  P->>DB: claimDue, FOR UPDATE SKIP LOCKED, sets the lease token
  P->>E: publish(id, aggregateId, payload)
  E->>EQ: SendMessage, group = aggregate, deduplication = event id
  P->>DB: complete, only while the lease token still matches
```

### A held reference, resolved later

```mermaid
sequenceDiagram
  participant W as Worker loop
  participant R as ProcessPendingReferences
  participant DB as PostgreSQL
  participant S as TransactionSettlement
  W->>R: runOnce
  R->>DB: SELECT due held rows, at most 20
  loop each held row
    R->>DB: SELECT wallets FOR UPDATE
    R->>DB: re-read the row under the lock
    R->>S: settle, existing = true
    S->>DB: UPDATE the row, INSERT the ledger entry, enqueue the events
  end
```

### A provider out of scope

```mermaid
sequenceDiagram
  participant P as Provider A
  participant C as WageringController
  P->>C: POST with providerId provider-b
  C->>C: requireProviderScope: provider A is not provider B
  C-->>P: 403 FORBIDDEN, nothing written
```

## Where to change what

- **A new kind of operation:** `KIND_RULES` in `wager-transaction-kind.ts`, the CHECK in a new
  migration, and tests in `test/unit/wagering` and `test/integration/wagering`.
- **A new event:** a class that extends `IntegrationEvent`, enqueued in `TransactionSettlement` or
  `OpenWallet`, with a test in `test/integration/messaging`.
- **A new table:** a migration, a record class, a repository, and a probe in
  `test/integration/schema/schema-constraints.test.ts`.
