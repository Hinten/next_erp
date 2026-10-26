/**
 * The Amazon `fulfillment` → `ESTADO_PEDIDO` table, the ONE CANCELLED predicate,
 * the approval test and the monotonic ladder (master plan step 5, PR 5-c; plan
 * §3 decisions 5, 7, 11, 14, 42).
 *
 * PURE: no Firestore, no wire call, no clock. The table answers "what does
 * Amazon say this order IS" ({@link alvoEstadoPedidoAmazon}); the ladder answers
 * "may that be written over what the snapshot holds" ({@link estadoAmazonAplicavel}).
 * Both are re-derived from each attempt's own snapshot (root `CLAUDE.md` rule 7).
 *
 * ## What this importer may move ("governed")
 *
 * `aguardandoConfirmacaoDePagamento`, `pago`, `cancelado`,
 * `estornadoIntegralmente`, and `error` ONLY while its text carries
 * {@link PREFIXO_ERRO_AMAZON}. Everything else (`emProcessamento`, `finalizado`,
 * `estornadoParcialmente`, `processandoCancelamento`, `fraude`, a foreign
 * `error`, …) is the operator's: `fora-da-escada`, never moved.
 *
 * ## ⚠️ An import never flips a stocked estado to `error` on a logistics signal
 *
 * `error` is outside both the reservation and the movement sets, so writing it
 * over a `pago` pedido would release the reservation and revert a removal for
 * goods that may already be gone. On UPDATE an absent or unknown status or
 * `fulfilledBy` therefore KEEPS the stored estado (+ an aviso), and AFN moves to
 * `error` only from a pre-approval estado or our own error.
 */
import type { PedidoWireAmazon } from '@delfrance/integrations-amazon-sp-api';
import {
  ESTADO_PEDIDO,
  MOTIVO_PEDIDO_AMAZON,
  STATUS_PAGAMENTO,
  estadoFreteSchema,
  estadoPedidoSchema,
  statusPagamentoSchema,
  type EstadoFrete,
  type EstadoPedido,
  type MotivoPedidoAmazon,
  type StatusPagamento,
} from '@delfrance/schemas';

import { INCIDENTE_PEDIDO_AMAZON, type IncidentePedidoAmazon } from './codigosPedidoAmazon';

/* -------------------------------------------------------------------------- */
/*                               the vocabulary                               */
/* -------------------------------------------------------------------------- */

/**
 * The prefix of every `pedido.error` this importer writes — what makes a CLEAR
 * provably ours: an error another writer left (an NF-e failure, a manual note)
 * is never erased, because the clear fires only on a text that starts with it.
 */
export const PREFIXO_ERRO_AMAZON = '[amazon] ';

/**
 * Amazon's `fulfillment.fulfillmentStatus` values (Orders v2026). A REFERENCE
 * list, never a parse gate: the wire field is an open string, so a new value is
 * DATA ("unknown"), never a throw.
 */
export const FULFILLMENT_STATUS_AMAZON = {
  pendingAvailability: 'PENDING_AVAILABILITY',
  pending: 'PENDING',
  unshipped: 'UNSHIPPED',
  partiallyShipped: 'PARTIALLY_SHIPPED',
  shipped: 'SHIPPED',
  cancelled: 'CANCELLED',
  unfulfillable: 'UNFULFILLABLE',
} as const satisfies Record<string, string>;

/** `fulfillment.fulfilledBy` (an open string on the wire). */
export const FULFILLED_BY_AMAZON = {
  merchant: 'MERCHANT',
  amazon: 'AMAZON',
} as const satisfies Record<string, string>;

/** The `error` texts the table writes (each with {@link PREFIXO_ERRO_AMAZON}). */
export const TEXTO_ERRO_AMAZON = {
  afn: `${PREFIXO_ERRO_AMAZON}pedido atendido pela Amazon`,
  naoAtendivel: `${PREFIXO_ERRO_AMAZON}pedido não atendível (UNFULFILLABLE)`,
  logisticaDesconhecida: `${PREFIXO_ERRO_AMAZON}logística do pedido não informada pela Amazon`,
  statusDesconhecido: `${PREFIXO_ERRO_AMAZON}status de atendimento desconhecido`,
} as const satisfies Record<string, string>;

