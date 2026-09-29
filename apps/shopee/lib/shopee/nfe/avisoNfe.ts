/**
 * The producer of the `nfeUploadRejeitado` aviso for Shopee (#1522, step 14),
 * and the machine resolvers that tipo owes (`packages/schemas/src/aviso.ts`,
 * the tipo docblock: every member names its resolver before it ships).
 *
 * ONE condition class, ONE row per PEDIDO: the NF-e of a Shopee pedido did not
 * reach the channel, or reached it and was refused, for a reason in
 * {@link MOTIVOS_QUE_AVISAM}. That set, in `errosNfe.ts`, is the ONLY source of
 * whether an outcome raises this aviso — this module refuses any other motivo
 * rather than deciding for itself.
 *
 * ## ⚠️ One chave per pedido, never per NF-e
 *
 * `entidade` is the pedidoId. A pedido can carry several NF-e documents over
 * its life (one per emission slot, and a replacement after a cancellation), and
 * keying on the NF-e id would leave the row a cancelled note raised standing
 * after its replacement landed — the resolver would compute the NEW note's key,
 * a key that was never created. One row per pedido means the replacement's
 * validation closes the row the first note opened, and a second refusal on the
 * same pedido refreshes it (`ocorrencias` + 1, the newer `motivo` and `erro`)
 * instead of minting a second one.
 *
 * No `janela` either, for the reason `avisos/autorizacao.ts` gives: a windowed
 * key is a key the resolver cannot recompute.
 *
 * ## ⚠️ `params` are exactly `pedido` and `erro`
 *
 * `apps/web/lib/avisos/mensagens.ts` renders this tipo from those two params
 * and nothing else, so any other param would be a field that drifts silently.
 * `pedido` is the display number (the order number on this channel, which the
 * operator recognises); `erro` is {@link fraseDoErroDoAviso}'s fragment — the
 * motivo's remedy-first sentence, plus a SANITIZED Shopee excerpt only for the
 * members of `MOTIVOS_COM_EXCERTO`. Shopee's numeric code never rides here; it
 * goes to the handler's log line. The kebab motivo itself is stored in
 * `aviso.motivo`, beside the tipo, because one event class has many remedies.
 *
 * ## ⚠️ No event clock, no deadline
 *
 * The plano's event-clock field is never supplied (the suite pins its absence
 * as raw text). `escreverAviso` drops a delivery whose clock merely EQUALS the
 * stored one (`<=`), and every NF-e task starts from a fresh read of Shopee
 * rather than from a provider delivery, so there is no provider clock to order
 * it by — supplying one would freeze `ocorrencias` and silently drop a genuine
 * repeat. `prazo` is omitted too: the order's own shipping deadline is not
 * something the recheck phase re-reads, and an absent optional means "I do not
 * know" rather than a promise.
 *
 * ## Units
 *
 * This module converts nothing. "Now" crosses into the aviso's microseconds
 * through the seam in `avisos/autorizacao.ts` ({@link agoraUsDe} /
 * {@link depsDeEscrita}); every signature here takes MILLISECONDS as a
 * parameter, and nothing in this folder reads a clock.
 *
 * ## The resolvers
 *
 * - {@link resolverAvisoNfeShopee} — step 14's own: Shopee holds OUR note and
 *   reads it valid (`nfe-validada`), or the order is cancelled at a task's
 *   pre-read (`pedido-cancelado`).
 * - {@link resolverAvisoNfeSeEncerrado} — the CROSS-STEP hook, called by BOTH
 *   callers of the step-7 frete transaction (the order import and the package
 *   push), after it returns, on every outcome: a frete estado in
 *   `ESTADOS_FRETE_REMOVE_ESTOQUE` that the channel's own package diary
 *   confirms means the parcel moved, which on this channel requires a shipment
 *   Shopee only allows with a valid invoice (`frete-despachado`); an order
 *   status of cancelled ends the problem too (`pedido-cancelado`). Without the
 *   second arm an aviso on a cancelled order would stand forever: a stamped
 *   frete never becomes `cancelado`, because step 7 preserves `error` against
 *   routine churn.
 *
 * ⚠️ This module imports NOTHING from `pedidos/`: `pedidos/` imports it (the
 * hook), and the dependency must stay one-way. The order status therefore
 * arrives as a plain string, and the one status token this module compares
 * against is pinned by the suite against the importer's own status table.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { type ResultadoAviso, escreverAviso, resolverAviso } from '@delfrance/data/admin/avisos';
import {
  CANAL_AVISO,
  ESTADOS_FRETE_REMOVE_ESTOQUE,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  chaveDeAviso,
  type EstadoFrete,
} from '@delfrance/schemas';

import { type AvisoDeps, agoraUsDe, depsDeEscrita } from '../avisos/autorizacao';
import {
  MOTIVO_NFE_SHOPEE,
  MOTIVOS_QUE_AVISAM,
  fraseDoErroDoAviso,
  type MotivoNfeShopee,
} from './errosNfe';

/* -------------------------------------------------------------------------- */
/*                                  the chave                                  */
/* -------------------------------------------------------------------------- */

