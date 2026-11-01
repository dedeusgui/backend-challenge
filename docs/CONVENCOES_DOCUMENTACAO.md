# Convenções da documentação

Estas regras valem para todos os próximos passos. A documentação é parte da avaliação (seção 14 do
[enunciado](CHALLENGE.md)), então qualquer mudança nela segue o mesmo fluxo.

## Idioma e pares em inglês

- A **versão principal é em português (pt-BR)**. É a que o avaliador lê primeiro.
- Cada documento principal tem uma **cópia de referência em inglês**, com o sufixo `.en.md`, como o par
  [README.md](../README.md) e [README.en.md](../README.en.md). Exemplos: `ARCHITECTURE.md` e `ARCHITECTURE.en.md`,
  `DECISIONS.md` e `DECISIONS.en.md`, `docs/adr/0001-pessimistic-wallet-lock.md` e o seu `.en.md`.
- A cópia em inglês aponta para a versão em português no topo, e seus links internos apontam para as cópias em inglês.
- **Ao mudar um documento que tem par, atualize os dois no mesmo commit.** A versão em português é a fonte da verdade.

## Nomes de arquivo não mudam

Código, testes, scripts e o `CLAUDE.md` apontam para caminhos fixos. Não renomeie nem mova estes arquivos sem
atualizar todas as referências: `ARCHITECTURE.md`, `DECISIONS.md`, `docs/REQUIREMENTS_MATRIX.md`,
`docs/LOAD_TEST_RESULTS.md`, `docs/CHALLENGE.md`, `docs/adr/*.md`, `docs/audit/*.md` e `CLAUDE.md`.

## O que não se traduz

- Código, comandos, caminhos, nomes de classe, de campo JSON e de variável de ambiente.
- IDs de requisito, de decisão e de teste (por exemplo `TX-02`, `ELIM-08`, `E-01`, `R-13`).
- Tokens de status da matriz: `PASSING`, `PASS`, `BLOCKED`. Ferramentas leem esses valores.
- Números no formato da fonte. Use ponto decimal (`100.00`) e vírgula de milhar (`1,153`), como estão no código e
  nas medições. Não converta para o formato brasileiro, porque misturar os dois confunde o leitor.

## Documentos gerados: não editar à mão

- [LOAD_TEST_RESULTS.md](LOAD_TEST_RESULTS.md) é gerado por `test/load/report.ts`. Qualquer edição é sobrescrita na
  próxima medição. Ele ainda está em inglês, porque traduzi-lo exige mudar o gerador; isso é uma fase de código.
- `docs/load/`, `docs/edge/results/` e `docs/audit/perf/` são medições brutas em JSON.
- `docs/site/` é a fonte do site estático. Gere com `bun run site:build`.

## Índices que precisam acompanhar as mudanças

- [docs/README.md](README.md): índice central, perguntas do avaliador e leitura principal. Atualize-o quando um
  documento for criado, removido ou mudar de papel.
- [DECISIONS.md](../DECISIONS.md): índice consolidado das decisões, por grupo. Uma decisão nova entra no grupo
  certo, e a contagem do índice é atualizada. Se ela tiver ADR, o ADR também é criado ou atualizado.
- [docs/adr/README.md](adr/README.md): índice dos ADRs. Um ADR superado mantém o arquivo, com a nota de superação no topo.

## Toda afirmação de prova aponta para algo que existe

- Um link relativo precisa apontar para um arquivo existente.
- Um caminho de teste citado precisa existir.
- Um comando citado precisa existir em `package.json`.
- Um requisito só pode ser `PASSING` depois que a suíte que o prova foi executada e passou.
- Uma afirmação que a evidência contradiz é corrigida. Quando o histórico importa, o texto antigo fica com nota
  de superação, e não é apagado.

## Fluxo de uma mudança de documentação

1. **Escopo:** diga o que muda e o que não muda. Mudança só de documentação não altera código.
2. **Tradução ou redação:** pode ser feita por um worker do Orca, com um contrato claro (arquivo permitido, o que não
   pode mudar e critério de aceite). Modelos de baixo custo servem para isso: Codex `gpt-6-luna` em esforço baixo, ou
   Antigravity `gemini-3.8-flash-low`. Escolha o ID do Antigravity com `agy models`.
3. **Revisão:** compare o arquivo com a versão original (`git show HEAD:<arquivo>`). Blocos de código, links, tabelas,
   números, IDs e tokens de status devem ser os mesmos. Leia uma amostra do texto, porque a checagem automática não
   pega uma frase mal traduzida.
4. **Formatação:** `bunx prettier --write <arquivos>`. Tabelas são realinhadas, então formate antes de conferir.
5. **Verificação:** `bun run check:fast`, que inclui o `format:check` e os testes que leem a matriz e o site. Antes de
   fechar a fatia, `bun run check:all`, que exige `bun run infra:up`. Depois, derrube a infraestrutura com
   `docker compose down`.
6. **Commit:** um commit em Conventional Commits, por exemplo `docs: ...`, com o corpo descrevendo o que mudou.

## Escopo atual

Nesta fase, a mudança é só documental. Ajustes no código serão tratados em uma fase separada, com contrato próprio.
