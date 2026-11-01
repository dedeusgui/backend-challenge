# Revisão e verificação

## Contexto

Use ao revisar uma mudança, preparar sua conclusão ou registrar evidências verificáveis. Para mudança especializada, abra também o runbook financeiro, concorrência, mensageria ou banco correspondente.

## Comandos

- `bun run check:fast` executa tipos, lint, formato, unidades e arquitetura.
- `bun run arch:check` verifica dependências entre módulos.
- `bun run deadcode:check` procura código não usado.
- `bun run check:all` é o gate final e requer infraestrutura.
- `bun run agent:verify` está pendente de integração pelo coordenador.

## Invariantes e evidências

- A arquitetura e as regras vinculantes estão em [CLAUDE.md](../../CLAUDE.md) e [ARCHITECTURE.md](../../ARCHITECTURE.md); não replique essas regras aqui.
- A convenção exige caminhos e comandos verificáveis: [CONVENCOES_DOCUMENTACAO.md](../CONVENCOES_DOCUMENTACAO.md).
- O gate rápido e o gate completo estão definidos em `package.json`; suas suítes têm cobertura em `test/unit/` e `test/integration/`.
- Uma suíte que não foi executada não prova o comportamento; a matriz de requisitos é [REQUIREMENTS_MATRIX.md](../REQUIREMENTS_MATRIX.md).

## Coordenação de trabalho

Use worktrees isoladas por tarefa e escopo explícito de arquivos; não deixe trabalhadores editarem o mesmo arquivo em paralelo. Mudanças financeiras precisam de revisão independente antes do merge. Comportamento validado prevalece sobre explicação persuasiva.

## Contrato de evidências

O relatório de conclusão contém exatamente estes campos: **What changed; Why; Failing test before the change (if applicable); Tests run (command and result); Risks; Commit; Limitations.**

Uma afirmação de sucesso exige o comando executado e sua saída observada. Registre resultados reais, inclusive falhas ou limitações; não trate análise estática ou intenção como teste executado.

## Conclusão

Revise o diff e o escopo, confirme os caminhos e pares de documentação e registre o relatório completo. Declare concluído somente com evidências reproduzíveis, riscos e limitações explícitos e SHA do commit.
