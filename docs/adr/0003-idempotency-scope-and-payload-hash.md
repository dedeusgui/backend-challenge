# ADR 0003: Escopo de idempotência e hash canônico de payload

**Status:** aceito

## Contexto

O cabeçalho `Idempotency-Key` é a fonte da verdade (desafio §10). Uma requisição
repetida deve fazer o replay do resultado original, incluindo o saldo visto na época. A mesma
chave com um payload diferente é um conflito, não um replay.

## Decisão

- A unicidade é por provedor: `UNIQUE(provider_id, idempotency_key)` e
  `UNIQUE(provider_id, external_transaction_id)` em `wager_transactions`.
- Uma requisição é um replay quando o hash do seu **payload de negócio** corresponde a uma
  transação armazenada encontrada pela chave ou pelo id externo. O payload é `providerId`,
  `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`,
  `money` e a referência. A chave e os metadados de transporte são excluídos.
- O hash é SHA-256 sobre JSON canônico: chaves ordenadas em todos os níveis, sem
  espaços em branco, uma referência ausente como `null`. Um golden test fixa a string exata.
- O resultado, incluindo `result_balance`, é armazenado na linha, para que um replay retorne
  o saldo observado no momento, mesmo após operações posteriores.

## Alternativas

- **Escopo global de chave.** Dois provedores poderiam colidir em uma chave que eles não controlam.
  O escopo por provedor evita isso, e o provedor já faz parte de toda busca de qualquer forma.
- **Calcular o hash de todo o corpo da requisição.** Incluiria campos de transporte e tornaria uma
  reordenação inofensiva em um conflito.
- **Cache em memória.** Proibido (desafio §5.2), e incorreto entre instâncias.

## Consequências

- Um mesmo id externo sob outra chave com o mesmo payload faz replay. Sob um
  payload diferente, gera conflito. Ambos são cobertos por testes.
- Alterar a forma canônica invalida hashes armazenados. O golden test é a
  guarda contra uma alteração acidental.

## Evidências

- `test/unit/wagering/domain/wager-payload-hash.test.ts` (string de referência e
  sensibilidade por campo).
- `test/integration/wagering/process-wager-transaction.test.ts`: replay com o
  saldo original, conflito e casos de id externo entre chaves.
- `test/concurrency/three-processes.test.ts`: 50 requisições idênticas em três
  processos produzem um débito e um id de transação.
