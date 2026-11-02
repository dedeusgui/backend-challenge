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
lista pública de Actions consultada terminava em execuções do SHA `2a2fb182`. Portanto, esses resultados antigos não
validam o HEAD posterior. O repositório não revela qual credencial originou o push nem as configurações de Actions,
então não é possível determinar por que os eventos não geraram execuções. Não há workflow neste repositório que faça
commit ou push de volta.

O CI geral e o CodeQL agora aceitam `workflow_dispatch`, além de `push` e `pull_request`. Isso permite uma execução
manual para um ref selecionado. Pushes feitos com `GITHUB_TOKEN` normalmente não iniciam novas execuções de workflows;
para publicar código via automação e obter os checks seguintes, use um token de GitHub App/PAT autorizado ou dispare o
workflow manualmente. Dependency Review continua exigindo uma pull request destinada a `main`. Nenhuma dessas rotas
foi executada nesta revisão por falta de credencial GitHub válida.

## Como revisar

Confira os arquivos de workflow acima e o status de suas execuções na aba Actions do GitHub. O YAML do CodeQL não
define uma exceção para forks; as permissões e limitações da plataforma GitHub continuam aplicáveis. Em uma pull
request para `main`, revise também o resultado de Dependency Review.

Não interprete a configuração local como prova de que as ações, as permissões, o upload de resultados ou as regras de
bloqueio funcionaram em um runner hospedado. Confirme isso em uma execução real de push ou PR antes de afirmar que
essas verificações passaram.
