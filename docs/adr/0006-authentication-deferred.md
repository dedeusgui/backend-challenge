# ADR 0006: Autenticação adiada, com um ponto de extensão explícito

**Status:** substituído por [ADR 0007](0007-api-key-authentication.md)

> **Nota:** esta decisão foi substituída pelo ADR 0007. O ponto de extensão citado abaixo, `ProviderIdentityPort`, não existe no código atual; a autenticação implementada é a do ADR 0007. O texto abaixo é mantido como registro histórico.

## Contexto

O desafio não atribui pontos à autenticação e permite que ela seja documentada
como omitida (desafio §2).

## Decisão

Nenhuma autenticação é implementada. Os endpoints são abertos, e as sondas de readiness e
liveness são públicas. O ponto de extensão é
`src/shared/application/ports/provider-identity.port.ts` (`ProviderIdentityPort`).
Uma implantação real adicionaria uma guarda OIDC contra um provedor de identidade externo
(Keycloak ou Zitadel) que resolve o id do provedor do chamador. Toda operação
verificaria então se o provedor resolvido corresponde a `providerId`. Nenhuma tabela de usuários local ou
senha é armazenada.

Mensagens da fila são tratadas como um canal interno confiável. Seus campos
de negócio ainda são validados: a compatibilidade de provedor e carteira é verificada no
domínio, qualquer que seja o transporte.

## Consequências

- A API HTTP não deve ser exposta fora de uma rede confiável.
- Um provedor poderia submeter operações para o id de outro provedor nesta versão. Esse
  é o risco mais importante, e está listado em ARCHITECTURE §14.
