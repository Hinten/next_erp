/**
 * `sincronizar` — the orchestration behind `POST …/links/sincronizar` (#367):
 * PULL a pedido's payments from Mercado Pago and run each one through the SAME
 * pipeline the webhook uses, so the ERP catches up on a notification it never
 * received (a dropped delivery, a redelivery lost past the sweep window, a legacy
 * link whose `notification_url` still points at the retired host).
 *
 * Nothing here reconciles anything itself. Each payment goes through
 * `processNotificationPayload`, which already: resolves the owning account, drops
 * a sandbox payment, RE-FETCHES the payment (the search result is never
 * trusted), applies the collector safety net, requires `external_reference`, maps
 * it (`mpPaymentToPagamento`), runs the update-if-newer reconcile and auto-closes
 * the link once its quota is paid. Progress is idempotent — a payment already
 * applied is a stale-skip — so an interrupted sync is safe to run again.
 *
 * ## Which accounts
 * The `metodo_pgto` ids come from the pedido's link docs
 * (`contaMercadoPagoOuterRef`, legacy links included) AND its pagamentos
 * (`metodoPagamentoOuterRef`), so a payment whose link doc is missing is still
 * found. An id that is not a configured Mercado Pago account (a cash / card
 * machine method recorded by hand) is skipped, not an error.
 *
 * ## Never guess the account
 * An account without a collector `user_id` is searched but NOT processed: the
 * pipeline would resolve a `null` collector through the "single connected
 * account" fallback, which can pick a DIFFERENT account than the one whose token
 * fetched the payment. Every payment it finds is reported as a failure instead.
 *
 * ## One dead grant does not sink the others
 * An account whose grant is dead (`MercadoPagoReauthRequiredError` — from the
 * token refresh or a 401 on the search) is reported as ONE failure
 * (`paymentId: '-'`, {@link MOTIVO_CONTA_DESCONECTADA}) and the sync moves on to
 * the next account. Only when NO account could be synchronised at all — each one
 * skipped as disconnected, not a Mercado Pago account, or without a `user_id` —
 * and at least one was disconnected, is the FIRST reauth error rethrown, so the
 * route answers 409 `MP_REAUTH_REQUIRED` (reconnect) rather than an empty 200.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  linkPgtoMercadoPagoCollection,
  pagamentoCollection,
  pedidoCollection,
} from '@delfrance/data/admin/collections';
import {
  MercadoPagoHttpError,
  MercadoPagoReauthRequiredError,
  type MercadoPagoApi,
  mpCauseCodes,
} from '@delfrance/integrations-mercado-pago';
import {
  MOTIVO_RECUSA_LINK,
  estadoPedidoSchema,
  type EstadoPedido,
  type SincronizarLinksPagamentoResposta,
} from '@delfrance/schemas';

import {
  MercadoPagoContaNotConfiguredError,
  loadMercadoPagoContext,
  type MercadoPagoContext,
} from '../mercadoPago';
import { PAYMENT_TOPIC, processNotificationPayload } from '../notificacao';
import { type FabricaApi, fabricaApiPadrao } from './api';
import { comoRegistro, metodoIdDoRef, userIdDaConta } from './leitura';
import {
  pedidoNaoEncontrado,
  recusaLink,
  requisicaoRepetida,
  respostaOk,
  type RespostaLink,
} from './respostas';

/** Payments requested per page of the search. */
const LIMITE_POR_PAGINA = 30;

/** Pages read per account before giving up — `truncado` tells the caller more may exist. */
const PAGINAS_MAX = 10;

/** Why a payment found on an account with no collector id is not processed. */
const MOTIVO_CONTA_SEM_USUARIO = 'conta sem usuário';

/** Why a payment reconciled under a DIFFERENT account than the one being synchronised. */
const MOTIVO_CONTA_DIVERGENTE = 'conta divergente';

/** Why a whole account was skipped: its grant is dead, it must reconnect. */
const MOTIVO_CONTA_DESCONECTADA = 'conta Mercado Pago desconectada';

/** The `paymentId` of a failure that belongs to an ACCOUNT, not to one payment. */
const SEM_PAGAMENTO = '-';

