# HTTP, autenticação e ciclo de vida (seções 7 e 8 da matriz) ficam fora deste harness.
Feature: Mensageria e referências pendentes
  @mensageria @edge:OB-01
  Scenario: A escrita de envelope malformado no outbox é recusada
    Given o banco de teste está pronto para gravar eventos no outbox
    When tento gravar um envelope malformado no outbox
    Then a escrita é recusada e o publicador continua processando os demais eventos

  @mensageria @edge:OB-02
  Scenario: Dois publicadores concorrentes reivindicam eventos distintos da mesma outbox
    Given existem eventos pendentes no outbox
    When dois publicadores reivindicam eventos em paralelo
    Then cada evento é enviado uma única vez

  @mensageria @edge:OB-03
  Scenario: Um publicador lento perde a posse após o lease expirar
    Given um publicador mantém um evento sob lease
    When o lease expira e outro publicador assume o evento
    Then a conclusão do publicador lento é recusada

  @mensageria @edge:OB-04
  Scenario: Uma falha parcial no lote reagenda somente os eventos recusados
    Given há um lote de eventos pendentes no outbox
    When o broker aceita parte do lote e recusa os demais
    Then somente os eventos recusados são reagendados

  @mensageria @edge:OB-05
  Scenario: Uma falha após o envio publica novamente o mesmo identificador de evento
    Given um evento foi aceito pelo broker antes da confirmação no outbox
    When o publicador falha antes de marcar o evento como publicado e tenta novamente
    Then o evento é republicado com o mesmo identificador

  @mensageria @edge:OB-06
  Scenario: Publicadores concorrentes podem enviar eventos da mesma wallet fora de ordem
    Given há eventos de versões sucessivas da mesma wallet no outbox
    When dois publicadores enviam esses eventos em paralelo
    Then a ordem de envio não é garantida e cada evento mantém sua versão da wallet

  @mensageria @edge:OB-07
  Scenario: O relógio adiantado de um publicador não rouba um lease ativo
    Given um evento está sob lease ativo no relógio do banco
    When outro publicador com relógio uma hora adiantado tenta reivindicá-lo
    Then o lease ativo não é roubado

  @mensageria @edge:OB-08
  Scenario: O relógio atrasado de um publicador respeita o backoff do outbox
    Given um evento recusado pelo broker foi reagendado com backoff
    When um publicador com relógio atrasado tenta processá-lo antes do prazo
    Then o evento permanece aguardando o prazo calculado pelo relógio do banco

  @mensageria @edge:QU-01
  Scenario: A renovação de visibilidade mantém oculto o fim de um lote lento
    Given três mensagens estão em processamento em um lote com janela de visibilidade de dois segundos
    When um segundo consumidor pesquisa a fila enquanto o primeiro lote ainda está em andamento
    Then nenhuma mensagem em voo é recebida pelo segundo consumidor

  @mensageria @edge:QU-02
  Scenario: Uma mensagem com corpo inválido vai para a DLQ e recebe ACK
    Given existe uma mensagem com corpo inválido na fila de comandos
    When o consumidor processa a mensagem
    Then a mensagem é enviada para a DLQ como falha permanente e removida da fila

  @mensageria @edge:QU-03
  Scenario: Uma falha transitória agenda nova tentativa sem enviar para a DLQ
    Given existe uma mensagem válida e o banco está indisponível temporariamente
    When o consumidor falha ao aplicar o comando
    Then a mensagem recebe visibilidade com backoff e não é enviada para a DLQ

  # Bloqueado no harness: a fila isolada não recebe a política de redrive (maxReceiveCount=10).
  # A cobertura real está em test/integration/messaging/broker-redrive.test.ts. Não executado aqui.
  @mensageria @bloqueado @edge:QU-04
  Scenario: Uma mensagem que falha em dez entregas vai para a DLQ pelo redrive
    Given uma mensagem continua falhando e a fila permite dez entregas
    When o broker atinge o limite de recebimentos da mensagem
    Then o broker move a mensagem para a DLQ

  @mensageria @edge:QU-05
  Scenario: A falha ao enviar para a DLQ e ao confirmar ACK não perde a mensagem
    Given uma cópia da mensagem já está na DLQ e a confirmação de ACK falha
    When a mensagem é entregue novamente e o envio para a DLQ é repetido
    Then permanece uma única cópia na DLQ e nenhuma mensagem é perdida

  @mensageria @edge:QU-06
  Scenario: A redelivery após morte do worker não duplica o efeito confirmado
    Given o worker confirmou o comando no banco e morreu antes de enviar ACK
    When a mesma mensagem é entregue novamente
    Then a inbox reconhece a mensagem e o efeito é aplicado uma única vez

  # Bloqueado no harness: SIGTERM só pode ser enviado ao processo real do worker, que este harness
  # não controla. A cobertura real está em test/concurrency/process-crash-and-shutdown.test.ts.
  @mensageria @bloqueado @edge:QU-07
  Scenario: SIGTERM durante um lote conclui o item atual e devolve o restante
    Given um consumidor está processando um lote quando recebe SIGTERM
    When o encerramento gracioso é iniciado
    Then o item em andamento termina e as mensagens restantes são devolvidas

  @mensageria @edge:QU-08
  Scenario: Dois consumidores processam mensagens da mesma fila sem duplicar operações
    Given existem quarenta operações distribuídas entre várias wallets na fila
    When dois consumidores processam as mensagens em paralelo
    Then cada operação é aplicada uma única vez

  @mensageria @edge:QU-09
  Scenario: A renovação mantém uma mensagem longa invisível até o limite de retenção
    Given uma mensagem demora seis segundos para processar e a janela de visibilidade é de dois segundos
    When um segundo consumidor pesquisa aos três segundos e meio
    Then a mensagem não é entregue antes do limite de retenção e é liberada depois dele

  @mensageria @edge:PR-01
  Scenario: Dois workers resolvendo a mesma pendência aplicam seu efeito uma vez
    Given existe uma referência pendente vencida para processamento
    When dois workers resolvem a referência em paralelo
    Then o efeito da transação é aplicado uma única vez

  @mensageria @edge:PR-02
  Scenario: Seis workers processam seis estornos pendentes da mesma wallet
    Given existem seis estornos pendentes para a mesma wallet
    When seis workers resolvem os estornos em paralelo
    Then cada estorno é aplicado uma única vez

  @mensageria @edge:PR-03
  Scenario: O agendamento de referências pendentes continua após reinício
    Given existem referências pendentes com próximas tentativas persistidas
    When o worker de referências é reiniciado e executa novamente
    Then as tentativas agendadas continuam sendo processadas

  @mensageria @edge:PR-04
  Scenario: Uma falha durante a resolução reverte a transação e permite nova tentativa
    Given existe uma referência pendente vencida para processamento
    When o worker falha durante a resolução antes do commit
    Then a alteração é revertida e uma tentativa posterior pode aplicá-la

  @mensageria @edge:PR-05
  Scenario: O worker respeita o backoff das retentativas de referência
    Given existe uma referência pendente com próxima tentativa futura
    When o worker busca referências antes do prazo
    Then nenhuma tentativa é executada antes do prazo

  @mensageria @edge:PR-06
  Scenario: Workers com relógios diferentes tomam a mesma decisão sobre o prazo
    Given existem referências pendentes com prazo definido pelo relógio do banco
    When workers com relógios separados por uma hora verificam as referências
    Then ambos respeitam a mesma decisão de vencimento do banco

  @mensageria @edge:PR-07
  Scenario: O limite de tentativas esgota uma fila crescente de referências pendentes
    Given existem quarenta e cinco referências pendentes
    When o worker executa três passagens respeitando seu limite de lote
    Then as referências atingem o limite de tentativas e são rejeitadas por referência não encontrada

  @mensageria @edge:TX-17
  Scenario: Uma referência pendente é resolvida após a aposta chegar
    Given uma wallet com saldo "100.00"
    When envio um refund sem referência e depois a aposta referenciada
    Then o refund pendente é processado e o saldo é "100.00"
