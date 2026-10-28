/**
 * Easy Ship package status → `freteInicial` (master plan step 7, PR 7): the
 * token table, the ladder, the write verdict, the package fold and the freight
 * group one import writes. The ONE module steps 7, 14 and 15 route their
 * `freteInicial.estado` writes through (plan §3 decision 38): a set or rule only
 * a later step consumes (step 15's "already scheduled" set; whether an
 * `ACCEPTED` invoice clears step 14's `error`) is added by that step, beside its
 * consumer.
 *
 * PURE: no Firestore, no wire call, no clock (the order clock is a parameter),
 * no environment, no logger. Every instant here is already µs; nothing is
 * converted.
 *
 * ## The table ({@link ESTADO_FRETE_DE_DETAILED_STATUS}) — exact match
 *
 * `packages[].packageStatus.detailedStatus` → `freteInicial.estado`, matched
 * EXACTLY (`Object.hasOwn`: no trim, no case fold, no inherited name), so
 * `'LABEL_CANCELED'`, `'DELIVERED '` and `'delivered'` are UNKNOWN, never a
 * guess. `PENDING_SCHEDULE` reads the ORDER's `tax.taxInvoicing.invoiceStatus`
 * as its second input. The reversal rows are typed against the ONE reversal set
 * (`DETAILED_STATUS_REVERSAO`, `pedidos/pacotesAmazon.ts`) and never a second
 * list. `packageStatus.status` (Amazon's closed enum) is stored in the diary and
 * counted in the log, never mapped to an estado or a target: there is no
 * status-only floor (plan §3 decision 37). Its one other reader is the goods-out
 * FALLBACK below, for a package whose token the table does not know.
 *
 * ## The fold ({@link dobrarPacotesAmazon})
 *
 * Over THIS read's packages: any package unknown or without a usable
 * `packageReferenceId` BLOCKS the answer (`pacote-status-desconhecido`); a
 * `PENDING_SCHEDULE` whose invoice status is absent gives no answer (a count
 * line, never a guess); otherwise the LEAST-advanced live rung wins (stock-safe:
 * the pedido leaves as a whole), failures and the reverse leg are ignored while
 * a live package exists, and with none live a DECLARED precedence by physical
 * consequence answers — never a clock. Each keyed package leaves a diary row,
 * and a row that once said the goods were out keeps saying so
 * ({@link dobrarPacotesAmazon}): it is the only record of a keyed package that
 * left while the block, at its least-advanced sibling, still says "waiting". A
 * package the fold cannot key leaves no row at all.
 *
 * ## The verdict ({@link estadoFreteAmazonAplicavel})
 *
 * Forward along {@link ESCADA_FRETE_AMAZON} only; never from an estado where the
 * goods are out to one where they are in, on any clock (a late
 * `LABEL_CANCELLED` after the pickup, a sibling still waiting beside a lost
 * package); resurrection (a failure → a live rung) only on a STRICTLY newer
 * order clock. Every other step applies on an EQUAL order clock (plan §3
 * decision 2): a package-only change Amazon did not stamp is not lost. An AFN
 * read never moves the block, and a stored `fulfillment` walks the ladder only
 * under a read that SAYS `MERCHANT` ({@link LogisticaAmazon}): an absent
 * `fulfilledBy` is no evidence of either, so the ladder never walks it. (The
 * goods-out reading below reads it on the restock side instead — and, through
 * the same flag, so does the D17 block's choice between the table's target and
 * our error, `remocaoDeEstoque` in `pedidos/pedidoMapeamento.ts`.)
 *
 * ## Goods out
 *
 * The CANCELLED predicate's "goods out" (plan §3 decision 47) ORs THREE
 * readings (`pedidos/pedidoMapeamento.ts`). The first is the stored block
 * estado, read through the ladder's legacy-residue projection widened for the
 * restock side ({@link estadoFreteParaMercadoriaForaAmazon}, PR 5-f). Under a
 * read without `fulfilledBy`, a stored `fulfillment` counts as goods out too,
 * unless the pedido is held at our own AFN error: wrongly keeping costs an
 * incidente, wrongly releasing restocks goods that may be at the carrier. The
 * second is ANY package of this read whose token projects to an estado where
 * the goods are out ({@link DobraPacotesAmazon.mercadoriaFora}). The third is
 * ANY stored diary row of this importer's own block that says so
 * ({@link diarioComMercadoriaForaAmazon}), unless the first reading reads that
 * block as `fulfillment`. That happens for an AFN seed, under an AFN read or
 * under a read without `fulfilledBy` while the pedido holds our AFN error: an
 * AFN read writes no estado but still writes the diary, and those rows are
 * Amazon's own packages. The predicate never reads the least-advanced target,
 * which is the stock-safe answer for REMOVING stock and the unsafe one for
 * RESTOCKING it. The stored block alone is not enough: it
 * lags this read's packages (the second reading), and it never shows a KEYED
 * package that left beside a sibling still waiting, which a later read may
 * cancel the pickup of or stop naming (the third). The verdict (gate 8) and the
 * fold's row gate keep the first and the third from moving from goods out to
 * goods in.
 *
 * The FALLBACK (PR 5-f, {@link statusPacoteComMercadoriaForaAmazon}): a package
 * whose `detailedStatus` the table does not know (absent included — only
 * `status` is required in the model's `PackageStatus`) projects to no estado,
 * so its token says nothing; its closed `packageStatus.status` then answers for
 * the second and the third readings — `IN_TRANSIT`, `SHIPPED`, `DELIVERED`,
 * `UNDELIVERABLE` ⇒ the goods are out. A known token always decides on its
 * own. The fallback is read on the wire (the second reading) and on a stored
 * row's verbatim `estadoMarketplace` + `statusMarketplace` (the third, same
 * ownership and AFN scope), through the ONE predicate, so a read and the next
 * read of the row it wrote answer the same. It NEVER feeds the fold's target,
 * the block estado or a row's `estado`: for REMOVING stock, an unreadable
 * package stays no answer (decision 37 holds).
 *
 * ⚠️ The residuals: a package the fold cannot key (no usable
 * `packageReferenceId`, or the same key twice in one read) BLOCKS the block and
 * leaves no row, so its goods out is read ONLY from a read that carries it (the
 * second reading). If a later read cancels its pickup or stops naming it, a
 * CANCELLED read without packages releases the pedido — pinned as it is today
 * in `pedidos/pedidoMapeamento.test.ts`, so closing it flips that test
 * deliberately. And the fallback's evidence on a KEYED row lives in that row's
 * WIRE fields, which take every read's values verbatim (the row gate keeps a
 * goods-out `estado` only, and no estado is invented from a status): a later
 * read that names the same package with a goods-in reading (a known pre-pickup
 * token, or an unknown one at `PENDING`/`CANCELLED`) rewrites them — on an
 * EQUAL order clock too, as a stale re-derive does — and a
 * CANCELLED read without packages after it releases — pinned too, in both test
 * files. The freight's own CANCELLED arm is the predicate's outcome
 * ({@link alvoFreteAmazon}), never a second copy of its rules.
 */
import type { PacoteWireAmazon, PedidoWireAmazon } from '@delfrance/integrations-amazon-sp-api';
import {
  ESTADO_FRETE,
  ESTADOS_FRETE_REMOVE_ESTOQUE,
  MOTIVO_PEDIDO_AMAZON,
  estadoFreteSchema,
  type EstadoFrete,
  type MotivoPedidoAmazon,
} from '@delfrance/schemas';

import {
  FULFILLED_BY_AMAZON,
  FULFILLMENT_STATUS_AMAZON,
  alvoCanceladoAmazon,
  type ContextoEstadoAmazon,
} from '../pedidos/estadoPedidoAmazon';
import { mercadoriaFora } from '../pedidos/freteAmazon';
import { DETAILED_STATUS_REVERSAO, type DetailedStatusReversao } from '../pedidos/pacotesAmazon';

/* -------------------------------------------------------------------------- */
/*                               the vocabulary                               */
/* -------------------------------------------------------------------------- */

