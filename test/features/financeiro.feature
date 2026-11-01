# HTTP, autenticação e ciclo de vida (seções 7 e 8 da matriz) ficam fora deste harness.
Feature: Financeiro
  @financeiro @edge:MN-01
  Scenario: Construir Money com valor inválido é rejeitado
    Given os valores monetários inválidos "NaN", "Infinity", "1e3", "1.001" e "-1.00"
    When tento construir Money com cada valor
    Then cada construção falha com erro de domínio

  @financeiro @edge:MN-02
  Scenario: Enviar valor malformado pela API retorna erro estável de dinheiro
    Given uma wallet com saldo "10.00"
    When envio pela API uma aposta com valor malformado "1.001"
    Then a resposta da API é 400 com o código de erro de dinheiro

  @financeiro @edge:MN-04
  Scenario: Creditar valor que excede o limite do saldo é recusado
    Given uma wallet com saldo próximo ao limite NUMERIC(20,2)
    When processo um crédito que excede o limite do saldo
    Then a transação fica "REJECTED" com "BALANCE_LIMIT_EXCEEDED" e o saldo não sofre overflow

  @financeiro @edge:MN-05
  Scenario: Lançar movimento em moeda diferente da wallet é recusado
    Given uma wallet com saldo "10.00"
    When tento inserir um lançamento de "1.00" em moeda "EUR" para a wallet BRL
    Then o banco recusa o lançamento e o saldo permanece "10.00"

  @financeiro @edge:TX-01
  Scenario: Uma aposta acima do saldo é rejeitada sem débito
    Given uma wallet com saldo "10.00"
    When processo uma aposta de "25.00"
    Then a transação fica "REJECTED" e o saldo permanece "10.00"

  @financeiro @edge:MN-03
  Scenario: Uma operação em outra moeda é rejeitada
    Given uma wallet com saldo "10.00"
    When processo uma aposta de moeda "USD"
    Then a transação fica "REJECTED" e o saldo permanece "10.00"

  @financeiro @edge:TX-08
  Scenario: Um rollback de aposta após perda estorna o débito
    Given uma wallet com saldo "100.00"
    When processo uma aposta de "25.00", uma perda e o rollback da aposta
    Then o saldo é "100.00"

  @financeiro @edge:TX-03
  Scenario: Cinquenta apostas idênticas em paralelo geram um débito
    Given uma wallet com saldo "100.00"
    When envio cinquenta vezes a mesma aposta de "25.00" em paralelo
    Then ocorre apenas um débito e o saldo é "75.00"

  @financeiro @edge:TX-04
  Scenario: Dois rollbacks concorrentes do mesmo BET geram um estorno
    Given uma aposta de "25.00" já processada em uma wallet com saldo "100.00"
    When envio dois rollbacks dessa aposta em paralelo
    Then ocorre apenas um estorno e o saldo é "100.00"

  @financeiro @edge:TX-05
  Scenario: WIN, REFUND e LOSS concorrentes aplicam um resultado ao mesmo BET
    Given uma aposta de "25.00" já processada em uma wallet com saldo "100.00"
    When envio WIN, REFUND e LOSS para essa aposta em paralelo
    Then apenas um resultado é processado e o saldo reflete um único resultado

  @financeiro @edge:TX-06
  Scenario: REFUND após WIN é rejeitado
    Given uma aposta de "25.00" com WIN já processado em uma wallet com saldo "100.00"
    When processo um REFUND para essa aposta
    Then a transação fica "REJECTED" com "REFERENCE_ALREADY_SETTLED" e o saldo permanece "100.00"

  @financeiro @edge:TX-07
  Scenario: ROLLBACK do BET após WIN estorna a aposta e mantém o WIN
    Given uma aposta de "25.00" com WIN já processado em uma wallet com saldo "100.00"
    When processo um ROLLBACK da aposta
    Then a aposta é estornada, o WIN permanece e o saldo é "125.00"

  @financeiro @edge:TX-09
  Scenario: ROLLBACK de um WIN inverte a direção do lançamento
    Given um WIN de "25.00" já processado em uma wallet com saldo "100.00"
    When processo um ROLLBACK do WIN
    Then o lançamento do WIN é debitado e o saldo é "100.00"

  @financeiro @edge:TX-10
  Scenario: ROLLBACK de um WIN já gasto é rejeitado por risco de saldo negativo
    Given um WIN de "25.00" já processado e gasto em uma wallet com saldo "0.00"
    When processo um ROLLBACK do WIN
    Then a transação fica "REJECTED" com "REVERSAL_WOULD_OVERDRAW" e o saldo permanece "0.00"

  @financeiro @edge:TX-11
  Scenario: ROLLBACK de um REFUND devolve o estorno e impede reverter o BET novamente
    Given um REFUND de "25.00" já processado para uma aposta em uma wallet com saldo "100.00"
    When processo um ROLLBACK do REFUND e depois um ROLLBACK da aposta
    Then o saldo é "75.00" e o BET não pode ser revertido novamente

  @financeiro @edge:TX-12
  Scenario: Estorno que deixaria o saldo negativo é rejeitado
    Given um WIN de "25.00" já processado e gasto em uma wallet com saldo "0.00"
    When processo um estorno de "25.00" desse WIN
    Then a transação fica "REJECTED" com "REVERSAL_WOULD_OVERDRAW" e o saldo permanece "0.00"

  @financeiro @edge:TX-13
  Scenario: REFUND de uma aposta rejeitada é recusado
    Given uma aposta de "25.00" rejeitada em uma wallet com saldo "0.00"
    When processo um REFUND de "25.00" para essa aposta
    Then a transação fica "REJECTED" com "REFERENCE_NOT_PROCESSED" e o saldo permanece "0.00"

  @financeiro @edge:TX-14
  Scenario: REFUND com referência de outro contexto é recusado
    Given uma aposta de "25.00" já processada em outra wallet ou rodada
    When processo um REFUND de "25.00" para essa aposta
    Then a transação fica "REJECTED" com "REFERENCE_CONTEXT_MISMATCH" e o saldo não muda

  @financeiro @edge:TX-15
  Scenario: ROLLBACK de LOSS é recusado por tipo de referência não permitido
    Given uma aposta de "25.00" com LOSS já processado em uma wallet com saldo "100.00"
    When processo um ROLLBACK do LOSS
    Then a transação fica "REJECTED" com "REFERENCE_KIND_NOT_ALLOWED" e o saldo permanece "75.00"

  @financeiro @edge:TX-16
  Scenario: REFUND com valor diferente da aposta é recusado
    Given uma aposta de "25.00" já processada em uma wallet com saldo "100.00"
    When processo um REFUND de "20.00" para essa aposta
    Then a transação fica "REJECTED" com "REFERENCE_AMOUNT_MISMATCH" e o saldo permanece "75.00"

  @financeiro @edge:TX-18
  Scenario: Referência de ROLLBACK nunca chega e a transação é rejeitada após seis buscas
    Given uma wallet com saldo "100.00"
    When processo um ROLLBACK de "25.00" para uma referência inexistente por seis buscas
    Then a transação fica "REJECTED" com "REFERENCE_NOT_FOUND" e o saldo permanece "100.00"

  @financeiro @edge:TX-19
  Scenario: BET chega após rejeição definitiva do ROLLBACK e a rejeição permanece
    Given uma wallet com saldo "100.00" e um ROLLBACK de "25.00" rejeitado por referência não encontrada
    When processo o BET de "25.00" que corresponde à referência
    Then o ROLLBACK continua "REJECTED" e o saldo reflete apenas o BET

  @financeiro @edge:TX-20
  Scenario: WIN sem referência não vinculado a um BET pode ser processado mais de uma vez
    Given uma wallet com saldo "100.00" e um BET sem vínculo de resultado
    When processo dois WIN de "25.00" sem referência para esse BET
    Then os dois WIN são processados e o saldo é "125.00"

  @financeiro @edge:TX-21
  Scenario: OPENING enviado por provedor é recusado como transação inválida
    Given uma wallet com saldo "10.00"
    When envio uma operação OPENING de "1.00" como transação externa
    Then a operação é recusada com "INVALID_TRANSACTION" e o saldo permanece "10.00"

  @financeiro @edge:TX-22
  Scenario: Aposta com valor zero é recusada
    Given uma wallet com saldo "10.00"
    When tento processar uma aposta de "0.00"
    Then o domínio recusa a aposta com "INVALID_TRANSACTION" e o saldo permanece "10.00"

  @financeiro @edge:LG-01
  Scenario: UPDATE, DELETE e TRUNCATE não podem alterar lançamentos do ledger
    Given uma wallet com saldo "10.00" e um lançamento no ledger
    When tento atualizar, excluir e truncar os lançamentos diretamente
    Then todas as operações são recusadas e o saldo permanece "10.00"

  @financeiro @edge:LG-02
  Scenario: Lançamento com aritmética inconsistente é recusado pelo banco
    Given uma wallet com saldo "10.00"
    When tento inserir diretamente um lançamento com aritmética inconsistente
    Then o banco recusa o lançamento e o saldo permanece "10.00"

  @financeiro @edge:LG-03
  Scenario: Dois lançamentos da mesma transação na mesma wallet são recusados
    Given uma wallet com saldo "10.00" e uma transação com lançamento no ledger
    When tento inserir outro lançamento para a mesma transação e wallet
    Then o banco recusa o lançamento duplicado e o saldo permanece "10.00"

  @financeiro @edge:LG-04
  Scenario: Escrita direta de saldo sem lançamento é aceita pelo esquema atual (lacuna F-06)
    Given uma wallet com saldo "10.00"
    When altero diretamente o saldo sem inserir lançamento
    Then a escrita é aceita pelo esquema e o invariante fica divergente

  @financeiro @edge:LG-05
  Scenario: Lançamento que não continua a cadeia é aceito pelo esquema atual
    Given uma wallet com saldo "10.00" e lançamentos no ledger
    When tento inserir um lançamento com saldo inicial diferente do saldo final anterior
    Then a reconciliação reporta a divergência do lançamento

  @financeiro @edge:LG-06
  Scenario: Saldo da wallet é igual à soma do ledger ao final do cenário
    Given uma wallet com saldo "10.00"
    When concluo o cenário sem alterar a wallet
    Then o invariante entre saldo e ledger permanece válido

  @financeiro @edge:LG-07
  Scenario: Cada movimento aumenta a versão da wallet uma vez
    Given uma wallet com saldo "100.00" e sua versão inicial
    When processo dois débitos sucessivos de "10.00"
    Then a versão aumenta em dois e o saldo é "80.00"

  @financeiro @edge:LG-08
  Scenario: Reconciliação reporta uma divergência sem corrigi-la
    Given uma wallet com divergência entre saldo e ledger
    When reconcilio a wallet
    Then a divergência é reportada e contada sem correção automática

  @financeiro @edge:LG-09
  Scenario: Reconciliação concorrente com débito não reporta divergência falsa
    Given uma wallet com saldo "100.00" e um débito em andamento
    When reconcilio a wallet enquanto o débito é confirmado
    Then a reconciliação não reporta divergência e o saldo é "90.00"
