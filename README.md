# Distributed Wagering Processor

Serviço transacional que processa `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK` por HTTP e SQS. Mantém o saldo de cada carteira igual à soma do ledger diante de concorrência, duplicatas, falhas e reinícios.

Versão em inglês: [README.en.md](README.en.md). Índice da documentação: [docs/README.md](docs/README.md).

## 1. O que o projeto resolve

O projeto é uma implementação do [desafio técnico](docs/CHALLENGE.md): receber comandos de provedores de jogos e liquidá-los sem saldo negativo, débito duplicado ou divergência entre carteira e ledger. A avaliação cobre correção financeira, concorrência, idempotência, mensageria e recuperação.

## 2. Stack e principais decisões

- Bun 1.4.4 e TypeScript estrito; NestJS 12 para HTTP e workers.
- PostgreSQL 17 com MikroORM 7; dinheiro em `decimal.js` e `NUMERIC(20,2)`.
- AWS SQS por meio de LocalStack 4.14 no ambiente local.
- Lock por carteira, idempotência persistida, inbox/outbox transacionais e triggers de integridade no banco.
- Chaves de API com papéis e escopo por provedor.

Motivos, alternativas e custos aceitos: [decisões](DECISIONS.md) e [ADRs](docs/adr/README.md). Visão técnica completa: [ARCHITECTURE.md](ARCHITECTURE.md).

## 3. Quick start funcional

Com Bun, Docker Compose e as dependências instaladas, configure `.env` a partir de `.env.example`. Em um terminal:

```bash
bun run infra:up
bun run db:migrate
bun run dev
```

Em outro terminal, com a API ativa:

```bash
bun run demo:finance
```

A demonstração chama a API e verifica saldos, replays, ledger e reconciliação. A API local usa PostgreSQL e LocalStack iniciados por `infra:up`.

## 4. Arquitetura resumida

```text
Provedor ──HTTP──> API ──> domínio/liquidação ──> PostgreSQL (wallet + ledger + outbox)
                         ^                              │
Provedor ──SQS──> inbox/worker ─────────────────────────┘
                                                        │
                         SQS <── publicador outbox <────┘
```

A mesma regra de liquidação atende HTTP e fila; o banco controla as invariantes e a outbox publica após o commit. Detalhes e fluxos: [ARCHITECTURE.md](ARCHITECTURE.md).

## 5. Garantias financeiras e distribuídas

| Garantia                                                           | Evidência principal                                                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Saldo igual à soma do ledger; ledger imutável e saldo não negativo | [teste de trigger](test/integration/schema/ledger-balance-trigger.test.ts), [testes de schema](test/integration/schema/) |
| Dinheiro decimal, nunca `number`                                   | [Money](src/shared/domain/money.ts), [teste](test/unit/shared/domain/money.test.ts)                                      |
| Concorrência serializada por carteira, sem lock global             | [hot-wallet](test/concurrency/hot-wallet.test.ts), [três processos](test/concurrency/three-processes.test.ts)            |
| Duplicatas persistidas e replay seguro                             | [entregas duplicadas](test/integration/messaging/duplicate-deliveries.test.ts)                                           |
| Evento publicado após commit; falhas recuperáveis                  | [outbox](test/integration/messaging/outbox-publisher.test.ts), [auditoria](docs/audit/README.md)                         |

A [matriz de requisitos](docs/REQUIREMENTS_MATRIX.md) e a [revisão de invariantes](docs/INVARIANT_REVIEW.md) relacionam evidências e limites.

## 6. Testes e demonstração

Com PostgreSQL e LocalStack disponíveis, os comandos abaixo executam as suítes correspondentes. `check:all` é o gate completo; `demo:finance` é a demonstração funcional.

