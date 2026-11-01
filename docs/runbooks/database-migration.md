# Migração de banco de dados

## Contexto

Use ao alterar migrations, entidades persistidas, constraints, índices, triggers ou dados derivados do schema.

## Comandos

- `bun run db:migrate` aplica migrations pelo ponto de entrada do projeto.
- `bun run test:integration` inclui validação do schema e das migrations.
- `bun run check:fast` cobre verificações rápidas e arquitetura.
- `bun run check:all` é o gate completo e depende da infraestrutura.

## Invariantes e evidências

- Migrations são versionadas e reaplicação após rollback restaura o mesmo schema: `src/shared/infrastructure/database/migrations/`; [teste](../../test/integration/schema/migrations.test.ts).
- Saldo materializado corresponde à soma do ledger e não fica negativo: [trigger](../../test/integration/schema/ledger-balance-trigger.test.ts); [teste de concorrência](../../test/concurrency/hot-wallet.test.ts).
- Constraints de wallets e transações rejeitam estados inválidos: [wallet](../../test/integration/schema/wallet-schema-constraints.test.ts) e [wagering](../../test/integration/schema/wagering-schema-constraints.test.ts).
- As tabelas de mensageria preservam identidade e unicidade: [constraints](../../test/integration/schema/messaging-schema-constraints.test.ts).
- A configuração ORM define a localização das migrations: `src/shared/infrastructure/database/orm-config.ts`; a prova de rollback e reaplicação está em [migrations.test.ts](../../test/integration/schema/migrations.test.ts).

## Conclusão

Revise o SQL gerado e os efeitos de upgrade e rollback. Confirme migrations reaplicáveis, constraints relevantes testadas e todos os dados derivados consistentes; execute o gate completo antes de concluir.
