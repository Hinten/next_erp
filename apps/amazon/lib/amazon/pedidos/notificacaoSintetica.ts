/**
 * The poll's SYNTHETIC notification (master plan step 4, PR 4-a): one listed
 * row → one `origem: 'poll'` task payload on step 3's reads queue, exactly the
 * variant `tarefaAmazonSchema` declares (`packages/schemas/src/notificacaoAmazon.ts`).
 *
 * Ids only, built field by field (step-3 plan §3 decision 29): the conta the
 * poll listed, its seller, the order and the row's `lastUpdatedTime` in µs. The
 * importer (step 5) re-fetches the order; the µs stamp only NAMES the failure
 * document (`poll:<conta>:<order>:<µs>`), so a later change of the same order
 * is a new row, and a re-poll of the same change collides instead of forking.
 *
 * The payload is checked against the REAL task schema before it leaves: the
 * dispatched task drops a payload its schema refuses, without a trace.
 */
import {
  ORIGEM_NOTIFICACAO_AMAZON,
  TIPO_TAREFA_AMAZON,
  tarefaAmazonSchema,
} from '@delfrance/schemas';

import type { PayloadNotificacaoAmazon } from '../notificacoes/notificacao';
import type { LinhaPollAmazon } from './janelaPoll';

/** The poll variant of the task payload. */
export type PayloadDoPollAmazon = Extract<PayloadNotificacaoAmazon, { readonly origem: 'poll' }>;

/** The conta a row was listed for: its id and the seller its credential belongs to. */
export interface ContaDoPoll {
  readonly integracaoId: string;
  readonly sellingPartnerId: string;
}

/**
 * The `origem: 'poll'` payload of one row.
 *
 * @throws {TypeError} for a payload the task schema refuses — reachable only
 *   through a conta id or a seller id outside their grammars, which the poll
 *   refuses before any row exists.
 */
export function notificacaoDoPoll(conta: ContaDoPoll, linha: LinhaPollAmazon): PayloadDoPollAmazon {
  const payload: PayloadDoPollAmazon = {
    tipo: TIPO_TAREFA_AMAZON.pedido,
    origem: ORIGEM_NOTIFICACAO_AMAZON.poll,
    sellerId: conta.sellingPartnerId,
    amazonOrderId: linha.orderId,
    contaId: conta.integracaoId,
    lastUpdatedUs: linha.lastUpdatedUs,
  };
  if (!tarefaAmazonSchema.safeParse(payload).success) {
    throw new TypeError('notificacaoDoPoll: o payload não passou pelo schema da tarefa');
  }
  return payload;
}
