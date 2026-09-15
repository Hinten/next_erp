/**
 * The PURE state model of the stuck-reservation sweep (step 8, #1516) — what
 * one live Shopee order says about a pedido that has been holding a stock
 * reservation past the horizon, plus the two ownership proofs and the age
 * reader the tick gates on.
 *
 * PURE: no Firestore, no wire call, no clock, no env. Same role
 * `freteShopeeMapping.ts` plays for step 7 and `orderStatusMaps.ts` plays for
 * step 5 — the tick (`reservaTravadaSweep.ts`) and the rehearsal CLI both
 * import this one function, which is what makes the dry-run parity a property
 * of ONE table instead of an agreement between two copies (root `CLAUDE.md`,
 * "a comment asserting what the OTHER copy does is the smell").
 *
 * ## The one status table
 *
 * `estadoPedidoDeOrderStatus` (`orderStatusMaps.ts`) is the ONLY status table
 * this module consults, and it carries no `order_status` token of its own —
 * `reservaTravadaMapping.test.ts` pins that with a raw-text grep over this
 * file, because a second table drifting toward plausible is exactly the failure
 * this channel already paid for once (#1369).
 *
 * ## ⚠️ The raw token, never the mapped estado
 *
 * Shopee's two pre-shipment tokens share ONE rung — both map to
 * `aguardandoConfirmacaoDePagamento` (`orderStatusMaps.ts:138-145`, and the
 * "`PENDING` sits on the SAME rung as `UNPAID`" docblock above it) — so the
 * estado alone cannot tell "the buyer never paid" from "Shopee is holding a
 * PAID sale". `announcement 1486` (BR, 2026-07-23) documents
 * `ARRANGE_SHIPMENT_PENDING` as applying to pedidos **pagos**, and the field
 * description on the page reads "Label print will be available within 4 days
 * after buyer paid" (E1 A6/R4). That is why {@link classificarReservaTravada}
 * compares the raw token in exactly one place, against the value
 * `SHOPEE_ORDER_STATUS` exports — never against a literal of its own.
 *
 * ## ⚠️ `segundosShopeeUtilizaveis`, never `!= null`
 *
 * `pay_time` is the ONLY documented payment signal ("NULL when order is not
 * paid yet", E1 A8), and Shopee zero-fills absent numerics on this wire
 * (`orderMapping.ts:50-58`, proven by the SG sandbox order). A `0` is an
 * ABSENCE, and an `=== null` test would read it as "paid at the epoch". The
 * fold is `segundosShopeeUtilizaveis`, which also refuses anything below
 * `PISO_SEGUNDOS_SHOPEE`, so `0`, `null`, `undefined`, `NaN` and any pre-2020
 * value all answer "absent" — whichever way Shopee turns out to spell it
 * (settle-live register item 39), the verdict is the same.
 *
 * ## ⚠️ `status-desconhecido` NEVER redirects
 *
 * A synthetic re-drive makes step 5 write `ESTADO_DO_ERRO_SHOPEE`
 * (= `ESTADO_PEDIDO.error`, `orderStatusMaps.ts:165`) for a token the ladder
 * does not model — verified on the real engine, not by reading: with
 * `aguardandoConfirmacaoDePagamento` stored, `estadoShopeeAplicavel` answers
 * `{escrever: true, estado: error}`, and `error` is OUTSIDE
 * `ESTADOS_PEDIDO_RESERVA` (`packages/schemas/src/pedido/pureLogic/estoque.ts:16-22`).
 * So re-driving would **RELEASE the reservation for a status nobody
 * understands** — the unsafe direction. Count it, log the raw token, act on
 * nothing. `reservaTravadaMapping.test.ts` executes both halves of that proof.
 *
 * ## ⚠️ The pedido preimage is the LEGACY one, and #1516 spells it wrong
 *
 * {@link provaDeIdentidadeShopee} recomputes `makePedidoIdShopee(contaId,
 * numero)` and compares it to the document id. The preimage is
 * `sha256("<contaId>-<orderSn>")` (`orderIds.ts:8-24`, which records the
 * issue's `<contaId>|shopee|<order_sn>` spelling as REJECTED). Building the
 * gate from the issue's string would fail the ownership proof for EVERY
 * migrated Shopee pedido — the population most likely to be stuck — and report
 * a clean, empty, completely wrong tick.
 *
 * ## Units
 *
 * This module converts nothing and earns no number on the µs SITE list in
 * `apps/shopee/CLAUDE.md`. {@link idadeEmDias} is a READER: it routes a STORED
 * stamp through `coerceToMicros`, which is correct on that side precisely
 * because the legacy corpus holds milliseconds and ISO strings — and wrong on a
 * Shopee wire value, which is SECONDS (see `microsDeSegundosShopee`'s docblock).
 * `pay_time` never reaches it: it is folded to a BOOLEAN and discarded.
 */
