# Automação de segurança

Este documento descreve a configuração versionada e os limites da evidência hospedada. A existência de um workflow
não prova que ele foi executado com sucesso.

| Verificação       | Configuração no repositório                                                                                                                                                         | Limite desta evidência                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| CodeQL            | `.github/workflows/codeql.yml`: push e pull request para `main`, agenda semanal e `workflow_dispatch`; analisa JavaScript/TypeScript. O workflow solicita `security-events: write`. | YAML conferido; execução CodeQL do SHA final ainda não confirmada.                       |
| Trivy             | `.github/workflows/ci.yml`: verifica vulnerabilidades `HIGH`/`CRITICAL` na imagem e no repositório; gera SBOM CycloneDX da imagem. Artefatos incluem o SHA e o run id.              | Configuração conferida; varreduras e upload hospedados não confirmados para o SHA final. |
| Dependency Review | `.github/workflows/dependency-review.yml`: PRs cujo destino é `main`; checkout sem credencial persistida; falha a partir de `low`.                                                  | Exige uma PR real; nenhuma execução para o SHA final foi observada.                      |
| Dependabot        | `.github/dependabot.yml`: verificações semanais para npm, Docker e GitHub Actions; limite de cinco PRs abertos por ecossistema.                                                     | Configuração conferida; não se afirma que alertas ou PRs foram criados.                  |

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
