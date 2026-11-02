# Automação de segurança

Este documento descreve a configuração versionada dos workflows. A existência de um workflow não prova que ele foi
executado com sucesso. Nesta revisão, resultados hospedados no GitHub e execuções de PR não foram executados nem
revisados.

| Verificação       | Configuração no repositório                                                                                                                                                                                                    | Limite desta evidência                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| CodeQL            | `.github/workflows/codeql.yml`: push e pull request para `main`, além de agenda semanal; analisa JavaScript/TypeScript. Em PRs de forks, a análise não envia resultados para o code scanning.                                  | Configuração lida; nenhum resultado hospedado foi consultado.                       |
| Trivy             | `.github/workflows/ci.yml`: após construir a imagem da API, falha para vulnerabilidades `HIGH` ou `CRITICAL`.                                                                                                                  | Configuração lida; a varredura em runner hospedado não foi executada nesta revisão. |
| Dependency Review | `.github/workflows/dependency-review.yml`: pull requests para `main` quando abertos, sincronizados ou reabertos; falha a partir de severidade `low` nos escopos runtime, development e unknown; não publica comentário-resumo. | Configuração lida; nenhuma execução de PR foi observada.                            |
| Dependabot        | `.github/dependabot.yml`: verificações semanais para npm, Docker e GitHub Actions; limite de cinco PRs abertos por ecossistema.                                                                                                | Configuração lida; não se afirma que alertas ou PRs foram criados.                  |

## Como revisar

Confira os arquivos de workflow acima e o status de suas execuções na aba Actions do GitHub. Em um pull request,
revise também o resultado de Dependency Review e o code scanning quando o PR vier do próprio repositório. Um PR de
fork não envia os resultados do CodeQL ao code scanning por decisão explícita no workflow.

Não interprete a configuração local como prova de que as ações, as permissões, o upload de resultados ou as regras de
bloqueio funcionaram em um runner hospedado. Confirme isso em uma execução real de push ou PR antes de afirmar que
essas verificações passaram.