import { coerceToMicros } from '@delfrance/core/datetime';
import { ESTADO_PEDIDO } from '@delfrance/schemas';

import { makePedidoIdShopee } from './orderIds';
import { segundosShopeeUtilizaveis } from './orderMapping';
import {
  ALVO_ESTADO_SHOPEE,
  SHOPEE_ORDER_STATUS,
  estadoPedidoDeOrderStatus,
  type AlvoEstadoShopee,
} from './orderStatusMaps';

/* -------------------------------------------------------------------------- */
/*                                  constants                                  */
/* -------------------------------------------------------------------------- */

/** Microseconds in one day. Declared here so the tick and the CLI share one. */
export const DIA_US = 24 * 60 * 60 * 1000 * 1000;

/**
 * Shopee's two spellings for "this shop has no such order".
 *
 * ⚠️ BOTH are on record and only one of them is in the package: the importer's
 * `SHOPEE_ERRO_ORDER_NOT_FOUND` is `order_not_found`
 * (`importarPedido.ts:131`), while `get_order_detail`'s own Error example and
 * its api-specific error list carry `error_not_found` (E1 A10). They are
 * declared here rather than imported so this module stays out of the importer's
 * graph; `reservaTravadaMapping.test.ts` pins the first against
 * `SHOPEE_ERRO_ORDER_NOT_FOUND` so the two can never drift apart.
 */
export const CODIGOS_PEDIDO_INEXISTENTE: ReadonlySet<string> = new Set([
  'order_not_found',
  'error_not_found',
]);

/* -------------------------------------------------------------------------- */
/*                                the verdicts                                 */
/* -------------------------------------------------------------------------- */

/**
 * What the sweep concluded about ONE candidate — a pedido this channel PROVED
 * it owns. Gate-1 rejects (`naoMarketplace`, `adotado`, `contaInativa`,
 * `foraDoEscopo`, `semShopId`) are deliberately NOT here: they are tick
 * counters beside `examinados`, which is what makes `Σ veredictos ===
 * candidatos` an assertable invariant (the Mercado Livre sweep folds them in
 * and has no such invariant).
 *
 * ⚠️ The split between the two `redirecionado-*` arms is the load-bearing one.
 * Only `redirecionado-cancelado` actually RELEASES a reservation (`cancelado`
 * and `processandoCancelamento` are outside `ESTADOS_PEDIDO_RESERVA`), while
 * `redirecionado-avancou` moves the pedido to `pago`, which is INSIDE it
 * (`packages/schemas/src/pedido/pureLogic/estoque.ts:16-22`). Folded, a log
 * line reading "examinados 200, redirecionados 40" would say forty units went
 * back to stock when thirty-nine of them are live sales whose record was merely
 * corrected.
 *
 * `tasks-desabilitado` is decided by the TICK, not here — it is a fact about
 * the deployment, not about the order — but it belongs in the union so the
 * counter map is total.
 */