/** `tax.taxInvoicing.invoiceStatus` (an open string on the wire; a REFERENCE list). */
export const INVOICE_STATUS_AMAZON = {
  notRequired: 'NOT_REQUIRED',
  notFound: 'NOT_FOUND',
  processing: 'PROCESSING',
  errored: 'ERRORED',
  accepted: 'ACCEPTED',
} as const satisfies Record<string, string>;

/**
 * `packageStatus.status` — Amazon's CLOSED enum (Orders v2026 `PackageStatus`;
 * an open string on the wire). Never mapped to a freight estado or a target
 * (no status-only floor, plan §3 decision 37). Its ONE consumer outside the
 * diary and the log is the goods-out fallback
 * ({@link MERCADORIA_FORA_DO_STATUS_PACOTE_AMAZON}).
 */
export const STATUS_PACOTE_AMAZON = {
  pending: 'PENDING',
  inTransit: 'IN_TRANSIT',
  shipped: 'SHIPPED',
  delivered: 'DELIVERED',
  cancelled: 'CANCELLED',
  undeliverable: 'UNDELIVERABLE',
} as const satisfies Record<string, string>;

export type StatusPacoteAmazon = (typeof STATUS_PACOTE_AMAZON)[keyof typeof STATUS_PACOTE_AMAZON];

/**
 * Whether the goods are out at each closed `packageStatus.status` — an
 * EXPLICIT, EXHAUSTIVE table (a missing member is a compile error), read ONLY
 * by the goods-out fallback ({@link statusPacoteComMercadoriaForaAmazon}),
 * never by the fold's target. `IN_TRANSIT`, `SHIPPED`, `DELIVERED` and
 * `UNDELIVERABLE` say the package left the warehouse (an undeliverable parcel
 * is with the carrier or on its way back, never on the shelf); `PENDING` and
 * `CANCELLED` do not.
 */
export const MERCADORIA_FORA_DO_STATUS_PACOTE_AMAZON: Readonly<
  Record<StatusPacoteAmazon, boolean>
> = Object.freeze({
  PENDING: false,
  IN_TRANSIT: true,
  SHIPPED: true,
  DELIVERED: true,
  CANCELLED: false,
  UNDELIVERABLE: true,
});

/** The two tokens the fold names on their own. */
export const DETAILED_STATUS_AMAZON = {
  /** The invoice status decides (rung 2 or 4). */
  pendingSchedule: 'PENDING_SCHEDULE',
  /** The PICKUP was cancelled, not the order (plan §3 decision 35). */
  labelCancelled: 'LABEL_CANCELLED',
} as const satisfies Record<string, string>;

/**
 * The closed set of sources of a diary row (`PacoteFrete['fonte']` is a free
 * string on purpose: the set is per channel). This importer has ONE.
 */
export const FONTE_PACOTE_AMAZON = { getOrder: 'getOrder' } as const satisfies Record<
  string,
  string
>;

/**
 * The order's logistics as ONE read states it — `fulfillment.fulfilledBy`,
 * matched EXACTLY: `MERCHANT` ⇒ `mfn`, `AMAZON` ⇒ `afn`, anything else (absent,
 * blank, another spelling) ⇒ `desconhecida`. Never inferred from the stored
 * block: a `fulfillment` this importer seeded for an AFN order and the legacy
 * residue on an MFN order hold the same value. Only the goods-out reading tells
 * them apart under `desconhecida`, and it does so by the stored PEDIDO (our
 * own AFN error), never by a logistics it infers
 * ({@link estadoFreteParaMercadoriaForaAmazon}).
 */
export type LogisticaAmazon = 'mfn' | 'afn' | 'desconhecida';

export const LOGISTICA_AMAZON = {
  mfn: 'mfn',
  afn: 'afn',
  desconhecida: 'desconhecida',
} as const satisfies Record<string, LogisticaAmazon>;

/** {@link LogisticaAmazon} from the raw `fulfilledBy` (exact match, no trim, no case fold). */
export function logisticaAmazon(fulfilledBy: unknown): LogisticaAmazon {
  if (fulfilledBy === FULFILLED_BY_AMAZON.merchant) return LOGISTICA_AMAZON.mfn;
  if (fulfilledBy === FULFILLED_BY_AMAZON.amazon) return LOGISTICA_AMAZON.afn;
  return LOGISTICA_AMAZON.desconhecida;
}

/** `pacoteFreteSchema.numero` is `.min(1).max(60)`; a longer reference cannot key a row. */
export const LIMITE_CHAVE_PACOTE_AMAZON = 60;
/** `pacoteFreteSchema.estadoMarketplace` is `.max(120)`. */
export const LIMITE_TOKEN_PACOTE_AMAZON = 120;
/** `freteDoPedidoSchema.codRastreio` and `pacoteFreteSchema.codRastreio` are `.max(200)`. */
export const LIMITE_COD_RASTREIO_AMAZON = 200;

/* -------------------------------------------------------------------------- */
/*                                  the table                                 */
/* -------------------------------------------------------------------------- */

/** A table row: an estado, or `nota` — the invoice status decides (`PENDING_SCHEDULE`). */
export type LinhaFreteAmazon =
  | { readonly tipo: 'estado'; readonly estado: EstadoFrete }
  | { readonly tipo: 'nota' };

function linha(estado: EstadoFrete): LinhaFreteAmazon {
  return Object.freeze({ tipo: 'estado', estado });
}

/**
 * The ONE reversal set, as this table reads it — the same object, identity-equal
 * (`estadoFreteAmazon.test.ts` pins it): never a second list.
 */
export const REVERSAO_DO_FRETE_AMAZON = DETAILED_STATUS_REVERSAO;

/**
 * The reversal rows, typed against the reversal set: a missing or an extra
 * token is a compile error.
 */
const ESTADO_FRETE_DA_REVERSAO: Readonly<Record<DetailedStatusReversao, EstadoFrete>> = {
  REJECTED_BY_BUYER: ESTADO_FRETE.falhaNaEntrega,
  UNDELIVERABLE: ESTADO_FRETE.enderecoNaoEncontrado,
  RETURNING_TO_SELLER: ESTADO_FRETE.aCaminhoDoRemetente,
  RETURNED_TO_SELLER: ESTADO_FRETE.devolvido,
  LOST: ESTADO_FRETE.objetoExtraviado,
  DAMAGED: ESTADO_FRETE.objetoExtraviado,
};

/**
 * `detailedStatus` → the freight estado (module header). The WHOLE table:
 *
 * | token | target |
 * |---|---|
 * | `PENDING_SCHEDULE` | `NOT_FOUND`/`PROCESSING`/`ERRORED` ⇒ `aguardandoNFe`; `ACCEPTED` or `NOT_REQUIRED` ⇒ `aguardandoAgendamento`; absent or unknown ⇒ no change |
 * | `PENDING_PICK_UP`, `PENDING_DROP_OFF` | `aguardandoPostagem` (starts the stock removal at scheduling, plan §3 decision 36) |
 * | `LABEL_CANCELLED` | `despachoNegado` + `coleta-cancelada` (plan §3 decision 35: rescheduling stays in Seller Central) |
 * | `PICKED_UP`, `DROPPED_OFF` | `postado` |
 * | `AT_ORIGIN_FC` | `recebidoPelaTransportadora` |
 * | `AT_DESTINATION_FC` | `aCaminho` |
 * | `OUT_FOR_DELIVERY` | `tentandoRealizarEntrega` |
 * | `DELIVERED` | `entregue` |
 * | the reversal set | `falhaNaEntrega`, `enderecoNaoEncontrado`, `aCaminhoDoRemetente`, `devolvido`, `objetoExtraviado` (×2) |
 * | anything else, absent included | unknown: blocks the fold + `pacote-status-desconhecido` |
 */
