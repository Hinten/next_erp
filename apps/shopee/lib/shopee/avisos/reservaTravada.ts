/**
 * The producer of the **stuck-reservation** aviso (step 8, #1516), and the
 * machine resolver `pedidoPrecisaDecisao` has owed since it was declared.
 *
 * ## What the residual is
 *
 * Step 5 imports an `UNPAID`/`PENDING` Shopee order as
 * `aguardandoConfirmacaoDePagamento`, which is inside `ESTADOS_PEDIDO_RESERVA`:
 * the unit is held on purpose, and the release is the `CANCELLED` push coming
 * back through the same ladder. When that push never arrives — a suspended
 * subscription loses everything not already in the 3-day lost-push queue, the
 * order backfill's `get_order_list` window is 15 days and ships OFF, and the
 * `UNPAID → PENDING` transition fires no push at all (`announcement 682` §4 Q1)
 * — the reservation is held forever. The weekly sweep
 * (`pedidos/reservaTravadaSweep.ts`) re-drives the candidates whose order
 * actually MOVED; what is left over is this module's subject: an order Shopee
 * still reports as unpaid or pending past the horizon, one Shopee no longer
 * knows, and one sitting in `TO_RETURN` that no re-drive can move.
 *
 * ## ⚠️ Why the residual is SURFACED and never written
 *
 * The sweep writes no pedido field, and this module is the whole reason it can
 * afford not to. Five, in brief (the long form is the step-8 plan §3.0 and the
 * master-plan bullet):
 *
 * 1. **One writer.** `pedido.estado` on this channel is written by step 5 and
 *    by nothing else, so the sweep gets rule 7 **tier 0** — the race is made
 *    impossible rather than survived — for free. The Mercado Livre sweep pays
 *    tier 2 for the opposite choice and concedes so in its own docblock.
 * 2. **Step 5's ladder is self-healing.** `cancelado → pago` is allowed and
 *    flagged `ressuscitado` (`orderStatusMaps.ts`), because the ladder is driven
 *    by a re-fetch of the LIVE order. A release written through it is
 *    reversible; ML's `pagamentoNaoRealizado` is not.
 * 3. **No shared decision engine is involved** — this module runs no multi-doc
 *    atomic write at all, which is why step 8 files no entry in the
 *    `firestore-transaction-inventory` and why the identifier that API is named
 *    by does not appear in any of its non-test modules (the inventory greps raw
 *    text, comments included).
 * 4. **The READ is the instrument.** A sweep that only enqueues produces zero
 *    evidence: a successful re-drive resolves over a failures-only store and
 *    records nothing durable. An aviso is the one artefact that outlives a tick.
 * 5. **Never enqueue for an order Shopee no longer knows.** The synthetic
 *    notification's doc id carries `nowMs`, so re-driving an unreachable order
 *    writes one new parked dead-letter document per tick, forever, and releases
 *    nothing. `inexistente` is what stops that, and this aviso is what gives
 *    that population an owner.
 *
 * ## ⚠️ This is `pedidoPrecisaDecisao`'s FIRST producer, so it owes the resolver
 *
 * `packages/schemas/src/aviso.ts` (the `tipo` docblock) requires every member to
 * name its **machine resolver** before it ships: `avisos` is `serverOwned`, so
 * there is no operator "dismiss" button. `pedidoPrecisaDecisao` was declared by
 * #1543 with no producer anywhere in the repo; step 8 is the first, and it ships
 * {@link resolverReservaTravada} plus the chave parser the sweep's reconciliation
 * pass needs, in two passes:
 *
 * - **(a) in-line**, on the candidate page, for exactly two verdicts —
 *   `interacao-humana` (`assumido-por-humano`) and `pagamento-aprovado`
 *   (`venda-viva`). Nothing else: resolving on an enqueue closes a live aviso
 *   while the unit is still held (the task can park or defer and there is no
 *   feedback channel), and resolving on a 429 closes one on the ABSENCE of an
 *   observation. Both would re-raise next week through `escreverAviso`'s
 *   **reopen** branch, with a fresh `criadoEm` that clears the operator's read
 *   watermark — re-alerting about a problem that never went away.
 * - **(b) the reconciliation pass**, after the conta loop, for the other four
 *   motivos, when the pedido has actually left the candidate set. The QUERY that
 *   drives it belongs to `reservaTravadaSweep.ts` (wave 3); this module exports
 *   only the resolver and {@link pedidoIdDaChaveReservaTravada}, which is that
 *   pass's ONLY "is this row ours" filter.
 *
 * ⚠️ **Pass (b) is not optional, and the retention sweep is why.**
 * `apps/functions/src/avisos/sweepAvisosResolvidos.ts` deletes a **resolved**
 * aviso 90 days after `resolvidoEm`. An aviso nothing ever resolves stands
 * **forever**. The cost of the narrow in-line set above is that a genuinely
 * fixed pedido keeps its row for one extra week, until pass (b) observes it left
 * the set — that is the right trade, and it is only affordable because pass (b)
 * exists.
 *
 * ## ⚠️ No event clock is ever supplied, and that is load-bearing
 *
 * `escreverAviso`'s watermark guard is `<=`, not `<`: a delivery whose clock
 * merely EQUALS the stored one is dropped as `'ignorado'`. The obvious Shopee
 * clock to hand it is `get_order_detail.update_time`, and the `ainda-nao-pago`
 * residual is BY DEFINITION the population whose `update_time` stopped moving.
 * So supplying one would freeze `ocorrencias` at 1, freeze `atualizadoEm`, and
 * freeze `params.situacao` at week one's age — the operator would read
 * "há 8 dia(s)" on a reservation stuck for four months, and every one of those
 * failures is silent (`escreverAviso` returns a legal result and nothing
 * throws). With no clock on either side the guard never fires, every repeat tick
 * answers `'repetido'`, `ocorrencias` climbs through `FieldValue.increment` and
 * `criadoEm` stays put. **`ocorrencias` is this design's only cross-tick
 * memory.** ⚠️ If a later producer of this tipo ever does supply an event clock,
 * it must be the SAME provider clock in the SAME unit as the stored one — the
 * field is compared only against itself, and a cross-unit comparison is a guard
 * that never fires (root `CLAUDE.md` rule 7; `autorizacao.ts` stores
 * milliseconds there while every other stamp on the row is µs).
 *
 * ## Units
 *
 * This module converts nothing and earns **no number** on the µs SITE list in
 * `apps/shopee/CLAUDE.md`. It imports `agoraUsDe` / `depsDeEscrita` /
 * `AvisoDeps` from `avisos/autorizacao.ts`, exactly as `avisos/pushSaude.ts`
 * does, which is what keeps that module's "exactly two call sites" promise true
 * with a third producer in the app. Nothing here reaches for the ms → µs
 * converter itself; the raw-text guard in the test pins that.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { type ResultadoAviso, escreverAviso, resolverAviso } from '@delfrance/data/admin/avisos';
import {
  CANAL_AVISO,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  chaveDeAviso,
} from '@delfrance/schemas';

import {
  type VereditoReservaTravada,
  VEREDITO_RESERVA_TRAVADA,
  VEREDITOS_QUE_AVISAM,
} from '../pedidos/reservaTravadaMapping';
import { type AvisoDeps, agoraUsDe, depsDeEscrita } from './autorizacao';

/* -------------------------------------------------------------------------- */
/*                                  the chave                                  */
/* -------------------------------------------------------------------------- */