export type VereditoReservaTravada =
  // --- the gates, decided with NO Shopee call --------------------------------
  | 'interacao-humana'
  | 'pagamento-aprovado'
  // --- the read -------------------------------------------------------------
  | 'nao-verificavel'
  | 'inexistente'
  // --- the classification (this module) -------------------------------------
  | 'ainda-nao-pago'
  | 'pendente-pago'
  | 'redirecionado-avancou'
  | 'redirecionado-cancelado'
  | 'manter-devolucao'
  | 'status-desconhecido'
  // --- the effect -----------------------------------------------------------
  | 'tasks-desabilitado';

/** Named members of {@link VereditoReservaTravada}. */
export const VEREDITO_RESERVA_TRAVADA = {
  interacaoHumana: 'interacao-humana',
  pagamentoAprovado: 'pagamento-aprovado',
  naoVerificavel: 'nao-verificavel',
  inexistente: 'inexistente',
  aindaNaoPago: 'ainda-nao-pago',
  pendentePago: 'pendente-pago',
  redirecionadoAvancou: 'redirecionado-avancou',
  redirecionadoCancelado: 'redirecionado-cancelado',
  manterDevolucao: 'manter-devolucao',
  statusDesconhecido: 'status-desconhecido',
  tasksDesabilitado: 'tasks-desabilitado',
} as const satisfies Record<string, VereditoReservaTravada>;

/**
 * Every arm, in declaration order — the ZERO-SEED for the tick's counter map.
 *
 * ⚠️ Zero-valued arms are present on purpose: the rehearsal instrument is a
 * week-over-week diff, and an omitted key is indistinguishable from an arm that
 * did not exist last week.
 */
export const VEREDITOS_RESERVA_TRAVADA: readonly VereditoReservaTravada[] = [
  VEREDITO_RESERVA_TRAVADA.interacaoHumana,
  VEREDITO_RESERVA_TRAVADA.pagamentoAprovado,
  VEREDITO_RESERVA_TRAVADA.naoVerificavel,
  VEREDITO_RESERVA_TRAVADA.inexistente,
  VEREDITO_RESERVA_TRAVADA.aindaNaoPago,
  VEREDITO_RESERVA_TRAVADA.pendentePago,
  VEREDITO_RESERVA_TRAVADA.redirecionadoAvancou,
  VEREDITO_RESERVA_TRAVADA.redirecionadoCancelado,
  VEREDITO_RESERVA_TRAVADA.manterDevolucao,
  VEREDITO_RESERVA_TRAVADA.statusDesconhecido,
  VEREDITO_RESERVA_TRAVADA.tasksDesabilitado,
];

/**
 * The verdicts an operator is owed an aviso for — declared ONCE, and the only
 * source of {@link ClassificacaoReservaTravada.surfacar}.
 *
 * The aviso producer lives in another file (`avisos/reservaTravada.ts`) and
 * must not re-derive "does this surface" from the verdict; the resolver pass
 * and the CLI's `avisaria` column need the Set for `inexistente`, which the
 * classifier never returns (it is decided at the READ, not from a status). One
 * declaration, two readers, no way for them to disagree.
 *
 * ⚠️ `manter-devolucao` is in the set, and that overrides the brief. A
 * `TO_RETURN` order answers `manter` at the FIRST clause of
 * `estadoShopeeAplicavel` (`orderStatusMaps.ts:268-270`), so a re-drive
 * provably cannot move the estado; `get_order_list` cannot list `TO_RETURN`
 * (E1 B2) and step 17 is unbuilt, so nothing else in this repo will ever reach
 * that pedido. A permanently held reservation nobody can see is the worst of
 * the available outcomes.
 *
 * ⚠️ `status-desconhecido` is deliberately NOT in the set: it is a token we do
 * not understand, and the pedido is very likely already carrying an aviso
 * raised in an earlier week as `ainda-nao-pago`, whose sentence is still true.
 */