export const ESTADO_FRETE_DE_DETAILED_STATUS: Readonly<Record<string, LinhaFreteAmazon>> =
  Object.freeze({
    [DETAILED_STATUS_AMAZON.pendingSchedule]: Object.freeze({ tipo: 'nota' as const }),
    PENDING_PICK_UP: linha(ESTADO_FRETE.aguardandoPostagem),
    PENDING_DROP_OFF: linha(ESTADO_FRETE.aguardandoPostagem),
    [DETAILED_STATUS_AMAZON.labelCancelled]: linha(ESTADO_FRETE.despachoNegado),
    PICKED_UP: linha(ESTADO_FRETE.postado),
    DROPPED_OFF: linha(ESTADO_FRETE.postado),
    AT_ORIGIN_FC: linha(ESTADO_FRETE.recebidoPelaTransportadora),
    AT_DESTINATION_FC: linha(ESTADO_FRETE.aCaminho),
    OUT_FOR_DELIVERY: linha(ESTADO_FRETE.tentandoRealizarEntrega),
    DELIVERED: linha(ESTADO_FRETE.entregue),
    ...Object.fromEntries(
      Object.entries(ESTADO_FRETE_DA_REVERSAO).map(([token, estado]) => [token, linha(estado)]),
    ),
  });

/** What one package (or an order without packages) says about the freight. */
export type ProjecaoPacoteAmazon =
  | {
      readonly tipo: 'estado';
      readonly estado: EstadoFrete;
      /** `PENDING_SCHEDULE` + `NOT_REQUIRED`: unexpected for a BR Easy Ship order (a count line). */
      readonly notaNaoExigida: boolean;
    }
  /** `PENDING_SCHEDULE` (or a to-ship order without packages) with no usable invoice status: no change. */
  | { readonly tipo: 'sem-nota' }
  /** A token the table does not hold (absent included): blocks the fold. */
  | { readonly tipo: 'desconhecido' };

const DESCONHECIDO: ProjecaoPacoteAmazon = Object.freeze({ tipo: 'desconhecido' });
const SEM_NOTA: ProjecaoPacoteAmazon = Object.freeze({ tipo: 'sem-nota' });

function projecaoEstado(estado: EstadoFrete, notaNaoExigida = false): ProjecaoPacoteAmazon {
  return { tipo: 'estado', estado, notaNaoExigida };
}

/** The `PENDING_SCHEDULE` branch: the invoice status decides, EXACTLY. */
function projecaoDaNota(invoiceStatus: unknown): ProjecaoPacoteAmazon {
  switch (invoiceStatus) {
    case INVOICE_STATUS_AMAZON.notFound:
    case INVOICE_STATUS_AMAZON.processing:
    case INVOICE_STATUS_AMAZON.errored:
      return projecaoEstado(ESTADO_FRETE.aguardandoNFe);
    case INVOICE_STATUS_AMAZON.accepted:
      return projecaoEstado(ESTADO_FRETE.aguardandoAgendamento);
    case INVOICE_STATUS_AMAZON.notRequired:
      return projecaoEstado(ESTADO_FRETE.aguardandoAgendamento, true);
    default:
      return SEM_NOTA;
  }
}

/** The table's row for a `detailedStatus`, matched EXACTLY; `null` = unknown (absent included). */
function linhaDoToken(detailedStatus: unknown): LinhaFreteAmazon | null {
  if (typeof detailedStatus !== 'string') return null;
  if (!Object.hasOwn(ESTADO_FRETE_DE_DETAILED_STATUS, detailedStatus)) return null;
  return ESTADO_FRETE_DE_DETAILED_STATUS[detailedStatus] ?? null;
}

/** One package's `detailedStatus` (+ the order's invoice status) → its projection. */
export function projetarPacoteAmazon(
  detailedStatus: unknown,
  invoiceStatus: unknown,
): ProjecaoPacoteAmazon {
  const linhaDaTabela = linhaDoToken(detailedStatus);
  if (linhaDaTabela === null) return DESCONHECIDO;
  return linhaDaTabela.tipo === 'estado'
    ? projecaoEstado(linhaDaTabela.estado)
    : projecaoDaNota(invoiceStatus);
}

/**
 * The goods-out FALLBACK on `packageStatus.status` (PR 5-f), for ONE package
 * — or one stored diary row, read through its verbatim `estadoMarketplace` and
 * `statusMarketplace`: `true` only when its `detailedStatus` is NOT a row of
 * the table (absent, blank, an undocumented or misspelt token — the
 * `desconhecido` projection) AND its closed status says the package left
 * ({@link MERCADORIA_FORA_DO_STATUS_PACOTE_AMAZON}, matched EXACTLY: no trim,
 * no case fold, no inherited name; an unknown status is not goods out).
 *
 * A KNOWN `detailedStatus` always decides on its own, whatever the status
 * says: `PENDING_PICK_UP` beside `SHIPPED` is not goods out, and
 * `PICKED_UP` beside `PENDING` is. The fallback feeds the CANCELLED
 * predicate's goods-out readings ONLY — the RESTOCK side, where reading an
 * unreadable package as "in the warehouse" puts units back on the shelf that
 * Amazon says are with the carrier — and, through the same flag, whether a
 * D17 block keeps the table's target instead of our error
 * (`remocaoDeEstoque`, `pedidos/pedidoMapeamento.ts`), the same question
 * asked of a block. It never feeds the fold's target, the
 * block, a diary row's `estado` or the reversal signal: for REMOVING stock,
 * the stock-safe answer to an unreadable package stays no answer (plan §3
 * decision 37: no status-only floor).
 */
export function statusPacoteComMercadoriaForaAmazon(
  detailedStatus: unknown,
  status: unknown,
): boolean {
  if (linhaDoToken(detailedStatus) !== null) return false;
  return (
    typeof status === 'string' &&
    Object.hasOwn(MERCADORIA_FORA_DO_STATUS_PACOTE_AMAZON, status) &&
    MERCADORIA_FORA_DO_STATUS_PACOTE_AMAZON[status as StatusPacoteAmazon]
  );
}

/**
 * An order WITHOUT packages (`packages` absent or `[]`): `UNSHIPPED` /
 * `PARTIALLY_SHIPPED` ⇒ the invoice status decides as the `PENDING_SCHEDULE`
 * rows; `PENDING`, `SHIPPED` (C1 decides whether a `postado` floor is honest),
 * `CANCELLED` (its own rule, {@link alvoFreteAmazon}) and anything else ⇒ no
 * change (`null`).
 */
