# Guia do avaliador

Este guia mostra como verificar a solução em cerca de 40 minutos, sem orientação do autor. Cada afirmação aponta
para o comando ou o arquivo que a prova. Quando um item não é provado, o guia diz isso.

## 1. Rodar a stack e a demonstração (10 min)

```bash
docker compose up --build
curl http://localhost:3000/health/ready
bun run demo:finance
```

A demonstração exige a stack em execução: ela chama a API, e é a stack que aplica as migrações ao banco. Sem a
stack, a demonstração falha ao criar a primeira chave, com a mensagem que pede para verificar o banco e as migrações.

A demonstração abre uma carteira com 100.00, faz uma aposta, um ganho, outra aposta com seu reembolso e um
rollback do ganho. Ela confere cada saldo, recusa um segundo rollback, repete uma aposta como replay, e compara a soma
do ledger com o saldo e com a reconciliação. Cada passo imprime o que foi observado. Ela não simula nada: chama a API.

Se `docker compose up --build` falhar num ambiente com proxy TLS que bloqueia o download de pacotes durante o build,
o problema é do ambiente, não da aplicação. A imagem também é construída pelo CI (execução `41251559996`), e
[ARCHITECTURE.md §14](../ARCHITECTURE.md) descreve o contorno usado na sandbox.

## 2. Ler a arquitetura, pela tabela de decisões (5 min)

[ARCHITECTURE.md](../ARCHITECTURE.md), a tabela no início. Cada decisão tem o motivo, o custo aceito, o teste que a
prova e a ADR com as alternativas. As seções 5 a 9 desenvolvem a concorrência, a idempotência, a mensageria, o outbox
e as referências fora de ordem.

## 3. Confirmar que as suítes passam (5 min)

```bash
bun run infra:up
bun run check:all
```

`check:all` roda tipos, lint, formato, os testes unitários, o teste de infraestrutura, a integração, a concorrência e
o e2e, contra PostgreSQL 17 e LocalStack reais. Os números de cada suíte mudam conforme você adiciona testes; o gate
exige que todos passem. Neste ambiente, as suítes levaram cerca de 100 s: unitários 6 s, integração 61 s, concorrência
26 s e e2e 3 s, sem contar a subida da infraestrutura.

## 4. Os três testes que mais importam (5 min)

| Requisito                                        | Comando                                                                                      | O que observar                                         |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 50 apostas idênticas em paralelo, três processos | `bun test test/concurrency/three-processes.test.ts -t "fifty identical requests"`            | um débito; as outras são replays                       |
| Disputa pelo mesmo saldo (cenário da §8)         | `bun test test/concurrency/hot-wallet.test.ts`                                               | exatamente uma aposta de 80.00 é aplicada sobre 100.00 |
| Worker morto depois do commit e antes do ACK     | `bun test test/concurrency/three-processes.test.ts -t "crashes after commit and before ACK"` | a reentrega aplica uma vez; saldo e ledger batem       |

Para ver que os testes de concorrência não estão vazios, veja as mutações registradas em
[TEST_STRATEGY.md](TEST_STRATEGY.md), na seção "Evidência de mutação": removendo a trava ou a guarda de versão, o teste falha.

Para qualquer outra garantia, o índice [audit/README.md](audit/README.md) aponta o teste que a prova.

## 5. Autenticação e autorização (5 min)

- `test/e2e/auth-http.test.ts`: o que cada papel pode fazer.
- `test/e2e/authorization-adversarial.test.ts`: 28 tentativas de contornar a regra, por caminho, por cabeçalho,
  por identificador e por chave revogada.
- A decisão que você deve questionar: uma chave de provedor que pede a transação de **outro** provedor, pelo id
  interno, recebe `404`, a mesma resposta de um id inexistente. Antes isso era `403`, o que revelava que o id
  existia. A mudança altera um status documentado e aguarda confirmação do dono do desafio; ver
  [ARCHITECTURE.md §12](../ARCHITECTURE.md) e `docs/audit/FINDINGS.md`.

## 6. Contrato HTTP (5 min)

