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
    titulo: 'Envio de NF-e rejeitado pelo canal',
    corpo: (params) =>
      `O canal recusou a NF-e do pedido ${p(params, 'pedido')}: ${p(params, 'erro')}. ` +
      'O pedido não pode ser despachado enquanto isso não for corrigido.',
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