/** A token of Amazon's closed-grammar shape, so a status may be quoted in our text. */
const TOKEN_AMAZON = /^[A-Z][A-Z_]{0,39}$/;

/* -------------------------------------------------------------------------- */
/*                         the stored pedido, tolerantly                      */
/* -------------------------------------------------------------------------- */

/** What the estado decisions read from a STORED pedido (raw, never trusted). */
export interface ResumoArmazenadoAmazon {
  /** `null`: not a member of the enum — read as `fora-da-escada`. */
  readonly estado: EstadoPedido | null;
  readonly error: string | null;
  /** `marketplace.tipo` (`'amazon'` once this importer wrote the pedido). */
  readonly marketplaceTipo: string | null;
  /** `marketplace.status`: Amazon's status the LAST accepted import saw. */
  readonly marketplaceStatus: string | null;
  /**
   * The pedido slip was printed: `foiImpresso === true || dtImpressao != null`
   * (plan §3 decision 7 (iii), the same signal the print action uses). BOTH
   * fields are read: the legacy corpus may carry either one alone.
   */
  readonly impresso: boolean;
  /** `hasUserInteraction === true`: an operator edited the pedido (plan §3 decision 9). */
  readonly congelado: boolean;
  /** `freteInicial.estado`, or `null` (no block, or outside the enum). */
  readonly freteEstado: EstadoFrete | null;
}

function textoOuNulo(valor: unknown): string | null {
  return typeof valor === 'string' ? valor : null;
}

function objetoOuNulo(valor: unknown): Record<string, unknown> | null {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : null;
}

/** {@link ResumoArmazenadoAmazon} from the raw stored document. Never throws. */
export function lerResumoArmazenadoAmazon(
  raw: Readonly<Record<string, unknown>>,
): ResumoArmazenadoAmazon {
  const estado = estadoPedidoSchema.safeParse(raw.estado);
  const marketplace = objetoOuNulo(raw.marketplace);
  const frete = objetoOuNulo(raw.freteInicial);
  const freteEstado = frete === null ? null : estadoFreteSchema.safeParse(frete.estado);
  return {
    estado: estado.success ? estado.data : null,
    error: textoOuNulo(raw.error),
    marketplaceTipo: textoOuNulo(marketplace?.tipo),
    marketplaceStatus: textoOuNulo(marketplace?.status),
    impresso:
      raw.foiImpresso === true || (raw.dtImpressao !== null && raw.dtImpressao !== undefined),
    congelado: raw.hasUserInteraction === true,
    freteEstado: freteEstado?.success === true ? freteEstado.data : null,
  };
}

/**
 * The stored pagamento's status, as the CANCELLED predicate reads it: a member
 * of `STATUS_PAGAMENTO`, `ausente` (no pagamento document), or `ilegivel` (a
 * document whose status is not a member — read as off the ladder).
 */
export type PagamentoArmazenadoAmazon = StatusPagamento | 'ausente' | 'ilegivel';

/**
 * {@link PagamentoArmazenadoAmazon} from the raw stored pagamento (or `null`):
 * its `status_pagamento` — the field the pagamento schema, the legacy corpus and
 * this importer's own writes (PR 6) all use.
 */
export function lerPagamentoArmazenadoAmazon(
  raw: Readonly<Record<string, unknown>> | null,
): PagamentoArmazenadoAmazon {
  if (raw === null) return 'ausente';
  const status = statusPagamentoSchema.safeParse(raw.status_pagamento);
  return status.success ? status.data : 'ilegivel';
}

/* -------------------------------------------------------------------------- */
/*                           governed, approved                               */
/* -------------------------------------------------------------------------- */

/** Whether a stored `error` text is OURS. */
export function ehErroAmazon(error: unknown): boolean {
  return typeof error === 'string' && error.startsWith(PREFIXO_ERRO_AMAZON);
}

/** The two TERMINAL estados of this channel (leaving one is a resurrection). */
export const ESTADOS_TERMINAIS_AMAZON: ReadonlySet<EstadoPedido> = new Set<EstadoPedido>([
  ESTADO_PEDIDO.cancelado,
  ESTADO_PEDIDO.estornadoIntegralmente,
]);