export function alvoSemPacotesAmazon(
  order: Pick<PedidoWireAmazon, 'fulfillment' | 'tax'>,
): ProjecaoPacoteAmazon | null {
  switch (order.fulfillment?.fulfillmentStatus) {
    case FULFILLMENT_STATUS_AMAZON.unshipped:
    case FULFILLMENT_STATUS_AMAZON.partiallyShipped:
      return projecaoDaNota(order.tax?.taxInvoicing?.invoiceStatus);
    case null:
    case undefined:
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/*                            the ladder, the sets                            */
/* -------------------------------------------------------------------------- */

/**
 * The ladder — ENUMERATED and pinned on its own, never "a subsequence of the
 * enum order": `aguardandoAgendamento` sits BEFORE `despachoAutorizado` here.
 * The `checkFinalizado` non-downgrade falls out of it (`PENDING_PICK_UP` is
 * rung 8 < 9).
 */
export const ESCADA_FRETE_AMAZON = [
  ESTADO_FRETE.iniciado, //                          0  step 5's seed
  ESTADO_FRETE.aguardandoAutorizacao, //             1
  ESTADO_FRETE.aguardandoNFe, //                     2  PENDING_SCHEDULE, invoice not accepted
  ESTADO_FRETE.aguardandoValidacaoTransporadora, //  3
  ESTADO_FRETE.aguardandoAgendamento, //             4  PENDING_SCHEDULE, invoice accepted
  ESTADO_FRETE.despachoAutorizado, //                5  step 15
  ESTADO_FRETE.emSeparacao, //                       6
  ESTADO_FRETE.empacotado, //                        7
  ESTADO_FRETE.aguardandoPostagem, //                8  PENDING_PICK_UP / PENDING_DROP_OFF
  ESTADO_FRETE.checkFinalizado, //                   9  the operator's dispatch checkout
  ESTADO_FRETE.postado, //                          10  PICKED_UP / DROPPED_OFF
  ESTADO_FRETE.recebidoPelaTransportadora, //       11  AT_ORIGIN_FC
  ESTADO_FRETE.aCaminho, //                         12  AT_DESTINATION_FC
  ESTADO_FRETE.tentandoRealizarEntrega, //          13  OUT_FOR_DELIVERY
  ESTADO_FRETE.entregue, //                         14  DELIVERED, terminal
] as const satisfies readonly EstadoFrete[];

/**
 * Failures, beside the chain. A stored `cancelado` on an order Amazon has NOT
 * cancelled (a legacy residue) is a failure like `despachoNegado`: left only
 * forward to `entregue`, or to a live rung on a strictly newer order clock.
 */
export const FALHAS_FRETE_AMAZON: ReadonlySet<EstadoFrete> = new Set<EstadoFrete>([
  ESTADO_FRETE.falhaNaEntrega,
  ESTADO_FRETE.enderecoNaoEncontrado,
  ESTADO_FRETE.objetoExtraviado,
  ESTADO_FRETE.despachoNegado,
  ESTADO_FRETE.cancelado,
]);

/** The reverse leg: `{falhaNaEntrega | enderecoNaoEncontrado} → aCaminhoDoRemetente → devolvido`. */
export const RETORNO_FRETE_AMAZON = [
  ESTADO_FRETE.aCaminhoDoRemetente,
  ESTADO_FRETE.devolvido,
] as const satisfies readonly EstadoFrete[];

/**
 * A block another modality owns. `fulfillment` is too, unless the read says
 * `MERCHANT` ({@link estadoFreteAmazonAplicavel}); and an AFN read moves no
 * block at all.
 */
export const FORA_DO_CANAL_FRETE_AMAZON: ReadonlySet<EstadoFrete> = new Set<EstadoFrete>([
  ESTADO_FRETE.aguardandoRetirada,
  ESTADO_FRETE.suspenso,
]);

/**
 * With NO live package: the precedence by PHYSICAL consequence, never by clock
 * (a clock-ordered answer is not idempotent). The plan's list
 * (`objetoExtraviado` > `falhaNaEntrega` > `enderecoNaoEncontrado` >
 * `despachoNegado` > `cancelado`) with the reverse leg placed where its
 * physical consequence sits: after the failures that start it, least-advanced
 * first (the pedido returns as a whole only when every package did).
 */
export const ORDEM_SEM_PACOTE_VIVO_AMAZON = [
  ESTADO_FRETE.objetoExtraviado,
  ESTADO_FRETE.falhaNaEntrega,
  ESTADO_FRETE.enderecoNaoEncontrado,
  ESTADO_FRETE.aCaminhoDoRemetente,
  ESTADO_FRETE.devolvido,
  ESTADO_FRETE.despachoNegado,
  ESTADO_FRETE.cancelado,
] as const satisfies readonly EstadoFrete[];

function indiceEscada(estado: EstadoFrete): number {
  return (ESCADA_FRETE_AMAZON as readonly EstadoFrete[]).indexOf(estado);
}

function indiceRetorno(estado: EstadoFrete): number {
  return (RETORNO_FRETE_AMAZON as readonly EstadoFrete[]).indexOf(estado);
}

/* -------------------------------------------------------------------------- */
/*                                 the verdict                                */
/* -------------------------------------------------------------------------- */

/** Why a freight estado was NOT written. */
export type MotivoFreteAmazon =
  /** No target (an unknown, unkeyed or invoice-less read, or nothing to say). */
  | 'sem-alvo'
  /** The stored estado already IS the target. */
  | 'sem-mudanca'
  /**
   * The block belongs to another modality, the read is AFN, or a stored
   * `fulfillment` under a read that does not say `MERCHANT`.
   */
  | 'fora-do-canal'
  /** The stored `error` (step 14's stamp) and the target is no physical fact. */
  | 'erro-preservado'
  /** The stored estado is on the reverse leg and the target is not forward on it. */
  | 'retorno-preservado'
  /**
   * Backwards on {@link ESCADA_FRETE_AMAZON}, or — on any clock — from an
   * estado where the goods are out (`MERCADORIA_FORA`, through the residue
   * projection) to ANY target where they are in, on the ladder or off it
   * ({@link estadoFreteAmazonAplicavel}, gate 8).
   */
  | 'regressivo'
  /** A failure → a live rung on an order clock that is not strictly newer. */
  | 'terminal';

export const MOTIVO_FRETE_AMAZON = {
  semAlvo: 'sem-alvo',
  semMudanca: 'sem-mudanca',
  foraDoCanal: 'fora-do-canal',
  erroPreservado: 'erro-preservado',
  retornoPreservado: 'retorno-preservado',
  regressivo: 'regressivo',
  terminal: 'terminal',
} as const satisfies Record<string, MotivoFreteAmazon>;

export type VereditoFreteAmazon =
  | { readonly escrever: true; readonly estado: EstadoFrete; readonly ressuscitado: boolean }
  | { readonly escrever: false; readonly motivo: MotivoFreteAmazon };

/**
 * The stored freight estado as the LADDER reads it. The goods-out check reads
 * it through {@link estadoFreteParaMercadoriaForaAmazon}, which is this
 * projection under a `MERCHANT` or an AFN read and widens it only under a read
 * without `fulfilledBy`. The legacy residue (described by shape): a stored
 * `fulfillment` under a read that says `MERCHANT` stands for a package already
 * at the carrier's facility, rung 11 (`recebidoPelaTransportadora`, goods out).
 * Under any other read it is returned as stored: the AFN seed of this importer
 * holds the same value, and an absent `fulfilledBy` does not say which one it
 * is, so the ladder never walks it.
 */
export function estadoFreteEfetivoAmazon(
  armazenado: EstadoFrete,
  logistica: LogisticaAmazon,
): EstadoFrete {
  return armazenado === ESTADO_FRETE.fulfillment && logistica === LOGISTICA_AMAZON.mfn
    ? ESTADO_FRETE.recebidoPelaTransportadora
    : armazenado;
}

/**
 * The stored freight estado as the CANCELLED predicate's FIRST goods-out
 * reading reads it (PR 5-f) — and, through the same flag, whether a D17 block
 * keeps the table's target instead of our error (`remocaoDeEstoque`,
 * `pedidos/pedidoMapeamento.ts`). It is {@link estadoFreteEfetivoAmazon} with ONE
 * widening, on the restock side only: a stored `fulfillment` under a read whose
 * logistics is `desconhecida` (no `fulfilledBy`, a blank, another spelling) is
 * read as the legacy residue too, rung 11 and goods out, UNLESS `afnNosso`
 * says the stored pedido is held at this importer's own AFN error
 * (`ehErroAfnAmazon`). That is the state an AFN seed is created in, and every
 * later AFN read, or read without `fulfilledBy`, keeps it. Under `MERCHANT` and
 * AFN it IS the ladder's projection: an AFN read still never reads the stored
 * value as goods out, because Amazon then says the order is its own.
 *
 * Why the two readings differ: the ladder must not WALK a block it cannot
 * attribute (an AFN block never moves into a stock-removal estado), while a
 * CANCELLED read must not RESTOCK goods that may already be at the carrier.
 * The two errors cost differently. Wrongly keeping a cancelled pedido costs an
 * incidente a person reads (`cancelado-apos-envio`). Wrongly releasing one puts
 * units that left back on sale. The stored `marketplace.fulfilledBy` is not the
 * tiebreak: a migrated pedido holds no such field until this importer writes
 * one, and this importer rewrites it verbatim on every read (`null` on a read
 * without it).
 */
export function estadoFreteParaMercadoriaForaAmazon(
  armazenado: EstadoFrete,
  e: { readonly logistica: LogisticaAmazon; readonly afnNosso: boolean },
): EstadoFrete {
  if (
    armazenado === ESTADO_FRETE.fulfillment &&
    e.logistica === LOGISTICA_AMAZON.desconhecida &&
    !e.afnNosso
  ) {
    return ESTADO_FRETE.recebidoPelaTransportadora;
  }
  return estadoFreteEfetivoAmazon(armazenado, e.logistica);
}

/**
 * May the stored `freteInicial.estado` be moved to the target? Gates, in order:
 *
 *  1. no target ⇒ `sem-alvo`;
 *  2. the same estado ⇒ `sem-mudanca`;
 *  3. an AFN read ⇒ `fora-do-canal`, WHATEVER is stored (the freight is
 *     Amazon's own: a block never walks into a stock-removal estado for it);
 *  4. a stored `aguardandoRetirada` or `suspenso`, or a stored `fulfillment`
 *     under a read that does not say `MERCHANT` ⇒ `fora-do-canal`;
 *  5. a stored `error` (step 14's future stamp) ⇒ written ONLY for a physical
 *     fact: a target in the SHARED `ESTADOS_FRETE_REMOVE_ESTOQUE`;
 *  6. a stored estado on the reverse leg ⇒ only forward on that leg;
 *  7. both on the ladder (the stored one through the residue projection) and
 *     the target lower ⇒ `regressivo`;
 *  8. the goods OUT at the stored estado (`MERCADORIA_FORA`, through the same
 *     residue projection) and IN at the target ⇒ `regressivo`, on ANY clock.
 *     What reaches it — pinned in `estadoFreteAmazon.test.ts` over every stored
 *     estado × every target × the three logistics × both clocks: a stored rung
 *     from `postado` up (the `fulfillment` residue under a `MERCHANT` read
 *     included, as rung 11) against the OFF-ladder targets where the goods are
 *     in — `despachoNegado`, `cancelado`, `desconhecido`, `error`,
 *     `fulfillment` (gate 7 already refused every lower rung; the residue
 *     against itself is gate 2's); and a stored `falhaNaEntrega`,
 *     `enderecoNaoEncontrado` or `objetoExtraviado` against EVERY target where
 *     the goods are in — those five and the rungs `iniciado` …
 *     `checkFinalizado`. An AFN read never reaches it. It runs BEFORE gates 9
 *     and 10, so a goods-out failure never resurrects into a goods-in rung: a
 *     sibling package still waiting beside a lost one, or a `LABEL_CANCELLED`
 *     after the pickup (a late read, or a sibling's), is no fact that puts the
 *     units back on the shelf, and writing it would erase the evidence the
 *     CANCELLED predicate reads — a later CANCELLED read without packages
 *     would restock goods that already left. `cancelado` is DEFENSIVE here: the
 *     CANCELLED predicate KEEPS over the same projection, so this importer
 *     never asks for it over goods out. A future step-14 `error` stamp routed
 *     through this verdict is refused over goods-out freight. The diary row and
 *     the `coleta-cancelada` motivo do not depend on this verdict;
 *  9. a failure → `entregue` ⇒ always written;
 * 10. a failure → a live rung ⇒ only on a STRICTLY newer order clock
 *     (`ressuscitado`), `terminal` on an equal one. What still reaches it after
 *     gate 8: a goods-IN failure (`despachoNegado`, `cancelado`) → any rung
 *     below `entregue` — the reschedule after `LABEL_CANCELLED` (plan §3
 *     decision 35) arrives this way — and a goods-OUT failure → a goods-out
 *     rung below it (`postado` … `tentandoRealizarEntrega`);
 * 11. otherwise written.
 *
 * Legacy residues in migrated pedidos (described by shape): a stored
 * `fulfillment` under a `MERCHANT` read reads as rung 11
 * ({@link estadoFreteEfetivoAmazon}: a later `PICKED_UP` is regressive,
 * `AT_DESTINATION_FC` is written, `LABEL_CANCELLED` is regressive); a stored
 * `desconhecido` is overwritable (it is on no ladder, list or set: gate 11).
 */
export function estadoFreteAmazonAplicavel(
  armazenado: EstadoFrete,
  alvo: EstadoFrete | null,
  opcoes: { readonly maisNovo: boolean; readonly logistica: LogisticaAmazon },
): VereditoFreteAmazon {
  if (alvo === null) return { escrever: false, motivo: MOTIVO_FRETE_AMAZON.semAlvo };
  if (alvo === armazenado) return { escrever: false, motivo: MOTIVO_FRETE_AMAZON.semMudanca };
  if (opcoes.logistica === LOGISTICA_AMAZON.afn) {
    return { escrever: false, motivo: MOTIVO_FRETE_AMAZON.foraDoCanal };
  }
  if (
    FORA_DO_CANAL_FRETE_AMAZON.has(armazenado) ||
    (armazenado === ESTADO_FRETE.fulfillment && opcoes.logistica !== LOGISTICA_AMAZON.mfn)
  ) {
    return { escrever: false, motivo: MOTIVO_FRETE_AMAZON.foraDoCanal };
  }
  if (armazenado === ESTADO_FRETE.error) {
    return ESTADOS_FRETE_REMOVE_ESTOQUE.has(alvo)
      ? { escrever: true, estado: alvo, ressuscitado: false }
      : { escrever: false, motivo: MOTIVO_FRETE_AMAZON.erroPreservado };
  }
  const deRetorno = indiceRetorno(armazenado);
  if (deRetorno >= 0) {
    return indiceRetorno(alvo) > deRetorno
      ? { escrever: true, estado: alvo, ressuscitado: false }
      : { escrever: false, motivo: MOTIVO_FRETE_AMAZON.retornoPreservado };
  }
  // The legacy residue: `fulfillment` under a MERCHANT read sits at rung 11.
  const efetivo = estadoFreteEfetivoAmazon(armazenado, opcoes.logistica);
  const de = indiceEscada(efetivo);
  const para = indiceEscada(alvo);
  if (de >= 0 && para >= 0 && para < de) {
    return { escrever: false, motivo: MOTIVO_FRETE_AMAZON.regressivo };
  }
  // Goods out → goods in, on any clock — BEFORE the resurrection gate.
  if (mercadoriaFora(efetivo) && !mercadoriaFora(alvo)) {
    return { escrever: false, motivo: MOTIVO_FRETE_AMAZON.regressivo };
  }
  if (FALHAS_FRETE_AMAZON.has(efetivo) && para >= 0 && alvo !== ESTADO_FRETE.entregue) {
    return opcoes.maisNovo
      ? { escrever: true, estado: alvo, ressuscitado: true }
      : { escrever: false, motivo: MOTIVO_FRETE_AMAZON.terminal };
  }
  return { escrever: true, estado: alvo, ressuscitado: false };
}

/* -------------------------------------------------------------------------- */
/*                                   the fold                                 */
/* -------------------------------------------------------------------------- */

/** A diary row, raw (a stored one is never trusted, a new one is written as built). */
export type LinhaDiarioAmazon = Readonly<Record<string, unknown>>;

/** The fold of one read's packages. */
export interface DobraPacotesAmazon {
  /** The fold target, or `null` (blocked, invoice-less, or no package). */
  readonly alvo: EstadoFrete | null;
  /** Some package's token is unknown, or it has no usable key (`pacote-status-desconhecido`). */
  readonly bloqueado: boolean;
  /** Some `PENDING_SCHEDULE` package had no usable invoice status (a count line). */
  readonly semNota: boolean;
  /** Some `PENDING_SCHEDULE` package read `NOT_REQUIRED` (a count line). */
  readonly notaNaoExigida: boolean;
  /** Some package is `LABEL_CANCELLED`, keyed or not (`coleta-cancelada`). */
  readonly coletaCancelada: boolean;
  /**
   * Some package of this read — keyed or not, beside an unknown sibling or not —
   * PROJECTS to an estado where the goods are out (`mercadoriaFora`), or, its
   * token unknown (absent included), carries a closed status that says it left
   * ({@link statusPacoteComMercadoriaForaAmazon}, PR 5-f): the CANCELLED
   * predicate's second reading, this read's own (plan §3 decision 47).
   * Computed apart from {@link alvo}: the least-advanced rung, or no answer at
   * all, is the stock-safe reading for REMOVING stock and the unsafe one for
   * restocking. A missing key makes a package unaddressable, not its status
   * unreadable — for THIS read only: an unkeyed package leaves no row, so no
   * later read's predicate sees it (the module header's residual). The row
   * gate's kept estado does not feed it: that estado comes from a STORED row,
   * which the predicate's third reading already counts
   * ({@link diarioComMercadoriaForaAmazon}).
   */
  readonly mercadoriaFora: boolean;
  /**
   * The whole diary after this read, sorted ascending by `numero`: this read's
   * KEYED packages (each row's `estado` through the row gate of
   * {@link dobrarPacotesAmazon}), plus every stored row this read does not name,
   * kept as stored (a package missing from one read is not evidence it stopped
   * existing; a stored row whose key this read carries twice is kept too). A
   * package without a usable key has no row. The fold's target and flags never
   * read a stored row; the CANCELLED predicate does.
   */
  readonly pacotes: readonly LinhaDiarioAmazon[];
  /** This read's distinct tracking numbers, by `numero`, `', '`-joined and capped; `null` = nothing to say. */
  readonly codRastreio: string | null;
  readonly contagens: {
    readonly pacotes: number;
    readonly naoMapeados: number;
    readonly semChave: number;
  };
  /** The distinct `packageStatus.status` values (closed codes, else `<outro>`/`<ausente>`), sorted, `,`-joined. */
  readonly statusPacotes: string;
}

export interface ContextoDobraAmazon {
  /** The order's `tax.taxInvoicing.invoiceStatus` (raw). */
  readonly invoiceStatus: unknown;
  /** The ORDER clock, µs — a row's `atualizadoEm` when its wire fields changed. */
  readonly relogioUs: number;
  /** The stored `freteInicial.pacotes` (raw; anything that is not an array reads as none). */
  readonly armazenados: unknown;
}

/** A usable key: a string with a visible character, ≤ 60, VERBATIM. */
function chaveDoPacote(valor: unknown): string | null {
  return typeof valor === 'string' &&
    valor.trim() !== '' &&
    valor.length <= LIMITE_CHAVE_PACOTE_AMAZON
    ? valor
    : null;
}

/** A verbatim wire text, `null` when absent, blank or over `limite`. */
function textoVerbatim(valor: unknown, limite: number): string | null {
  return typeof valor === 'string' && valor.trim() !== '' && valor.length <= limite ? valor : null;
}

function objeto(valor: unknown): Readonly<Record<string, unknown>> | null {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Readonly<Record<string, unknown>>)
    : null;
}

/** Plain code-unit order — never `localeCompare` (locale-dependent). */
function compararTexto(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function numeroDaLinha(linhaDiario: LinhaDiarioAmazon): string | null {
  return typeof linhaDiario.numero === 'string' ? linhaDiario.numero : null;
}

/**
 * A STORED diary row's `estado`, read defensively (rows are raw, never
 * trusted): a member of the enum, or `null` — not an object, no `estado`, or a
 * value outside the enum (no trim, no case fold). Read AS STORED: a row's
 * `estado` is this importer's own projection of a token, never a legacy
 * residue, so the block's residue projection does not apply. The ONE reader of
 * a stored row's `estado`, for the row gate and for the CANCELLED predicate
 * alike, so the two never disagree on one row.
 */
export function estadoDaLinhaAmazon(linhaDiario: unknown): EstadoFrete | null {
  const o = objeto(linhaDiario);
  if (o === null) return null;
  const lido = estadoFreteSchema.safeParse(o.estado);
  return lido.success ? lido.data : null;
}

/**
 * Some STORED diary row says the goods are out — the CANCELLED predicate's
 * THIRD reading (plan §3 decision 47; the module header). The caller hands in
 * the rows of this importer's own `amz` block only: another channel's diary is
 * its own importer's, and that block's estado already speaks for it. Nor does
 * it hand in the rows of a block the first reading reads as `fulfillment` (an
 * AFN seed: under an AFN read, or under a read without `fulfilledBy` while the
 * pedido holds our AFN error, {@link estadoFreteParaMercadoriaForaAmazon}): an
 * AFN read writes no estado but still writes the diary, and those rows are
 * Amazon's own packages, never this ERP's stock. A row says the goods are out by its `estado`
 * ({@link estadoDaLinhaAmazon}), or (PR 5-f) — its verbatim
 * `estadoMarketplace` not a token the table knows, absent included — by its
 * verbatim `statusMarketplace` ({@link statusPacoteComMercadoriaForaAmazon},
 * the same predicate the read's own packages go through, so the row a read
 * wrote answers what that read answered). A row whose `estado` does not read
 * and whose statuses do not say it contributes nothing, and anything that is
 * not an array reads as no row. Every readable stored row counts, a string
 * `numero` or not: wrongly KEEPING a cancelled pedido costs an incidente a
 * person reads, wrongly releasing it restocks goods that left. A `devolvido`
 * row counts too (`MERCADORIA_FORA.devolvido`): a package Amazon reported
 * returned to the seller keeps a CANCELLED pedido, and a person restocks those
 * units by hand — the accepted cost. Only KEYED packages ever reach the diary:
 * an unkeyed one is the module header's residual; so is a status-only row a
 * later goods-in read of the same package rewrote.
 */
export function diarioComMercadoriaForaAmazon(armazenados: unknown): boolean {
  return (
    Array.isArray(armazenados) &&
    (armazenados as unknown[]).some((l) => {
      if (mercadoriaFora(estadoDaLinhaAmazon(l))) return true;
      const o = objeto(l);
      return (
        o !== null && statusPacoteComMercadoriaForaAmazon(o.estadoMarketplace, o.statusMarketplace)
      );
    })
  );
}

/** Rows with a string `numero` first, ascending; any other kept row after them, in stored order. */
function ordenarDiario(linhas: LinhaDiarioAmazon[]): LinhaDiarioAmazon[] {
  return linhas
    .map((l, i) => ({ l, i }))
    .sort((a, b) => {
      const na = numeroDaLinha(a.l);
      const nb = numeroDaLinha(b.l);
      if (na !== null && nb !== null) return compararTexto(na, nb) || a.i - b.i;
      if (na !== null) return -1;
      if (nb !== null) return 1;
      return a.i - b.i;
    })
    .map(({ l }) => l);
}

/** The joined tracking numbers: whole entries only, a ` +N` remainder when they do not fit. */
function juntarCodRastreio(numeros: readonly string[]): string | null {
  const primeiro = numeros[0];
  if (primeiro === undefined) return null;
  const inteiro = numeros.join(', ');
  if (inteiro.length <= LIMITE_COD_RASTREIO_AMAZON) return inteiro;
  for (let mantidos = numeros.length - 1; mantidos >= 1; mantidos -= 1) {
    const texto = `${numeros.slice(0, mantidos).join(', ')} +${String(numeros.length - mantidos)}`;
    if (texto.length <= LIMITE_COD_RASTREIO_AMAZON) return texto;
  }
  // Every number is ≤ 200 by construction, so the first one alone always fits.
  return primeiro;
}

/** `packageStatus.status` as a closed code for the log. */
function statusComoCodigo(valor: unknown): string {
  if (valor === null || valor === undefined) return '<ausente>';
  return typeof valor === 'string' &&
    (Object.values(STATUS_PACOTE_AMAZON) as readonly string[]).includes(valor)
    ? valor
    : '<outro>';
}

/**
 * The fold of ONE read's packages (module header), and the diary it leaves.
 *
 * Each keyed package becomes a row `{ numero, estado, estadoMarketplace,
 * statusMarketplace, codRastreio, canalId, prazoDespacho, atualizadoEm,
 * fonte }`: `estado` is the projection (re-derived every read) through the
 * ROW GATE below, the two statuses and the tracking number VERBATIM,
 * `atualizadoEm` the ORDER clock — advanced ONLY when one of those three wire
 * fields changed against the stored row (so an unchanged redelivery is an
 * empty diff), `fonte: 'getOrder'`. A stored row's other keys are carried over.
 *
 * The row gate: when the STORED row's `estado` reads as an estado where the
 * goods are out ({@link estadoDaLinhaAmazon}, `mercadoriaFora`) and this read's
 * projection for that package does not — a goods-in estado, or none at all (an
 * unknown token, an invoice-less `PENDING_SCHEDULE`) — the row KEEPS the stored
 * `estado`, while its wire fields still take this read's values verbatim (the
 * diary still shows what Amazon said). A `LABEL_CANCELLED` after the pickup is
 * no fact that the units came back, and the row is the only durable record of
 * a package that left while a sibling still waits (the block sits at the
 * least-advanced rung). A goods-out projection that DIFFERS (`postado` →
 * `aCaminho`, → `objetoExtraviado`, → `devolvido`) is written; a goods-in row
 * is re-derived as before. The gate shapes the ROW only: {@link
 * DobraPacotesAmazon.alvo} and every flag read this read's PROJECTION, so the
 * least-advanced target (stock-safe for removing) is unchanged, and the
 * goods-out flag counts every goods-out projection exactly as before.
 * ⚠️ The ONE-direction exception `pacoteFreteSchema` declares to its contract
 * (#1369: `estado` a projection of `estadoMarketplace`, so a token-table
 * correction retro-applies to every row): such a correction still re-derives
 * every row, except one it would move from goods out to goods in. The gate
 * reads the stored `estado` only: a row whose goods out came from the status
 * fallback (`estado: null`) is re-derived like any goods-in row — the module
 * header's second residual.
 *
 * A package without a usable `packageReferenceId` (absent, blank, over 60, or
 * the same key twice in one read) answers nothing for the target: the fold is
 * BLOCKED and it writes no row (it has no key) — never a parse refusal, never
 * silently dropped. The other packages' rows are still written, and its token
 * (or, the token unknown, its closed status) still counts for
 * {@link DobraPacotesAmazon.mercadoriaFora} — for THIS read only: with no row,
 * no later read remembers that it left (the module header's residual).
 */
export function dobrarPacotesAmazon(
  pacotes: readonly PacoteWireAmazon[],
  contexto: ContextoDobraAmazon,
): DobraPacotesAmazon {
  const ocorrencias = new Map<string, number>();
  for (const p of pacotes) {
    const chave = chaveDoPacote(p.packageReferenceId);
    if (chave !== null) ocorrencias.set(chave, (ocorrencias.get(chave) ?? 0) + 1);
  }

  const armazenados = Array.isArray(contexto.armazenados)
    ? (contexto.armazenados as unknown[]).flatMap((l) => {
        const o = objeto(l);
        return o === null ? [] : [o];
      })
    : [];
  const guardadoPorNumero = new Map<string, LinhaDiarioAmazon>();
  for (const l of armazenados) {
    const n = numeroDaLinha(l);
    if (n !== null && !guardadoPorNumero.has(n)) guardadoPorNumero.set(n, l);
  }

  let bloqueado = false;
  let semNota = false;
  let notaNaoExigida = false;
  let coletaCancelada = false;
  let algumaMercadoriaFora = false;
  let naoMapeados = 0;
  let semChave = 0;
  let vivo: { readonly estado: EstadoFrete; readonly indice: number } | null = null;
  const semVida = new Set<EstadoFrete>();
  const status = new Set<string>();
  const novas = new Map<string, LinhaDiarioAmazon>();

  for (const p of pacotes) {
    const token = p.packageStatus?.detailedStatus;
    status.add(statusComoCodigo(p.packageStatus?.status));
    if (token === DETAILED_STATUS_AMAZON.labelCancelled) coletaCancelada = true;
    const projecao = projetarPacoteAmazon(token, contexto.invoiceStatus);
    // Goods out: read from EVERY package, before the key and the block decide
    // anything — its projection, or (an unknown token only) its closed status.
    if (
      (projecao.tipo === 'estado' && mercadoriaFora(projecao.estado)) ||
      statusPacoteComMercadoriaForaAmazon(token, p.packageStatus?.status)
    ) {
      algumaMercadoriaFora = true;
    }
    const chave = chaveDoPacote(p.packageReferenceId);
    if (chave === null || (ocorrencias.get(chave) ?? 0) > 1) {
      semChave += 1;
      bloqueado = true;
      continue;
    }
    let estado: EstadoFrete | null = null;
    if (projecao.tipo === 'desconhecido') {
      naoMapeados += 1;
      bloqueado = true;
    } else if (projecao.tipo === 'sem-nota') {
      semNota = true;
    } else {
      estado = projecao.estado;
      if (projecao.notaNaoExigida) notaNaoExigida = true;
      const indice = indiceEscada(estado);
      if (indice >= 0) {
        if (vivo === null || indice < vivo.indice) vivo = { estado, indice };
      } else {
        semVida.add(estado);
      }
    }

    const guardado = guardadoPorNumero.get(chave) ?? null;
    // The row gate: a stored goods-out estado is never replaced by one where the goods are in.
    const estadoGuardado = guardado === null ? null : estadoDaLinhaAmazon(guardado);
    const estadoDaLinha =
      mercadoriaFora(estadoGuardado) && !mercadoriaFora(estado) ? estadoGuardado : estado;
    const estadoMarketplace = textoVerbatim(token, LIMITE_TOKEN_PACOTE_AMAZON);
    const statusMarketplace = textoVerbatim(p.packageStatus?.status, LIMITE_TOKEN_PACOTE_AMAZON);
    const codRastreio = textoVerbatim(p.trackingNumber, LIMITE_COD_RASTREIO_AMAZON);
    // "Changed" is about the WIRE: an absent stored field reads as `null` here only.
    const mudou =
      guardado === null ||
      (guardado.estadoMarketplace ?? null) !== estadoMarketplace ||
      (guardado.statusMarketplace ?? null) !== statusMarketplace ||
      (guardado.codRastreio ?? null) !== codRastreio;
    novas.set(chave, {
      ...(guardado ?? { canalId: null, prazoDespacho: null }),
      numero: chave,
      estado: estadoDaLinha,
      estadoMarketplace,
      statusMarketplace,
      codRastreio,
      atualizadoEm: mudou ? contexto.relogioUs : (guardado?.atualizadoEm ?? null),
      fonte: FONTE_PACOTE_AMAZON.getOrder,
    });
  }

  // The refusals come FIRST: a live or failed package may not answer for a
  // sibling nobody can read, and an invoice-less PENDING_SCHEDULE is a live
  // package whose rung is unknown.
  const alvo =
    bloqueado || semNota
      ? null
      : vivo !== null
        ? vivo.estado
        : (ORDEM_SEM_PACOTE_VIVO_AMAZON.find((e) => semVida.has(e)) ?? null);

  // The diary: every stored row this read does not name, kept; this read's rows.
  const usados = new Set<string>();
  const diario: LinhaDiarioAmazon[] = [];
  for (const guardado of armazenados) {
    const n = numeroDaLinha(guardado);
    const nova = n === null ? undefined : novas.get(n);
    if (n !== null && nova !== undefined && !usados.has(n)) {
      usados.add(n);
      diario.push(nova);
    } else {
      diario.push(guardado);
    }
  }
  for (const [n, nova] of novas) if (!usados.has(n)) diario.push(nova);

  const numeros: string[] = [];
  for (const n of [...novas.keys()].sort(compararTexto)) {
    const cod = novas.get(n)?.codRastreio;
    if (typeof cod === 'string' && !numeros.includes(cod)) numeros.push(cod);
  }

  return {
    alvo,
    bloqueado,
    semNota,
    notaNaoExigida,
    coletaCancelada,
    mercadoriaFora: algumaMercadoriaFora,
    pacotes: ordenarDiario(diario),
    codRastreio: juntarCodRastreio(numeros),
    contagens: { pacotes: pacotes.length, naoMapeados, semChave },
    statusPacotes: [...status].sort(compararTexto).join(','),
  };
}

/* -------------------------------------------------------------------------- */
/*                         one read, the order's rules                        */
/* -------------------------------------------------------------------------- */

/** What ONE read says about the freight, before the CANCELLED rule. */
export interface LeituraFreteAmazon {
  /** The fold's target, or the no-packages rule's (`null`: no change). */
  readonly alvo: EstadoFrete | null;
  /** The fold, when the read carries packages; `null` otherwise. */
  readonly dobra: DobraPacotesAmazon | null;
  /**
   * Some package of this read says the goods are out
   * ({@link DobraPacotesAmazon.mercadoriaFora}: the predicate's second
   * reading); without packages, whether the no-packages target does (it never
   * does today: its rows end at rung 4).
   */
  readonly mercadoriaFora: boolean;
  /** An invoice-less `PENDING_SCHEDULE`, or a to-ship order without packages and invoice status. */
  readonly semNota: boolean;
  readonly notaNaoExigida: boolean;
  /**
   * The per-pedido aviso motivos this read derives — a function of the order
   * ALONE, whoever owns the block, so each is resolved exactly when its
   * condition ends: `pacote-status-desconhecido` while some package is unknown
   * or unkeyed; `coleta-cancelada` while some package is `LABEL_CANCELLED` and
   * the order is not `CANCELLED`.
   */
  readonly motivos: readonly MotivoPedidoAmazon[];
}

/** The freight read of one order (module header): the fold, or the no-packages rule. */
export function lerFreteAmazon(
  order: Pick<PedidoWireAmazon, 'fulfillment' | 'tax' | 'packages'>,
  contexto: Omit<ContextoDobraAmazon, 'invoiceStatus'>,
): LeituraFreteAmazon {
  const pacotes = order.packages ?? [];
  const cancelado = order.fulfillment?.fulfillmentStatus === FULFILLMENT_STATUS_AMAZON.cancelled;
  if (pacotes.length === 0) {
    const projecao = alvoSemPacotesAmazon(order);
    const alvo = projecao?.tipo === 'estado' ? projecao.estado : null;
    return {
      alvo,
      dobra: null,
      mercadoriaFora: mercadoriaFora(alvo),
      semNota: projecao?.tipo === 'sem-nota',
      notaNaoExigida: projecao?.tipo === 'estado' && projecao.notaNaoExigida,
      motivos: [],
    };
  }
  const dobra = dobrarPacotesAmazon(pacotes, {
    ...contexto,
    invoiceStatus: order.tax?.taxInvoicing?.invoiceStatus,
  });
  const motivos: MotivoPedidoAmazon[] = [];
  if (dobra.bloqueado) motivos.push(MOTIVO_PEDIDO_AMAZON.pacoteStatusDesconhecido);
  if (dobra.coletaCancelada && !cancelado) motivos.push(MOTIVO_PEDIDO_AMAZON.coletaCancelada);
  return {
    alvo: dobra.alvo,
    dobra,
    mercadoriaFora: dobra.mercadoriaFora,
    semNota: dobra.semNota,
    notaNaoExigida: dobra.notaNaoExigida,
    motivos,
  };
}

/**
 * The freight target once the order's own CANCELLED rule applies (plan §3
 * decision 47), decided by the pedido estado's ONE CANCELLED predicate
 * (`alvoCanceladoAmazon`, over the SAME context) — its outcome, never a second
 * copy of its arms. Amazon CANCELLED and the predicate KEEPS the pedido estado
 * (the goods are out — the stored block estado, any package of this read, or
 * any stored diary row of this importer's block unless that block reads as
 * `fulfillment` — or the stored estado is the
 * operator's; `cancelado-apos-envio` is filed) ⇒ the read's target; the
 * predicate RELEASES the goods ⇒ `cancelado` (terminal; the stock returns
 * through the pedido estado). Any other status ⇒ the read's target.
 */
export function alvoFreteAmazon(e: {
  readonly cancelado: boolean;
  /** The context the pedido estado's predicate decided on (the goods-out OR included). */
  readonly contexto: ContextoEstadoAmazon;
  readonly alvoDaLeitura: EstadoFrete | null;
}): EstadoFrete | null {
  if (!e.cancelado) return e.alvoDaLeitura;
  return alvoCanceladoAmazon(e.contexto).alvo.tipo === 'manter'
    ? e.alvoDaLeitura
    : ESTADO_FRETE.cancelado;
}

/* -------------------------------------------------------------------------- */
/*                          the group, against a block                        */
/* -------------------------------------------------------------------------- */

/** A key BOTH rows hold, with the same value (`===`) — absent ≢ `null`. */
function mesmoCampo(
  guardado: Readonly<Record<string, unknown>>,
  novo: Readonly<Record<string, unknown>>,
  chave: string,
): boolean {
  return (
    Object.hasOwn(guardado, chave) && Object.hasOwn(novo, chave) && guardado[chave] === novo[chave]
  );
}

/**
 * The diary comparator (plan §3 decision 41): the same length, then row by row
 * in the sorted order, every key of EITHER row strictly (`===`, absent ≢
 * `null`). No deep-equal, no fold.
 */
export function mesmoDiarioAmazon(guardado: unknown, novo: readonly LinhaDiarioAmazon[]): boolean {
  if (!Array.isArray(guardado) || guardado.length !== novo.length) return false;
  return novo.every((linhaNova, i) => {
    const linhaGuardada = objeto((guardado as unknown[])[i]);
    if (linhaGuardada === null) return false;
    const chaves = new Set([...Object.keys(linhaGuardada), ...Object.keys(linhaNova)]);
    return [...chaves].every((c) => mesmoCampo(linhaGuardada, linhaNova, c));
  });
}

/** What the freight group writes on one block. */
export interface GrupoFreteAmazon {
  /** `estado`, `pacotes`, `codRastreio` — only what differs from the block. */
  readonly mudancas: Readonly<Record<string, unknown>>;
  /** The estado verdict (`null`: the stored estado is unreadable — nothing decided). */
  readonly veredito: VereditoFreteAmazon | null;
  /** A non-empty stored `codRastreio` was REPLACED (logged, never the value). */
  readonly codRastreioDivergente: boolean;
}

/**
 * The freight group against ONE block — the stored `freteInicial`, or the seed
 * of a block this attempt creates: the estado through
 * {@link estadoFreteAmazonAplicavel}; the diary when it differs row by row;
 * `codRastreio` REPLACED by a non-null fold (the marketplace is the authority
 * on its own block) and kept by an empty one. `externalId` is step 15's. Only
 * the estado is refused to an AFN read (the verdict's gate 3): the diary and
 * `codRastreio` are written whatever the logistics, so an AFN block's diary
 * holds Amazon's own packages — which is why the CANCELLED predicate never
 * reads the diary of a block it reads as `fulfillment`
 * ({@link diarioComMercadoriaForaAmazon}).
 */
export function grupoFreteAmazon(e: {
  readonly bloco: Readonly<Record<string, unknown>>;
  readonly alvo: EstadoFrete | null;
  readonly dobra: DobraPacotesAmazon | null;
  readonly maisNovo: boolean;
  readonly logistica: LogisticaAmazon;
}): GrupoFreteAmazon {
  const mudancas: Record<string, unknown> = {};
  const lido = estadoFreteSchema.safeParse(e.bloco.estado);
  const veredito = lido.success
    ? estadoFreteAmazonAplicavel(lido.data, e.alvo, {
        maisNovo: e.maisNovo,
        logistica: e.logistica,
      })
    : null;
  if (veredito?.escrever === true) mudancas.estado = veredito.estado;

  let codRastreioDivergente = false;
  if (e.dobra !== null) {
    if (!mesmoDiarioAmazon(e.bloco.pacotes, e.dobra.pacotes)) mudancas.pacotes = e.dobra.pacotes;
    const cod = e.dobra.codRastreio;
    if (cod !== null && !(Object.hasOwn(e.bloco, 'codRastreio') && e.bloco.codRastreio === cod)) {
      mudancas.codRastreio = cod;
      const anterior = e.bloco.codRastreio;
      codRastreioDivergente = typeof anterior === 'string' && anterior.trim() !== '';
    }
  }
  return { mudancas, veredito, codRastreioDivergente };
}
