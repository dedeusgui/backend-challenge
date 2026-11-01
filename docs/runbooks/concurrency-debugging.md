# Depuração de concorrência

## Contexto

Use quando houver contenção, deadlock, duplicidade sob corrida, timeout de lock ou divergência entre saldo e ledger.

## Comandos

- `bun run test:concurrency` executa as provas concorrentes.
- `bun run test:integration` cobre locks, timeouts e persistência.
- `bun run test:unit` executa a suíte unitária.
- `bun run check:fast` valida tipo, lint, formato, unidades e arquitetura.

## Invariantes e evidências

- O trabalho financeiro usa transação e limites de lock/statement: `src/shared/infrastructure/database/mikro-orm-financial-unit-of-work.ts`; [teste de timeout](../../test/integration/wagering/lock-timeout.test.ts).
- A serialização do saldo deve impedir saldo negativo e preservar igualdade com ledger: `src/modules/wallet/domain/wallet.ts`; [teste de carteira concorrida](../../test/concurrency/hot-wallet.test.ts).
- Retentativa de conflito deve observar o vencedor e não aplicar a mesma operação duas vezes: `src/modules/wagering/application/process-wager-transaction.use-case.ts`; [teste de idempotência e corrida](../../test/integration/wagering/process-wager-transaction.test.ts).
- A estratégia de lock pessimista está registrada no ADR: [ADR 0001](../adr/0001-pessimistic-wallet-lock.md); sua prova concorrente está em [hot-wallet](../../test/concurrency/hot-wallet.test.ts).

## Conclusão

Reproduza a corrida com um teste determinístico, confira ambos os resultados e o estado persistido e rode a suíte concorrente. A correção só termina quando o teste antes falhar pelo motivo esperado e a igualdade saldo/ledger e ausência de duplicidade forem demonstradas.