/**
 * The dedup identity — and the Firestore document id — of the stuck-reservation
 * aviso: one open row per `(integração, pedido)`.
 *
 * ⚠️ **No `janela`.** `avisos/autorizacao.ts`'s "No janela" section carries the
 * general reasoning and it ports verbatim, but here the damage is worse than a
 * stranded row. `janela` is documented as "what makes two otherwise-identical
 * events DIFFERENT occurrences rather than a repeat of one", and a reservation
 * stuck in week 3 is the **same** occurrence as in week 2. A weekly window would
 * create a NEW document every Monday, each standing until retention, and
 * `ocorrencias` would never leave 1 — deleting the only cross-tick memory this
 * design has.
 *
 * {@link avisarReservaTravada} does not pass this string: `escreverAviso`
 * derives the id from the same three inputs through the same `chaveDeAviso`, so
 * there is one definition and no way for the producer and the resolver to
 * compute different keys.
 */
export function chaveReservaTravada(integracaoId: string, pedidoId: string): string {
  return chaveDeAviso({
    tipo: TIPO_AVISO.pedidoPrecisaDecisao,
    conta: integracaoId,
    entidade: pedidoId,
  });
}

/** How many `:`-separated parts one of our chaves has: tipo, conta, entidade. */
const PARTES_DA_CHAVE = 3;

