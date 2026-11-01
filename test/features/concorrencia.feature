# HTTP, autenticação e ciclo de vida (seções 7 e 8 da matriz) ficam fora deste harness.
Feature: Concorrência financeira
  @concorrencia @cenario:13.1
  Scenario: Cinquenta envios paralelos da mesma aposta geram um débito
    Given uma wallet com saldo "100.00"
    When envio cinquenta vezes a mesma aposta de "25.00" em paralelo
    Then ocorre apenas um débito e o saldo é "75.00"

  @concorrencia @cenario:13.2 @edge:TX-02
  Scenario: Duas apostas simultâneas de oitenta disputam saldo de cem
    Given uma wallet com saldo "100.00"
    When envio duas apostas de "80.00" em paralelo
    Then uma transação é processada, uma é rejeitada e o saldo é "20.00"

  @concorrencia @cenario:13.3
  Scenario: Apostas em wallets distintas são processadas em paralelo
    Given uma wallet com saldo "100.00"
    When envio uma aposta em cada uma de duas wallets em paralelo
    Then as duas wallets ficam com saldo "75.00"

  @concorrencia @cenario:13.4
  Scenario: Três casos de uso disputam a mesma wallet no mesmo processo
    Given uma wallet com saldo "100.00"
    When envio apostas concorrentes por três casos de uso no mesmo processo
    Then cada aposta processada aparece uma vez no ledger e o saldo é consistente

  @concorrencia @cenario:13.6
  Scenario: Dois publishers reivindicam eventos da mesma outbox
    Given existem eventos pendentes na mesma outbox
    When dois publishers trabalham simultaneamente
    Then cada evento é enviado uma vez e nenhum evento é perdido

  @concorrencia @cenario:13.8
  Scenario: Um publicador novo processa as operações pendentes sem alterar o saldo
    Given existem operações financeiras confirmadas no banco
    When um publicador novo processa as operações pendentes
    Then o saldo final de cada wallet coincide com o ledger
