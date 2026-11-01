# HTTP, autenticação e ciclo de vida (seções 7 e 8 da matriz) ficam fora deste harness.
Feature: Idempotência
  @idempotencia @edge:ID-01
  Scenario: Reenviar a mesma aposta devolve o resultado original
    Given uma wallet com saldo "100.00"
    When processo duas vezes a mesma aposta de "25.00"
    Then ocorre apenas um débito e o saldo é "75.00"

  @idempotencia @edge:ID-02
  Scenario: Reutilizar a mesma chave com payload divergente gera conflito
    Given uma wallet com saldo "100.00"
    When reenvio a mesma chave de aposta com payload divergente
    Then a segunda operação entra em conflito sem novo débito

  @idempotencia @edge:ID-03
  Scenario: Reenviar o mesmo external id com outra chave e payload igual reproduz o resultado
    Given uma wallet com saldo "100.00"
    When reenvio o mesmo external id com outra chave e payload igual
    Then ocorre replay sem efeito duplicado

  @idempotencia @edge:ID-04
  Scenario: Reenviar o mesmo external id com outra chave e payload divergente gera conflito
    Given uma wallet com saldo "100.00"
    When reenvio o mesmo external id com outra chave e payload divergente
    Then a segunda operação entra em conflito sem novo débito

  @idempotencia @edge:ID-05
  Scenario: O mesmo external id em provedores diferentes cria duas transações
    Given uma wallet com saldo "100.00"
    When processo o mesmo external id por dois provedores
    Then são criadas duas transações independentes

  @idempotencia @edge:ID-06
  Scenario: A mesma chave de idempotência em provedores diferentes é aceita
    Given uma wallet com saldo "100.00"
    When processo a mesma chave por dois provedores
    Then são criadas duas transações independentes

  @idempotencia @edge:ID-07
  Scenario: Redelivery do mesmo messageId com payload diferente vai para dead letter
    Given uma wallet com saldo "100.00"
    When redeliver a mensagem com o mesmo messageId e payload diferente
    Then a mensagem é recusada por conflito de payload

  @idempotencia @edge:ID-08
  Scenario: Redelivery do mesmo messageId com outra idempotencyKey gera conflito
    Given uma wallet com saldo "100.00"
    When redeliver a mensagem com o mesmo messageId e outra chave de idempotência
    Then a mensagem é recusada por conflito de payload

  @idempotencia @edge:ID-09
  Scenario: Redelivery de inbox legado compara os campos de negócio
    Given uma wallet com saldo "100.00"
    When redeliver uma mensagem cuja inbox legado não tem fingerprint
    Then a redelivery é aceita como duplicata compatível

  @idempotencia @edge:ID-10
  Scenario: O mesmo comando recebido por HTTP e depois por SQS só debita uma vez
    Given uma wallet com saldo "100.00"
    When processo o mesmo comando por HTTP e depois por SQS
    Then ocorre apenas um débito e o saldo é "75.00"