/**
 * The dedup identity — and the Firestore document id — of the NF-e aviso:
 * `(tipo, integração, pedido)`, no NF-e id and no window (module docblock).
 *
 * ⚠️ Exported so the producer and every resolver derive the SAME key; a
 * resolver that computes its own is how a row ends up standing forever.
 * {@link avisarNfeShopee} does not pass it: `escreverAviso` derives the id from
 * the same three inputs through the same `chaveDeAviso`.
 */
export function chaveAvisoNfeShopee(integracaoId: string, pedidoId: string): string {
  return chaveDeAviso({
    tipo: TIPO_AVISO.nfeUploadRejeitado,
    conta: integracaoId,
    entidade: pedidoId,
  });
}

/* -------------------------------------------------------------------------- */
/*                                the producer                                 */
/* -------------------------------------------------------------------------- */

/** What the handler knows when an outcome raises the aviso. */
export interface EventoAvisoNfeShopee {
  /** The integração document id — the dedup conta. */
  readonly integracaoId: string;
  /** The pedido document id — the dedup entidade AND the route's parameter. */
  readonly pedidoId: string;
  /** The pedido's DISPLAY number, rendered as `params.pedido`. */
  readonly numero: string;
  /** Our kebab motivo; must be a member of {@link MOTIVOS_QUE_AVISAM}. */
  readonly motivo: MotivoNfeShopee;
  /**
   * Shopee's text for the two motivos whose meaning is not ours to know in
   * advance, or `null`. Dropped for every other motivo, and re-sanitized by
   * {@link fraseDoErroDoAviso} whatever the caller already did.
   */
  readonly excerto: string | null;
}

/**
 * Raise (or refresh) "the NF-e of this pedido did not get through to Shopee".
 *
 * `severidade: atencao` — the pedido cannot ship until someone acts, but
 * nothing is down; `critico` is the one tier that escalates out of the app,
 * and it must stay rare enough that nobody learns to ignore it. `canal:
 * shopee`, and the link is the PEDIDO's edit route (through the builder,
 * never a literal: the route freezes at write time and `rotas.test.ts` in
 * `apps/web` walks the builders).
 *
 * ⚠️ `prazo` and the event clock are OMITTED, not nulled — an absent optional
 * is "I do not know", while a `null` would RESET a stored value (module
 * docblock).
 *
 * @throws RangeError when handed a motivo outside {@link MOTIVOS_QUE_AVISAM}.
 * The set is the only source of whether an outcome surfaces, so a caller that
 * reaches here with any other motivo is a bug, and a loud one beats a row the
 * operator should never have seen. Nothing is written in that case.
 */
export async function avisarNfeShopee(
  db: Firestore,
  ev: EventoAvisoNfeShopee,
  deps: AvisoDeps,
): Promise<ResultadoAviso> {
  if (!MOTIVOS_QUE_AVISAM.has(ev.motivo)) {
    throw new RangeError(
      `avisarNfeShopee: o motivo ${ev.motivo} não gera aviso — só os membros de ` +
        'MOTIVOS_QUE_AVISAM (errosNfe.ts) viram aviso; o restante é log.',
    );
  }

  const { resultado } = await escreverAviso(
    db,
    {
      tipo: TIPO_AVISO.nfeUploadRejeitado,
      conta: ev.integracaoId,
      entidade: ev.pedidoId,
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.shopee,
      // Structured params, never a rendered sentence, and exactly these two:
      // the pt-BR wording around them lives in `apps/web/lib/avisos/mensagens.ts`.
      params: {
        pedido: ev.numero,
        erro: fraseDoErroDoAviso(ev.motivo, ev.excerto),
      },
      motivo: ev.motivo,
      urlInterna: { rota: ROTAS_AVISO.pedido.build(ev.pedidoId), campo: null },
    },
    depsDeEscrita(deps),
  );
  return resultado;
}

/* -------------------------------------------------------------------------- */
/*                                the resolvers                                */
/* -------------------------------------------------------------------------- */

/**
 * Which fact closed the row. Persisted in `resolucaoMotivo`, so a closed aviso
 * still says WHY — and therefore not free to rename. Two of the three reuse
 * the motivo slugs of the same facts.
 */
export const RESOLUCAO_AVISO_NFE_SHOPEE = {
  nfeValidada: MOTIVO_NFE_SHOPEE.nfeValidada,
  freteDespachado: 'frete-despachado',
  pedidoCancelado: MOTIVO_NFE_SHOPEE.pedidoCancelado,
} as const;