/** The ORDERED rungs — forward only. */
export const ORDEM_ESTADO_AMAZON = [
  ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
  ESTADO_PEDIDO.pago,
] as const satisfies readonly EstadoPedido[];

/** Whether this importer may move the stored estado (module header). */
export function governadoAmazon(
  armazenado: Pick<ResumoArmazenadoAmazon, 'estado' | 'error'>,
): boolean {
  const { estado } = armazenado;
  if (estado === null) return false;
  if (estado === ESTADO_PEDIDO.error) return ehErroAmazon(armazenado.error);
  return (
    (ORDEM_ESTADO_AMAZON as readonly EstadoPedido[]).includes(estado) ||
    ESTADOS_TERMINAIS_AMAZON.has(estado)
  );
}

/** The estados before a sale is approved (plan §3 decision 5). */
export const ESTADOS_PRE_APROVACAO_AMAZON: ReadonlySet<EstadoPedido> = new Set<EstadoPedido>([
  ESTADO_PEDIDO.iniciado,
  ESTADO_PEDIDO.carrinho,
  ESTADO_PEDIDO.carrinhoAbandonado,
  ESTADO_PEDIDO.escolhendoFormaDePagamento,
  ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
  ESTADO_PEDIDO.emAnalise,
  ESTADO_PEDIDO.pagamentoNaoRealizado,
]);

/** Amazon's statuses of an approved order. */
const STATUS_APROVADOS_AMAZON: ReadonlySet<string> = new Set<string>([
  FULFILLMENT_STATUS_AMAZON.unshipped,
  FULFILLMENT_STATUS_AMAZON.partiallyShipped,
  FULFILLMENT_STATUS_AMAZON.shipped,
]);

/**
 * Whether the STORED pedido is approved — what starts D17's lock (plan §3
 * decision 5). Decided from the snapshot, never from the incoming status, so the
 * import that FIRST sees the approval mirrors Amazon and the lock starts after
 * it.
 *
 * Outside the pre-approval set ⇒ approved — EXCEPT our own `[amazon]` error,
 * which counts only when the stored `marketplace.status` is an approved one: a
 * pedido CREATED at our error (unknown status, AFN, absent `fulfilledBy`) was
 * never approved, while one held at our error by a divergence was. An estado
 * outside the enum reads as approved (the conservative arm: it locks).
 */
export function aprovadoAmazon(armazenado: ResumoArmazenadoAmazon): boolean {
  const { estado } = armazenado;
  if (estado === ESTADO_PEDIDO.error && ehErroAmazon(armazenado.error)) {
    return (
      armazenado.marketplaceStatus !== null &&
      STATUS_APROVADOS_AMAZON.has(armazenado.marketplaceStatus)
    );
  }
  return estado === null || !ESTADOS_PRE_APROVACAO_AMAZON.has(estado);
}

/* -------------------------------------------------------------------------- */
/*                                 the targets                                */
/* -------------------------------------------------------------------------- */

/** What Amazon's order says the pedido should be. */
export type AlvoEstadoAmazon =
  | {
      readonly tipo: 'estado';
      readonly estado: EstadoPedido;
      /** The full `error` text (with our prefix) when `estado` is `error`; `null` otherwise. */
      readonly erro: string | null;
    }
  /** Keep whatever is stored. */
  | { readonly tipo: 'manter' };

/** The table's verdict, with what it found worth reporting. */
export interface DecisaoEstadoAmazon {
  readonly alvo: AlvoEstadoAmazon;
  readonly incidentes: readonly IncidentePedidoAmazon[];
  readonly avisos: readonly MotivoPedidoAmazon[];
}

/** What the table and the predicate read beside the order. */
export interface ContextoEstadoAmazon {
  /** The stored pedido; `null` on a create. */
  readonly armazenado: ResumoArmazenadoAmazon | null;
  readonly pagamentoArmazenado: PagamentoArmazenadoAmazon;
  /** The goods are out (`mercadoriaFora` over the stored freight; PR 7 adds the fold). */
  readonly mercadoriaFora: boolean;
}

const MANTER: AlvoEstadoAmazon = { tipo: 'manter' };

