# Automação de segurança

Este documento descreve a configuração versionada e os limites da evidência hospedada. A existência de um workflow
não prova que ele foi executado com sucesso.

| Workflow                | Push              | Pull request      | `workflow_dispatch` / agenda     | Dependências de configuração                                                                                                                      |
| ----------------------- | ----------------- | ----------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`                | Todas as branches | Todas as branches | Dispatch manual; sem agenda      | Nenhuma configuração externa declarada no YAML. Regras de proteção/rulesets que tornem o job obrigatório dependem da configuração do repositório. |
| `codeql.yml`            | `main`            | Destino `main`    | Dispatch manual e agenda semanal | Publicação de alertas depende das permissões efetivas do workflow e das configurações da plataforma.                                              |
| `dependency-review.yml` | —                 | Destino `main`    | —                                | Só roda em uma PR real; regrasets podem exigir o resultado como status obrigatório.                                                               |
| `pages.yml`             | `main`            | —                 | Dispatch manual                  | Pages precisa estar habilitado com Source = GitHub Actions; deploy também depende das permissões Pages efetivas.                                  |

Trivy e geração/upload de SBOM são etapas de `ci.yml`; rodam quando o workflow CI é disparado e concluídas as etapas anteriores. Dependabot é configuração semanal em `.github/dependabot.yml`, não um workflow Actions deste repositório. YAML confirma somente gatilhos e etapas declaradas; não prova execução hospedada nem resultado. As regrasets e a configuração de Pages não são versionadas aqui e precisam ser conferidas nas configurações do repositório.

## Estado observado em 2026-11-02

A página pública de checks de `37ff489977e817ecac98b9c86efc5ba9a5fe5932` informou “There are no checks for this commit”; a
lista consultada terminava em execuções do SHA `2a2fb182`. Depois, o push de `47617e76f5c44507a92e7a6fe80b1a2403bd40ca`
para `main` foi aceito, mas a página pública desse commit também informou “There are no checks for this commit”. O commit
posterior `2284a9d3664c71126e2529368552a94fa635cace`, que atualizou esta evidência, também foi enviado e permaneceu sem
checks públicos. O workflow CI versionado declara `push` sem filtro de branch e `workflow_dispatch`; não há workflow neste repositório que
faça commit ou push de volta. A causa exata da ausência de execução não foi comprovada.

O CI geral e o CodeQL aceitam `workflow_dispatch`, além dos gatilhos automáticos. Nesta revisão, `GH_TOKEN` foi
rejeitado como inválido, `gh` não tinha sessão autenticada sem essa variável e a tentativa de dispatch recebeu
`Forbidden` de `api.github.com`. As páginas públicas de `github.com` e o push Git remoto estavam acessíveis. O ator ou
tipo de credencial usado no push e as configurações de Actions da organização não puderam ser inspecionados; a supressão
de execuções em pushes feitos com `GITHUB_TOKEN` é uma possibilidade, não uma causa confirmada. Dependency Review
continua exigindo uma pull request destinada a `main`. CodeQL, Trivy, Dependency Review e dispatch manual não tiveram
resultados hospedados observados para o SHA publicado `2284a9d`.

## Como revisar

Confira os arquivos de workflow acima e o status de suas execuções na aba Actions do GitHub. O YAML do CodeQL não
define uma exceção para forks; as permissões e limitações da plataforma GitHub continuam aplicáveis. Em uma pull
request para `main`, revise também o resultado de Dependency Review.

Não interprete a configuração local como prova de que as ações, as permissões, o upload de resultados ou as regras de
bloqueio funcionaram em um runner hospedado. Confirme isso em uma execução real de push ou PR antes de afirmar que
essas verificações passaram.

### Verificação de release iniciada em `44a793bcb09d72620660339186a046311b4e549a`

A [página pública de checks desse commit](https://github.com/dedeusgui/backend-challenge/commit/44a793bcb09d72620660339186a046311b4e549a/checks)
informou que não havia checks. O workflow versionado declara `push` e `workflow_dispatch`; isso confirma a configuração,
mas não explica a ausência de execução. `gh run list` recebeu `Forbidden` de `api.github.com` neste ambiente e não foi
possível usar uma sessão autenticada para disparar o CI ou o CodeQL. Também não foi possível inspecionar as configurações
de Actions do repositório/organização ou a identidade usada no push. A hipótese de supressão por `GITHUB_TOKEN` permanece
sem comprovação.

Para gerar a evidência hospedada que falta, um mantenedor deve executar CI e CodeQL em **Actions → Run workflow**, no
SHA de release; Dependency Review exige uma pull request destinada a `main`. Até essas execuções existirem, não há
aprovação hospedada de CI, Testcontainers, runtime smoke, modo protegido, Trivy ou CodeQL para esse SHA.

### Resultado após o push

`main` foi atualizado para `440fc2240cac979c28f68c268ecc295255cbf04b`. A [página pública de checks](https://github.com/dedeusgui/backend-challenge/commit/440fc2240cac979c28f68c268ecc295255cbf04b/checks)
informa “There are no checks for this commit”; a [lista de Actions](https://github.com/dedeusgui/backend-challenge/actions)
não apresenta execução para ele. O push funcionou, mas sua identidade não pôde ser inspecionada. O token `GH_TOKEN` é
inválido, e a API do GitHub não está disponível pela allowlist de rede deste ambiente. Não há evidência para atribuir
isso à supressão de workflows pelo `GITHUB_TOKEN` ou a configurações de Actions desabilitadas.