export const VEREDITOS_QUE_AVISAM: ReadonlySet<VereditoReservaTravada> = new Set([
  VEREDITO_RESERVA_TRAVADA.aindaNaoPago,
  VEREDITO_RESERVA_TRAVADA.pendentePago,
  VEREDITO_RESERVA_TRAVADA.inexistente,
  VEREDITO_RESERVA_TRAVADA.manterDevolucao,
]);

/**
 * The verdicts that earn a synthetic code-3 re-drive. Same discipline as
 * {@link VEREDITOS_QUE_AVISAM}: declared once, read as data.
 */
const VEREDITOS_QUE_REDIRIGEM: ReadonlySet<VereditoReservaTravada> = new Set([
  VEREDITO_RESERVA_TRAVADA.redirecionadoAvancou,
  VEREDITO_RESERVA_TRAVADA.redirecionadoCancelado,
]);

/* -------------------------------------------------------------------------- */
/*                               the classifier                                */
/* -------------------------------------------------------------------------- */

/** What one live `get_order_detail` row says, reduced to what the decision needs. */
export interface LeituraReservaTravada {
  /** `order_status`, VERBATIM off the wire — a BASE field, always present. */
  readonly orderStatus: string;
  /**
   * `pay_time`, in Shopee SECONDS, exactly as it arrived — the caller passes it
   * RAW and {@link classificarReservaTravada} applies the one fold.
   *
   * ⚠️ Off a PARSED row this is always `number | null`: every optional on
   * `shopeeOrderDetailRowSchema` is `.nullable().default(null)`
   * (`packages/integrations/shopee/src/types.ts:1113-1182`). The permissive
   * type exists so a hand-built fixture needs no filler, not because
   * `undefined` carries a third meaning. The defence against "we forgot to name
   * `pay_time` in `response_optional_fields`" is NOT this type — it is the
   * tick's test asserting that literal is in its `responseOptionalFields`
   * array, because an unnamed optional field is simply ABSENT on this wire
   * (`packages/integrations/shopee/src/api.ts:586-589`) and would read as
   * "unpaid".
   */
  readonly payTime: number | null | undefined;
  /**
   * `pending_terms` — gated by `request_order_status_pending`, NOT by the
   * optional-fields list (E1 A5), so narrowing that list never drops it.
   */
  readonly pendingTerms: readonly string[] | null | undefined;
}

/** The classifier's answer. `redirigir` / `surfacar` are DATA, not a branch. */
export interface ClassificacaoReservaTravada {
  readonly veredito: Extract<
    VereditoReservaTravada,
    | 'ainda-nao-pago'
    | 'pendente-pago'
    | 'redirecionado-avancou'
    | 'redirecionado-cancelado'
    | 'manter-devolucao'
    | 'status-desconhecido'
  >;
  /** The ladder's own answer, carried so the log can say which rung replied. */
  readonly alvo: AlvoEstadoShopee;
  /** May the tick enqueue a synthetic code 3 for this candidate? */
  readonly redirigir: boolean;
  /** Does this candidate belong in the operator's inbox? */
  readonly surfacar: boolean;
  /** `order_status` verbatim — for the log, the aviso `motivo` and the payload. */
  readonly orderStatus: string;
  /** `pay_time` folded to a BOOLEAN. Never the value: it is not a datum we need. */
  readonly temPayTime: boolean;
  /** `pending_terms` as stated: `[]` when asked-and-none, `null` when unstated. */
  readonly pendingTerms: readonly string[] | null;
}

