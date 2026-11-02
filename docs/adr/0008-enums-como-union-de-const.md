# ADR 0003: Enums como união de tipos com const

**Status:** aceito

## Contexto

O domínio possui conjuntos finitos de estados e papéis: status de transação (`WagerTransactionStatus`), tipos de operação (`WagerTransactionKind`), papéis de cliente de API (`ApiClientRole`), direções de movimentação do ledger (`LedgerDirection`) e códigos de falha (`FailureCode`). Esses valores trafegam como strings em payloads JSON nas fronteiras de rede (HTTP e SQS) e são persistidos no PostgreSQL em colunas de tipo `text` (como `kind` e `status` em `src/modules/wagering/infrastructure/wager-transaction.record.ts:17,22`, `direction` em `src/modules/wallet/infrastructure/wallet-ledger-entry.record.ts:12` e `role` em `src/modules/auth/infrastructure/api-client.record.ts:10`).

## Decisão

Representar conjuntos finitos por arrays imutáveis literais anotados com `as const`, derivando o tipo de união por meio de `(typeof ARRAY)[number]`. Não utilizar a palavra-chave `enum` do TypeScript.

Sem objeto em tempo de execução gerado pelo compilador: o valor em memória, o valor gravado no banco de dados e o valor serializado em JSON são a mesma string literal, eliminando etapas de mapeamento reverso. O array literal atua simultaneamente como catálogo em tempo de execução para os validadores de entrada e de infraestrutura.

## Alternativas

- **`enum` numérico do TypeScript.** Rejeitado: emite um objeto bidirecional em tempo de execução com mapeamento reverso entre nome e número, incompatível com literais de texto esperados em JSON e em colunas `text`.
- **`enum` com string do TypeScript.** Rejeitado: gera código de objeto no build JavaScript e exige funções auxiliares como `Object.values` para iterar sobre valores válidos.
- **Classes com constantes estáticas.** Rejeitado: sintaxe verbosa, gera código desnecessário em tempo de execução e não deriva tipos de união fechados diretamente.

## Consequências

- Ausência de namespace de enum em tempo de execução. Para operações que exigem listagem ou verificação de valores válidos, utiliza-se diretamente o array imutável subjacente.
- Casos no código que utilizam o array diretamente: geração de mensagens de erro na validação de entrada (`src/modules/wagering/application/wager-command-fields.ts:75` com `WAGER_TRANSACTION_KINDS.join(', ')`, e `src/auth.ts:44` com `API_CLIENT_ROLES.join(', ')`), e narrowing na leitura do banco de dados com `oneOf` (`src/shared/infrastructure/database/stored-values.ts:5`).

## Evidências

- O compilador do TypeScript (`bun run typecheck`, `tsc --noEmit`) rejeita atribuições de valores fora do conjunto de união nas camadas de domínio e aplicação.
- A contagem de `enum` do TypeScript no projeto é 0 (confirmado com `grep -rn "^\s*\(export \)\?enum " src test`).
- Teste unitário de narrowing na leitura de valores gravados: `test/unit/shared/validation-and-errors.test.ts:161-167` comprova que `oneOf` recusa valores fora da lista permitida e reporta o valor desconhecido.
