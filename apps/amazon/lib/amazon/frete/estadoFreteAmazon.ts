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
 * counted in the log, never mapped: there is no status-only floor (plan §3
 * decision 37).
 *
 * ## The fold ({@link dobrarPacotesAmazon})
 *
 * Over THIS read's packages: any package unknown or without a usable
 * `packageReferenceId` BLOCKS the answer (`pacote-status-desconhecido`); a
 * `PENDING_SCHEDULE` whose invoice status is absent gives no answer (a count
 * line, never a guess); otherwise the LEAST-advanced live rung wins (stock-safe:
 * the pedido leaves as a whole), failures and the reverse leg are ignored while
 * a live package exists, and with none live a DECLARED precedence by physical
 * consequence answers — never a clock.
 *
 * ## The verdict ({@link estadoFreteAmazonAplicavel})
 *
 * Forward along {@link ESCADA_FRETE_AMAZON} only; resurrection (a failure → a
 * live rung) only on a STRICTLY newer order clock. Every other step applies on
 * an EQUAL order clock (plan §3 decision 2): a package-only change Amazon did
 * not stamp is not lost. An AFN read never moves the block, and a stored
 * `fulfillment` walks the ladder only under a read that SAYS `MERCHANT`
 * ({@link LogisticaAmazon}): an absent `fulfilledBy` is no evidence of either.
 *
 * ## Goods out
 *
 * The CANCELLED predicate's "goods out" (plan §3 decision 47) reads the stored
 * estado through the SAME legacy-residue projection as the ladder
 * ({@link estadoFreteEfetivoAmazon}) and, from this read, ANY package whose
 * token projects to an estado where the goods are out
 * ({@link DobraPacotesAmazon.mercadoriaFora}) — never the least-advanced
 * target, which is the stock-safe answer for REMOVING stock and the unsafe one
 * for RESTOCKING it. The freight's own CANCELLED arm is that predicate's
 * outcome ({@link alvoFreteAmazon}), never a second copy of its rules.
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

/** `packageStatus.status` — Amazon's CLOSED enum (Orders v2026 `PackageStatus`). Never mapped. */
export const STATUS_PACOTE_AMAZON = {
  pending: 'PENDING',
  inTransit: 'IN_TRANSIT',
  shipped: 'SHIPPED',
  delivered: 'DELIVERED',
  cancelled: 'CANCELLED',
  undeliverable: 'UNDELIVERABLE',
} as const satisfies Record<string, string>;

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
 * residue on an MFN order hold the same value.
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

/** One package's `detailedStatus` (+ the order's invoice status) → its projection. */
export function projetarPacoteAmazon(
  detailedStatus: unknown,
  invoiceStatus: unknown,
): ProjecaoPacoteAmazon {
  if (typeof detailedStatus !== 'string') return DESCONHECIDO;
  if (!Object.hasOwn(ESTADO_FRETE_DE_DETAILED_STATUS, detailedStatus)) return DESCONHECIDO;
  const linhaDaTabela = ESTADO_FRETE_DE_DETAILED_STATUS[detailedStatus];
  if (linhaDaTabela === undefined) return DESCONHECIDO;
  return linhaDaTabela.tipo === 'estado'
    ? projecaoEstado(linhaDaTabela.estado)
    : projecaoDaNota(invoiceStatus);
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
  /** Backwards on {@link ESCADA_FRETE_AMAZON}. */
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
 * The stored freight estado as the ladder AND the goods-out check read it —
 * ONE projection, so the two never disagree on one stored value. The legacy
 * residue (described by shape): a stored `fulfillment` under a read that says
 * `MERCHANT` stands for a package already at the carrier's facility, rung 11
 * (`recebidoPelaTransportadora`, goods out). Under any other read it is
 * returned as stored: the AFN seed of this importer holds the same value, and
 * an absent `fulfilledBy` does not say which one it is.
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
 *  7. both on the ladder and the target lower ⇒ `regressivo`;
 *  8. a failure → `entregue` ⇒ always written;
 *  9. a failure → a live rung ⇒ only on a STRICTLY newer order clock
 *     (`ressuscitado`: a reschedule after `LABEL_CANCELLED` arrives this way);
 * 10. otherwise written.
 *
 * Legacy residues in migrated pedidos (described by shape): a stored
 * `fulfillment` under a `MERCHANT` read reads as rung 11
 * ({@link estadoFreteEfetivoAmazon}: a later `PICKED_UP` is regressive,
 * `AT_DESTINATION_FC` is written); a stored `desconhecido` is overwritable (it
 * is on no ladder, list or set: gate 10).
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
   * projects to an estado where the goods are out (`mercadoriaFora`): the
   * CANCELLED predicate's half from this read (plan §3 decision 47). Computed
   * apart from {@link alvo}: the least-advanced rung, or no answer at all, is
   * the stock-safe reading for REMOVING stock and the unsafe one for
   * restocking. A missing key makes a package unaddressable, not its status
   * unreadable.
   */
  readonly mercadoriaFora: boolean;
  /**
   * The whole diary after this read, sorted ascending by `numero`: this read's
   * keyed packages, plus every stored row this read does not name, kept as
   * stored (a package missing from one read is not evidence it stopped
   * existing; the fold never reads them).
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
 * fonte }`: `estado` is the projection (re-derived every read), the two
 * statuses and the tracking number VERBATIM, `atualizadoEm` the ORDER clock —
 * advanced ONLY when one of those three wire fields changed against the stored
 * row (so an unchanged redelivery is an empty diff), `fonte: 'getOrder'`. A
 * stored row's other keys are carried over.
 *
 * A package without a usable `packageReferenceId` (absent, blank, over 60, or
 * the same key twice in one read) answers nothing for the target: the fold is
 * BLOCKED and it writes no row (it has no key) — never a parse refusal, never
 * silently dropped. The other packages' rows are still written, and its token
 * still counts for {@link DobraPacotesAmazon.mercadoriaFora}.
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
    // Goods out: read from EVERY package, before the key and the block decide anything.
    if (projecao.tipo === 'estado' && mercadoriaFora(projecao.estado)) algumaMercadoriaFora = true;
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
      estado,
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
   * ({@link DobraPacotesAmazon.mercadoriaFora}); without packages, whether the
   * no-packages target does (it never does today: its rows end at rung 4).
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
 * (the goods are out — the stored estado or any package of this read — or the
 * stored estado is the operator's; `cancelado-apos-envio` is filed) ⇒ the
 * read's target; the predicate RELEASES the goods ⇒ `cancelado` (terminal; the
 * stock returns through the pedido estado). Any other status ⇒ the read's
 * target.
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
 * on its own block) and kept by an empty one. `externalId` is step 15's.
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