/**
 * One live order → one verdict about the reservation it is holding.
 *
 * The whole table, and the ONE place the raw token is compared:
 *
 * | ladder answer | extra test | verdict | redirects | surfaces |
 * |---|---|---|---|---|
 * | `erro` | — | `status-desconhecido` | no | no |
 * | `manter` (`TO_RETURN`) | — | `manter-devolucao` | no | **yes** |
 * | `aguardandoConfirmacaoDePagamento` | pending token **and** a usable `pay_time` | `pendente-pago` | no | **yes** |
 * | idem | otherwise | `ainda-nao-pago` | no | **yes** |
 * | `pago` | — | `redirecionado-avancou` | **yes** | no |
 * | `cancelado` \| `processandoCancelamento` | — | `redirecionado-cancelado` | **yes** | no |
 * | any other estado | unreachable from this ladder | `status-desconhecido` | no | no |
 *
 * ⚠️ **`pending_terms` and `cancel_reason` are never branched on.** No wire
 * field distinguishes BR's pending causes — `announcement 1431` puts "pendências
 * de validação de pagamento" in the same bucket `announcement 1486` puts PAID
 * orders in — so `pay_time` alone discriminates and the terms are aviso text
 * (E1 A7). `cancel_reason`'s one API sample, `BACKEND_LOGISTICS_NOT_STARTED`,
 * sits outside every documented list (E1 A9); branching on it would be a fold
 * over a vocabulary nobody published.
 */
export function classificarReservaTravada(
  leitura: LeituraReservaTravada,
): ClassificacaoReservaTravada {
  const alvo = estadoPedidoDeOrderStatus(leitura.orderStatus);
  const temPayTime = segundosShopeeUtilizaveis(leitura.payTime ?? null) !== null;
  const veredito = vereditoDoAlvo(alvo, leitura.orderStatus, temPayTime);
  return {
    veredito,
    alvo,
    redirigir: VEREDITOS_QUE_REDIRIGEM.has(veredito),
    surfacar: VEREDITOS_QUE_AVISAM.has(veredito),
    orderStatus: leitura.orderStatus,
    temPayTime,
    pendingTerms: leitura.pendingTerms ?? null,
  };
}

function vereditoDoAlvo(
  alvo: AlvoEstadoShopee,
  orderStatus: string,
  temPayTime: boolean,
): ClassificacaoReservaTravada['veredito'] {
  if (alvo.tipo === ALVO_ESTADO_SHOPEE.erro) {
    return VEREDITO_RESERVA_TRAVADA.statusDesconhecido;
  }
  if (alvo.tipo === ALVO_ESTADO_SHOPEE.manter) {
    return VEREDITO_RESERVA_TRAVADA.manterDevolucao;
  }
  // An if-chain rather than a `switch`, deliberately: the ladder's target type
  // is the whole sixteen-member `EstadoPedido`, of which it can produce five, so
  // an exhaustive switch would have to enumerate eleven estados this channel
  // never writes — and `switch-exhaustiveness-check` does not accept a `default`
  // as the answer. The closing `return` is the same safe fallthrough either way.
  const { estado } = alvo;
  if (estado === ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento) {
    // ⚠️ THE one raw-token comparison in this module, and it is against the
    // value step 5 exports — never a literal. The two tokens share this rung,
    // so the estado cannot tell a paid-and-held order from an unpaid one.
    return orderStatus === SHOPEE_ORDER_STATUS.pending && temPayTime
      ? VEREDITO_RESERVA_TRAVADA.pendentePago
      : VEREDITO_RESERVA_TRAVADA.aindaNaoPago;
  }
  if (estado === ESTADO_PEDIDO.pago) {
    return VEREDITO_RESERVA_TRAVADA.redirecionadoAvancou;
  }
  if (estado === ESTADO_PEDIDO.cancelado || estado === ESTADO_PEDIDO.processandoCancelamento) {
    return VEREDITO_RESERVA_TRAVADA.redirecionadoCancelado;
  }
  // Unreachable from this ladder today — and if a rung is ever added, the safe
  // answer is the one that acts on nothing.
  return VEREDITO_RESERVA_TRAVADA.statusDesconhecido;
}

/* -------------------------------------------------------------------------- */
/*                             ownership and age                               */
/* -------------------------------------------------------------------------- */

