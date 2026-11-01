# ADR 0001: Bloqueio pessimista de linha na carteira

**Status:** aceito

## Contexto

A unidade de concorrência é a carteira (desafio §8). Duas apostas de 80.00 contra um
saldo de 100.00 devem produzir um débito, uma recusa e um saldo final de
20.00, com várias instâncias em execução.

## Decisão

Toda operação financeira primeiro lê a carteira com `SELECT ... FOR UPDATE`
(`MikroOrmWalletRepository.findForUpdate`, `LockMode.PESSIMISTIC_WRITE`). A
verificação de idempotência de uma nova operação se repete sob esse bloqueio, e a decisão de saldo acontece ali.
Um replay de uma transação armazenada é respondido antes do bloqueio, porque não escreve nada (ARCHITECTURE
seção 5). A escrita
do novo saldo também é guardada por `WHERE version = expected`, de modo que um bloqueio perdido
seja detectado em vez de sobrescrever silenciosamente.

## Alternativas

- **Versão otimista com retentativa limitada.** Menos esperas sob baixa contenção, mas
  sob uma carteira disputada toda tentativa perdedora repete a decisão inteira. Medimos
  isso: com o bloqueio de linha removido e a guarda de versão mantida, o caso misto
  de carteira disputada esgota suas três tentativas e falha com CONCURRENCY_CONFLICT
  (`test/concurrency/hot-wallet.test.ts`). Nenhum saldo foi corrompido.
- **UPDATE atômico condicional** (`SET balance = balance - ? WHERE balance >= ?`).
  Correto apenas para o saldo, mas as decisões de idempotência e do ledger
  ainda precisariam de coordenação, portanto o bloqueio é mantido para toda a decisão.
- **Redis ou outro bloqueio externo.** Adiciona um modo de falha enquanto o PostgreSQL já
  é o dono da consistência (ARCHITECTURE §5).

## Consequências

- As operações em uma carteira são serializadas. Uma carteira disputada tem um teto de vazão
  definido pelo tempo de transação. Isso é aceito e é o principal trade-off.
- Operações em carteiras diferentes nunca bloqueiam umas às outras (`test/concurrency`).
- Bloqueios são mantidos pela duração de uma transação curta. Nenhum I/O de SQS acontece
  dentro dela (ADR 0004).
- O tempo de espera de bloqueio ainda não é exportado como métrica (`OBS-03` permanece parcial).

## Evidências

- `test/concurrency/hot-wallet.test.ts`: 80/80 em 100, 50 requisições idênticas, 40
  operações mistas em uma carteira, dois reembolsos concorrentes.
- `test/concurrency/three-processes.test.ts`: as mesmas disputas em três processos
  de API e um worker.
- Verificações de mutação registradas nas mensagens de commit: sem o bloqueio e a guarda,
  o caso 80/80 debita em duplicidade.