| Objetivo                  | Comando                              |
| ------------------------- | ------------------------------------ |
| Gate completo             | `bun run check:all`                  |
| Unitários e arquitetura   | `bun run check:fast`                 |
| Integração                | `bun run test:integration`           |
| Concorrência              | `bun run test:concurrency`           |
| HTTP/e2e                  | `bun run test:e2e`                   |
| Cenários Gherkin          | `bun run test:features`              |
| Verificação SQL read-only | `bun run check:financial-invariants` |
| Demonstração financeira   | `bun run demo:finance`               |

Estratégia e limites das suítes: [docs/TEST_STRATEGY.md](docs/TEST_STRATEGY.md). Roteiro passo a passo: [docs/REVIEWER_GUIDE.md](docs/REVIEWER_GUIDE.md).

## 7. Resultados de carga resumidos

No baseline de nuvem, o maior degrau aprovado foi 100 req/s com 1 CPU, 200 req/s com 2 CPUs e 400 req/s com 4 CPUs; cada degrau durou 20 segundos. São execuções únicas, em host específico, com LocalStack e sem teste de longa duração. O ensaio de 4 CPUs terminou em 400 req/s, portanto esse valor é o limite do ensaio, não a capacidade máxima.

As campanhas foram feitas antes da migração 12, que adicionou triggers de concordância saldo-ledger; o custo dos triggers foi medido isoladamente. O baseline local tem 13 cenários em outra máquina, e não é diretamente comparável. Métodos, restrições e resultados completos: [docs/LOAD_TEST_RESULTS.md](docs/LOAD_TEST_RESULTS.md) e [baseline local](docs/LOAD_TEST_BASELINE.md).

## 8. Limitações e trade-offs

- Carga HTTP não representa chamadas pela fila, AWS SQS, produção ou um ensaio de soak; veja os limites descritos no relatório de carga.
- Os baselines completos antecedem os triggers de concordância; há medição isolada desses triggers em [comparação de desempenho](docs/audit/PERFORMANCE_COMPARISON.md).
- A implantação local usa LocalStack; disponibilidade e latência não caracterizam AWS.
- Trade-offs de locks, outbox, autenticação e opções não adotadas estão registrados em [DECISIONS.md](DECISIONS.md) e [ADRs](docs/adr/README.md).

## 9. Documentação detalhada

- [Desafio](docs/CHALLENGE.md) · [Arquitetura](ARCHITECTURE.md) · [Decisões](DECISIONS.md)
- [Matriz de requisitos](docs/REQUIREMENTS_MATRIX.md) · [Estratégia de testes](docs/TEST_STRATEGY.md) · [Guia do avaliador](docs/REVIEWER_GUIDE.md)
- [ADRs](docs/adr/README.md) · [Auditorias](docs/audit/README.md) · [Invariantes](docs/INVARIANT_REVIEW.md)
- [Resultados de carga](docs/LOAD_TEST_RESULTS.md) · [Baseline local](docs/LOAD_TEST_BASELINE.md) · [Índice geral](docs/README.md)

## 10. Como comprovar cada garantia

Execute os comandos com a infraestrutura disponível. Comandos de suíte usam scripts declarados em `package.json`.

| Garantia                                       | Comando                    | Arquivo de evidência                                      |
| ---------------------------------------------- | -------------------------- | --------------------------------------------------------- |
| Valores monetários decimais                    | `bun run test:unit`        | `test/unit/shared/domain/money.test.ts`                   |
| Saldo igual ao ledger e ledger imutável        | `bun run test:integration` | `test/integration/schema/ledger-balance-trigger.test.ts`  |
| Sem overspend sob disputa de carteira          | `bun run test:concurrency` | `test/concurrency/hot-wallet.test.ts`                     |
| Uma aplicação para mensagens duplicadas        | `bun run test:integration` | `test/integration/messaging/duplicate-deliveries.test.ts` |
| Publicação por outbox após commit              | `bun run test:integration` | `test/integration/messaging/outbox-publisher.test.ts`     |
| Fluxo financeiro ponta a ponta e reconciliação | `bun run demo:finance`     | `test/demo/finance.ts`                                    |
