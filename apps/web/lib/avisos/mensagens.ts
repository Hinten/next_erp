import {
  MOTIVO_CONTA_AMAZON,
  MOTIVO_FRETE_NAO_SUPORTADO_LI,
  MOTIVO_IMPORTACAO_PARADA_AMAZON,
  MOTIVO_IMPORTACAO_PARADA_LI,
  MOTIVO_PEDIDO_AMAZON,
  MOTIVO_PEDIDO_CONTESTADO_LI,
  MOTIVO_REVERSAO_COM_ETIQUETA_LI,
  PENDENCIA_RECLAMACAO,
  SITUACAO_ANUNCIO_FORA_DA_SINCRONIZACAO,
  TIPO_AVISO,
  motivoContaAmazonSchema,
  motivoFreteNaoSuportadoLiSchema,
  motivoImportacaoParadaAmazonSchema,
  motivoImportacaoParadaLiSchema,
  motivoPedidoAmazonSchema,
  motivoPedidoContestadoLiSchema,
  motivoReversaoComEtiquetaLiSchema,
  pendenciaReclamacaoSchema,
  situacaoAnuncioForaDaSincronizacaoSchema,
  type Aviso,
  type MotivoContaAmazon,
  type MotivoFreteNaoSuportadoLi,
  type MotivoImportacaoParadaAmazon,
  type MotivoImportacaoParadaLi,
  type MotivoPedidoAmazon,
  type MotivoPedidoContestadoLi,
  type MotivoReversaoComEtiquetaLi,
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
 *
 * Exportada para a conferência de pagamento (`lib/loja-integrada/conferenciaPagamento.ts`)
 * dizer a MESMA frase quando bloqueia ou avisa — uma cópia só, nunca duas que
 * se afastam.
 */
export const FRASE_MOTIVO_CONTESTADO_LI: Readonly<Record<MotivoPedidoContestadoLi, string>> = {
  [MOTIVO_PEDIDO_CONTESTADO_LI.disputa]: 'o pagamento está em disputa',
  [MOTIVO_PEDIDO_CONTESTADO_LI.chargeback]:
    'o comprador contestou a cobrança junto ao emissor do cartão (chargeback)',
  [MOTIVO_PEDIDO_CONTESTADO_LI.devolvido]: 'o pagamento foi devolvido ao comprador',
  [MOTIVO_PEDIDO_CONTESTADO_LI.devolvidoSemRetorno]:
    'o pagamento foi devolvido ao comprador sem o retorno da mercadoria',
};

/**
 * O que a conferência de pagamento da Loja Integrada faz com um pedido
 * contestado — dito pelo aviso, porque é o que o operador precisa saber dele:
 * os portões que GASTAM (o checkout tira o estoque, a compra paga a etiqueta)
 * RECUSAM, seja pela situação lida na loja, seja por este aviso aberto quando a
 * loja não pode ser lida; os que só imprimem (a reimpressão, a etiqueta
 * genérica) pedem o "Estou ciente do risco". ⚠️ É uma afirmação sobre as
 * tabelas de decisão (`lib/loja-integrada/conferenciaPagamento.ts`), e o teste
 * a prende a elas: mudou uma, muda a frase.
 */
const PORTOES_DO_PEDIDO_CONTESTADO_LI =
  'O checkout e a compra de etiqueta no Melhor Envio são recusados enquanto a Loja Integrada ' +
  'mostrar o pedido contestado ou este aviso estiver aberto. A reimpressão da etiqueta e a ' +
  'etiqueta genérica só prosseguem depois que o operador confirmar que está ciente do risco.';

/**
 * O corpo do aviso de pedido contestado. ⚠️ Diz SEMPRE o que os portões fazem
 * ({@link PORTOES_DO_PEDIDO_CONTESTADO_LI}): quem não soubesse que o checkout
 * será recusado iria descobrir no balcão, e quem achasse que nada segura o
 * envio despacharia sem conferir. Nos três códigos de devolução a frase diz
 * também que o estado e o pagamento foram MANTIDOS (a mercadoria pode não ter
 * voltado) e que a situação é final lá, porque é por isso que o aviso não some
 * sozinho. Um código mais novo que esta tela, uma chave herdada (`'toString'`)
 * ou um param ausente caem no texto neutro, nunca em "undefined".
 */
function corpoPedidoContestadoLi(params: Aviso['params']): string {
  const codigo = motivoPedidoContestadoLiSchema.safeParse(params.motivo);
  const abertura =
    `O pedido ${p(params, 'pedido')} da loja ${p(params, 'loja')} está contestado na Loja ` +
    `Integrada: ${codigo.success ? FRASE_MOTIVO_CONTESTADO_LI[codigo.data] : 'o pagamento foi contestado'}. ` +
    PORTOES_DO_PEDIDO_CONTESTADO_LI;
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
 * pt-BR da reversão que a Loja Integrada aplicou a um pedido com etiqueta já
 * comprada — TOTAL sobre o código (`params.motivo`, um
 * {@link MOTIVO_REVERSAO_COM_ETIQUETA_LI}). O produtor (o importador de
 * pedidos) grava o CÓDIGO, nunca a frase.
 */
const FRASE_MOTIVO_REVERSAO_COM_ETIQUETA_LI: Record<MotivoReversaoComEtiquetaLi, string> = {
  [MOTIVO_REVERSAO_COM_ETIQUETA_LI.cancelado]: 'cancelado',
  [MOTIVO_REVERSAO_COM_ETIQUETA_LI.devolvido]: 'estornado, com o pagamento devolvido ao comprador',
  [MOTIVO_REVERSAO_COM_ETIQUETA_LI.chargeback]:
    'contestado pelo comprador junto ao emissor do cartão (chargeback)',
  [MOTIVO_REVERSAO_COM_ETIQUETA_LI.devolvidoSemRetorno]: 'estornado sem o retorno da mercadoria',
};

/**
 * O corpo do aviso de reversão com etiqueta comprada. ⚠️ Diz que o ERP NÃO
 * cancela a etiqueta nem a NF-e — é por isso que o aviso existe — e que a
 * situação é final lá, porque é por isso que ele não some sozinho. Um código
 * mais novo que esta tela, uma chave herdada (`'toString'`) ou um param
 * ausente caem no texto neutro ("revertido"), nunca em "undefined".
 */
function corpoReversaoComEtiquetaLi(params: Aviso['params']): string {
  const codigo = motivoReversaoComEtiquetaLiSchema.safeParse(params.motivo);
  const como = codigo.success ? FRASE_MOTIVO_REVERSAO_COM_ETIQUETA_LI[codigo.data] : 'revertido';
  return (
    `O pedido ${p(params, 'pedido')} da loja ${p(params, 'loja')} foi ${como} na Loja Integrada ` +
    'depois que a etiqueta dele já tinha sido comprada. O ERP aplicou a situação ao pedido como ' +
    'de costume, mas não cancela a etiqueta nem a NF-e: cancele a etiqueta no Melhor Envio e a ' +
    'NF-e do pedido, se ela já foi emitida, antes que o pacote seja despachado. Essa situação é ' +
    'final na Loja Integrada, então o aviso só se encerra se o pedido for reaberto no painel da ' +
    'loja.'
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

/**
 * Onde uma conta Amazon é reautorizada: no ERP. ⚠️ Nunca no Seller Central — o
 * botão de reautorizar de lá abre uma página de login que este ERP não atende,
 * então a frase diz para não usá-lo. E sem nomear o rótulo do botão do painel,
 * que muda com o estado da conexão.
 */
const REAUTORIZE_AMAZON =
  'Reautorize pelo painel de conexão da conta, no ERP — o botão de reautorizar do Seller ' +
  'Central não é suportado.';

/**
 * A frase da autorização da Amazon que se aproxima dos 365 dias. `dias` é um
 * NÚMERO de dias civis (São Paulo): `0` no próprio dia, negativo depois dele —
 * cada um com sua frase, porque "vence em 0 dia(s)" e "vence em -3 dia(s)" seriam
 * lidos como erro do sistema. Qualquer outro valor cai na frase futura com o
 * marcador, nunca em "undefined".
 */
function corpoReautorizacaoAmazon(params: Aviso['params']): string {
  const loja = p(params, 'loja');
  const data = dataCivilBr(params.expiraEm);
  const quando = data === null ? '' : ` (${data})`;
  const dias = params.dias;
  if (typeof dias === 'number' && dias < 0) {
    return (
      `O prazo de 365 dias da autorização da Amazon da conta ${loja} já passou${quando}, e a ` +
      `Amazon pode recusá-la a qualquer momento. ${REAUTORIZE_AMAZON}`
    );
  }
  const prazo = dias === 0 ? 'vence hoje' : `vence em ${p(params, 'dias')} dia(s)`;
  return `A autorização da Amazon da conta ${loja} ${prazo}${quando}. ${REAUTORIZE_AMAZON}`;
}

/**
 * A frase do vencimento do segredo do aplicativo da Amazon. ⚠️ `dias` e
 * `expiraEm` AUSENTES (os dois) quer dizer que a data não está registrada OU
 * que o valor registrado não é uma data válida — o produtor não distingue os
 * dois casos e levanta o aviso mesmo assim, e a frase nomeia as duas causas e
 * diz que o prazo é desconhecido em vez de imprimir marcadores. `0` e negativo
 * têm frases próprias, como na autorização da conta.
 */
function corpoSegredoLwaExpirandoAmazon(params: Aviso['params']): string {
  if (params.dias === undefined && params.expiraEm === undefined) {
    return (
      'A data de vencimento do segredo do aplicativo da Amazon (client secret do LWA) não está ' +
      'registrada, ou o valor registrado não é uma data válida no formato AAAA-MM-DD, então o ' +
      'ERP não consegue avisar antes de ele vencer. Quando ele vence, a integração de todas as ' +
      'contas Amazon para.'
    );
  }
  const data = dataCivilBr(params.expiraEm);
  const quando = data === null ? '' : ` (${data})`;
  const dias = params.dias;
  if (typeof dias === 'number' && dias < 0) {
    return (
      `A data registrada para o vencimento do segredo do aplicativo da Amazon já passou${quando}. ` +
      'Se o segredo não foi trocado, a Amazon passa a recusá-lo e a integração de todas as ' +
      'contas Amazon para; se foi, falta registrar a nova data.'
    );
  }
  const prazo = dias === 0 ? 'vence hoje' : `vence em ${p(params, 'dias')} dia(s)`;
  return (
    `O segredo do aplicativo da Amazon (client secret do LWA) ${prazo}${quando}. ` +
    'Sem a troca, a integração de todas as contas Amazon para.'
  );
}

/**
 * pt-BR do motivo de uma importação de pedidos da Amazon parada — TOTAL sobre o
 * código (`params.motivo`, um {@link MOTIVO_IMPORTACAO_PARADA_AMAZON}). O produtor
 * (a varredura de pedidos de reserva, a cada 15 minutos) grava o CÓDIGO, nunca a
 * frase.
 */
const FRASE_MOTIVO_IMPORTACAO_PARADA_AMAZON: Record<MotivoImportacaoParadaAmazon, string> = {
  [MOTIVO_IMPORTACAO_PARADA_AMAZON.idDeContaInvalido]:
    'o id desta conta não é aceito pela varredura de pedidos',
  [MOTIVO_IMPORTACAO_PARADA_AMAZON.credencialAusente]:
    'a conta está conectada, mas não tem credencial salva — reconecte-a',
  [MOTIVO_IMPORTACAO_PARADA_AMAZON.credencialInvalida]:
    'a credencial salva da conta está ilegível — reconecte-a',
  [MOTIVO_IMPORTACAO_PARADA_AMAZON.vendedorDuplicado]:
    'mais de uma conta ativa do ERP está ligada ao mesmo vendedor da Amazon, e nenhuma delas é ' +
    'lida para não importar cada pedido duas vezes',
  [MOTIVO_IMPORTACAO_PARADA_AMAZON.vendedorInvalido]:
    'o vendedor da Amazon gravado nesta conta não é um identificador válido — reconecte-a',
  [MOTIVO_IMPORTACAO_PARADA_AMAZON.lookbackInvalido]:
    'o período inicial de busca de pedidos está configurado com um valor inválido',
  [MOTIVO_IMPORTACAO_PARADA_AMAZON.semPermissao]:
    'a Amazon negou acesso à lista de pedidos mesmo com um token renovado (falta permissão de ' +
    'pedidos ao aplicativo ou à autorização da conta)',
  [MOTIVO_IMPORTACAO_PARADA_AMAZON.limiteDeTaxa]:
    'a Amazon limitou seguidamente as requisições da lista de pedidos',
  [MOTIVO_IMPORTACAO_PARADA_AMAZON.requisicaoRecusada]:
    'a Amazon recusou a busca de pedidos que o ERP montou',
  [MOTIVO_IMPORTACAO_PARADA_AMAZON.falhaTransitoria]:
    'a Amazon falhou seguidamente (erro no servidor, rede ou tempo esgotado)',
  [MOTIVO_IMPORTACAO_PARADA_AMAZON.respostaInvalida]: 'a Amazon respondeu fora do formato esperado',
  [MOTIVO_IMPORTACAO_PARADA_AMAZON.filaIndisponivel]:
    'a fila de importação do ERP recusou os pedidos, como acontece numa implantação incompleta',
  [MOTIVO_IMPORTACAO_PARADA_AMAZON.orcamentoEsgotado]:
    'a varredura ficou sem tempo antes de ler todos os pedidos alterados',
};

/** A frase do motivo, ou um texto neutro — o mesmo contrato de {@link fraseMotivoImportacaoParada}. */
function fraseMotivoImportacaoParadaAmazon(valor: Aviso['params'][string] | undefined): string {
  const codigo = motivoImportacaoParadaAmazonSchema.safeParse(valor);
  return codigo.success
    ? FRASE_MOTIVO_IMPORTACAO_PARADA_AMAZON[codigo.data]
    : 'confira o registro da varredura de pedidos';
}

/**
 * pt-BR do porquê um pedido da Amazon precisa de atenção — TOTAL sobre o código
 * (`params.motivo`, um {@link MOTIVO_PEDIDO_AMAZON}). O produtor (a importação de
 * pedidos da Amazon) grava o CÓDIGO, nunca a frase. Cada frase diz o que
 * aconteceu, o que FAZER e quando o aviso se encerra — e nenhuma imprime outro
 * valor além do número do pedido, que o corpo já traz.
 *
 * ⚠️ "Se encerra na próxima atualização do pedido pela Amazon": quem fecha o
 * aviso é a importação seguinte desse pedido, não o conserto em si, então a
 * frase não promete que ele some na hora.
 */
const FRASE_MOTIVO_PEDIDO_AMAZON: Record<MotivoPedidoAmazon, string> = {
  [MOTIVO_PEDIDO_AMAZON.divergenciaItens]:
    'os itens ou os valores que a Amazon informa não batem com os do pedido no ERP (por exemplo, ' +
    'um item cancelado num pedido ainda a enviar), e o ERP não aplicou a mudança. Confira o ' +
    'pedido no Seller Central e ajuste os itens no ERP antes de enviar; o aviso se encerra na ' +
    'próxima atualização do pedido pela Amazon em que os itens baterem ou já tiverem sido ' +
    'editados no ERP',
  [MOTIVO_PEDIDO_AMAZON.logisticaDesconhecida]:
    'a Amazon não informou quem faz a entrega (o vendedor ou a própria Amazon), então o ERP não ' +
    'sabe se este pedido deve ser separado e enviado daqui. Confira no Seller Central quem ' +
    'atende o pedido antes de enviar; o aviso se encerra quando a Amazon informar, ou se o ' +
    'pedido for cancelado',
  // ⚠️ Dois produtores gravam este código: a importação (um pedido impresso que
  // ela marca como cancelado) e, mais tarde, os passos de NF-e e de etiqueta
  // (que recusam um pedido com pedido de cancelamento aberto, sem cancelá-lo).
  // Os params guardam só o código, então a frase vale para os dois.
  [MOTIVO_PEDIDO_AMAZON.aceitarCancelamento]:
    'o comprador pediu o cancelamento de um pedido que já foi impresso. Aceite o cancelamento ' +
    'no Seller Central — enquanto isso, a Amazon continua esperando o envio; o aviso se ' +
    'encerra quando a Amazon registrar o cancelamento ou o envio, ou quando não houver mais ' +
    'pedido de cancelamento aberto',
  [MOTIVO_PEDIDO_AMAZON.canceladoSoNoErp]:
    'o pedido está cancelado no ERP, mas a Amazon ainda espera o envio e não há pedido de ' +
    'cancelamento aberto (o cancelamento foi recusado no Seller Central, ou o pedido foi ' +
    'cancelado só no ERP). Reabra o pedido no ERP para enviá-lo, ou cancele-o no Seller ' +
    'Central; o aviso se encerra quando a Amazon registrar o cancelamento ou o envio, ou na ' +
    'próxima atualização do pedido pela Amazon depois de ele ser reaberto',
  [MOTIVO_PEDIDO_AMAZON.statusDesconhecido]:
    'a Amazon enviou uma situação de pedido que o ERP não conhece, e o estado do pedido não foi ' +
    'mudado por ela (um pedido novo fica marcado com um erro). Confira o pedido no Seller ' +
    'Central; o aviso se encerra quando a Amazon enviar uma situação conhecida',
  [MOTIVO_PEDIDO_AMAZON.cancelamentoSolicitado]:
    'o comprador pediu o cancelamento, e o pedido ainda não foi impresso. Decida no Seller ' +
    'Central se aceita o cancelamento antes de imprimir ou enviar o pedido; o aviso se encerra ' +
    'quando o pedido de cancelamento for aceito ou recusado, ou, se o pedido for impresso ' +
    'antes disso, passa a pedir que você aceite o cancelamento',
  [MOTIVO_PEDIDO_AMAZON.pacoteStatusDesconhecido]:
    'a Amazon enviou uma situação de pacote que o ERP não conhece, e o frete do pedido não foi ' +
    'atualizado por ela. Confira o envio no Seller Central; o aviso se encerra quando a Amazon ' +
    'enviar situações conhecidas para todos os pacotes',
  [MOTIVO_PEDIDO_AMAZON.coletaCancelada]:
    'a coleta de um pacote foi cancelada — a coleta, não o pedido. Reagende a coleta no Seller ' +
    'Central; o aviso se encerra quando nenhum pacote estiver com a coleta cancelada, ou se o ' +
    'pedido for cancelado',
};

/** A frase do motivo, ou um texto neutro — o mesmo contrato de {@link fraseMotivoImportacaoParada}. */
function fraseMotivoPedidoAmazon(valor: Aviso['params'][string] | undefined): string {
  const codigo = motivoPedidoAmazonSchema.safeParse(valor);
  return codigo.success
    ? FRASE_MOTIVO_PEDIDO_AMAZON[codigo.data]
    : 'confira o pedido no Seller Central';
}

/**
 * pt-BR do porquê uma conta da Amazon precisa de atenção — TOTAL sobre o código
 * (`params.motivo`, um {@link MOTIVO_CONTA_AMAZON}). Sem nenhum valor
 * interpolado: o link do aviso já abre a conta.
 */
const FRASE_MOTIVO_CONTA_AMAZON: Record<MotivoContaAmazon, string> = {
  [MOTIVO_CONTA_AMAZON.contaSemOperacao]:
    'ela não tem operação definida, então os pedidos dela entram no ERP sem operação. Defina a ' +
    'operação no cadastro da conta: os pedidos já importados a recebem na próxima atualização ' +
    'de cada um pela Amazon, e o aviso se encerra na próxima importação de pedido da conta',
  [MOTIVO_CONTA_AMAZON.intermediadorDivergente]:
    'o CNPJ do intermediador que a Amazon informa nos pedidos não confere com o CNPJ do ' +
    'intermediador cadastrado na conta, que é o que vai na NF-e. Corrija o CNPJ do intermediador ' +
    'no cadastro da conta; o aviso se encerra quando um pedido importado depois da correção ' +
    'trouxer um CNPJ que confere',
};

/** A frase do motivo, ou um texto neutro — o mesmo contrato de {@link fraseMotivoImportacaoParada}. */
function fraseMotivoContaAmazon(valor: Aviso['params'][string] | undefined): string {
  const codigo = motivoContaAmazonSchema.safeParse(valor);
  return codigo.success ? FRASE_MOTIVO_CONTA_AMAZON[codigo.data] : 'confira o cadastro da conta';
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
  // Os tipos da importação de pedidos da Loja Integrada (passos 5 e 6), até os da Amazon.
  // Todos `atencao` — cada um fala de UM pedido ou UMA forma de envio, e a entrada de
  // pedidos segue funcionando —, exceto `lojaIntegradaPedidoPagoSemEndereco`, `critico`.
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
  [TIPO_AVISO.lojaIntegradaReversaoComEtiqueta]: {
    titulo: 'Pedido da Loja Integrada revertido com etiqueta comprada',
    corpo: corpoReversaoComEtiquetaLi,
    // Os dois cancelamentos ficam fora desta tela: a etiqueta no Melhor Envio, a NF-e
    // no fluxo da NF-e.
    runbook:
      'Cancele a etiqueta no painel do Melhor Envio. Se a NF-e do pedido já foi emitida, ' +
      'cancele-a pelo ERP dentro do prazo de cancelamento da SEFAZ.',
  },
  // Crítico: uma venda PAGA sem endereço de entrega é uma venda que ninguém despacha. O
  // aviso só sobe quando as novas tentativas acabaram (a fila e a varredura), por isso a
  // frase diz que a importação tentou de novo ANTES de abri-lo — e não que parou: uma
  // importação posterior com um CEP inválido grava o pedido sem endereço e deixa o aviso
  // aberto, e a frase continua certa. Só um pedido SEM CEP nenhum (ausente, vazio, em
  // branco ou só o traço "-") é recusado: um CEP inválido, digitado pelo cliente, não se
  // conserta esperando, e esse pedido entra sem endereço — por isso a frase fala em CEP
  // "utilizável", nunca em CEP "válido".
  [TIPO_AVISO.lojaIntegradaPedidoPagoSemEndereco]: {
    titulo: 'Pedido pago da Loja Integrada sem endereço',
    corpo: (params) =>
      `O pedido ${p(params, 'pedido')} da loja ${p(params, 'loja')} está pago na Loja ` +
      'Integrada, mas chegou sem um CEP de entrega utilizável e por isso não pôde ser ' +
      'importado com o endereço de entrega: sem endereço não há como comprar a etiqueta. A ' +
      'importação tentou de novo por algumas horas antes de abrir este aviso. O aviso se ' +
      'encerra quando o pedido tiver o endereço de entrega, virar retirada na loja ou deixar ' +
      'de estar pago.',
    // O conserto está FORA do app: o endereço é preenchido no painel da Loja Integrada. Que
    // essa alteração traga o pedido de volta à importação é o ESPERADO, ainda não observado
    // (nenhuma captura mostra a edição do endereço mudando a data de modificação do pedido),
    // por isso a frase diz "deve" e dá a saída para quando não trouxer. A retirada precisa
    // estar ATIVA: uma inativa não dispensa o endereço. O aviso só se encerra quando o pedido
    // fica com o endereço de entrega (um que já guardava, nunca sobrescrito, ou um que a
    // importação gravou sob o cliente do pedido), vira retirada na loja ou deixa de estar
    // pago (decisão de 2026-10-20). Nada mais o encerra: um CEP que o montador de endereço
    // não lê, um CEP legível de um comprador sem documento válido (sem cliente, sem
    // endereço) e uma atualização sem envio deixam o aviso aberto — daí a conferência dos
    // 8 dígitos antes de chamar um desenvolvedor.
    runbook:
      'Preencha o endereço de entrega do pedido no painel da Loja Integrada; a alteração deve ' +
      'trazer o pedido de volta à importação. Se ele for de retirada na loja, mapeie antes a ' +
      'forma de envio dele para uma retirada na loja ativa na aba Mapeamento do Frete da conta ' +
      'e depois altere o pedido no painel. O aviso fica aberto até o pedido ter o endereço de ' +
      'entrega (o de retirada na loja não precisa dele) ou deixar de estar pago. Se o aviso ' +
      'continuar aberto depois da alteração, confira no painel se o CEP tem 8 dígitos; se ' +
      'tiver, peça a um desenvolvedor que confira a notificação estacionada desse pedido.',
  },
  // Sem `runbook` nos dois avisos por CONTA da Amazon: o conserto está no app —
  // uma nova autorização pelo painel de conexão da conta (o link do aviso).
  [TIPO_AVISO.amazonReconexaoPendente]: {
    titulo: 'Autorização da Amazon recusada',
    corpo: (params) => {
      // `p()` decide o que é "ausente" (sem a chave OU ''), então a cláusula e o
      // marcador nunca discordam: sem status, a cláusula inteira some.
      const status = p(params, 'status', '');
      return (
        `A Amazon recusou a autorização da conta ${p(params, 'loja')}` +
        `${status === '' ? '' : ` (HTTP ${status})`}. ` +
        `A integração desta conta fica parada até ela ser reautorizada. ${REAUTORIZE_AMAZON}`
      );
    },
  },
  [TIPO_AVISO.amazonReautorizacaoExpirando]: {
    titulo: 'Autorização da Amazon expirando',
    corpo: corpoReautorizacaoAmazon,
  },
  // Os dois avisos do APLICATIVO (um por canal, não por conta) têm `runbook`: o
  // conserto é uma implantação — o segredo vive no Secret Manager, fora do app.
  [TIPO_AVISO.amazonSegredoLwaExpirando]: {
    titulo: 'Segredo do aplicativo da Amazon expirando',
    corpo: corpoSegredoLwaExpirandoAmazon,
    // Dois ramos, e registrar vem ANTES de trocar: quando só falta a data (ou
    // ela está em outro formato), gerar um segredo novo seria o passo mais
    // arriscado do canal para um conserto que não precisa dele.
    runbook:
      'Se a data não está registrada, ou não está no formato AAAA-MM-DD, grave em ' +
      'AMAZON_LWA_SEGREDO_EXPIRA_EM a data de vencimento do segredo ATUAL, como AAAA-MM-DD — sem ' +
      'gerar outro segredo. Se o segredo está perto de vencer (ou já venceu), gere um novo client ' +
      'secret para o aplicativo no portal de desenvolvedor da Amazon e, na MESMA implantação, ' +
      'grave-o em AMAZON_LWA_CLIENT_SECRET (Secret Manager) de todos os backends da Amazon e ' +
      'registre a nova data de vencimento em AMAZON_LWA_SEGREDO_EXPIRA_EM (AAAA-MM-DD). O ' +
      'segredo antigo pode deixar de valer assim que o novo é gerado.',
  },
  [TIPO_AVISO.amazonSegredoLwaRecusado]: {
    titulo: 'Segredo do aplicativo da Amazon recusado',
    corpo: () =>
      'A Amazon recusou as credenciais do aplicativo (client secret do LWA). Nenhuma conta ' +
      'Amazon consegue renovar o acesso até isso ser corrigido — as contas não precisam ser ' +
      'reconectadas.',
    runbook:
      'Confira se AMAZON_LWA_CLIENT_ID (variável de ambiente do backend) e ' +
      'AMAZON_LWA_CLIENT_SECRET (Secret Manager) de todos os backends da Amazon são o par atual ' +
      'do aplicativo no portal de desenvolvedor da Amazon — um segredo vencido, ou trocado no ' +
      'portal sem atualizar o Secret Manager, dá exatamente isto. Corrija e reimplante; o aviso ' +
      'se encerra sozinho na próxima troca de token aceita.',
  },
  // Crítico: a varredura de reserva (a cada 15 minutos) é o caminho GARANTIDO de
  // entrada de pedidos da Amazon; as notificações podem seguir chegando, mas o que
  // elas perderem não entra. Uma conta PARADA, ou o segredo do aplicativo recusado,
  // nunca levantam este aviso — falam os avisos próprios deles.
  [TIPO_AVISO.amazonImportacaoParada]: {
    titulo: 'Importação de pedidos da Amazon parada',
    corpo: (params) =>
      `A varredura de pedidos da Amazon parou para a conta ${p(params, 'loja')}: ` +
      `${fraseMotivoImportacaoParadaAmazon(params.motivo)}. Pedidos cuja notificação da Amazon ` +
      'não chegar ficam fora do ERP enquanto isso não se resolver.',
    // A credencial e o vendedor gravado têm conserto no app (o painel da conta); o
    // vendedor duplicado, nos cadastros das contas; o resto é implantação ou registro
    // da varredura.
    runbook:
      'Se o motivo for a credencial ou o vendedor gravado na conta, reconecte a conta pelo painel ' +
      'de conexão da conta, no ERP. Se duas contas ativas estiverem ligadas ao mesmo vendedor, ' +
      'desative a que sobra. Se faltar permissão, confira os papéis do aplicativo no portal de ' +
      'desenvolvedor da Amazon e reautorize a conta. Nos demais casos, um desenvolvedor confere o ' +
      'registro da varredura de pedidos (o período inicial de busca é AMAZON_POLL_LOOKBACK_H, no ' +
      'ambiente das funções).',
  },
  // Os dois avisos da importação de pedidos da Amazon (passos 5 e 7). Sem
  // `runbook`: o que fazer muda com o motivo, então cada frase de motivo o diz —
  // no Seller Central ou no próprio ERP (o link abre o pedido ou a conta).
  [TIPO_AVISO.amazonPedidoPrecisaAtencao]: {
    titulo: 'Pedido da Amazon precisa de atenção',
    corpo: (params) =>
      `O pedido ${p(params, 'pedido')} da Amazon precisa de atenção: ` +
      `${fraseMotivoPedidoAmazon(params.motivo)}.`,
  },
  [TIPO_AVISO.amazonContaPrecisaAtencao]: {
    titulo: 'Conta da Amazon precisa de atenção',
    corpo: (params) =>
      `A conta da Amazon precisa de atenção: ${fraseMotivoContaAmazon(params.motivo)}.`,
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
