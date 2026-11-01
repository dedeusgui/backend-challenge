# ADR 0007: Chaves de API com dois papéis e escopo de provedor

**Status:** aceito. Substitui o [ADR 0006](0006-authentication-deferred.md).

## Contexto

O ADR 0006 adiou a autenticação, e o desafio permite isso. O proprietário agora pede um
esquema funcional e simples que permita ao projeto fazer o que deve: provedores submetem operações para
seu próprio id de provedor, operadores gerenciam o back office, e ninguém mais alcança a API. O
desafio sugere a integração de um provedor de identidade externo (Keycloak ou Zitadel) e adverte
contra a autenticação caseira com tabela de usuários e hashes de senha.

## Decisão

Cada cliente de API tem uma **chave bearer** de longa duração, enviada como `Authorization: Bearer <key>`. Um
cliente tem um de dois papéis:

| Papel      | Vinculado a     | Pode                                                                          |
| ---------- | --------------- | ----------------------------------------------------------------------------- |
| `PROVIDER` | um `providerId` | submeter e ler as operações do seu próprio id de provedor                     |
| `OPERATOR` | nenhum provedor | abrir, ler e reconciliar carteiras, ler métricas e agir por qualquer provedor |

- Sondas de health são públicas. Todas as outras rotas necessitam de uma chave válida.
- Uma requisição de PROVIDER para outro id de provedor é recusada com `403 FORBIDDEN`, antes que qualquer
  coisa seja escrita. Uma leitura de transação por id que pertence a outro provedor resulta em `404 TRANSACTION_NOT_FOUND`,
  a resposta de um id ausente, de modo que o id não possa ser sondado (consulte ARCHITECTURE §12).
- A chave tem 256 bits aleatórios com o prefixo `wgr_`. Apenas seu hash SHA-256 é armazenado em
  `api_clients`. O hash é suficiente: a chave não pode ser pesquisada a partir dele, e um hash de senha
  apenas tornaria mais lenta uma consulta feita em cada requisição.
- Uma chave é criada e revogada com `bun run auth:create` e `bun run auth:revoke`. A chave é
  exibida uma única vez. Um cliente revogado mantém sua linha, para que uma auditoria ainda possa vê-lo.
- A guarda (`ApiKeyGuard`) autentica cada requisição uma vez, antes da execução do controller.
  O controller verifica o escopo de provedor, pois somente ele conhece o provedor do registro.

O stub não utilizado `ProviderIdentityPort` é removido. Esta guarda o substitui.

## Alternativas

- **Keycloak ou Zitadel, com OIDC.** A expectativa do desafio, e a escolha certa para uma
  implantação real. Adiciona um container com seu próprio realm, clientes e tempos de vida de tokens, e esta
  versão ainda precisaria de um segundo serviço para testar. A tabela de chaves e a guarda são o local
  onde um verificador OIDC substituiria a consulta por hash, portanto a alteração permanece local.
- **JWTs assinados emitidos localmente.** Ainda necessita de um emissor, e não oferece revogação sem uma
  lista. Recusada.
- **Um segredo compartilhado para todos.** Não oferece escopo de provedor. Recusada.

## Consequências

- Chaves não expiram, e a rotação é manual: cria-se um novo cliente e, em seguida, revoga-se o antigo.
- As chaves são enviadas em cada requisição, portanto a API deve rodar atrás de TLS em qualquer implantação real. Esta
  versão serve HTTP simples dentro de uma rede confiável, como antes.
- Mensagens de fila continuam sendo um canal interno confiável. O autenticador não as vê.
  Seus campos de provedor e carteira ainda são verificados no domínio.
- Uma chave vazada permite que seu detentor aja pelo seu provedor até que seja revogada. Uma chave revogada é
  recusada na requisição seguinte, sem cache para limpar.

## Evidências

- `test/unit/auth/api-client.test.ts`: as regras de papéis, formato da chave, hash, análise do bearer e
  a validação de `CreateApiClient`.
- `test/integration/auth/api-clients.test.ts`: apenas o hash é armazenado, uma chave revogada é recusada,
  e a tabela recusa um PROVIDER sem um provedor e um OPERATOR com um. Também executa o
  comando `auth` e verifica a chave que ele imprime.
- `test/e2e/auth-http.test.ts`: 401 sem chaves, com chaves desconhecidas ou revogadas; 403 para um
  provedor em rotas de operador, em submissões e leituras de outro provedor; 200 para os casos
  permitidos; health público.
