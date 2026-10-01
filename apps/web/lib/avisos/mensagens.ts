import { TIPO_AVISO, type Aviso, type TipoAviso } from '@delfrance/schemas';

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
    corpo: (params) =>
      `O anúncio ${p(params, 'anuncio')} está com violação (${p(params, 'violacao')}).` +
      (params.prazo === undefined ? '' : ` Prazo para corrigir: ${p(params, 'prazo')}.`),
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
