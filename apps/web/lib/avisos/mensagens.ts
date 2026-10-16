import {
  MOTIVO_FRETE_NAO_SUPORTADO_LI,
  MOTIVO_IMPORTACAO_PARADA_LI,
  MOTIVO_PEDIDO_CONTESTADO_LI,
  PENDENCIA_RECLAMACAO,
  SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO,
  TIPO_AVISO,
  motivoFreteNaoSuportadoLiSchema,
  motivoImportacaoParadaLiSchema,
  motivoPedidoContestadoLiSchema,
  pendenciaReclamacaoSchema,
  situacaoAnuncioForaDaSincronizacaoSchema,
  type Aviso,
  type MotivoFreteNaoSuportadoLi,
  type MotivoImportacaoParadaLi,
  type MotivoPedidoContestadoLi,
  type PendenciaReclamacao,
  type SituacaoAnuncioForaDaSincronizacao,
  type TipoAviso,
} from '@delfrance/schemas';

/**
 * pt-BR wording for each aviso `tipo`, rendered at READ time from the row's
 * `params`.
 *
 * The row stores structured params, never a rendered sentence, so fixing a
 * confusing message applies retroactively to every aviso already written —
 * including ones raised months ago that are still open. It is the same reason
 * `precoMotivos` stores codes rather than text.
 *
 * `runbook` is for the events with no in-app fix at all: the remedy is an
 * infrastructure edit or a Seller Centre action, and telling the operator to
 * click a button that does not exist is worse than telling them nothing.
 *
 * ⚠️ Total by construction (`Record<TipoAviso, …>`): adding a `tipo` to the
 * schema fails typecheck here until it has a message. That is what stops a
 * stored aviso from rendering as a blank row in the panel.
 */
export interface MensagemAviso {
  titulo: string;
  corpo: (params: Aviso['params']) => string;
  runbook?: string;
}

/** Reads a param without letting a missing one render as "undefined". */
function p(params: Aviso['params'], chave: string, fallback = '—'): string {
  const valor = params[chave];
  return valor === undefined || valor === '' ? fallback : String(valor);
}

/**
 * pt-BR do que a reclamação espera do vendedor — TOTAL sobre o código
 * (`params.pendencia`, um {@link PENDENCIA_RECLAMACAO}). O produtor grava o
 * CÓDIGO, nunca a frase, para que corrigir uma redação valha para todo aviso já
 * gravado.
 */
const FRASE_PENDENCIA_RECLAMACAO: Record<PendenciaReclamacao, string> = {
  [PENDENCIA_RECLAMACAO.responderSolicitacao]: 'responda à solicitação de devolução',
  [PENDENCIA_RECLAMACAO.responderProposta]: 'o comprador fez uma proposta e aguarda sua resposta',
  [PENDENCIA_RECLAMACAO.enviarEvidencias]: 'o canal pediu evidências',
};

/**
 * A frase da pendência, ou um texto neutro. ⚠️ Um código mais novo que esta tela
 * (ou um param ausente) cai no fallback — nunca em "undefined". O `safeParse` é
 * o que impede um `'toString'` gravado de achar uma chave herdada do objeto.
 */
/**
 * "Nome (MLB123)" when the producer resolved a name, the bare id otherwise. The
 * id always rides along: two ML categories can share a leaf name, and the id is
 * what the operator matches against the produto's category field.
 */
function rotuloCategoria(params: Aviso['params'], nome: string, id: string): string {
  const idCategoria = p(params, id);
  const nomeCategoria = params[nome];
  return typeof nomeCategoria === 'string' && nomeCategoria !== ''
    ? `${nomeCategoria} (${idCategoria})`
    : idCategoria;
}

/**
 * "Comissão estimada pelo Mercado Livre: 16% → 11,5%." — only when the producer
 * stored BOTH numbers. One alone compares nothing, and a string (a producer bug
 * or a future shape) must not render as a percentage.
 */
