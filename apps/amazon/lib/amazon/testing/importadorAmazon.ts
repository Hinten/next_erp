/**
 * The order-import harness of the step-5 suites (PR 5-d) — **for tests only**:
 * nothing outside a `*.test.ts` imports this (`estrutura.test.ts`).
 *
 * One `FakeDb` holding an active, connected conta and a fresh credential (no LWA
 * exchange is due), the REAL context loader over it, and a scripted `fetch`:
 * every SP-API GET is answered from {@link HarnessImportador.respostas} (the
 * last one repeats), every LWA POST with a fresh token, and both are counted.
 * Nothing reaches a network (D11): the suites also stub the global `fetch` to
 * refuse.
 *
 * ⚠️ PLACEHOLDERS ONLY (the repository is public): the conta id, the seller id
 * and the order ids are synthetic.
 */
import type { PedidoWireAmazon } from '@delfrance/integrations-amazon-sp-api';
import { ORIGEM_NOTIFICACAO_AMAZON, TIPO_TAREFA_AMAZON } from '@delfrance/schemas';

import { loadAmazonContext, type ContextoAmazon } from '../core/contexto';
import { FLUXO_LEITURA_AMAZON, type PayloadNotificacaoAmazon } from '../notificacoes/notificacao';
import { FakeDb, asDb } from './fakeDb';
import {
  AGORA_MS,
  AMBIENTE_LIGADO,
  SPID_A,
  loggerEspiao,
  respostaJson,
  seedConta,
  seedCredencial,
  tokenDeAcesso,
} from './fixtures';
import { ORDER_ID_TESTE } from './pedidoWireAmazon';

/** The conta every importer suite seeds. */
export const CONTA_IMPORTADOR = 'conta-amz-importador';

/** One scripted SP-API answer. */
export interface RespostaSpApiTeste {
  readonly status: number;
  readonly corpo: unknown;
}

/** The getOrder 200 body for one parsed order. */
export function respostaDoPedido(order: PedidoWireAmazon | Record<string, unknown>) {
  return { status: 200, corpo: { order } } satisfies RespostaSpApiTeste;
}

/** A push task payload for `orderId`. */
export function payloadPush(orderId = ORDER_ID_TESTE): PayloadNotificacaoAmazon {
  return {
    tipo: TIPO_TAREFA_AMAZON.pedido,
    origem: ORIGEM_NOTIFICACAO_AMAZON.push,
    sellerId: SPID_A,
    amazonOrderId: orderId,
    notificationId: 'notif-teste-1',
    publishTimeMs: AGORA_MS - 1000,
  };
}

/** A poll task payload for `orderId`, carrying the search's µs stamp. */
export function payloadPoll(
  lastUpdatedUs: number,
  orderId = ORDER_ID_TESTE,
): PayloadNotificacaoAmazon {
  return {
    tipo: TIPO_TAREFA_AMAZON.pedido,
    origem: ORIGEM_NOTIFICACAO_AMAZON.poll,
    sellerId: SPID_A,
    amazonOrderId: orderId,
    contaId: CONTA_IMPORTADOR,
    lastUpdatedUs,
  };
}

/** A queue attempt's registro (`tentativa` 0), or a sweep's (`null`). */
export function registroTeste(tentativa: number | null = 0) {
  return tentativa === null
    ? { fluxo: FLUXO_LEITURA_AMAZON.reprocesso, tentativa: null, idTarefa: null }
    : { fluxo: FLUXO_LEITURA_AMAZON.intake, tentativa, idTarefa: 'tarefa-teste-1' };
}

export interface HarnessImportador {
  readonly db: FakeDb;
  readonly log: ReturnType<typeof loggerEspiao>;
  /** The SP-API answers, in order; the LAST one repeats. */
  respostas: RespostaSpApiTeste[];
  /** Every SP-API GET's URL, in order. */
  readonly gets: URL[];
  /** LWA exchanges made. */
  lwa: number;
  readonly fetch: typeof globalThis.fetch;
  /** The REAL context over the fake (the switch on, as an object literal). */
  contexto(): Promise<ContextoAmazon>;
}

export function harnessImportador(respostas: RespostaSpApiTeste[] = []): HarnessImportador {
  const db = new FakeDb();
  seedConta(db, CONTA_IMPORTADOR, { nome: 'Conta Teste', selling_partner_id: SPID_A });
  seedCredencial(db, CONTA_IMPORTADOR);
  const log = loggerEspiao();
  const h: HarnessImportador = {
    db,
    log,
    respostas,
    gets: [],
    lwa: 0,
    fetch: (input, init) => {
      const url = new URL(String(input));
      if ((init?.method ?? 'GET') === 'POST') {
        h.lwa += 1;
        return Promise.resolve(tokenDeAcesso());
      }
      h.gets.push(url);
      const r = h.respostas.length > 1 ? h.respostas.shift() : h.respostas[0];
      if (r === undefined)
        return Promise.reject(new Error('harness: nenhuma resposta roteirizada'));
      return Promise.resolve(respostaJson(r.status, r.corpo));
    },
    contexto: () =>
      loadAmazonContext(asDb(db), CONTA_IMPORTADOR, {
        ambiente: AMBIENTE_LIGADO,
        agora: () => AGORA_MS,
        logger: log.logger,
        fetch: h.fetch,
        gerarCorrelationId: () => 'corr-teste',
      }),
  };
  return h;
}