/** One of {@link RESOLUCAO_AVISO_NFE_SHOPEE}'s values. */
export type ResolucaoAvisoNfeShopee =
  (typeof RESOLUCAO_AVISO_NFE_SHOPEE)[keyof typeof RESOLUCAO_AVISO_NFE_SHOPEE];

/**
 * Close the NF-e aviso of one pedido, and report whether THIS call closed it.
 *
 * ⚠️ It answers a TRANSITION, not the existence of a document: an absent or
 * already-resolved row answers `false` and writes nothing (`resolverAviso`'s
 * contract), so `resolvidoEm` is not re-stamped on every validated recheck —
 * which would push the row past the retention sweep's cutoff forever.
 */
export function resolverAvisoNfeShopee(
  db: Firestore,
  integracaoId: string,
  pedidoId: string,
  resolucao: ResolucaoAvisoNfeShopee,
  deps: Pick<AvisoDeps, 'nowMs'>,
): Promise<boolean> {
  return resolverAviso(db, chaveAvisoNfeShopee(integracaoId, pedidoId), resolucao, {
    agoraUs: agoraUsDe(deps),
  });
}

/**
 * Shopee's `order_status` for a cancelled order.
 *
 * ⚠️ Spelled here, not imported, because this module must not import
 * `pedidos/` (module docblock). The suite drives the resolver with the
 * importer's own status table, so a drift between the two is a red test.
 * `IN_CANCEL` is deliberately NOT it: a cancellation request can still be
 * refused, and the order then ships.
 */
const ORDER_STATUS_CANCELADO = 'CANCELLED';

/** What a caller of the step-7 frete transaction observed, after it returned. */
export interface EncerramentoNfeShopee {
  readonly integracaoId: string;
  readonly pedidoId: string;
  /**
   * The frete estado the block holds once the step-7 transaction is over —
   * the one it wrote, or on a replay the one its own read found and kept — and
   * only when the channel's package diary folds to that same estado; `null`
   * otherwise (`ResultadoFreteShopee.estadoConfirmado`, in `pedidos/freteTx.ts`).
   *
   * ⚠️ Despite the historical name it is NOT only a write: a replay that writes
   * nothing must still hand the estado over, or a delivery whose resolve failed
   * after the frete committed would never retry it. And it is NOT the bare
   * stored estado either: the operator's warehouse estados (`empacotado`,
   * `checkFinalizado`) sit in the removal set too, and closing an NF-e aviso
   * because a parcel was packed would hide a problem Shopee has not cleared.
   */
  readonly estadoFreteEscrito: EstadoFrete | null;
  /** Shopee's `order_status` verbatim, or `null` on a path that has no order row. */
  readonly orderStatus: string | null;
}

/**
 * The cross-step hook: does what steps 5 and 7 just observed end the NF-e
 * problem of this pedido? If so, close its aviso.
 *
 * - `estadoFreteEscrito ∈ ESTADOS_FRETE_REMOVE_ESTOQUE` ⇒ `frete-despachado`;
 * - otherwise `orderStatus` is cancelled ⇒ `pedido-cancelado`;
 * - otherwise `false`, with ZERO reads — this runs on every import and every
 *   package push, and a pre-shipment delivery must cost nothing.
 *
 * The cost it does have: ONE aviso read per delivery about a parcel already in
 * the removal set — a replay, or a refresh that moves no estado — plus one per
 * import of a cancelled order. That read is what makes the retry below real.
 *
 * Called OUTSIDE the frete transaction, after it committed. A Firestore
 * failure here PROPAGATES (no catch): both deliveries that call it are
 * idempotent, so the queue redelivers, the frete comes back
 * `ignorado-sem-mudanca`, and the caller still hands over the confirmed estado
 * (or the cancelled status), so the retry tries the resolve again. Swallowing
 * it would leave a row standing for a problem that has ended.
 */
export async function resolverAvisoNfeSeEncerrado(
  db: Firestore,
  obs: EncerramentoNfeShopee,
  deps: Pick<AvisoDeps, 'nowMs'>,
): Promise<boolean> {
  const resolucao = resolucaoDoEncerramento(obs);
  if (resolucao === null) return false;
  return resolverAvisoNfeShopee(db, obs.integracaoId, obs.pedidoId, resolucao, deps);
}

function resolucaoDoEncerramento(obs: EncerramentoNfeShopee): ResolucaoAvisoNfeShopee | null {
  if (obs.estadoFreteEscrito !== null && ESTADOS_FRETE_REMOVE_ESTOQUE.has(obs.estadoFreteEscrito)) {
    return RESOLUCAO_AVISO_NFE_SHOPEE.freteDespachado;
  }
  if (obs.orderStatus === ORDER_STATUS_CANCELADO) {
    return RESOLUCAO_AVISO_NFE_SHOPEE.pedidoCancelado;
  }
  return null;
}