/**
 * The pedido id out of one of OUR chaves, or `null`.
 *
 * ⚠️ **Total and refusing.** This is the reconciliation pass's ONLY "is this row
 * ours" filter — the avisos page it walks carries every unresolved row of every
 * tipo and every canal, because no index discriminates them — so a loose parser
 * would resolve a row this sweep never wrote, on a `serverOwned` collection
 * where nobody can undo it by hand. It therefore demands exactly three
 * `:`-separated parts with the first equal to `pedidoPrecisaDecisao` and the
 * other two non-empty: a FOUR-part chave (a future producer that adopted a
 * `janela`), another tipo, a two-part chave and an empty string all answer
 * `null` and are left alone.
 *
 * Splitting on `:` is safe because `segmentoChave` folds `:` (along with
 * `/ \ . # [ ]` and whitespace) to `_` inside every segment — that fold exists
 * precisely so a colon in a value cannot shift the segment boundaries — so a
 * chave built by {@link chaveReservaTravada} has exactly three parts however the
 * integração id and the pedido id are spelled.
 */
export function pedidoIdDaChaveReservaTravada(chave: string): string | null {
  const partes = chave.split(':');
  if (partes.length !== PARTES_DA_CHAVE) return null;
  const [tipo, conta, pedidoId] = partes;
  if (tipo !== TIPO_AVISO.pedidoPrecisaDecisao) return null;
  if (conta === undefined || conta.length === 0) return null;
  if (pedidoId === undefined || pedidoId.length === 0) return null;
  return pedidoId;
}

/* -------------------------------------------------------------------------- */
/*                               the situação                                  */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ Cap on the interpolated fragment. `params` values are `z.string()` with no
 * length bound, but `order_status` and `pending_terms` are UNTRUSTED provider
 * strings that land inside an operator's sentence. `MOTIVO_MAX`'s reasoning in
 * `apps/functions/src/estoques/sincronizarEstoquePedido.ts` is the precedent;
 * the failure here is a bell row nobody can read rather than a parse throw, so
 * the cap is smaller and the ellipsis is the same.
 */
export const SITUACAO_MAX = 300;

/** The four surfacing verdicts — the only ones this module has a sentence for. */
export type VereditoQueAvisa = Extract<
  VereditoReservaTravada,
  'ainda-nao-pago' | 'pendente-pago' | 'inexistente' | 'manter-devolucao'
>;

/** Why Shopee could not tell us about the order at all. */
export type MotivoInexistente = 'order_not_found' | 'ausente-na-resposta';

export interface SituacaoReservaTravadaArgs {
  readonly veredito: VereditoQueAvisa;
  /** `order_status` verbatim off the wire. `null` only on `inexistente`. */
  readonly orderStatus: string | null;
  /** `pending_terms` as stated: `[]` asked-and-none, `null` never asked. */
  readonly pendingTerms: readonly string[] | null;
  /** Only on `inexistente`; `null` on every other arm. */
  readonly motivoInexistente: MotivoInexistente | null;
  /** Whole days the pedido has been sitting in the reserve estado. */
  readonly idadeDias: number;
}

/**
 * The operator-facing half of the sentence, in pt-BR.
 *
 * `apps/web/lib/avisos/mensagens.ts` renders
 * `O pedido {pedido} precisa de uma decisão manual: {situacao}.` — so this is a
 * **lowercase fragment with no trailing period**, exactly as the e2e seed writes
 * it. One function, so the tick and the rehearsal CLI cannot word the same
 * verdict differently.
 *
 * ⚠️ **No buyer datum, ever.** The only provider strings interpolated here are
 * `order_status`, `pending_terms[]` and our own two `inexistente` motivos.
 * `cancel_reason` / `cancel_by` are read by the tick but belong to candidates
 * that get re-driven, which raise no aviso; they go to the log line only.
 */
export function situacaoReservaTravada(args: SituacaoReservaTravadaArgs): string {
  const texto = textoDaSituacao(args);
  return texto.length > SITUACAO_MAX ? `${texto.slice(0, SITUACAO_MAX - 1)}…` : texto;
}

