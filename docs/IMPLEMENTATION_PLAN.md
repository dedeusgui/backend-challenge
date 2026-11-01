# Plano de implementação e status

> **Apêndice.** O registro dos slices, mantido como histórico. Onde diferir de [ARCHITECTURE.md](../ARCHITECTURE.md),
> ARCHITECTURE.md é a leitura atual.
>
> Os números de carga desta página são de uma rodada anterior e estão superados. Os valores atuais estão em [LOAD_TEST_RESULTS.md](LOAD_TEST_RESULTS.md).

A [especificação do desafio](CHALLENGE.md) é mandatória. A
[matriz de requisitos](REQUIREMENTS_MATRIX.md) é o status detalhado. Esta página
resume os slices e o que cada um comprovou.

## Fundação e ferramentas

- [x] Bun 1.4.4 fixado localmente, no CI e no Dockerfile. `bun.lock` commitado.
- [x] `check:fast` e `check:all` executam o que anunciam. O CI executa `check:all`.
- [x] Compose inicia o PostgreSQL 17 e o LocalStack 4.14, provisiona as filas FIFO e a
      política de redrive, executa a migração uma vez e, em seguida, inicia a API e o worker.
- [x] Apontamentos da auditoria corrigidos: o Dockerfile instalava sem lockfile, o CI usava uma versão
      flutuante do Bun e `format:check` falhava em cinco arquivos.

## Domínio

- [x] `Money`: aritmética decimal exata, entrada estrita, verificações de moeda, verificação contra mutação.
- [x] `Wallet` e `WalletLedgerEntry`: proteção de saldo, validação antes da mutação, abertura, versão.
- [x] `WagerTransaction`: tabela de regras por tipo, máquina de estados, avaliação de referência, códigos de falha.
- [x] Hash canônico de payload com golden test.
- [x] Envelope de eventos de integração e os quatro eventos concretos.
- [x] Entidades de inbox e outbox, com backoff de retentativa.

## Persistência

- [x] Migração 1: tabelas, constraints, índices parciais, trigger append-only.
- [x] Migração 2: agendamento de referência, reversível.
- [x] Migração 3: uma operação referenciada é revertida uma única vez, qualquer que seja o tipo de reversão, e um
      WIN pode carregar a referência de sua BET. Reversível.
- [x] Repositórios com mapeamento explícito e parsing checado de enums armazenados.
- [x] Migrações aplicadas a partir do banco vazio, revertidas até zero e reaplicadas.

## Aplicação

- [x] `ProcessWagerTransaction`: um único caminho para HTTP e SQS, com idempotência sob o lock da carteira.
- [x] `TransactionSettlement`: a decisão financeira única, compartilhada com o worker de referências.
- [x] `ProcessPendingReferences`: retenções vencidas resolvidas sob o lock da carteira, retentativas delimitadas.
- [x] `OpenWallet`, consultas de carteira e de operações, reconciliação (apenas diagnóstica).

## Mensageria

- [x] Consumidor de comandos: ACK após commit, falha permanente para a DLQ, falha transitória com backoff.
- [x] Publicador do outbox: reserva e lease com `SKIP LOCKED`, marcações de propriedade do lease, at-least-once.
- [x] Redrive no broker após dez entregas verificado na fila provisionada pelo Compose.

## HTTP, integridade e observabilidade

- [x] Endpoints na seção 10 de `ARCHITECTURE.md`, com a taxonomia de status.
- [x] Liveness é livre de dependências. Readiness sonda o PostgreSQL e o SQS e responde 503 quando algum falhar.
- [x] Logs de operações em JSON sem valores monetários. Métricas por processo em `GET /metrics`.
- [x] Cada métrica mínima possui uma asserção: transações, replays, conflitos de lock, retentativas, DLQ, lag do outbox, latência e divergências.

## Prova de concorrência e de falhas

- [x] Hot wallet 80/80, cinquenta requisições idênticas, carteiras distintas, uma hot wallet mista e
      reversões concorrentes, tudo em processo, com o invariante final.
- [x] Três processos independentes de API e um worker contra PostgreSQL e LocalStack compartilhados.
- [x] Queda após o commit e antes do ACK, recuperada por um worker reiniciado, com um único efeito.
- [x] Encerramento gracioso por SIGTERM finaliza com 0.
- [x] Injeção de falhas antes do commit, após aceite do broker e antes da marcação, e durante
      a resolução de referências.
- [x] Invariante do ledger verificado no encerramento de cada suíte de testes de fluxo com banco de dados.
- [x] Queda em nível de processo antes do commit e lote interrompido durante o encerramento
      (`test/concurrency/process-crash-and-shutdown.test.ts`).

## Documentação e decisões

- [x] `README.md`, `ARCHITECTURE.md` com cinco diagramas Mermaid, `docs/TEST_STRATEGY.md`.
- [x] Sete ADRs em `docs/adr/`, cada um com as evidências que o sustentam. ADR 0006 foi substituído pelo 0007.
- [x] Comparação com repositórios públicos reescrita e depois removida do repositório (histórico no git).
- [x] `CLAUDE.md` para agentes.

## Não contemplado nesta versão

- Autenticação não é integração com IdP (ADR 0007): chaves de API com dois papéis, tabela de chaves com hash, escopo de provedor e uma CLI para criar e revogar chaves.
- Teste de carga: fixado em 1, 2 e 4 CPUs em uma VM de nuvem. Taxas acordadas de 25, 100 e 200 req/s; primeiras com falha em 50, 125 e 300. Registros em `docs/load/results/`, relatório em `docs/LOAD_TEST_RESULTS.md`. Não está em `check:all`.
- Ferramenta de replay de dead-letter e rotina agendada de reconciliação.

## Revisão de finalização (esta branch)

Alterações da revisão, cada uma com sua evidência na mensagem de commit e na seção P de `DECISIONS.md`:

- Fila e HTTP compartilham um único parser para os campos de negócio (`d437452`); uma cópia em dead-letter mantém uma cópia dentro da
  janela do broker (`ebc9589`); uma duplicata que aguarda o lock não grava uma segunda linha na inbox (`a10fd11`).
- Instrumentação de fases da transação, do lock e do outbox (`ceb60c7`), e o harness de carga a lê
  (`e6b0380`).
- Lotes do outbox na ordem devida, o que corrigiu um defeito de ordenação (`89b7bc1`); menos round trips no caminho de lock, com uma
  consulta de resultado que usa os índices parciais (`9e8dabe`).
- O teste de queda executa isoladamente (`f0f1f9b`); fixtures de teste falham em caso de valor ausente (`336110b`).
- Modo protegido, uma borda opcional Nginx com limites por cliente, e sua suíte (`66c590f`).
- O relatório fixado de carga deste host: 100, 200 e 400 req/s acordados em 1, 2 e 4 CPUs.
