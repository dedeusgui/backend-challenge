# Mudança financeira

## Contexto

Use este roteiro ao alterar saldos, lançamentos, regras de BET/WIN/LOSS/REFUND/ROLLBACK, idempotência ou liquidação.
Leia também [CLAUDE.md](../../CLAUDE.md) e [Arquitetura](../../ARCHITECTURE.md) antes de mudar código financeiro.

## Comandos

- `bun run test:unit` para unidades; `bun run test:integration` cobre persistência financeira.
- `bun run test:concurrency` cobre corridas entre processos.
- `bun run check:fast` é a verificação rápida; para mudança financeira, o gate completo é `bun run check:all`.
- `bun run arch:check` verifica fronteiras entre módulos.

## Invariantes e evidências

- Valores monetários são decimais exatos e nunca `number`: `src/shared/domain/money.ts`; [teste](../../test/unit/shared/domain/money.test.ts).
- O saldo não pode ficar negativo e deve corresponder à soma do ledger: `src/modules/wallet/domain/wallet.ts`; [concorrência](../../test/concurrency/hot-wallet.test.ts).
- Liquidação mantém as regras num único serviço compartilhado pelos fluxos HTTP e de referência: `src/modules/wagering/application/transaction-settlement.ts`; [teste](../../test/integration/wagering/process-wager-transaction.test.ts).
- Persistência financeira ocorre numa transação unitária: `src/shared/infrastructure/database/mikro-orm-financial-unit-of-work.ts`; [teste de crash e rollback](../../test/integration/faults/fault-injection.test.ts).
- Uma referência só pode ser revertida/liquidada conforme o ciclo de vida: `src/modules/wagering/domain/wager-transaction.ts`; [teste de liquidação](../../test/integration/wagering/process-wager-transaction.test.ts).

## Conclusão

Documente o teste que falhava antes, execute os testes relevantes e registre comando e resultado no [contrato de evidências](code-review-verification.md#contrato-de-evidências). Mudanças financeiras precisam de revisão independente antes do merge. Só conclua quando as regras financeiras e o ledger persistido concordarem e o gate aplicável passar.