function fraseComissao(params: Aviso['params']): string {
  const erp = params.comissaoCategoriaErpPct;
  const ml = params.comissaoCategoriaMlPct;
  if (typeof erp !== 'number' || typeof ml !== 'number') return '';
  if (!Number.isFinite(erp) || !Number.isFinite(ml)) return '';
  const pct = (v: number) => `${v.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
  return ` Comissão estimada pelo Mercado Livre: ${pct(erp)} → ${pct(ml)}.`;
}

function frasePendencia(valor: Aviso['params'][string] | undefined): string {
  const codigo = pendenciaReclamacaoSchema.safeParse(valor);
  return codigo.success
    ? FRASE_PENDENCIA_RECLAMACAO[codigo.data]
    : 'confira a situação da devolução';
}

/**
 * pt-BR do motivo de uma importação de pedidos da Loja Integrada parada — TOTAL
 * sobre o código (`params.motivo`, um {@link MOTIVO_IMPORTACAO_PARADA_LI}). O
 * produtor (a varredura de pedidos) grava o CÓDIGO, nunca a frase.
 */
const FRASE_MOTIVO_IMPORTACAO_PARADA_LI: Record<MotivoImportacaoParadaLi, string> = {
  [MOTIVO_IMPORTACAO_PARADA_LI.credencialAusente]: 'a conta está ativa, mas não tem token salvo',
  [MOTIVO_IMPORTACAO_PARADA_LI.credencialInvalida]:
    'o token salvo está ilegível — remova-o e salve-o de novo',
  [MOTIVO_IMPORTACAO_PARADA_LI.lookbackInvalido]:
    'o período inicial de busca de pedidos está configurado com um valor inválido',
  [MOTIVO_IMPORTACAO_PARADA_LI.idDeContaInvalido]:
    'o id desta conta não é aceito pela varredura de pedidos',
  [MOTIVO_IMPORTACAO_PARADA_LI.orcamentoEsgotado]:
    'a Loja Integrada respondeu devagar demais para ler todos os pedidos alterados',
  [MOTIVO_IMPORTACAO_PARADA_LI.janelaInstavel]: 'a lista de pedidos mudou durante a leitura',
  [MOTIVO_IMPORTACAO_PARADA_LI.falhaTransitoria]:
    'a Loja Integrada falhou seguidamente (limite de requisições, erro no servidor ou rede)',
  [MOTIVO_IMPORTACAO_PARADA_LI.limiteDePaginas]:
    'há mais pedidos alterados do que uma varredura consegue ler',
  [MOTIVO_IMPORTACAO_PARADA_LI.paginacaoInvalida]: 'a paginação da Loja Integrada não avançou',
  [MOTIVO_IMPORTACAO_PARADA_LI.respostaInvalida]:
    'a Loja Integrada respondeu fora do formato esperado',
  [MOTIVO_IMPORTACAO_PARADA_LI.formatoDeData]:
    'uma data de modificação de pedido veio num formato desconhecido',
  [MOTIVO_IMPORTACAO_PARADA_LI.filtroIgnorado]:
    'a Loja Integrada ignorou o filtro de data da busca de pedidos',
  [MOTIVO_IMPORTACAO_PARADA_LI.janelaGrandeDemais]:
    'há pedidos alterados demais desde a última leitura',
};

/**
 * A frase do motivo, ou um texto neutro. ⚠️ Um código mais novo que esta tela
 * (ou um param ausente) cai no fallback — nunca em "undefined"; o `safeParse` é
 * o que impede um `'toString'` gravado de achar uma chave herdada do objeto.
 */
function fraseMotivoImportacaoParada(valor: Aviso['params'][string] | undefined): string {
  const codigo = motivoImportacaoParadaLiSchema.safeParse(valor);
  return codigo.success
    ? FRASE_MOTIVO_IMPORTACAO_PARADA_LI[codigo.data]
    : 'confira o registro da varredura de pedidos';
}

/**
 * pt-BR do que contesta um pedido da Loja Integrada — TOTAL sobre o código
 * (`params.motivo`, um {@link MOTIVO_PEDIDO_CONTESTADO_LI}). O produtor (o
 * importador de pedidos) grava o CÓDIGO, nunca a frase.
 */
const FRASE_MOTIVO_CONTESTADO_LI: Record<MotivoPedidoContestadoLi, string> = {
  [MOTIVO_PEDIDO_CONTESTADO_LI.disputa]: 'o pagamento está em disputa',
  [MOTIVO_PEDIDO_CONTESTADO_LI.chargeback]:
    'o comprador contestou a cobrança junto ao emissor do cartão (chargeback)',
  [MOTIVO_PEDIDO_CONTESTADO_LI.devolvido]: 'o pagamento foi devolvido ao comprador',
  [MOTIVO_PEDIDO_CONTESTADO_LI.devolvidoSemRetorno]:
    'o pagamento foi devolvido ao comprador sem o retorno da mercadoria',
};

/**
 * O corpo do aviso de pedido contestado. ⚠️ Diz SEMPRE que o despacho não fica
 * bloqueado: nada no ERP segura o envio de um pedido da Loja Integrada por
 * causa deste aviso, e quem lesse "contestado" como bloqueio enviaria sem
 * conferir — ou deixaria de enviar um pedido que só está em disputa. Nos três
 * códigos de devolução a frase diz também que o estado e o pagamento foram
 * MANTIDOS (a mercadoria pode não ter voltado) e que a situação é final lá,
 * porque é por isso que o aviso não some sozinho. Um código mais novo que esta
 * tela, uma chave herdada (`'toString'`) ou um param ausente caem no texto
 * neutro, nunca em "undefined".
 */
function corpoPedidoContestadoLi(params: Aviso['params']): string {
  const codigo = motivoPedidoContestadoLiSchema.safeParse(params.motivo);
  const abertura =
    `O pedido ${p(params, 'pedido')} da loja ${p(params, 'loja')} está contestado na Loja ` +
    `Integrada: ${codigo.success ? FRASE_MOTIVO_CONTESTADO_LI[codigo.data] : 'o pagamento foi contestado'}. ` +
    'O despacho NÃO fica bloqueado no ERP — confira o pedido antes de enviar.';
  if (!codigo.success || codigo.data === MOTIVO_PEDIDO_CONTESTADO_LI.disputa) {
    // O resolvedor fecha a linha em QUALQUER importação seguinte que não a levanta —
    // inclusive um estorno antes de o estoque sair —, então a frase nomeia o único caso
    // que a mantém aberta, em vez de prometer "uma situação que não seja de contestação".
    return (
      `${abertura} O aviso se encerra quando a Loja Integrada tirar o pedido da disputa ` +
      '(por exemplo, pago de novo ou cancelado); se o pagamento for devolvido depois que o ' +
      'estoque do pedido já saiu, o aviso continua aberto, agora como devolução.'
    );
  }
  return (
    `${abertura} O ERP manteve o estado e o pagamento do pedido, porque a mercadoria pode não ` +
    'ter voltado: confira a devolução e ajuste o pedido e o estoque se for o caso. Essa situação ' +
    'é final na Loja Integrada, então o aviso só se encerra se ela for mudada no painel da loja.'
  );
}

/**
 * pt-BR do porquê a forma de envio mapeada não serve à importação — TOTAL sobre
 * o código (`params.motivo`, um {@link MOTIVO_FRETE_NAO_SUPORTADO_LI}).
 */
const FRASE_MOTIVO_FRETE_NAO_SUPORTADO_LI: Record<MotivoFreteNaoSuportadoLi, string> = {
  [MOTIVO_FRETE_NAO_SUPORTADO_LI.alvoAusente]:
    'o frete para o qual ela está mapeada não existe mais',
  [MOTIVO_FRETE_NAO_SUPORTADO_LI.alvoInativo]: 'o frete para o qual ela está mapeada está inativo',
  // FOB e outros são um mapeamento VÁLIDO (a etiqueta os resolve, e a importação não
  // levanta aviso para eles): a frase não pode mandar o operador para longe deles.
  [MOTIVO_FRETE_NAO_SUPORTADO_LI.tipoNaoSuportado]:
    'ela está mapeada para um tipo de frete que a importação não usa: mapeie-a para Melhor ' +
    'Envio, motoboy ou retirada na loja — ou para FOB ou outros, que a etiqueta resolve',
  [MOTIVO_FRETE_NAO_SUPORTADO_LI.alvoSemServico]:
    'ela está mapeada para um frete do Melhor Envio sem serviço definido',
};

/** A frase do motivo, ou um texto neutro — o mesmo contrato de {@link fraseMotivoImportacaoParada}. */
function fraseMotivoFreteNaoSuportado(valor: Aviso['params'][string] | undefined): string {
  const codigo = motivoFreteNaoSuportadoLiSchema.safeParse(valor);
  return codigo.success
    ? FRASE_MOTIVO_FRETE_NAO_SUPORTADO_LI[codigo.data]
    : 'o frete para o qual ela está mapeada não pode ser usado';
}

/**
 * The recriar clause of `shopeeKitReceitaDivergente`: the tab's "Recriar kit" on
 * the named link when the aviso names it, and otherwise the link the republish
 * will name. Never a command line — the operator acts in the produto's Shopee
 * tab (#1529).
 */
function fraseRecriarKit(params: Aviso['params']): string {
  const vinculo = p(params, 'vinculo');
  return vinculo === '—'
    ? 'use "Recriar kit" no anúncio que a republicação indicar'
    : `use "Recriar kit" no anúncio do vínculo ${vinculo}`;
}

/**
 * pt-BR do porquê o anúncio está fora da sincronização, com o conserto — TOTAL
 * sobre o código (`params.situacao`, um {@link SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO}).
 * Mesma razão de {@link FRASE_PENDENCIA_RECLAMACAO}: o produtor grava o CÓDIGO.
 */
const FRASE_SITUACAO_ANUNCIO: Record<SituacaoAnuncioForaDaSincronizacao, string> = {
  [SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO.linkEmVariacao]:
    'ele está vinculado a uma variação, e não ao produto pai — refaça o vínculo no produto pai',
  [SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO.paiIdInvalido]:
    'o cadastro do produto tem um vínculo de produto pai inválido — corrija o cadastro do produto',
  [SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO.produtoAusente]:
    'ele aponta para um produto que não existe mais — encerre o anúncio no canal ou peça a ' +
    'remoção do vínculo órfão',
};

/**
 * A frase da situação, ou um texto neutro — o mesmo contrato de
 * {@link frasePendencia}: código mais novo que esta tela, param ausente ou uma
 * chave herdada (`'toString'`) caem no fallback, nunca em "undefined".
 */
function fraseSituacaoAnuncio(valor: Aviso['params'][string] | undefined): string {
  const codigo = situacaoAnuncioForaDaSincronizacaoSchema.safeParse(valor);
  return codigo.success ? FRASE_SITUACAO_ANUNCIO[codigo.data] : 'confira o vínculo do anúncio';
}

/**
 * A frase extra quando o produto tem mais de um anúncio na mesma situação.
 * ⚠️ Só para um NÚMERO maior que 1 — o produtor grava a contagem como número; um
 * valor de outro tipo omite a frase em vez de adivinhar uma contagem.
 */
function fraseOutrosAnuncios(valor: Aviso['params'][string] | undefined): string {
  return typeof valor === 'number' && valor > 1
    ? ` Este produto tem ${String(valor)} anúncios nessa situação.`
    : '';
}

/**
 * `YYYY-MM-DD` (a civil date, as the Loja Integrada producers store
 * `params.expiraEm`) → `DD/MM/AAAA`, by splitting the string. ⚠️ No `Date`
 * parsing on purpose: `new Date('2026-11-02')` is UTC midnight, which the
 * browser renders as the PREVIOUS day in São Paulo. Anything else — absent, a
 * number, a malformed string — returns `null` and the sentence omits the date.
 */
function dataCivilBr(valor: Aviso['params'][string] | undefined): string | null {
  if (typeof valor !== 'string') return null;
  const partes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(valor);
  if (partes === null) return null;
  const [, ano = '', mes = '', dia = ''] = partes;
  return `${dia}/${mes}/${ano}`;
}

/**
 * The expiry sentence's tense. `dias` is written as a NUMBER (`0` on the last
 * day, negative once the date has passed); anything else falls back to the
 * future-tense sentence with the placeholder, never "undefined".
 */
function corpoExpiracaoLojaIntegrada(params: Aviso['params']): string {
  const loja = p(params, 'loja');
  const data = dataCivilBr(params.expiraEm);
  const quando = data === null ? '' : ` (${data})`;
  const dias = params.dias;
  if (typeof dias === 'number' && dias < 0) {
    return (
      `A validade informada para o token da Loja Integrada da loja ${loja} já passou${quando}. ` +
      'Se o token não foi renovado no painel, ele foi revogado — gere um novo e salve-o no ERP. ' +
      'Se foi renovado, atualize a validade no ERP.'
    );
  }
  const prazo = dias === 0 ? 'vence hoje' : `vence em ${p(params, 'dias')} dia(s)`;
  return (
    `O token da Loja Integrada da loja ${loja} ${prazo}${quando}. ` +
    'Renove no painel e atualize a validade no ERP.'
  );
}

export const MENSAGENS_POR_TIPO: Record<TipoAviso, MensagemAviso> = {
  [TIPO_AVISO.shopeeAutorizacaoExpirando]: {
    titulo: 'Autorização Shopee expirando',
    corpo: (params) =>
      `A autorização da loja ${p(params, 'loja')} expira em ${p(params, 'dias')} dia(s). ` +
      'Reautorize escolhendo 365 dias para não repetir o processo em breve.',
  },
  [TIPO_AVISO.shopeeDesautorizado]: {
    titulo: 'Conta Shopee desautorizada',
    corpo: (params) =>
      `A loja ${p(params, 'loja')} deixou de estar autorizada. Nenhum pedido, estoque ou ` +
      'etiqueta será sincronizado até a reautorização.',
  },
  [TIPO_AVISO.shopeePushDegradado]: {
    titulo: 'Entrega de notificações Shopee degradada',
    corpo: (params) =>
      `A Shopee reporta entrega degradada (${p(params, 'status')}). Os pedidos continuam ` +
      'chegando pela varredura de reserva, com atraso.',
    runbook:
      'Se persistir, defina minInstances: 1 em apps/shopee/apphosting.yaml — a instância fria ' +
      'não responde dentro dos 3 segundos que a Shopee espera.',
  },
  [TIPO_AVISO.shopeePushSuspenso]: {
    titulo: 'Assinatura de notificações Shopee suspensa',
    // ⚠️ A fila de 3 dias NÃO cobre uma suspensão: ela guarda o que a Shopee
    // tentou entregar e não conseguiu, e uma assinatura desativada não gera
    // entrega nenhuma. Quem recupera os pedidos desse período é a varredura de
    // pedidos, que relê as orders por `update_time`.
    corpo: () =>
      'A Shopee suspendeu o envio de notificações. O que não foi entregue nesse período não ' +
      'entra na fila de 3 dias — quem recupera os pedidos é a varredura de pedidos.',
    runbook:
      'Reative a assinatura no Console da Shopee e confirme que a varredura de pedidos está ' +
      'ligada — é a única recuperação documentada para o período suspenso.',
  },
  [TIPO_AVISO.canalSemCredencial]: {
    titulo: 'Canal sem credencial válida',
    corpo: (params) =>
      `O canal ${p(params, 'canal')} não tem credencial utilizável${
        params.motivo === undefined ? '' : ` (${p(params, 'motivo')})`
      }. Reconecte a conta.`,
  },
  [TIPO_AVISO.nfeUploadRejeitado]: {
    titulo: 'Envio de NF-e ao canal não concluído',
    // ⚠️ Nem todo motivo é uma recusa (o canal pode não ter respondido, a
    // autorização pode ter expirado, a fila pode estar desligada), então a frase
    // não diz "recusou" — o `erro` de cada motivo traz a causa e o que fazer.
    corpo: (params) =>
      `O envio da NF-e do pedido ${p(params, 'pedido')} ao canal não foi concluído: ` +
      `${p(params, 'erro')}.`,
  },
  [TIPO_AVISO.pedidoPrecisaDecisao]: {
    titulo: 'Pedido aguardando decisão',
    corpo: (params) =>
      `O pedido ${p(params, 'pedido')} precisa de uma decisão manual: ${p(params, 'situacao')}.`,
  },
  [TIPO_AVISO.anuncioComViolacao]: {
    titulo: 'Anúncio com violação',
    // ⚠️ No deadline here. The deadline is the aviso's `prazo` FIELD, which the
    // panel formats for every tipo; a `params.prazo` interpolated through `p()`
    // would print the stored µs integer as if it were a date.
    corpo: (params) =>
      `O anúncio ${p(params, 'anuncio')} está com violação (${p(params, 'violacao')}).`,
  },
  [TIPO_AVISO.jobConcluidoComFalhas]: {
    titulo: 'Processamento concluído com falhas',
    corpo: (params) =>
      `${p(params, 'job')} terminou com ${p(params, 'falhas')} falha(s) de ` +
      `${p(params, 'total')} item(ns). Abra o relatório para ver os motivos.`,
  },
  [TIPO_AVISO.estoqueAcimaDoDisponivel]: {
    titulo: 'Estoque enviado acima do disponível',
    corpo: (params) =>
      `O anúncio ${p(params, 'anuncio')} teve ${p(params, 'reservado')} unidade(s) reservadas ` +
      `para uma promoção, mas o ERP tem ${p(params, 'disponivel')}. O estoque foi enviado no ` +
      'valor da reserva. Reduza a reserva ou reponha o estoque.',
  },
  // Sem `runbook` nos dois abaixo: ambos têm conserto dentro do app — o checkout
  // (`ROTAS_AVISO.despachoCheckout`) emite a NF-e, imprime o DANFE e busca a etiqueta.
  [TIPO_AVISO.despachoAutomaticoPendente]: {
    titulo: 'Despacho automático pendente',
    // ⚠️ A `situacao` traz a causa E o que fazer (um fragmento do produtor, em
    // minúsculas e sem ponto final); a frase fixa só diz o que se perde sem agir.
    corpo: (params) =>
      `O despacho automático de um pacote do pedido ${p(params, 'pedido')} não foi feito: ` +
      `${p(params, 'situacao')}. Sem uma tentativa de despacho, a Shopee cancela o pedido.`,
  },
  [TIPO_AVISO.etiquetaComPrazo]: {
    titulo: 'Etiqueta com prazo de impressão',
    // ⚠️ Nada observa a IMPRESSÃO (o agente de impressão responde 200 mesmo quando
    // falha), então o aviso se encerra na COLETA — e a frase diz isso, para quem já
    // imprimiu pelo checkout não achar que o aviso ficou preso.
    corpo: (params) =>
      `O envio do pedido ${p(params, 'pedido')} já está organizado. Emita e imprima a ` +
      'etiqueta em até 1 hora após a criação do pedido — a Shopee exige isso neste canal de ' +
      'entrega rápida. Se ela já foi impressa, nada a fazer: o aviso se encerra quando a ' +
      'Shopee registrar a coleta.',
  },
  // Sem `runbook`: o conserto está no app (o painel da devolução, na aba Incidentes)
  // ou, para as evidências, nomeado na própria frase.
  [TIPO_AVISO.reclamacaoAguardandoVendedor]: {
    titulo: 'Reclamação aguardando o vendedor',
    // ⚠️ Sem prazo no texto: o prazo é o CAMPO `prazo` (formatado pelo painel para
    // todo tipo, #1751) — um `params.prazo` passado por `p()` imprimiria o µs cru. A
    // frase diz o que se perde: sem resposta, o canal decide sozinho (faq 477: o
    // reembolso é emitido ao comprador).
    corpo: (params) =>
      `A devolução ${p(params, 'devolucao')} do pedido ${p(params, 'pedido')} aguarda você: ` +
      `${frasePendencia(params.pendencia)}. Sem resposta até o prazo, o canal decide sozinho — ` +
      'em geral a favor do comprador. Abra a aba Incidentes do pedido.',
  },
  // Sem `runbook`: o conserto está no app — a categoria do produto. ⚠️ A frase diz
  // que o aviso se encerra ao TROCAR a categoria do produto, porque é exatamente o
  // resolvedor (`onProdutoCategoriaAlterada`): quem decidir manter a categoria
  // antiga precisa saber que o aviso não some sozinho.
  [TIPO_AVISO.anuncioCategoriaAlterada]: {
    titulo: 'Categoria do anúncio alterada',
    corpo: (params) =>
      `O Mercado Livre moveu o anúncio ${p(params, 'anuncio')} para a categoria ` +
      `${rotuloCategoria(params, 'categoriaMlNome', 'categoriaMlId')}, mas o produto continua ` +
      `na categoria ${rotuloCategoria(params, 'categoriaErpNome', 'categoriaErpId')} — é ela ` +
      'que escolhe as fórmulas de preço (comissão, frete) e as regras de imposto da NF-e.' +
      `${fraseComissao(params)} Confira se a nova categoria tem fórmulas e impostos ` +
      'configurados (sem fórmulas, valem as padrão da lista), troque a categoria do produto ' +
      'e das variações, e recalcule o preço. O aviso se encerra quando a categoria do ' +
      'produto for alterada.',
  },
  // Sem `runbook`: o conserto é a aba Shopee do produto (passo 21, #1529). ⚠️
  // "Republique PRIMEIRO" é a ação segura: um reapontamento do mapa (#1450) muda a
  // impressão digital da receita sem mudar a receita na Shopee, e recriar exclui
  // um anúncio que está vendendo. Por isso a frase nomeia o vínculo — recriar sem
  // ele não diz qual kit trocar — e, sem vínculo conhecido, manda ao anúncio que a
  // republicação indicar (`fraseRecriarKit`).
  [TIPO_AVISO.shopeeKitReceitaDivergente]: {
    titulo: 'Kit da Shopee com composição antiga',
    corpo: (params) =>
      `A composição das variações ${p(params, 'variacoes')} do kit ${p(params, 'kit')} mudou no ERP, mas o kit ` +
      `${p(params, 'anuncio')} na Shopee continua com a receita antiga — a Shopee não permite alterar componentes ` +
      'nem quantidades de um kit, então o estoque que ela calcula pode estar errado. Use "Republicar" no anúncio, ' +
      'na aba Shopee do produto: se a composição na Shopee já for a mesma, este aviso se resolve sozinho. ' +
      `Senão, ${fraseRecriarKit(params)} ou volte a composição ao que está na Shopee.`,
  },
  // Sem `runbook`: o conserto está no app — o cadastro do produto (para onde o aviso
  // aponta) ou, para o produto que não existe mais, a página da conta no canal.
  [TIPO_AVISO.anuncioForaDaSincronizacao]: {
    titulo: 'Anúncio fora da sincronização',
    // ⚠️ "no canal", nunca "no Mercado Livre": o tipo é neutro quanto ao canal (o
    // `canal` do aviso já diz qual), e a frase vale para o próximo que o produzir.
    corpo: (params) =>
      `O anúncio ${p(params, 'anuncio')} está ativo no canal, mas não recebe estoque nem ` +
      `preço automaticamente: ${fraseSituacaoAnuncio(params.situacao)}.` +
      fraseOutrosAnuncios(params.anuncios),
  },
  // Sem `runbook`: o conserto está no app — o painel da conta (o link do aviso)
  // atualiza a validade depois que o proprietário renova no painel da Loja Integrada.
  [TIPO_AVISO.lojaIntegradaTokenExpirando]: {
    titulo: 'Token da Loja Integrada expirando',
    // ⚠️ `dias` 0 e negativo têm frases próprias: "vence em 0 dia(s)" e "vence em -3
    // dia(s)" seriam lidos como erro do sistema, não como um token vencido.
    corpo: corpoExpiracaoLojaIntegrada,
  },
  [TIPO_AVISO.lojaIntegradaReconexaoPendente]: {
    titulo: 'Token da Loja Integrada recusado',
    corpo: (params) => {
      // `p()` decides what "missing" means (absent OR ''), so the clause and the
      // placeholder can never disagree: a missing status drops the whole clause.
      const status = p(params, 'status', '');
      return (
        `A Loja Integrada recusou o token da loja ${p(params, 'loja')}` +
        `${status === '' ? '' : ` (HTTP ${status})`}. ` +
        'A importação fica parada até salvar um token válido.'
      );
    },
    // O remédio está FORA do app: só o proprietário da loja gera ou renova o token.
    runbook:
      'Peça ao proprietário da loja que gere um novo token ou renove o atual no painel da Loja ' +
      'Integrada (Configurações > Chave para API) e salve-o na conta, no ERP.',
  },
  // Crítico: o caminho garantido de entrada de pedidos (a varredura a cada 5
  // minutos) parou para esta conta. Uma conta PARADA por token recusado nunca
  // levanta este aviso — quem fala é o aviso de token recusado.
  [TIPO_AVISO.lojaIntegradaImportacaoParada]: {
    titulo: 'Importação de pedidos da Loja Integrada parada',
    corpo: (params) =>
      `Os pedidos da loja ${p(params, 'loja')} não estão sendo importados da Loja Integrada: ` +
      `${fraseMotivoImportacaoParada(params.motivo)}. Pedidos novos e alterados não chegam ao ` +
      'ERP enquanto isso não se resolver.',
    // Só os dois motivos de token têm conserto no app (o painel da conta); os
    // demais são da varredura e ficam com quem lê o Cloud Logging.
    runbook:
      'Se o motivo for o token, salve um token válido na conta. Nos demais casos, um ' +
      'desenvolvedor confere o registro da varredura de pedidos; quando há pedidos alterados ' +
      'demais, reiniciar o cursor da conta faz a leitura recomeçar pelo período inicial de busca.',
  },
  // Os quatro tipos da importação de pedidos (passos 5 e 6). Todos `atencao`: cada um
  // fala de UM pedido ou UMA forma de envio, e a entrada de pedidos segue funcionando.
  [TIPO_AVISO.lojaIntegradaSituacaoDesconhecida]: {
    titulo: 'Situação desconhecida em pedido da Loja Integrada',
    corpo: (params) =>
      `O pedido ${p(params, 'pedido')} da loja ${p(params, 'loja')} chegou da Loja Integrada ` +
      `com a situação "${p(params, 'codigo')}", que o ERP não conhece. O pedido foi importado e ` +
      'ficou marcado com um erro até a situação ser reconhecida — confira-o no painel da Loja ' +
      'Integrada. O aviso se encerra quando o pedido voltar com uma situação conhecida.',
    // O conserto é de código: a situação nova entra na tabela compartilhada.
    runbook:
      'Um desenvolvedor inclui a situação nova na tabela de situações da Loja Integrada ' +
      '(packages/schemas, situacaoPedidoLojaIntegrada.ts) e decide o estado e o status de ' +
      'pagamento dela.',
  },
  [TIPO_AVISO.lojaIntegradaPedidoContestado]: {
    titulo: 'Pedido da Loja Integrada contestado',
    corpo: corpoPedidoContestadoLi,
  },
  [TIPO_AVISO.lojaIntegradaPedidoHub]: {
    titulo: 'Pedido da Loja Integrada vindo de um hub',
    corpo: (params) =>
      `O pedido ${p(params, 'pedido')} da loja ${p(params, 'loja')} chegou à Loja Integrada por ` +
      'um hub de marketplaces e não foi importado: esta integração importa só os pedidos da ' +
      'própria loja virtual. Confira no painel da Loja Integrada se algum hub foi ativado. O ' +
      'aviso se encerra se o pedido voltar sem as marcas de hub ou for cancelado.',
    // O conserto está fora do app: no painel da loja, ou numa decisão de plano.
    runbook:
      'Pedidos de hub não são importados por decisão do plano da integração. Se um hub foi ' +
      'ativado de propósito, um desenvolvedor precisa avaliar como esses pedidos entram no ERP.',
  },
  // Sem `runbook`: o conserto está no app — a aba Mapeamento do Frete da conta, para
  // onde o aviso aponta.
  [TIPO_AVISO.lojaIntegradaFreteNaoSuportado]: {
    titulo: 'Forma de envio da Loja Integrada sem frete utilizável',
    corpo: (params) =>
      `A forma de envio ${p(params, 'formaEnvio')} da loja ${p(params, 'loja')} não pôde ser ` +
      `usada na importação de pedidos: ${fraseMotivoFreteNaoSuportado(params.motivo)}. Os ` +
      'pedidos com ela foram importados com o frete da própria Loja Integrada, e o mapeamento é ' +
      'conferido de novo na hora da etiqueta. Revise o mapeamento na aba Mapeamento do Frete da ' +
      'conta; o aviso se encerra quando um pedido com essa forma de envio for importado depois ' +
      'da correção.',
  },
};

/**
 * Hosts an aviso's `urlExterna` may point at. Provider-supplied URLs are
 * untrusted input, so the link is only rendered when it is `https:` AND lands on
 * one of these — see `urlExternaSegura`.
 */
export const HOSTS_EXTERNOS_PERMITIDOS: ReadonlyArray<string> = [
  'shopee.com.br',
  'mercadolivre.com.br',
  'mercadolibre.com',
  'melhorenvio.com.br',
  'facebook.com',
];
