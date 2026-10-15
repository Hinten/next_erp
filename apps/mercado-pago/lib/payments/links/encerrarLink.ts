/**
 * The auto-close (#367): once a payment link has received every payment it
 * accepts, expire its Mercado Pago preference and mark the doc `concluido`.
 *
 * Mercado Pago has no "max uses" for a preference, so a per-person link would
 * otherwise stay payable after its one payment — and a payment on top of it
 * overpays the pedido, which blocks the NF-e (cStat 866: Mercado Pago money is
 * never tPag 01 dinheiro, so no troco is allowed).
 *
 * Called by the webhook task (`processNotificationPayload`) AFTER the pedido
 * reconcile, with the count `reconcilePedidoFromPagamento` returns
 * (`aprovadosDoLink`: payments EVER approved on the link — the same definition as
 * `linkAtingiuCota`). It runs in the NESTED Cloud Functions codebase, which
 * bundles `notificacao.ts`, so a change here needs a `functions:mercado-pago`
 * redeploy as well as App Hosting.
 *
 * ## Failure policy — which errors retry
 *
 *  - A network failure, a 5xx, a 429 or a dead grant (reauth) THROWS. The task
 *    retries; the reconcile then stale-skips the payment but still returns
 *    `aprovadosDoLink`, so the close is retried too. Marking the link `concluido`
 *    on such an error would leave a payable preference behind a "closed" doc.
 *  - Any OTHER 4xx (403 / 404, or a 400 that survives `expirarPreferencia`'s one
 *    retry without `date_of_expiration`) is Mercado Pago's DEFINITIVE answer that
 *    this application cannot alter the preference — retrying cannot help. The
 *    link is marked `concluido` with `erroEncerramento` so the operator sees why
 *    and closes it in the panel.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { linkPgtoMercadoPagoCollection } from '@delfrance/data/admin/collections';
import { MercadoPagoHttpError } from '@delfrance/integrations-mercado-pago';
import { STATUS_LINK_PAGAMENTO, linkAtingiuCotaComAprovados } from '@delfrance/schemas';

import { loadMercadoPagoContext } from '../mercadoPago';
import { type FabricaApi, fabricaApiPadrao } from './api';
import { expirarPreferencia } from './expirar';
import { lerLink } from './leitura';
import { marcarLinkTerminal, type ResultadoTerminal } from './linkStore';

/**
 *  - `encerrado`   — the preference was expired and the doc marked `concluido`;
 *  - `aberto`      — the quota is not met yet: nothing done;
 *  - `ja-terminal` — nothing to close: a legacy link, or one already
 *    `concluido` / `cancelado` (a redelivery, or a cancel that won the race);
 *  - `inexistente` — the link doc is gone;
 *  - `erro-mp`     — Mercado Pago definitively refused the expiry; the doc was
 *    marked `concluido` with `erroEncerramento`.
 */
export type ResultadoEncerramento =
  | 'encerrado'
  | 'aberto'
  | 'ja-terminal'
  | 'inexistente'
  | 'erro-mp';

/** Test seam: the Mercado Pago client, built from the account's live token. */
export interface EncerrarLinkDeps {
  api?: FabricaApi;
}

const DO_TERMINAL: Record<ResultadoTerminal, ResultadoEncerramento> = {
  marcado: 'encerrado',
  'ja-terminal': 'ja-terminal',
  inexistente: 'inexistente',
};

/** A 4xx that a retry cannot change (429 is the exception: it is rate limiting). */
function recusaDefinitiva(err: unknown): err is MercadoPagoHttpError {
  return (
    err instanceof MercadoPagoHttpError &&
    err.status >= 400 &&
    err.status < 500 &&
    err.status !== 429
  );
}

export async function encerrarLinkSeCompleto(
  db: Firestore,
  i: { metodoId: string; pedidoId: string; linkId: string; aprovados: number; agoraMs: number },
  deps: EncerrarLinkDeps = {},
): Promise<ResultadoEncerramento> {
  const snap = await linkPgtoMercadoPagoCollection
    .docRef(db, { pedidoId: i.pedidoId }, i.linkId)
    .get();
  if (!snap.exists) return 'inexistente';
  const link = lerLink(snap.data());

  // A legacy link was created under the legacy application and has no quota: it
  // is not ours to close. A terminal one is already done.
  if (link.modo === null || link.status !== STATUS_LINK_PAGAMENTO.aberto) return 'ja-terminal';

  // THE shared quota rule, in its count form (`linkAtingiuCotaComAprovados`, the
  // one `linkAtingiuCota` delegates to) — never a re-written copy of it. A
  // traceable link with no stored quota accepts ONE payment, as the summary reads
  // it; a count that is not a number (NaN) leaves the link OPEN.
  if (!linkAtingiuCotaComAprovados(link, i.aprovados)) return 'aberto';

  const terminal = {
    pedidoId: i.pedidoId,
    linkId: i.linkId,
    status: STATUS_LINK_PAGAMENTO.concluido,
    encerradoEm: i.agoraMs,
    // Auto-closed: no operator did it.
    encerradoPorOuterRef: null,
  };

  // Nothing to expire on Mercado Pago's side; still close the doc, and say why.
  if (link.preferenceId === null) {
    const semPreferencia = await marcarLinkTerminal(db, {
      ...terminal,
      erroEncerramento: 'sem preferência',
    });
    return DO_TERMINAL[semPreferencia];
  }

  // The account is the one the webhook resolved for this payment.
  const ctx = await loadMercadoPagoContext(db, i.metodoId);
  const token = await ctx.resolveAccessToken();
  const api = (deps.api ?? fabricaApiPadrao)(token);
  try {
    // A 400 on the full patch is retried once without `date_of_expiration`
    // (`expirarPreferencia`); the policy below judges the FINAL answer.
    await expirarPreferencia(api, link.preferenceId, i.agoraMs);
  } catch (err) {
    if (!recusaDefinitiva(err)) throw err;
    console.warn('[mercado-pago] auto-close refused by Mercado Pago — marking the link closed', {
      pedidoId: i.pedidoId,
      linkId: i.linkId,
      status: err.status,
    });
    const marcado = await marcarLinkTerminal(db, {
      ...terminal,
      erroEncerramento: `MP ${err.status}`,
    });
    // Only report the refusal if THIS call is the one that recorded it.
    return marcado === 'marcado' ? 'erro-mp' : DO_TERMINAL[marcado];
  }

  const encerrado = await marcarLinkTerminal(db, { ...terminal, erroEncerramento: null });
  return DO_TERMINAL[encerrado];
}