/**
 * `integracaoPedidoOuterRef` → the integração doc id, or `null`.
 *
 * The field is an `outerRefSchema`, `documents/<col>/<id>`
 * (`packages/schemas/src/shared/outerRef.ts`), written by step 5 as
 * `toOuterRef(integracaoCollection.docPath({}, integracaoId))`
 * (`importarPedido.ts:539`), so the last non-empty segment is exact.
 *
 * ⚠️ This is a deliberate COPY of Mercado Livre's `integracaoIdDoPedido`
 * (`apps/mercado-livre/lib/marketplace/pedidos/pedidoTravadoSweep.ts:234-239`),
 * not an import: `apps/shopee` has no dependency edge to any other `apps/*` and
 * none is possible. A THIRD copy is the one to promote to `@delfrance/data`,
 * not the second (root `CLAUDE.md`, "extract it to a shared package instead" —
 * whose own test is "pure and total", which this is).
 */
export function integracaoIdDoPedidoShopee(raw: Record<string, unknown>): string | null {
  const ref = raw.integracaoPedidoOuterRef;
  if (typeof ref !== 'string' || ref.length === 0) return null;
  const id = ref.split('/').filter(Boolean).pop() ?? null;
  return id != null && id.length > 0 ? id : null;
}

/**
 * Does this document PROVE the Shopee importer created it?
 *
 * The proof is recomputable from the document alone: the pedido id is the
 * deterministic digest of `(contaId, order_sn)`, so
 * `makePedidoIdShopee(contaId, numero) === docId` can only hold for a document
 * this channel wrote — no editor can author it, and no other channel's id
 * collides with it. `marketplace.tipo === 'shopee'` is a separate, unindexed,
 * positive marker the TICK uses to tell "adopted" from "not ours"; it is not
 * part of the proof.
 *
 * ⚠️ `makePedidoIdShopee` is IMPORTED, never re-derived here. Its preimage is
 * the legacy-exact `sha256("<contaId>-<orderSn>")`, and the issue's
 * `<contaId>|shopee|<order_sn>` spelling is on record as REJECTED
 * (`orderIds.ts:8-24`): a re-derivation that drifted to it would refuse every
 * migrated Shopee pedido and report an empty, confident, wrong tick.
 */
export function provaDeIdentidadeShopee(
  docId: string,
  raw: Record<string, unknown>,
): { readonly contaId: string; readonly orderSn: string } | null {
  const contaId = integracaoIdDoPedidoShopee(raw);
  if (contaId == null) return null;
  const numero = raw.numero;
  if (typeof numero !== 'string' || numero.length === 0) return null;
  if (makePedidoIdShopee(contaId, numero) !== docId) return null;
  return { contaId, orderSn: numero };
}

/**
 * How many whole days a STORED stamp is behind `nowUs`, or `null` when the
 * value will not coerce.
 *
 * ⚠️ `coerceToMicros`, not a `typeof === 'number'` read. The legacy Flutter app
 * serialised every `DateTime` as MILLISECONDS, so a migrated Shopee pedido
 * carries a ms `timestamp` — which a strict µs reader would report as 1970 and
 * which this one classifies by magnitude and answers honestly. (The Mercado
 * Livre sweep's `readMicros` is the strict shape to avoid.) The opposite rule
 * holds for a Shopee WIRE stamp, which is seconds and must go through
 * `microsDeSegundosShopee`; nothing of the sort reaches this function.
 *
 * A stamp in the FUTURE answers `0` rather than a negative age: clock skew and
 * a fill-once `timestamp` taken from Shopee's own `create_time` both make it
 * reachable, and a negative age in a bucket table reads as a defect in the
 * table.
 */
export function idadeEmDias(timestampArmazenado: unknown, nowUs: number): number | null {
  const stampUs = coerceToMicros(timestampArmazenado);
  if (stampUs == null) return null;
  return Math.max(0, Math.floor((nowUs - stampUs) / DIA_US));
}
