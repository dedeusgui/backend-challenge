# ADR 0002: Dinheiro como string decimal, aritmética com decimal.js, armazenamento em NUMERIC(20,2)

**Status:** aceito, emendado (a escala de entrada, veja abaixo)

## Contexto

O contrato é uma string decimal com dois dígitos fracionários e uma moeda ISO
(desafio §6.1). `number`, `float` e `double` são proibidos para dinheiro.

## Decisão

- `Money` é um value object imutável sobre `decimal.js`, com um contexto de precisão
  de 40 dígitos (`src/shared/domain/money.ts`). O contexto padrão (20 dígitos) arredonda uma
  soma de dois operandos `NUMERIC(20,2)`. Um teste fixa isso: `999999999999999999.99 +
0.02` deve ser `1000000000000000000.01`.
- A entrada necessita de exatamente 2 dígitos fracionários e nenhum zero à esquerda, e no máximo 18 dígitos inteiros, os
  mesmos limites da coluna. Qualquer outra coisa é recusada, nunca arredondada ou normalizada.
  Uma versão anterior normalizava `"25"` para `"25.00"`. Isso foi retirado, porque o contrato
  fixa a escala e um valor deve ter uma única representação.
- O armazenamento é `numeric(20,2)` no PostgreSQL, lido de volta como strings e analisado por meio
  de `Money.from`.

## Alternativas

- **Subunidades inteiras (`bigint`).** Exato e simples para moedas de duas casas decimais,
  e não necessita de dependência. Dois dos projetos de referência o utilizam. Escolhemos
  `decimal.js` conforme decidido em ARCHITECTURE §3. A escolha é barata de reverter: `Money`
  é o único lugar que conhece a representação.

## Consequências

- A aritmética é exata, e uma regressão em precisão falha um teste unitário.
- O CHECK aritmético do ledger (`balance_after = balance_before ± amount`) é
  aplicado pelo banco de dados com o mesmo tipo numérico, para que os dois lados não possam
  discordar sobre a escala.

## Evidências

- `test/unit/shared/domain/money.test.ts` (43 casos, incluindo os limites de precisão e
  overflow). Mutantes no contexto de precisão e no limite de 18 dígitos
  foram detectados.
- `test/integration/schema/schema-constraints.test.ts`: overflow de `NUMERIC(20,2)`
  é recusado com SQLSTATE 22003.