function textoDaSituacao(args: SituacaoReservaTravadaArgs): string {
  // `orderStatus` is non-null on every arm but `inexistente`, which never reads
  // it. The fallback exists so a malformed caller degrades instead of printing
  // the word `null` inside an operator's sentence.
  const status = args.orderStatus ?? 'desconhecido';
  const termos = termosEntreParenteses(args.pendingTerms);
  const idade = `há ${String(args.idadeDias)} dia(s)`;

  switch (args.veredito) {
    case VEREDITO_RESERVA_TRAVADA.aindaNaoPago:
      return (
        `a Shopee ainda reporta este pedido como "${status}"${termos}, ${idade} sem ` +
        'confirmação de pagamento — a reserva de estoque continua presa e só uma ' +
        'decisão humana a libera'
      );
    case VEREDITO_RESERVA_TRAVADA.pendentePago:
      // ⚠️ The sentence must talk the operator OUT of the obvious action.
      // `ARRANGE_SHIPMENT_PENDING` applies to pedidos already PAID
      // (`announcement 1486`, BR): cancelling here ends a live sale, and the
      // only remedy is a ticket on the Open Platform.
      return (
        `a Shopee reporta "${status}"${termos} e o pagamento JÁ foi registrado: ${idade} ` +
        'esta é uma venda paga retida do lado da Shopee, não falta de pagamento — ' +
        'não cancele; o caminho é um chamado no Open Platform'
      );
    case VEREDITO_RESERVA_TRAVADA.inexistente:
      return (
        `a Shopee não reconhece mais este pedido (${args.motivoInexistente ?? 'sem motivo'}), ` +
        `${idade} — nenhuma releitura pode resolver isso e a reserva de estoque ` +
        'continua presa'
      );
    case VEREDITO_RESERVA_TRAVADA.manterDevolucao:
      return (
        `a Shopee reporta "${status}" mas o pedido nunca saiu de "aguardando ` +
        `confirmação de pagamento", ${idade} — nenhuma releitura corrige o estado e ` +
        'a reserva de estoque continua presa'
      );
  }
}

function termosEntreParenteses(termos: readonly string[] | null): string {
  if (termos === null || termos.length === 0) return '';
  return ` (${termos.join(', ')})`;
}

/* -------------------------------------------------------------------------- */
/*                                the producer                                 */
/* -------------------------------------------------------------------------- */

/** One surfacing candidate, reduced to what the aviso renders and dedups on. */
export interface EventoReservaTravada {
  readonly veredito: VereditoQueAvisa;
  /** The pedido document id — the dedup entidade AND the route's parameter. */
  readonly pedidoId: string;
  /** The integração document id — the dedup conta. */
  readonly integracaoId: string;
  /**
   * The DISPLAY number, which on this channel is the `order_sn` verbatim and
   * fill-once. `params.pedido` carries it because that is the string the
   * operator recognises; the route carries the id.
   */
  readonly numero: string;
  /** `order_status` verbatim. `null` only on `inexistente`. */
  readonly orderStatus: string | null;
  readonly pendingTerms: readonly string[] | null;
  /** Only on `inexistente`; `null` on every other arm. */
  readonly motivoInexistente: MotivoInexistente | null;
  readonly idadeDias: number;
}

/**
 * Raise (or refresh) "this pedido is holding a reservation and needs a human".
 *
 * `severidade: atencao` — a held unit is a real sale blocked, so not
 * `informativo`; and `critico` is the only tier that escalates out of the app,
 * which in a three-person team must stay rare enough that nobody learns to
 * ignore it (`packages/schemas/src/aviso.ts`, the severidade docblock). It
 * matches `shopeeAutorizacaoExpirando`.
 *
 * `motivo` is the provider's own code for WHY — the live `order_status` on the
 * three status-derived arms (which on `manter-devolucao` is `TO_RETURN`, by
 * construction: that is the only token the ladder answers `manter` for) and our
 * own `inexistente` motivo otherwise. It is stored beside the `tipo` because one
 * event class here has four different operator ACTIONS.
 *
 * No `prazo`: Shopee publishes no deadline for an unpaid order anywhere in its
 * documentation, and an absent optional means "I do not know" — inventing one
 * would render as a promise. No `destinatarioUid`: a stuck reservation is
 * everyone-who-can-act. No event clock — see the module docblock.
 *
 * @throws RangeError when handed a verdict that does not surface. The producer
 * must never be reachable from a non-surfacing arm, and
 * {@link VEREDITOS_QUE_AVISAM} is the single source of that set — the classifier
 * computes its own `surfacar` from the very same Set, so the two cannot
 * disagree and this guard only ever fires on a caller bug.
 */
