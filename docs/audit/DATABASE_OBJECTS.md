# Objetos de banco: o que entrou, o que foi medido e o que ficou de fora

Cada objeto de banco que foi considerado nesta rodada tem uma decisão e uma razão. "Adotado" significa que está
numa migration, com teste. "Não adotado" significa que a razão está descrita e, quando havia medição, o número
está em `PERFORMANCE_COMPARISON.md`.

| Objeto                                                                            | Decisão               | Razão                                                                                                                                                                                                                          | Prova                                                                                                                                             |
| --------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| CHECK, NOT NULL, UNIQUE, FK compostas (vocabulário, forma das linhas, aritmética) | Já existiam, mantidos | Custo zero na escrita, e cada regra é local à linha                                                                                                                                                                            | `test/integration/schema/schema-constraints.test.ts`                                                                                              |
| **Guardas de linha**, `BEFORE UPDATE` (migration 10)                              | **Adotado**           | Lêem só a linha alterada, sem consulta sob o lock. Impõem identidade e payload, a tabela de transições de status, o estado terminal, o contador monotônico, e a regra de versão da wallet (§6.2)                               | `row-guards.test.ts` (37 casos, incluindo os 20 pares de status comparados com a tabela de domínio); experimento 1b                               |
| **Triggers entre linhas** (concordância saldo/ledger)                             | **Não adotado**       | Consultam o ledger e rodam no `COMMIT`, com o lock da wallet ativo. Custo mediano medido de +1,8 ms sob contenção, e cauda não delimitada                                                                                      | `PERFORMANCE_COMPARISON.md`, experimento 1                                                                                                        |
| **View de leitura consolidada** `wallet_ledger_summary` (migration 11)            | **Adotado**           | Mostra, por wallet, saldo gravado, soma do ledger, número de lançamentos e diferença. Não influencia nenhuma decisão. Serve de segunda implementação da mesma regra, que a reconciliação calcula em TypeScript                 | `wallet-ledger-summary.test.ts` (3 casos, incluindo a divergência com versão consistente, que as duas implementações encontram com o mesmo valor) |
| **View materializada**                                                            | **Não adotado**       | Mostraria um saldo anterior ao último commit. Um número cuja função é conferir o saldo não pode estar defasado. Não há dado fixo que justifique o custo de atualização                                                         | —                                                                                                                                                 |
| **Procedure** para resolver uma operação                                          | **Não adotado**       | A regra de negócio ficaria duplicada em SQL, e `CLAUDE.md` exige que cada regra financeira exista em um só lugar, no domínio, chamada por HTTP, fila e worker. A atomicidade já vem da unidade de trabalho e do lock da wallet | `CLAUDE.md`, seção de fronteiras                                                                                                                  |
| Tabela de referência para status e códigos de falha, com FK                       | **Não adotado**       | Um CHECK já cobre o vocabulário, sem join em cada escrita. A tabela de transições fica no código, e é copiada para a guarda, com teste que compara os dois                                                                     | `row-guards.test.ts`                                                                                                                              |

## Como a decisão foi tomada

1. Cada objeto precisava responder a uma exigência do enunciado, ou a um risco demonstrado. Não entrou nada só por
   ser "mais garantia".
2. Um objeto que consultasse outras linhas dentro do caminho da escrita foi medido antes de ser adotado. Os dois
   que fizeram isso (triggers entre linhas, medidos com seis rodadas) ficaram de fora.
3. Um objeto de leitura só entrou quando uma segunda implementação dele pôde ser comparada com a da aplicação.

## Limite declarado

A guarda de linha não impede uma divergência em que o saldo e a versão mudam juntos sem lançamento. Esse caso passa
pela guarda e é encontrado pela reconciliação. Quem quiser impedi-lo na escrita precisa do trigger entre linhas, com
o custo medido em `PERFORMANCE_COMPARISON.md`.
