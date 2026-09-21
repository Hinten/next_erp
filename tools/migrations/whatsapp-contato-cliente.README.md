# WhatsApp: contato → cliente e uma conversa por cliente/integração (#1084)

Esta operação pertence à janela de corte de ADR 0013 e ao runbook #1208,
acompanhada por [#1604](https://github.com/Hinten/next_erp/issues/1604).
Agentes não a executam contra produção. O código não constitui evidência sobre
o corpus: a auditoria e o ensaio com a importação real ainda precisam ocorrer.

## Garantias e decisões

- Uma conversa canônica por `(integração, cliente)`: conserva o menor ID existente
  em ordem lexicográfica. A escolha fica congelada no manifesto.
- A integração precisa existir e carregar o tipo WhatsApp oficial (`6`). Tipo
  ausente, desconhecido ou de outro canal bloqueia até revisão da conta/referência.
- Resolve automaticamente somente um `clienteOuterRef` existente ou um vínculo
  `userCliente` legado único. Reconhece `user` e `usuarios`, com e sem `documents/`.
  Telefone e nome sozinhos não autorizam associação; contatos sem vínculo ou com
  vínculo ambíguo aparecem como `pending` no relatório completo.
  Aplicação, finalização e verificação exigem zero pendências legadas: cada contato
  histórico precisa de decisão no manifesto antes de liberar consumidores.
- Criar cliente exige decisão explícita. O ID é o SHA-256 de
  `JSON.stringify(['whatsapp-migration-cliente', decisionId])`; usar o mesmo
  `decisionId` compartilha a criação, e campos divergentes bloqueiam o manifesto.
- Divergências de atendimento exigem uma conversa fonte para o estado operacional.
  Números distintos exigem escolher separadamente a fonte do destino de resposta.
  Escolher destino não aposenta nenhum outro número. Telefones aposentados e
  substituições são decisões explícitas, nunca deduções de nomes ou timestamps.
- `data_cadastro` conserva o mínimo; `ultima_modificacao`, o máximo. O destino
  recebe o relógio inbound do próprio número, sem misturar janelas de 24 horas.
  Eventos de sistema só avançam `ultimaIdentificacaoEm`; `ultimaMensagemEm`
  e `prazo_resposta` dependem de mensagens recebidas do cliente, sem eventos.
- Mensagens com `mid` usam o ID determinístico por integração/wamid. Mesmo `mid`
  com conteúdo divergente é conflito; metadados de entrega só se combinam com
  relógio explícito suficiente. Mensagens sem `mid` nunca deduplicam por texto.
  Colisões sem `mid` recebem `migrado_<sha256(caminhoOriginal)>`.
  `whatsappIdentidadeId` registra a identidade remetente de cada inbound na conversa
  original; mensagens de saída recebem null. Recibos de leitura respeitam essa origem.
- Campos desconhecidos, subcoleções arbitrárias e tipos Firestore são conservados.
  Colisão desconhecida divergente bloqueia a operação. Referências exatas para
  conversas/mensagens movidas são reescritas, inclusive contexto e reação.
  Textos livres não sofrem substituição de substrings.
- Registros `whatsappConversas`, `whatsappMensagens` e `whatsappIdentidades`
  são semeados. Um registro já existente divergente bloqueia a execução.
- `whatsappConversaAliases/{oldChatId}` e sua subcoleção
  `mensagens/{oldMsgId}` preservam links antigos, sem duas fontes de histórico.
- A migração não exclui usuários sintéticos nem arquivos de mídia. Anexos
  continuam apontando aos mesmos arquivos; transferência de bucket/URLs é a
  operação separada de ADR 0013.

## Revisão das decisões

JSON opcional fornecido com `--decisions <arquivo>`:

```json
{
  "clientes": {
    "chat-sem-vinculo": { "clienteId": "cliente-existente" },
    "chat-novo": {
      "novo": {
        "decisionId": "contato-revisado-001",
        "fields": { "nome": "Nome confirmado", "telefone": "5511999998888" }
      }
    }
  },
  "estado": { "id-canonico": "chat-com-atendimento-que-deve-continuar" },
  "destino": { "id-canonico": "chat-do-numero-atual-confirmado" },
  "telefones": {
    "cliente-existente": {
      "principal": "5511999998888",
      "historicos": ["5511888887777"]
    }
  },
  "identidades": {
    "id-da-identidade-aposentada": { "ativa": false, "sucessoraId": "id-da-sucessora" }
  }
}
```

O relatório imprime os caminhos necessários para essas decisões. `documentos`
permite um objeto completo por caminho final para resolver conflito de conteúdo
revisado. Ele preserva obrigatoriamente os campos protegidos de identidade e de
destino; não é uma forma de mudar o cliente depois de calcular os registros.
Arquivar o motivo humano ao lado do arquivo de decisões. Gerar novo manifesto
depois de revisar decisões; nunca editar um manifesto em execução.

`telefonesAdicionais` contém os históricos explicitamente informados; o principal
existente permanece salvo quando não há decisão de troca. O snapshot
`telefoneClienteNoVinculo` usa o principal resultante para que uma alteração
cadastral futura invalide o vínculo telefônico antigo. BSUID não é inventado a
partir de telefone ou de `sender_id`: esta passagem semeia identidades telefônicas
do corpus legado; o runtime recebe BSUID comprovado da Meta.
Vínculos decididos explicitamente em `clientes` ou `identidades` registram
`confirmadaManualmente: true`; associações automáticas recebem false. A decisão
humana pode resolver telefones ambíguos, mas continua sujeita à revogação e à
alteração posterior do principal cadastrado.

## Ensaio e operação humana

Credenciais do destino devem estar configuradas no ambiente ou em
`--service-account <arquivo>`. O script não carrega arquivos de ambiente; o
`--project` obrigatório é conferido contra o projeto da service account.

```bash
# 1. Inventário completo, sem escrita no Firestore.
pnpm --filter @delfrance/migrations migrate:whatsapp-contato-cliente --project <destino> --report-only

# 2. Depois das decisões, produz JSONL e manifesto com dados before/after.
pnpm --filter @delfrance/migrations migrate:whatsapp-contato-cliente --project <destino> --decisions <decisoes.json>

# 3. Revalida o manifesto sem escrever. Conflitos bloqueiam; pending é contado.
pnpm --filter @delfrance/migrations migrate:whatsapp-contato-cliente --project <destino> --manifest <manifesto.json>

# 4. Só com escritores/consumidores suspensos: copia e verifica, sem excluir origens.
pnpm --filter @delfrance/migrations migrate:whatsapp-contato-cliente --project <destino> --manifest <manifesto.json> --apply --writers-stopped

# 5. Finaliza: revalida tudo e exclui cópias antigas, filhos antes dos pais.
pnpm --filter @delfrance/migrations migrate:whatsapp-contato-cliente --project <destino> --manifest <manifesto.json> --apply --writers-stopped --finalize

# 6. Verifica destinos e repete finalize: zero escritas/exclusões é a idempotência.
pnpm --filter @delfrance/migrations migrate:whatsapp-contato-cliente --project <destino> --manifest <manifesto.json> --verify
```

Usar o mesmo manifesto ao retomar uma execução interrompida. Fingerprints
before/after permitem reconhecer operações já concluídas; precondições nativas
impedem sobrescrever alterações concorrentes. O preflight confere todos os
documentos originais e procura descendentes novos antes da primeira escrita.
O checkpoint vincula-se ao fingerprint do manifesto. O JSONL registra cada
operação concluída ou pretendida. Manifesto contém dados pessoais: conservar
em `out/`, fora do Git, com o mesmo acesso do backup da migração.

O inventário inclui todos os documentos e subcoleções de `chat`, inclusive
subcoleções sob pais ausentes; as demais coleções necessárias são lidas somente
na raiz. Não caminha pelas subcoleções de credenciais de integração. A operação
guarda o inventário em memória: medir tamanho e RAM no ensaio. Tipos Firestore
nativos não reconhecidos recusam serialização, em vez de perder dados.

## Ordem e impedimentos reais

1. Ensaiar num projeto descartável, com snapshot representativo e sem consumidores.
2. Congelar o legado e estacionar notificações; importar a cópia final no destino.
3. Executar a normalização de telefones com a classificação internacional correta.
4. Auditar, revisar decisões, gerar manifesto e executar os comandos acima.
5. Verificar históricos, contagens por wamid, refs, estados, anexos e links antigos.
6. Implantar/liberar consumidores e reprocessar notificações estacionadas.

**SDK writes disparam triggers.** O `--writers-stopped` é uma declaração
operacional exigida pela CLI, não uma suspensão implementada por ela. Execute
antes da primeira implantação dos triggers de negócio (fase 3 de ADR 0013), ou
com triggers e sweeps efetivamente suspensos e seus eventos drenados. Copiar
mensagens `salva`/`enviando` sem `mid` pode reenviar mensagens; essa população
aparece como conflito e precisa ser reconciliada. Não confundir inbound
estacionado com outbound parado.

Não liberar a UI entre cópia e finalização, pois as origens ainda existem nesse
intervalo. Resolver todas as pendências históricas no arquivo de decisões e
regenerar o manifesto antes da aplicação. Integração ausente ou destino sem
evidência também bloqueiam até revisão humana documentada. O fluxo manual do
runtime atende novos inbound; ele não consolida históricos legados.

Rollback simples é restaurar a cópia/export no destino descartável e repetir
o manifesto antes de receber novas escritas. **Depois do primeiro inbound,
replay, envio ou escrita humana no destino, voltar ao legado exige reconciliar
essas escritas.** A migração não implementa rollback automático sobre dados novos.

## Validação automatizada

Os testes puros verificam igualdade estrita, vínculos ambíguos, cliente explícito,
dois números/mesmo cliente, referências, campos desconhecidos, autoria, dedup por
wamid e colisões sem mid. O executor é interrompido em cada operação e retomado;
drift, descendentes novos e exclusões fora do inventário são recusados. O codec
testa timestamps, geopoints, bytes, valores numéricos especiais e mapas escapados.
`apps/whatsapp/lib/whatsapp/migracao.firestore.test.ts` executa o adaptador, o codec
e a transformação reais no Firestore local do carve-out `firebase.e2e.json`, em
`demo-erp/default`. Verifica tipos nativos, aliases, subárvores sob pais ausentes,
dedup, preservação de anexos, duas finalizações, drift e precondições nativas.
O inventário não entra em subcoleções da integração nem coleta arquivos fora de
sua lista de raízes; o teste usa uma sentinela sintética para conferir esse limite.
Isso não substitui o ensaio nem demonstra que a base real não possui conflitos.