export function avisarReservaTravada(
  db: Firestore,
  evento: EventoReservaTravada,
  deps: AvisoDeps,
): Promise<{ chave: string; resultado: ResultadoAviso }> {
  if (!VEREDITOS_QUE_AVISAM.has(evento.veredito)) {
    throw new RangeError(
      `avisarReservaTravada: o veredito ${evento.veredito} não superficializa — só ` +
        `${[...VEREDITOS_QUE_AVISAM].join(', ')} viram aviso, e o restante é contador e log.`,
    );
  }

  const motivo =
    evento.veredito === VEREDITO_RESERVA_TRAVADA.inexistente
      ? evento.motivoInexistente
      : evento.orderStatus;

  return escreverAviso(
    db,
    {
      tipo: TIPO_AVISO.pedidoPrecisaDecisao,
      conta: evento.integracaoId,
      entidade: evento.pedidoId,
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.shopee,
      // Structured params, never a rendered sentence: the pt-BR wording lives in
      // `apps/web/lib/avisos/mensagens.ts` and reads exactly `pedido` and
      // `situacao`. Nothing else may be added here — a param nothing renders is
      // a field that drifts silently, and this one would carry provider text.
      params: {
        pedido: evento.numero,
        situacao: situacaoReservaTravada(evento),
      },
      motivo,
      // The builder, never a literal: the route FREEZES at write time and this
      // module has no dependency edge to `apps/web`, so `rotas.test.ts` walking
      // the builders is the only thing that keeps the link honest. ⚠️ The bare
      // `/pedidos/[id]` is not navigable — the builder answers `…/editar`.
      urlInterna: { rota: ROTAS_AVISO.pedido.build(evento.pedidoId), campo: null },
    },
    depsDeEscrita(deps),
  );
}

/* -------------------------------------------------------------------------- */
/*                                the resolver                                 */
/* -------------------------------------------------------------------------- */

/**
 * Why a stuck-reservation aviso was closed. Six motivos, two callers.
 *
 * Pass (a), in-line on the candidate page, uses exactly two — and only two, for
 * the reason in the module docblock:
 * - `assumidoPorHumano` — the pedido carries `hasUserInteraction`, so a person
 *   already owns it;
 * - `vendaViva` — an `aprovado` pagamento exists, so it is not a stuck
 *   reservation at all.
 *
 * Pass (b), the reconciliation over the open avisos page, uses the other four,
 * each meaning "the pedido left the candidate set":
 * - `pedidoInexistente` — the pedido document is gone;
 * - `estadoSaiuDoConjunto` — its estado is no longer the reserve one (which is
 *   the OBSERVATION that a re-drive landed, and the reason a `redirecionado-*`
 *   verdict never resolves in-line);
 * - `foraDaPosse` — the ownership proof no longer holds;
 * - `dentroDoHorizonte` — its stored timestamp is newer than the cutoff again.
 */
export const MOTIVO_RESOLUCAO_RESERVA_TRAVADA = {
  assumidoPorHumano: 'assumido-por-humano',
  vendaViva: 'venda-viva',
  pedidoInexistente: 'pedido-inexistente',
  estadoSaiuDoConjunto: 'estado-saiu-do-conjunto',
  foraDaPosse: 'fora-da-posse',
  dentroDoHorizonte: 'dentro-do-horizonte',
} as const;

/** One of {@link MOTIVO_RESOLUCAO_RESERVA_TRAVADA}'s values. */
export type MotivoResolucaoReservaTravada =
  (typeof MOTIVO_RESOLUCAO_RESERVA_TRAVADA)[keyof typeof MOTIVO_RESOLUCAO_RESERVA_TRAVADA];

/**
 * Close one stuck-reservation aviso, and report whether this call closed it.
 *
 * ⚠️ It answers a **transition**, not the existence of a document: an absent or
 * already-resolved row answers `false` without writing, so a caller's
 * `reconciliados` counter reports closures rather than lookups — and so
 * `resolvidoEm` is not re-stamped every week, which would push the row past the
 * retention sweep's 90-day cutoff forever.
 *
 * The chave is passed in rather than rebuilt: pass (b) reads it off the document
 * it is reconciling, and pass (a) builds it with {@link chaveReservaTravada} —
 * the same function the producer's write derives its id from. A resolver that
 * derives its own key is how a row ends up standing forever.
 *
 * ⚠️ The QUERY that feeds pass (b) — the open-avisos page, the tipo/canal skip,
 * the pedido re-read and the five resolve conditions — lives in
 * `pedidos/reservaTravadaSweep.ts`, not here. This module ships the resolver and
 * {@link pedidoIdDaChaveReservaTravada}, which that pass needs to tell our rows
 * from everyone else's.
 *
 * `deps` is narrower than {@link AvisoDeps} on purpose — closing a row needs no
 * `increment` sentinel — and a full `AvisoDeps` satisfies it, which is the shape
 * `avisos/autorizacao.ts`'s own resolvers use.
 */
export function resolverReservaTravada(
  db: Firestore,
  chave: string,
  motivo: MotivoResolucaoReservaTravada,
  deps: Pick<AvisoDeps, 'nowMs'>,
): Promise<boolean> {
  return resolverAviso(db, chave, motivo, { agoraUs: agoraUsDe(deps) });
}