function alvoEstado(estado: EstadoPedido): AlvoEstadoAmazon {
  return { tipo: 'estado', estado, erro: null };
}

/** An `error` target carrying `texto` (which must already carry our prefix). */
export function alvoErroAmazon(texto: string): AlvoEstadoAmazon {
  return { tipo: 'estado', estado: ESTADO_PEDIDO.error, erro: texto };
}

/** A stored pre-approval estado, or our own error: the only update sources of a logistics `error`. */
function preAprovacaoOuErroNosso(armazenado: ResumoArmazenadoAmazon): boolean {
  if (armazenado.estado === null) return false;
  if (armazenado.estado === ESTADO_PEDIDO.error) return ehErroAmazon(armazenado.error);
  return ESTADOS_PRE_APROVACAO_AMAZON.has(armazenado.estado);
}

/**
 * The ONE CANCELLED predicate (plan §3 decision 42), over the stored pedido, the
 * stored pagamento and the freight; first match wins:
 *
 * 1. a stored estado `fora-da-escada` ⇒ KEEP + `cancelado-apos-envio` (the
 *    operator owns that estado);
 * 2. the goods are out ⇒ KEEP + `cancelado-apos-envio` (restocking goods that
 *    left would be wrong);
 * 3. a stored pagamento `aprovado` or `estornado` ⇒ `estornadoIntegralmente`;
 * 4. no pagamento ⇒ `cancelado`, whatever the stored estado (a never-approved
 *    pedido, and the legacy's approved pedido written without one);
 * 5. a stored pagamento off the ladder (an operator's `em_disputa`, `recusado`,
 *    …, or an unreadable status) ⇒ `cancelado` + `pagamento-divergente`: the
 *    stock must be released, the money is the operator's.
 *
 * It decides an Amazon CANCELLED AND the TARGET of a buyer's cancellation
 * request on a PRINTED pedido still to ship (plan §3 decision 7), so both move
 * the estado alike. The incidentes are an Amazon CANCELLED's only: the request
 * branch takes the target alone, because Amazon has cancelled nothing yet.
 */
export function alvoCanceladoAmazon(contexto: ContextoEstadoAmazon): DecisaoEstadoAmazon {
  const { armazenado, pagamentoArmazenado } = contexto;
  if (armazenado !== null && !governadoAmazon(armazenado)) {
    return { alvo: MANTER, incidentes: [INCIDENTE_PEDIDO_AMAZON.canceladoAposEnvio], avisos: [] };
  }
  if (contexto.mercadoriaFora) {
    return { alvo: MANTER, incidentes: [INCIDENTE_PEDIDO_AMAZON.canceladoAposEnvio], avisos: [] };
  }
  if (
    pagamentoArmazenado === STATUS_PAGAMENTO.aprovado ||
    pagamentoArmazenado === STATUS_PAGAMENTO.estornado
  ) {
    return { alvo: alvoEstado(ESTADO_PEDIDO.estornadoIntegralmente), incidentes: [], avisos: [] };
  }
  if (pagamentoArmazenado === 'ausente') {
    return { alvo: alvoEstado(ESTADO_PEDIDO.cancelado), incidentes: [], avisos: [] };
  }
  return {
    alvo: alvoEstado(ESTADO_PEDIDO.cancelado),
    incidentes: [INCIDENTE_PEDIDO_AMAZON.pagamentoDivergente],
    avisos: [],
  };
}

/** A wire text, or `null` when absent or blank (a withheld field reads as absent). */
function textoDoWire(valor: string | null | undefined): string | null {
  return typeof valor === 'string' && valor.trim() !== '' ? valor : null;
}

function textoStatusDesconhecido(status: string | null): string {
  return status !== null && TOKEN_AMAZON.test(status)
    ? `${TEXTO_ERRO_AMAZON.statusDesconhecido}: ${status}`
    : TEXTO_ERRO_AMAZON.statusDesconhecido;
}

