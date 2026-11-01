# Registros de decisão de arquitetura

Cada registro apresenta o contexto, a decisão, as alternativas e as consequências.
O [ARCHITECTURE.md](../../ARCHITECTURE.md) apresenta as decisões principais em uma tabela e inclui links para cá
para o detalhamento dos motivos.

| Registro                                           | Decisão                                                                                 | Status               |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------- |
| [0001](0001-pessimistic-wallet-lock.md)            | Bloqueio pessimista de linha na carteira, com a versão como guarda                      | aceito               |
| [0002](0002-money-representation.md)               | Dinheiro como string decimal, aritmética com decimal.js, armazenamento em NUMERIC(20,2) | aceito               |
| [0003](0003-idempotency-scope-and-payload-hash.md) | Escopo de idempotência por provedor e hash canônico de payload                          | aceito               |
| [0004](0004-outbox-claim-lease-at-least-once.md)   | Outbox com reivindicação e lease, entrega at-least-once                                 | aceito               |
| [0005](0005-reference-hold-and-bounded-retries.md) | Retenção de transações para referências ausentes, com retentativas limitadas            | aceito               |
| [0006](0006-authentication-deferred.md)            | Autenticação adiada, com ponto de extensão explícito                                    | substituído por 0007 |
| [0007](0007-api-key-authentication.md)             | Chaves de API com dois papéis e escopo de provedor                                      | aceito               |