/** Test seams: the pipeline entry point and the Mercado Pago client. */
export interface SincronizarPedidoDeps {
  process?: typeof processNotificationPayload;
  api?: FabricaApi;
}

/** One search hit, reduced to what the sync needs. */
interface AchadoDaBusca {
  id: number;
  externalReference: string | null;
}

/**
 * Every payment Mercado Pago holds for `pedidoId`, newest first, up to
 * {@link PAGINAS_MAX} pages of {@link LIMITE_POR_PAGINA}. `truncado` is `true`
 * only when the cap was reached with more still to read.
 */
async function buscarPagamentos(
  api: MercadoPagoApi,
  pedidoId: string,
): Promise<{ achados: AchadoDaBusca[]; truncado: boolean }> {
  const achados: AchadoDaBusca[] = [];
  for (let pagina = 0; pagina < PAGINAS_MAX; pagina += 1) {
    const offset = pagina * LIMITE_POR_PAGINA;
    const busca = await api.searchPayments({
      externalReference: pedidoId,
      offset,
      limit: LIMITE_POR_PAGINA,
    });
    const resultados = busca.results ?? [];
    for (const resultado of resultados) {
      achados.push({ id: resultado.id, externalReference: resultado.external_reference ?? null });
    }
    // The last page is short, or the reported total is already covered.
    if (resultados.length < LIMITE_POR_PAGINA) return { achados, truncado: false };
    const total = busca.paging?.total ?? null;
    if (total !== null && offset + LIMITE_POR_PAGINA >= total) return { achados, truncado: false };
  }
  return { achados, truncado: true };
}

/** The distinct `metodo_pgto` ids the pedido's links and pagamentos name, first-seen first. */
function metodosDoPedido(
  links: ReadonlyArray<unknown>,
  pagamentos: ReadonlyArray<unknown>,
): string[] {
  const ids = new Set<string>();
  for (const link of links) {
    const id = metodoIdDoRef(comoRegistro(link).contaMercadoPagoOuterRef);
    if (id !== null) ids.add(id);
  }
  for (const pagamento of pagamentos) {
    const id = metodoIdDoRef(comoRegistro(pagamento).metodoPagamentoOuterRef);
    if (id !== null) ids.add(id);
  }
  return [...ids];
}

/**
 * The account's context, or `null` when `metodoId` is not a configured Mercado
 * Pago account (missing, or another tipo) — a pedido's pagamentos may point at
 * accounts that have nothing to synchronise.
 */
async function contextoDaConta(
  db: Firestore,
  metodoId: string,
): Promise<MercadoPagoContext | null> {
  try {
    return await loadMercadoPagoContext(db, metodoId);
  } catch (err) {
    if (err instanceof MercadoPagoContaNotConfiguredError) return null;
    throw err;
  }
}