/**
 * The table (plan "The estado table"): what Amazon's `fulfillment` says the
 * pedido is, on a CREATE (`armazenado === null`) or an UPDATE.
 *
 * - `CANCELLED` ⇒ {@link alvoCanceladoAmazon}, whatever the logistics;
 * - `fulfilledBy` is read first for every other status: `AMAZON` (AFN) ⇒
 *   create `error` / update `error` only from a pre-approval estado or our own
 *   error, else KEEP — `logistica-amazon` either way; absent or unknown ⇒ create
 *   `error` / update KEEP, + `logistica-desconhecida` (a C1 checkpoint: if
 *   PENDING reads lack it, 5-c1 flips the create arm);
 * - `MERCHANT`: `PENDING`/`PENDING_AVAILABILITY` ⇒ `aguardandoConfirmacaoDePagamento`
 *   (it reserves, plan §3 decision 13); `UNSHIPPED`/`PARTIALLY_SHIPPED`/`SHIPPED`
 *   ⇒ `pago` (the ceiling: `finalizado` is the checkout's); `UNFULFILLABLE` ⇒
 *   create or a pre-approval/our error: `error`, else KEEP, + `logistica-amazon`;
 *   absent or unknown ⇒ create `error` / update KEEP, + `status-desconhecido`.
 */
export function alvoEstadoPedidoAmazon(
  order: Pick<PedidoWireAmazon, 'fulfillment'>,
  contexto: ContextoEstadoAmazon,
): DecisaoEstadoAmazon {
  const status = textoDoWire(order.fulfillment?.fulfillmentStatus);
  const por = textoDoWire(order.fulfillment?.fulfilledBy);
  const { armazenado } = contexto;

  if (status === FULFILLMENT_STATUS_AMAZON.cancelled) return alvoCanceladoAmazon(contexto);

  const statusConhecido =
    status !== null &&
    Object.values(FULFILLMENT_STATUS_AMAZON).includes(
      status as (typeof FULFILLMENT_STATUS_AMAZON)[keyof typeof FULFILLMENT_STATUS_AMAZON],
    );
  const avisosDoStatus: MotivoPedidoAmazon[] = statusConhecido
    ? []
    : [MOTIVO_PEDIDO_AMAZON.statusDesconhecido];

  if (por === FULFILLED_BY_AMAZON.amazon) {
    const incidentes = [INCIDENTE_PEDIDO_AMAZON.logisticaAmazon];
    if (armazenado === null || preAprovacaoOuErroNosso(armazenado)) {
      return { alvo: alvoErroAmazon(TEXTO_ERRO_AMAZON.afn), incidentes, avisos: avisosDoStatus };
    }
    return { alvo: MANTER, incidentes, avisos: avisosDoStatus };
  }
  if (por !== FULFILLED_BY_AMAZON.merchant) {
    const avisos = [MOTIVO_PEDIDO_AMAZON.logisticaDesconhecida, ...avisosDoStatus];
    return armazenado === null
      ? { alvo: alvoErroAmazon(TEXTO_ERRO_AMAZON.logisticaDesconhecida), incidentes: [], avisos }
      : { alvo: MANTER, incidentes: [], avisos };
  }

  switch (status) {
    case FULFILLMENT_STATUS_AMAZON.pendingAvailability:
    case FULFILLMENT_STATUS_AMAZON.pending:
      return {
        alvo: alvoEstado(ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento),
        incidentes: [],
        avisos: [],
      };
    case FULFILLMENT_STATUS_AMAZON.unshipped:
    case FULFILLMENT_STATUS_AMAZON.partiallyShipped:
    case FULFILLMENT_STATUS_AMAZON.shipped:
      return { alvo: alvoEstado(ESTADO_PEDIDO.pago), incidentes: [], avisos: [] };
    case FULFILLMENT_STATUS_AMAZON.unfulfillable: {
      const incidentes = [INCIDENTE_PEDIDO_AMAZON.logisticaAmazon];
      return armazenado === null || preAprovacaoOuErroNosso(armazenado)
        ? { alvo: alvoErroAmazon(TEXTO_ERRO_AMAZON.naoAtendivel), incidentes, avisos: [] }
        : { alvo: MANTER, incidentes, avisos: [] };
    }
    case null:
    default:
      return armazenado === null
        ? {
            alvo: alvoErroAmazon(textoStatusDesconhecido(status)),
            incidentes: [],
            avisos: avisosDoStatus,
          }
        : { alvo: MANTER, incidentes: [], avisos: avisosDoStatus };
  }
}