[openapi.json](openapi.json) descreve as dez operações. Duas verificações o mantêm honesto:
`test/unit/openapi/openapi-contract.test.ts` (estrutura e paridade com as rotas registradas) e
`test/e2e/openapi-responses.test.ts` (cada resposta real precisa ter status documentado e corpo válido). A segunda
achou uma divergência, e o contrato foi corrigido: `seq` do ledger é texto.

## 7. Modo protegido e exposição de portas (5 min)

```bash
docker compose -f docker-compose.yml -f docker-compose.protected.yml up --build
bun run test:edge
docker compose -f docker-compose.yml -f docker-compose.protected.yml down
```

No modo padrão, PostgreSQL, LocalStack e a API publicam porta apenas em `127.0.0.1`. No modo protegido, só a borda
publica, também em `127.0.0.1`. `test/infra` e o `test:edge` verificam isso no Compose efetivo e no contêiner em
execução.

## 8. Mensageria: o que é garantido e o que não é

Leia [ARCHITECTURE.md §8](../ARCHITECTURE.md), a seção "What an external consumer can rely on". Em resumo: todo evento
chega (tentativas sem teto, só o atraso é limitado); `eventId` identifica o fato; `walletVersion` ordena as alterações
de saldo de uma carteira. A ordem de chegada **não** é garantida: um evento recusado é retentado depois, e um evento
posterior da mesma carteira pode chegar antes. O teste `partial-batch-order.test.ts` mostra essa sequência no SQS real.

Desde esta rodada, o lease e o reagendamento do outbox são decididos pelo relógio do banco
(`outbox-lease-clock.test.ts`, `outbox-retry-clock.test.ts`), e o worker de retenções também
(`database-clock-references.test.ts`). Uma mensagem em voo é renovada enquanto o seu comando roda, até 300 s
(`slow-message-hold.test.ts`). Uma retenção com falha permanente vira `FAILED` e é anunciada como
`WagerTransactionFailed`, evento que a especificação não lista (ver F-13 em [FINDINGS.md](audit/FINDINGS.md)).

## 9. O que não foi feito, e por quê

- **Custo da renovação de visibilidade e vazão do consumidor de fila.** Não medidos: o teste de carga envia só HTTP.
  Ver [PERFORMANCE_COMPARISON.md](audit/PERFORMANCE_COMPARISON.md), experimentos 2 e 4.
- **Console de engenharia e laboratório de carga.** Não construídos nesta rodada. A telemetria que um console
  mostraria só ficou verdadeira com a superfície do worker; um painel sobre os números atuais seria prematuro.
  Ver [AUDITORIA_FINAL.md](AUDITORIA_FINAL.md).
- **Prometheus e Grafana.** Não instalados. `/metrics` por processo e a superfície do worker cobrem a avaliação; um
  agregador exigiria coleta por instância, e isso ainda não está provado em execução.
- **Testes de propriedade (`fast-check`).** Não adicionados: a biblioteca não traria prova que os testes existentes não
  dão.
- **Comparação com as referências públicas.** Não reexecutada nesta sessão. Os números em `docs/LOAD_TEST_RESULTS.md`
  são de execuções anteriores, em uma VM de quatro vCPUs, e não devem ser comparados com outra máquina sem aviso.
- **Medição local.** A linha de base em `docs/LOAD_TEST_BASELINE.md` mede 13 cenários na minha máquina, com as taxas
  acordadas e a correção em cada passo. Não deve ser lida como melhoria em relação à nuvem: são máquinas diferentes.

## 10. Limites conhecidos

A lista completa está em [ARCHITECTURE.md §14](../ARCHITECTURE.md). Os que mais pesam numa decisão de produção:
chaves de API sem rotação nem login; HTTP simples atrás de TLS a ser colocado; ausência de limite de taxa no modo
padrão; um `WIN` sem referência que não bloqueia o `REFUND` da sua aposta; um `WIN` reenviado sob outro id externo, sem
nomear a BET, é contado como segundo crédito. Uma segunda liquidação da mesma BET é recusada com
`REFERENCE_ALREADY_SETTLED`.

- Uma mensagem em voo que roda além de 300 s é liberada, e dois consumidores podem processar o mesmo comando ao mesmo
  tempo. A identidade da transação mantém o efeito em um (`slow-message-hold.test.ts`).
