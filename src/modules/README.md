# Limites dos módulos

As pastas abaixo são separações intencionais, não funcionalidades implementadas.

- **wallet** é responsável por Wallet, operações voltadas a Money, o ledger imutável de carteira e reconciliação. Endpoints HTTP ficam em `http`; adaptadores de persistência em `infrastructure`.
- **wagering** é responsável pelo ciclo de vida de WagerTransaction e pelo caso de uso central ProcessWagerTransaction. HTTP e SQS devem invocar este mesmo caso de uso da aplicação.
- **messaging** é responsável pela deduplicação de Inbox, registros transacionais de Outbox e adaptadores SQS. Não decide se uma BET ou REFUND é válida.
- **shared** é reservado para conceitos genuinamente transversais (por exemplo, o value object imutável Money, o limite de transação do banco de dados e a porta de identidade do provedor), nunca um depósito de uso geral.

Casos de uso coordenam; objetos de domínio aplicam invariantes; repositórios mapeiam dados e participam de uma transação pertencente ao chamador. Mantenha imports de NestJS, MikroORM e AWS fora de `domain`.