/* -------------------------------------------------------------------------- */
/*                                 the ladder                                 */
/* -------------------------------------------------------------------------- */

/** Why an estado was NOT written. */
export type MotivoEstadoAmazon =
  /** The table (or the predicate) chose to keep the stored estado. */
  | 'manter'
  /** The stored estado already IS the target. */
  | 'sem-mudanca'
  /** Backwards on the ordered rungs (a late PENDING over a `pago`). */
  | 'regressivo'
  /** The stored estado belongs to the operator. */
  | 'fora-da-escada'
  /** A terminal estado that may not be left (module docblock of {@link estadoAmazonAplicavel}). */
  | 'terminal';

/** Named members of {@link MotivoEstadoAmazon}. */
export const MOTIVO_ESTADO_AMAZON = {
  manter: 'manter',
  semMudanca: 'sem-mudanca',
  regressivo: 'regressivo',
  foraDaEscada: 'fora-da-escada',
  terminal: 'terminal',
} as const satisfies Record<string, MotivoEstadoAmazon>;

export type VereditoEstadoAmazon =
  | { readonly escrever: true; readonly estado: EstadoPedido; readonly ressuscitado: boolean }
  | { readonly escrever: false; readonly motivo: MotivoEstadoAmazon };

/**
 * May the stored estado be moved to the target? (plan §3 decision 11). In order:
 *
 * 1. `manter` ⇒ nothing; a create writes the target;
 * 2. the same estado ⇒ `sem-mudanca`;
 * 3. a stored estado this importer does not govern ⇒ `fora-da-escada`;
 * 4. **terminal → anything non-terminal** (`cancelado`/`estornadoIntegralmente`
 *    → `pago`, …) only when the incoming clock is STRICTLY newer (`maisNovo`)
 *    AND the STORED `marketplace.status` is `CANCELLED` — Amazon itself had
 *    cancelled, and now says the order lives (`ressuscitado`). A terminal estado
 *    with any other stored status was cancelled on the ERP side (a printed
 *    request, plan §3 decision 7, or an operator) and is NEVER reopened by an
 *    import (`terminal`; the caller raises `cancelado-so-no-erp`). An equal
 *    clock never resurrects;
 * 5. backwards on {@link ORDEM_ESTADO_AMAZON} ⇒ `regressivo`;
 * 6. otherwise written.
 */
export function estadoAmazonAplicavel(
  armazenado: ResumoArmazenadoAmazon | null,
  alvo: AlvoEstadoAmazon,
  opcoes: { readonly maisNovo: boolean },
): VereditoEstadoAmazon {
  if (alvo.tipo === 'manter') return { escrever: false, motivo: MOTIVO_ESTADO_AMAZON.manter };
  if (armazenado === null) return { escrever: true, estado: alvo.estado, ressuscitado: false };
  const de = armazenado.estado;
  if (de === alvo.estado) return { escrever: false, motivo: MOTIVO_ESTADO_AMAZON.semMudanca };
  if (de === null || !governadoAmazon(armazenado)) {
    return { escrever: false, motivo: MOTIVO_ESTADO_AMAZON.foraDaEscada };
  }
  if (ESTADOS_TERMINAIS_AMAZON.has(de) && !ESTADOS_TERMINAIS_AMAZON.has(alvo.estado)) {
    const amazonCancelou = armazenado.marketplaceStatus === FULFILLMENT_STATUS_AMAZON.cancelled;
    return opcoes.maisNovo && amazonCancelou
      ? { escrever: true, estado: alvo.estado, ressuscitado: true }
      : { escrever: false, motivo: MOTIVO_ESTADO_AMAZON.terminal };
  }
  const ordem = ORDEM_ESTADO_AMAZON as readonly EstadoPedido[];
  const indiceDe = ordem.indexOf(de);
  const indicePara = ordem.indexOf(alvo.estado);
  if (indiceDe >= 0 && indicePara >= 0 && indicePara < indiceDe) {
    return { escrever: false, motivo: MOTIVO_ESTADO_AMAZON.regressivo };
  }
  return { escrever: true, estado: alvo.estado, ressuscitado: false };
}