export async function sincronizarPedido(
  db: Firestore,
  // `agoraMs` is part of the shared orchestration signature; the search window is
  // relative to Mercado Pago's own clock (`NOW-360DAYS … NOW`), so it is unused.
  i: { pedidoId: string; agoraMs: number },
  deps: SincronizarPedidoDeps = {},
): Promise<RespostaLink<SincronizarLinksPagamentoResposta>> {
  const { pedidoId } = i;
  const processar = deps.process ?? processNotificationPayload;
  const fabricaApi = deps.api ?? fabricaApiPadrao;

  const pedidoSnap = await pedidoCollection.docRef(db, {}, pedidoId).get();
  if (!pedidoSnap.exists) return pedidoNaoEncontrado();

  const [linksSnap, pagamentosSnap] = await Promise.all([
    linkPgtoMercadoPagoCollection.ref(db, { pedidoId }).get(),
    pagamentoCollection.ref(db, { pedidoId }).get(),
  ]);
  const metodoIds = metodosDoPedido(
    linksSnap.docs.map((doc) => doc.data()),
    pagamentosSnap.docs.map((doc) => doc.data()),
  );
  if (metodoIds.length === 0) return recusaLink(MOTIVO_RECUSA_LINK.semConta);

  let encontrados = 0;
  let reconciliados = 0;
  let ignorados = 0;
  let truncado = false;
  let contasSincronizadas = 0;
  // Accounts whose payments could actually be PROCESSED: searched, with a user_id.
  let contasProcessaveis = 0;
  // The first dead grant met — rethrown only if no account could be synchronised.
  let primeiraReautenticacao: MercadoPagoReauthRequiredError | null = null;
  const falhas: SincronizarLinksPagamentoResposta['falhas'] = [];
  const transicoes = new Set<EstadoPedido>();
  // Payment ids are global at Mercado Pago: one seen under two accounts (or
  // twice in the paging, when a payment lands mid-search) is processed once.
  const vistos = new Set<number>();

  try {
    for (const metodoId of metodoIds) {
      const ctx = await contextoDaConta(db, metodoId);
      if (ctx === null) continue;

      const userId = userIdDaConta(ctx.conta);
      let busca: { achados: AchadoDaBusca[]; truncado: boolean };
      try {
        const api = fabricaApi(await ctx.resolveAccessToken());
        busca = await buscarPagamentos(api, pedidoId);
      } catch (err) {
        // A dead grant on THIS account (the refresh, or a 401 on the search) is
        // this account's failure, not the whole sync's: record it and move on.
        if (!(err instanceof MercadoPagoReauthRequiredError)) throw err;
        primeiraReautenticacao ??= err;
        const motivo = `${MOTIVO_CONTA_DESCONECTADA}: ${metodoId}`;
        falhas.push({ paymentId: SEM_PAGAMENTO, motivo });
        continue;
      }
      contasSincronizadas += 1;
      if (userId !== null) contasProcessaveis += 1;
      if (busca.truncado) truncado = true;

      for (const achado of busca.achados) {
        // The search filters by `external_reference`; a hit that disagrees is not
        // this pedido's, whatever the filter meant to do.
        if (achado.externalReference !== pedidoId || vistos.has(achado.id)) continue;
        vistos.add(achado.id);
        encontrados += 1;
        const paymentId = String(achado.id);

        if (userId === null) {
          falhas.push({ paymentId, motivo: MOTIVO_CONTA_SEM_USUARIO });
          continue;
        }

        // A transient failure (Firestore, network, 5xx) THROWS out of here: the
        // route maps it, and a re-run resumes where this one stopped.
        const resultado = await processar(db, {
          id: null,
          paymentId,
          topic: PAYMENT_TOPIC,
          collectorUserId: userId,
          liveMode: null,
          dateCreated: null,
        });

        switch (resultado.kind) {
          case 'reconciled': {
            if (resultado.metodoId !== metodoId) {
              falhas.push({ paymentId, motivo: MOTIVO_CONTA_DIVERGENTE });
            } else if (resultado.detail === 'stale-ignorado') {
              ignorados += 1;
            } else {
              reconciliados += 1;
              // `detail` is an estado when the pedido moved, else 'sem-transicao'.
              const estado = estadoPedidoSchema.safeParse(resultado.detail);
              if (estado.success) transicoes.add(estado.data);
            }
            break;
          }
          case 'dropped':
            ignorados += 1;
            break;
          case 'failed':
            falhas.push({ paymentId, motivo: resultado.reason });
            break;
        }
      }
    }
  } catch (err) {
    // Mercado Pago refuses an identical request made within a minute (error
    // 2001): a double click, not a fault. Everything else is the mapper's.
    if (err instanceof MercadoPagoHttpError && mpCauseCodes(err).includes('2001')) {
      return requisicaoRepetida();
    }
    throw err;
  }

  // Nothing could be synchronised and at least one account needs reconnecting:
  // that is the answer (409 MP_REAUTH_REQUIRED), not an empty 200.
  if (contasProcessaveis === 0 && primeiraReautenticacao !== null) throw primeiraReautenticacao;
  if (contasSincronizadas === 0) return recusaLink(MOTIVO_RECUSA_LINK.semConta);
  return respostaOk({
    encontrados,
    reconciliados,
    ignorados,
    falhas,
    transicoes: [...transicoes],
    truncado,
  });
}
