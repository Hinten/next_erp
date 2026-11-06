/**
 * The Easy Ship scheduling's PURE decisions (step 15, PR 15-b): no Firestore,
 * no wire call, no clock, no environment, no logger. The callers (the
 * scheduling task and the label route, 15-c/15-d) read; this module decides.
 * "Scheduled" is decided from Amazon's own package status through step 7's
 * fold (`frete/estadoFreteAmazon.ts`), never from the stored
 * `freteInicial.estado`: one fold, so the importer and the scheduling can never
 * disagree about it (step-15 plan §3 decision 4). Every predicate it shares
 * with another flow is IMPORTED from that flow, never copied: the live DBA and
 * open-request gates and the NF-e eligibility and cancelled-sale rules (step
 * 14), the freight ownership rule (the order import).
 *
 * ## The live order ({@link decidirAgendamentoAmazon}; first match wins)
 *
 * | # | Live order | Result |
 * | --- | --- | --- |
 * | 0 | a foreign marketplace (`lerPedidoAmazon.ts`) | `recusar` `marketplace-estrangeiro` |
 * | 1 | `CANCELLED` | `recusar` `pedido-cancelado` |
 * | 2 | `PENDING` / `PENDING_AVAILABILITY` | `recusar` `pedido-pendente` |
 * | 3 | an OPEN cancellation request | `recusar` `cancelamento-solicitado` |
 * | 4 | not Delivery by Amazon (`MERCHANT` + `DELIVERY_BY_AMAZON`; never keyed on `AMAZON_EASY_SHIP`) | `recusar` `nao-dba` |
 * | 5 | `SHIPPED` | `recusar` `ja-enviado` |
 * | 6 | anything but `UNSHIPPED` (`PARTIALLY_SHIPPED`, `UNFULFILLABLE`, unknown, absent) | `recusar` `status-pedido-inesperado` |
 * | 7a | the fold is blocked (a package unknown or unkeyed) | `recusar` `pacote-desconhecido` |
 * | 7b | some package is `LABEL_CANCELLED` | `recusar` `coleta-cancelada` (rescheduling stays in Seller Central) |
 * | 7c | some package says the goods are out | `recusar` `ja-enviado` |
 * | 7d | the fold's target is {@link ESTADO_FRETE_AGENDADO_AMAZON} (`PENDING_PICK_UP` / `PENDING_DROP_OFF`) | `ja-agendado` |
 * | 7e | the target is {@link ESTADO_FRETE_A_AGENDAR_AMAZON} and the ORDER-level invoice status is EXACTLY `ACCEPTED` | `agendar` |
 * | 7f | the same target with `NOT_REQUIRED` | `recusar` `nf-nao-requerida` (only `ACCEPTED` schedules) |
 * | 7g | the target is `aguardandoNFe`, or no usable invoice status | `aceite-pendente`, its motivo keyed on the invoice status |
 * | 7h | any other target | `recusar` `status-pedido-inesperado` |
 *
 * A mixed package set follows the fold: its least-advanced package decides, so
 * `PENDING_SCHEDULE` beside `PENDING_PICK_UP` is `agendar` and Amazon answers
 * for the order.
 *
 * ## The stored pedido ({@link gatesArmazenadosAgendamentoAmazon})
 *
 * Ownership, a cancelled or blocked sale and goods out — never "scheduled":
 * stored `checkFinalizado`, `aguardandoPostagem` and step 14's `error` stamp all
 * pass, because Amazon's live state decides.
 *
 * ## The pedido's NF-e documents ({@link gateNotasAgendamentoAmazon})
 *
 * Step 14's posture over ONE unfiltered `nfev4` listing (step-15 plan §3
 * decision 27). It gates `agendar` ONLY ({@link planoAgendamentoAmazon}): a
 * `ja-agendado` print still answers its label — the pickup exists, and printing
 * changes nothing.
 *
 * ## Amazon's answer ({@link lerRespostaAgendamentoAmazon})
 *
 * `rejectedOrders` FIRST, then `scheduledPackages` (step-15 plan §3 decision
 * 10). The URL is read, and never logged, stored or answered by this module's
 * callers outside the label download.
 *
 * ## When scheduling has ENDED ({@link agendamentoEncerradoAmazon})
 *
 * The order import's resolve rule for the two scheduling motivos
 * (`dimensoes-ausentes`, `agendamento-recusado`; `pedidos/importarPedido.ts`):
 * once it answers `true`, no scheduling is left to refuse, so a refusal the
 * scheduling task raised is over. Any one of:
 *
 * - the order's phase is `cancelado` or `env` (Amazon `CANCELLED` or
 *   `SHIPPED`);
 * - some package of the read says the goods are out (the fold's
 *   `mercadoriaFora`, its status fallback included);
 * - the fold's target sits at or above {@link ESTADO_FRETE_AGENDADO_AMAZON} on
 *   the ladder (`PENDING_PICK_UP` / `PENDING_DROP_OFF` and every later rung);
 * - some package is `LABEL_CANCELLED` (a schedule existed; rescheduling stays
 *   in Seller Central).
 *
 * Everything else — `PENDING_SCHEDULE` whatever the invoice status, no
 * packages, a mixed set whose least-advanced package still waits to be
 * scheduled, an unknown token whose closed status does not say it left, a
 * `PENDING` order — is NOT ended: the import then neither resolves the two
 * motivos nor reads their keys.
 */
import {
  AmazonAuthError,
  type AmazonHttpError,
  AmazonThrottleError,
  CODIGO_DIMENSOES_AUSENTES_EASY_SHIP,
  CODIGO_PACOTE_JA_AGENDADO_EASY_SHIP,
  type PedidoWireAmazon,
  type RespostaAgendamentoEasyShip,
} from '@delfrance/integrations-amazon-sp-api';
import {
  ESTADO_FRETE,
  ESTADO_PEDIDO,
  ESTADOS_FRETE_MERCADORIA_FORA,
  type EstadoFrete,
  MOTIVO_ETIQUETA_AMAZON,
} from '@delfrance/schemas';

import type { PlanoEscritaAmazon } from '../core/escrita';
import { CODIGO_OUTRO, passaPredicadoAmazon } from '../core/redacao';
import {
  ESCADA_FRETE_AMAZON,
  ESTADO_FRETE_AGENDADO_AMAZON,
  ESTADO_FRETE_A_AGENDAR_AMAZON,
  INVOICE_STATUS_AMAZON,
  lerFreteAmazon,
} from '../frete/estadoFreteAmazon';
import { ehPedidoDbaAmazon, solicitacaoCancelamentoAbertaAmazon } from '../nfe/gatesPedidoNfe';
import {
  type DocumentoNfeAmazon,
  motivoForaDoEnvioNfeAmazon,
  notaDeVendaCanceladaAmazon,
  provaDeIdentidadeAmazon,
  vendaCanceladaAmazon,
} from '../nfe/pedidoNfe';
import { FULFILLMENT_STATUS_AMAZON } from '../pedidos/estadoPedidoAmazon';
import {
  FALHA_LEITURA_AMAZON,
  classificarFalhaDeLeituraAmazon,
} from '../pedidos/falhaLeituraAmazon';
import type { LeituraPedidoAmazon } from '../pedidos/lerPedidoAmazon';
import { freteInicialDaAmazon } from '../pedidos/pedidoMapeamento';
import { faseVendaAmazon } from '../pedidos/vendaAmazon';
import { ehFalhaHttpDoBulkEasyShip } from './easyShipAmazon';

/* -------------------------------------------------------------------------- */
/*                                the live order                               */
/* -------------------------------------------------------------------------- */

/** What the live order says the scheduling should do (module header). */
export type AcaoAgendamentoAmazon = 'agendar' | 'ja-agendado' | 'aceite-pendente' | 'recusar';

export const ACAO_AGENDAMENTO_AMAZON = {
  agendar: 'agendar',
  jaAgendado: 'ja-agendado',
  aceitePendente: 'aceite-pendente',
  recusar: 'recusar',
} as const satisfies Record<string, AcaoAgendamentoAmazon>;

/** Why the live order refuses (rows 0–7h). */
export type MotivoRecusaPedidoAgendamentoAmazon =
  | typeof MOTIVO_ETIQUETA_AMAZON.marketplaceEstrangeiro
  | typeof MOTIVO_ETIQUETA_AMAZON.pedidoCancelado
  | typeof MOTIVO_ETIQUETA_AMAZON.pedidoPendente
  | typeof MOTIVO_ETIQUETA_AMAZON.cancelamentoSolicitado
  | typeof MOTIVO_ETIQUETA_AMAZON.naoDba
  | typeof MOTIVO_ETIQUETA_AMAZON.jaEnviado
  | typeof MOTIVO_ETIQUETA_AMAZON.statusPedidoInesperado
  | typeof MOTIVO_ETIQUETA_AMAZON.pacoteDesconhecido
  | typeof MOTIVO_ETIQUETA_AMAZON.coletaCancelada
  | typeof MOTIVO_ETIQUETA_AMAZON.nfNaoRequerida;

/**
 * Why an accepted NF-e is still awaited (row 7g), keyed on the ORDER-level
 * invoice status: `ERRORED` (Amazon refused it), `NOT_FOUND` (never received),
 * and `PROCESSING`, absent or unknown (still processing).
 */
export type MotivoAceitePendenteAgendamentoAmazon =
  | typeof MOTIVO_ETIQUETA_AMAZON.nfeEmProcessamento
  | typeof MOTIVO_ETIQUETA_AMAZON.nfeRecusadaPelaAmazon
  | typeof MOTIVO_ETIQUETA_AMAZON.nfeNaoEnviada;

/** The order's `fulfillmentStatus` and invoice status as a line may carry them: closed tokens, else `<outro>`. */
interface TokensDoPedidoAgendamentoAmazon {
  /** `fulfillment.fulfillmentStatus` through its closed set, else `<outro>` (absent included). */
  readonly fase: string;
  /** `tax.taxInvoicing.invoiceStatus` through its closed set, else `<outro>` (absent included). */
  readonly invoiceStatus: string;
}

/** The decision over the live order (module header). */
export type DecisaoAgendamentoAmazon = TokensDoPedidoAgendamentoAmazon &
  (
    | { readonly acao: typeof ACAO_AGENDAMENTO_AMAZON.agendar; readonly motivo: null }
    | { readonly acao: typeof ACAO_AGENDAMENTO_AMAZON.jaAgendado; readonly motivo: null }
    | {
        readonly acao: typeof ACAO_AGENDAMENTO_AMAZON.aceitePendente;
        readonly motivo: MotivoAceitePendenteAgendamentoAmazon;
      }
    | {
        readonly acao: typeof ACAO_AGENDAMENTO_AMAZON.recusar;
        readonly motivo: MotivoRecusaPedidoAgendamentoAmazon;
      }
  );

const FULFILLMENT_STATUS_CONHECIDOS: ReadonlySet<string> = new Set<string>(
  Object.values(FULFILLMENT_STATUS_AMAZON),
);
const INVOICE_STATUS_CONHECIDOS: ReadonlySet<string> = new Set<string>(
  Object.values(INVOICE_STATUS_AMAZON),
);

/** A wire value through a closed set, else `<outro>`. */
function tokenDoConjunto(conjunto: ReadonlySet<string>, valor: unknown): string {
  return typeof valor === 'string' && conjunto.has(valor) ? valor : CODIGO_OUTRO;
}

/** Row 7g's motivo, from the RAW order-level invoice status (exact). */
function motivoAceitePendente(invoiceStatus: unknown): MotivoAceitePendenteAgendamentoAmazon {
  if (invoiceStatus === INVOICE_STATUS_AMAZON.errored) {
    return MOTIVO_ETIQUETA_AMAZON.nfeRecusadaPelaAmazon;
  }
  if (invoiceStatus === INVOICE_STATUS_AMAZON.notFound) return MOTIVO_ETIQUETA_AMAZON.nfeNaoEnviada;
  return MOTIVO_ETIQUETA_AMAZON.nfeEmProcessamento;
}

/** The decision over the live order: the module header's table, first match wins. */
export function decidirAgendamentoAmazon(leitura: LeituraPedidoAmazon): DecisaoAgendamentoAmazon {
  // 0. A foreign marketplace: there is no order to read tokens from.
  if (leitura.tipo === 'marketplace-estrangeiro') {
    return {
      acao: ACAO_AGENDAMENTO_AMAZON.recusar,
      motivo: MOTIVO_ETIQUETA_AMAZON.marketplaceEstrangeiro,
      fase: CODIGO_OUTRO,
      invoiceStatus: CODIGO_OUTRO,
    };
  }
  const { order } = leitura;
  const statusPedido = order.fulfillment?.fulfillmentStatus;
  const statusNota = order.tax?.taxInvoicing?.invoiceStatus;
  const tokens: TokensDoPedidoAgendamentoAmazon = {
    fase: tokenDoConjunto(FULFILLMENT_STATUS_CONHECIDOS, statusPedido),
    invoiceStatus: tokenDoConjunto(INVOICE_STATUS_CONHECIDOS, statusNota),
  };
  const recusar = (motivo: MotivoRecusaPedidoAgendamentoAmazon): DecisaoAgendamentoAmazon => ({
    acao: ACAO_AGENDAMENTO_AMAZON.recusar,
    motivo,
    ...tokens,
  });

  const fase = faseVendaAmazon(statusPedido);
  if (fase === 'cancelado') return recusar(MOTIVO_ETIQUETA_AMAZON.pedidoCancelado); // 1
  if (fase === 'pre') return recusar(MOTIVO_ETIQUETA_AMAZON.pedidoPendente); // 2
  if (solicitacaoCancelamentoAbertaAmazon(order)) {
    return recusar(MOTIVO_ETIQUETA_AMAZON.cancelamentoSolicitado); // 3
  }
  if (!ehPedidoDbaAmazon(order)) return recusar(MOTIVO_ETIQUETA_AMAZON.naoDba); // 4
  if (fase === 'env') return recusar(MOTIVO_ETIQUETA_AMAZON.jaEnviado); // 5
  if (statusPedido !== FULFILLMENT_STATUS_AMAZON.unshipped) {
    return recusar(MOTIVO_ETIQUETA_AMAZON.statusPedidoInesperado); // 6
  }

  // 7. Step 7's own fold, over the live order alone (no stored rows).
  const frete = lerFreteAmazon(order, { relogioUs: leitura.watermarkUs, armazenados: null });
  if (frete.dobra?.bloqueado === true) {
    return recusar(MOTIVO_ETIQUETA_AMAZON.pacoteDesconhecido); // 7a
  }
  if (frete.dobra?.coletaCancelada === true) {
    return recusar(MOTIVO_ETIQUETA_AMAZON.coletaCancelada); // 7b
  }
  if (frete.mercadoriaFora) return recusar(MOTIVO_ETIQUETA_AMAZON.jaEnviado); // 7c
  if (frete.alvo === ESTADO_FRETE_AGENDADO_AMAZON) {
    return { acao: ACAO_AGENDAMENTO_AMAZON.jaAgendado, motivo: null, ...tokens }; // 7d
  }
  if (frete.alvo === ESTADO_FRETE_A_AGENDAR_AMAZON) {
    if (statusNota === INVOICE_STATUS_AMAZON.accepted) {
      return { acao: ACAO_AGENDAMENTO_AMAZON.agendar, motivo: null, ...tokens }; // 7e
    }
    return recusar(
      statusNota === INVOICE_STATUS_AMAZON.notRequired
        ? MOTIVO_ETIQUETA_AMAZON.nfNaoRequerida // 7f
        : MOTIVO_ETIQUETA_AMAZON.statusPedidoInesperado, // unreachable through the fold
    );
  }
  if (frete.alvo === ESTADO_FRETE.aguardandoNFe || frete.semNota) {
    return {
      acao: ACAO_AGENDAMENTO_AMAZON.aceitePendente,
      motivo: motivoAceitePendente(statusNota),
      ...tokens,
    }; // 7g
  }
  return recusar(MOTIVO_ETIQUETA_AMAZON.statusPedidoInesperado); // 7h
}

/* -------------------------------------------------------------------------- */
/*                                the stored pedido                            */
/* -------------------------------------------------------------------------- */

/** Why the stored pedido refuses (module header). */
export type MotivoGateArmazenadoAgendamentoAmazon =
  | typeof MOTIVO_ETIQUETA_AMAZON.naoAmazon
  | typeof MOTIVO_ETIQUETA_AMAZON.outraIntegradora
  | typeof MOTIVO_ETIQUETA_AMAZON.pedidoCancelado
  | typeof MOTIVO_ETIQUETA_AMAZON.pedidoBloqueado
  | typeof MOTIVO_ETIQUETA_AMAZON.mercadoriaFora;

/** The stored pedido's verdict: proved, with its conta and order, or a refusal. */
export type GateArmazenadoAgendamentoAmazon =
  | { readonly segue: true; readonly contaId: string; readonly orderId: string }
  | { readonly segue: false; readonly motivo: MotivoGateArmazenadoAgendamentoAmazon };

/** An object field of a raw document, or `null`. */
function objeto(valor: unknown): Readonly<Record<string, unknown>> | null {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Readonly<Record<string, unknown>>)
    : null;
}

/** The shared goods-out set, asked about a RAW stored value. */
const MERCADORIA_FORA: ReadonlySet<string> = ESTADOS_FRETE_MERCADORIA_FORA;

/**
 * The stored pedido's gates, on the RAW document (first match wins):
 *
 * 1. not PROVED an Amazon pedido of a conta (`provaDeIdentidadeAmazon`) ⇒
 *    `nao-amazon`;
 * 2. a PRESENT freight block that is not this channel's — the order import's
 *    own ownership rule (`freteInicialDaAmazon`), so a block naming no
 *    integradora is foreign here exactly as it is to the import ⇒
 *    `outra-integradora`;
 * 3. a cancelled sale (`cancelado` or `estornadoIntegralmente`) ⇒
 *    `pedido-cancelado`;
 * 4. the pedido held at `error` (an emission block, an Amazon-fulfilled order,
 *    an operator's note) ⇒ `pedido-bloqueado`;
 * 5. the stored freight says the goods are out ⇒ `mercadoria-fora`;
 * 6. otherwise it goes on, with the proved conta and order.
 *
 * Stored `checkFinalizado`, `aguardandoPostagem` and the freight `error` stamp
 * of the NF-e upload all pass: none is goods out, and "scheduled" is the live
 * order's to say.
 */
export function gatesArmazenadosAgendamentoAmazon(
  pedidoId: string,
  raw: Readonly<Record<string, unknown>> | null,
): GateArmazenadoAgendamentoAmazon {
  const prova = provaDeIdentidadeAmazon(pedidoId, raw);
  if (prova === null || raw === null) {
    return { segue: false, motivo: MOTIVO_ETIQUETA_AMAZON.naoAmazon };
  }
  const freteRaw = objeto(raw.freteInicial);
  if (freteRaw !== null && !freteInicialDaAmazon(freteRaw)) {
    return { segue: false, motivo: MOTIVO_ETIQUETA_AMAZON.outraIntegradora };
  }
  if (vendaCanceladaAmazon(raw)) {
    return { segue: false, motivo: MOTIVO_ETIQUETA_AMAZON.pedidoCancelado };
  }
  if (raw.estado === ESTADO_PEDIDO.error) {
    return { segue: false, motivo: MOTIVO_ETIQUETA_AMAZON.pedidoBloqueado };
  }
  const estadoFrete = freteRaw?.estado;
  if (typeof estadoFrete === 'string' && MERCADORIA_FORA.has(estadoFrete)) {
    return { segue: false, motivo: MOTIVO_ETIQUETA_AMAZON.mercadoriaFora };
  }
  return { segue: true, contaId: prova.contaId, orderId: prova.orderId };
}

/* -------------------------------------------------------------------------- */
/*                            the pedido's NF-e documents                      */
/* -------------------------------------------------------------------------- */

/** Why the pedido's NF-e documents refuse a FIRST schedule. */
export type MotivoGateNotasAgendamentoAmazon =
  | typeof MOTIVO_ETIQUETA_AMAZON.nfeAmbigua
  | typeof MOTIVO_ETIQUETA_AMAZON.nfeSubstituta
  | typeof MOTIVO_ETIQUETA_AMAZON.nfeCancelada;

export type GateNotasAgendamentoAmazon =
  | { readonly segue: true }
  | { readonly segue: false; readonly motivo: MotivoGateNotasAgendamentoAmazon };

/**
 * The NF-e gate over the pedido's WHOLE, unfiltered `nfev4` listing (first
 * match wins), through step 14's own predicates:
 *
 * 1. two or more ELIGIBLE sale notes (`motivoForaDoEnvioNfeAmazon` answers
 *    `null`) ⇒ `nfe-ambigua`;
 * 2. a cancelled SALE note (`notaDeVendaCanceladaAmazon`; a cancelled devolução
 *    is not one) ⇒ `nfe-substituta` beside one eligible note, `nfe-cancelada`
 *    beside none;
 * 3. otherwise — one eligible note, or none at all (an NF-e uploaded by hand,
 *    or emitted outside the ERP) — it goes on.
 *
 * A partial acceptance is deliberately NOT gated (step-15 plan §3 decision 27):
 * these documents cannot show it, and the operator already holds the NF-e
 * upload's own aviso for it.
 */
export function gateNotasAgendamentoAmazon(
  docs: readonly Pick<DocumentoNfeAmazon, 'raw'>[],
): GateNotasAgendamentoAmazon {
  let elegiveis = 0;
  let vendaCancelada = false;
  for (const doc of docs) {
    if (motivoForaDoEnvioNfeAmazon(doc.raw) === null) elegiveis += 1;
    if (notaDeVendaCanceladaAmazon(doc.raw)) vendaCancelada = true;
  }
  if (elegiveis >= 2) return { segue: false, motivo: MOTIVO_ETIQUETA_AMAZON.nfeAmbigua };
  if (vendaCancelada) {
    return {
      segue: false,
      motivo:
        elegiveis === 1
          ? MOTIVO_ETIQUETA_AMAZON.nfeSubstituta
          : MOTIVO_ETIQUETA_AMAZON.nfeCancelada,
    };
  }
  return { segue: true };
}

/* -------------------------------------------------------------------------- */
/*                                 Amazon's answer                             */
/* -------------------------------------------------------------------------- */

/** An OUTAGE answered for one order: retried exactly like a top-level 500. */
export const CODIGO_FALHA_INTERNA_EASY_SHIP = 'InternalServerError';

/**
 * The two SLOT codes: "the selected time slot" failed or expired, and the
 * remedy is a new slot, then scheduling again. No slot is ever sent, so Amazon
 * picks it, and re-sending the same body IS a request with a newly chosen slot.
 */
export const CODIGOS_NOVO_HORARIO_EASY_SHIP: ReadonlySet<string> = new Set([
  'RetryableAfterGettingNewSlots',
  'ScheduleWindowExpired',
]);

/**
 * The CLOSED retryable set (step-15 plan §3 decision 10): the outage and the
 * two slot codes. `InvalidTimeSlotId` is NOT here: no slot id is ever sent, so
 * it is an anomaly, not an expired slot.
 */
export const CODIGOS_RETENTAVEIS_EASY_SHIP: ReadonlySet<string> = new Set([
  CODIGO_FALHA_INTERNA_EASY_SHIP,
  ...CODIGOS_NOVO_HORARIO_EASY_SHIP,
]);

/** What Amazon's 2xx answer says about OUR order. */
export type TipoRespostaAgendamentoAmazon =
  | 'agendado'
  | 'ja-agendado'
  | 'transitorio'
  | 'recusado'
  | 'sem-pedido';

export const TIPO_RESPOSTA_AGENDAMENTO_AMAZON = {
  agendado: 'agendado',
  jaAgendado: 'ja-agendado',
  transitorio: 'transitorio',
  recusado: 'recusado',
  semPedido: 'sem-pedido',
} as const satisfies Record<string, TipoRespostaAgendamentoAmazon>;

export interface RespostaAgendamentoLidaAmazon {
  readonly tipo: TipoRespostaAgendamentoAmazon;
  /**
   * Our order's rejection code: the code itself when it is
   * `ScheduledPackageAlreadyExists` or retryable, else through the rejection
   * grammar (`<outro>` outside it); `null` without a rejection, or with one
   * that carries no code.
   */
  readonly codigo: string | null;
  /**
   * `printableDocumentsUrl`, or `null`. ⚠️ A pre-signed bearer link to the
   * buyer's label: it goes to the label download and NOWHERE else — never a
   * log line, an aviso, a payload or an answer.
   */
  readonly url: string | null;
  /** How many `scheduledPackages` entries name our order. */
  readonly pacotes: number;
}

/** A rejection code through the grammar the log uses for it, else `<outro>`. */
function codigoDeRejeicao(codigo: string): string {
  return passaPredicadoAmazon('codigoRejeicao', codigo) ? codigo : CODIGO_OUTRO;
}

/**
 * Amazon's 2xx answer, for OUR order (module header; first match wins):
 *
 * 1. our order in `rejectedOrders` with `ScheduledPackageAlreadyExists` ⇒
 *    `ja-agendado`;
 * 2. … with a code of {@link CODIGOS_RETENTAVEIS_EASY_SHIP} ⇒ `transitorio`,
 *    the code kept;
 * 3. … with any other code, or with NO `error` object (optional in the model) ⇒
 *    `recusado`, the code through the grammar, or `null`;
 * 4. our order in `scheduledPackages` ⇒ `agendado`;
 * 5. neither, or an empty 2xx (`null`) ⇒ `sem-pedido`.
 *
 * Rows 1–3 are read BEFORE `scheduledPackages`: an order in both lists is a
 * rejection.
 */
export function lerRespostaAgendamentoAmazon(
  dados: RespostaAgendamentoEasyShip,
  orderId: string,
): RespostaAgendamentoLidaAmazon {
  if (dados === null) {
    return {
      tipo: TIPO_RESPOSTA_AGENDAMENTO_AMAZON.semPedido,
      codigo: null,
      url: null,
      pacotes: 0,
    };
  }
  const url =
    typeof dados.printableDocumentsUrl === 'string' && dados.printableDocumentsUrl !== ''
      ? dados.printableDocumentsUrl
      : null;
  const pacotes = (dados.scheduledPackages ?? []).filter(
    (p) => p.scheduledPackageId?.amazonOrderId === orderId,
  ).length;
  const rejeicao = (dados.rejectedOrders ?? []).find((r) => r.amazonOrderId === orderId);
  if (rejeicao !== undefined) {
    const codigo = rejeicao.error?.code ?? null;
    if (codigo === CODIGO_PACOTE_JA_AGENDADO_EASY_SHIP) {
      return { tipo: TIPO_RESPOSTA_AGENDAMENTO_AMAZON.jaAgendado, codigo, url, pacotes };
    }
    if (codigo !== null && CODIGOS_RETENTAVEIS_EASY_SHIP.has(codigo)) {
      return { tipo: TIPO_RESPOSTA_AGENDAMENTO_AMAZON.transitorio, codigo, url, pacotes };
    }
    return {
      tipo: TIPO_RESPOSTA_AGENDAMENTO_AMAZON.recusado,
      codigo: codigo === null ? null : codigoDeRejeicao(codigo),
      url,
      pacotes,
    };
  }
  if (pacotes > 0) {
    return { tipo: TIPO_RESPOSTA_AGENDAMENTO_AMAZON.agendado, codigo: null, url, pacotes };
  }
  return { tipo: TIPO_RESPOSTA_AGENDAMENTO_AMAZON.semPedido, codigo: null, url, pacotes };
}

/* -------------------------------------------------------------------------- */
/*                                    the plans                                */
/* -------------------------------------------------------------------------- */

/** Which surface runs the scheduling: the queue's task, or the label route's print. */
export type ModoAgendamentoAmazon = 'tarefa' | 'impressao';

export const MODO_AGENDAMENTO_AMAZON = {
  tarefa: 'tarefa',
  impressao: 'impressao',
} as const satisfies Record<string, ModoAgendamentoAmazon>;

/** The plan's own motivo for a read older than the stored floor: it never writes. */
export const MOTIVO_LEITURA_DEFASADA_AGENDAMENTO_AMAZON = 'leitura-defasada';

/** Every motivo a plan may carry: the decision's, the NF-e gate's, or a stale read. */
export type MotivoPlanoAgendamentoAmazon =
  | MotivoRecusaPedidoAgendamentoAmazon
  | MotivoAceitePendenteAgendamentoAmazon
  | MotivoGateNotasAgendamentoAmazon
  | typeof MOTIVO_LEITURA_DEFASADA_AGENDAMENTO_AMAZON;

/**
 * The dry-run line's campos, EXACTLY: closed tokens only — never a URL, a slot,
 * a tracking or a package id. A type alias, not an interface: it must be
 * assignable to the logger's campos.
 */
export type DiffAgendamentoAmazon = {
  readonly acao: AcaoAgendamentoAmazon;
  readonly motivo: MotivoPlanoAgendamentoAmazon | null;
  readonly fase: string;
  readonly invoiceStatus: string;
  readonly modoExecucao: ModoAgendamentoAmazon;
  readonly escreveria: boolean;
};

export interface PlanoAgendamentoAmazon extends PlanoEscritaAmazon {
  /** The live order's decision, before the NF-e gate. */
  readonly decisao: DecisaoAgendamentoAmazon;
  /** The decision's `acao`, an `agendar` the NF-e gate refused turned into `recusar`. */
  readonly acao: AcaoAgendamentoAmazon;
  readonly motivo: MotivoPlanoAgendamentoAmazon | null;
  readonly diff: DiffAgendamentoAmazon;
}

/**
 * The plan the write engine runs (step-15 plan §2, PR 15-b):
 *
 * - an `agendar` whose NF-e gate does not go on becomes `recusar` with the
 *   gate's motivo; every other `acao` ignores `notas` (a `ja-agendado` print
 *   still prints);
 * - **a stale read never writes**: `defasada` (the read's `defasadaAceita`,
 *   possible only on the route's read, which takes no attempt) ⇒ no write, and
 *   the motivo `leitura-defasada`. Such a read may show a schedulable or
 *   scheduled order the import already saw cancelled, or with an open request,
 *   and Amazon's answer to a bulk cannot tell: it schedules;
 * - otherwise, in `tarefa` mode, it writes exactly when the `acao` is `agendar`;
 *   in `impressao` mode, an `agendar` with `podeAgendar` (the caller may
 *   schedule) or a `ja-agendado` (the bulk over an existing schedule answers
 *   the label's URL).
 */
export function planoAgendamentoAmazon(
  decisao: DecisaoAgendamentoAmazon,
  modo: ModoAgendamentoAmazon,
  podeAgendar: boolean,
  notas: GateNotasAgendamentoAmazon,
  defasada: boolean,
): PlanoAgendamentoAmazon {
  let acao: AcaoAgendamentoAmazon = decisao.acao;
  let motivo: MotivoPlanoAgendamentoAmazon | null = decisao.motivo;
  if (decisao.acao === ACAO_AGENDAMENTO_AMAZON.agendar && !notas.segue) {
    acao = ACAO_AGENDAMENTO_AMAZON.recusar;
    motivo = notas.motivo;
  }
  let escrever: boolean;
  if (defasada) {
    escrever = false;
    motivo = MOTIVO_LEITURA_DEFASADA_AGENDAMENTO_AMAZON;
  } else if (modo === MODO_AGENDAMENTO_AMAZON.tarefa) {
    escrever = acao === ACAO_AGENDAMENTO_AMAZON.agendar;
  } else {
    escrever =
      (acao === ACAO_AGENDAMENTO_AMAZON.agendar && podeAgendar) ||
      acao === ACAO_AGENDAMENTO_AMAZON.jaAgendado;
  }
  return {
    decisao,
    acao,
    motivo,
    escrever,
    diff: {
      acao,
      motivo,
      fase: decisao.fase,
      invoiceStatus: decisao.invoiceStatus,
      modoExecucao: modo,
      escreveria: escrever,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                                the print's outcome                          */
/* -------------------------------------------------------------------------- */

/** What a print does after its bulk (15-d maps each to the label route's answer). */
export type TipoDesfechoImpressaoAgendamentoAmazon =
  /** Download the label document at `url`. */
  | 'baixar'
  /** No usable label (502): the label is printed from Seller Central. */
  | 'indisponivel'
  /** Amazon refused to schedule this order (409), `motivo` the aviso's. */
  | 'recusada'
  /** Amazon is unavailable for now (503): wait about a minute and reprint. */
  | 'amazon-indisponivel'
  /** The conta or its credential cannot be used (503). */
  | 'conta-indisponivel'
  /** The read switch is off (503). */
  | 'chamadas-desligadas'
  /** A class this table does not answer (an `AmazonConfigError`: a bug): rethrow. */
  | 'relancar';

export type DesfechoImpressaoAgendamentoAmazon =
  | { readonly tipo: 'baixar'; readonly url: string }
  | {
      readonly tipo: 'recusada';
      readonly motivo:
        | typeof MOTIVO_ETIQUETA_AMAZON.dimensoesAusentes
        | typeof MOTIVO_ETIQUETA_AMAZON.agendamentoRecusado;
    }
  | {
      readonly tipo: Exclude<TipoDesfechoImpressaoAgendamentoAmazon, 'baixar' | 'recusada'>;
    };

/** What the print's bulk produced: Amazon's read 2xx answer, or a thrown failure. */
export type ResultadoBulkImpressaoAgendamentoAmazon =
  | { readonly tipo: 'resposta'; readonly resposta: RespostaAgendamentoLidaAmazon }
  | { readonly tipo: 'erro'; readonly erro: unknown };

const INDISPONIVEL = { tipo: 'indisponivel' } as const;
const AMAZON_INDISPONIVEL = { tipo: 'amazon-indisponivel' } as const;

/** A refusal of THIS order: the aviso's motivo, by the code. */
function recusada(codigo: string | null): DesfechoImpressaoAgendamentoAmazon {
  return {
    tipo: 'recusada',
    motivo:
      codigo === CODIGO_DIMENSOES_AUSENTES_EASY_SHIP
        ? MOTIVO_ETIQUETA_AMAZON.dimensoesAusentes
        : MOTIVO_ETIQUETA_AMAZON.agendamentoRecusado,
  };
}

/**
 * A 4xx of the BULK itself (`ehFalhaHttpDoBulkEasyShip`) that is neither a
 * throttle nor a credential refusal: the answers the table reads by code. The
 * token mint's and the LWA exchange's answers never are — a refused mint or
 * exchange is the app's or the conta's, not Amazon refusing this order — and
 * neither is a 3xx.
 */
function ehRecusaHttpDoBulk(erro: unknown): erro is AmazonHttpError {
  return (
    ehFalhaHttpDoBulkEasyShip(erro) &&
    !(erro instanceof AmazonThrottleError) &&
    !(erro instanceof AmazonAuthError) &&
    erro.status >= 400 &&
    erro.status < 500
  );
}

/**
 * The print's outcome after its bulk, by the run's decision (`agendar` or
 * `ja-agendado`, the two that write in `impressao` mode).
 *
 * **Over an existing schedule** (`ja-agendado`) the pickup already exists, so no
 * answer may send the operator to schedule it in Seller Central: a `recusado`
 * answer (any code that is not retryable, or no `error` object) or a
 * `sem-pedido` one WITH a URL goes on to the download, so the document itself
 * decides; the same without a URL, and a thrown non-auth, non-429 4xx of the
 * bulk, is `indisponivel` (print from Seller Central) — NEVER `recusada`.
 *
 * An `agendar` print keeps the reader's rows: a refusal there IS a refusal
 * (`dimensoes-ausentes` for `MissingPackageDimensions`, per order or top-level,
 * else `agendamento-recusado`), and `sem-pedido` is `indisponivel`.
 *
 * For both:
 *
 * - `agendado` / `ja-agendado` with a URL ⇒ `baixar`, without ⇒ `indisponivel`;
 * - `transitorio` (a retryable code for our order) ⇒ `amazon-indisponivel`;
 * - a thrown 4xx of the BULK (`ehFalhaHttpDoBulkEasyShip`) naming
 *   `ScheduledPackageAlreadyExists` ⇒ `indisponivel` (a top-level error list
 *   carries no URL); one naming a retryable code ⇒ `amazon-indisponivel`;
 * - a thrown HTTP refusal of the token MINT or of an LWA exchange is never
 *   `recusada`: nothing in the order was refused, so it reads by its class
 *   below (a 4xx ⇒ `indisponivel`);
 * - a 5xx, a 429, a timeout or the network ⇒ `amazon-indisponivel` (a cut bulk
 *   may still be running at Amazon: wait, then reprint); a 2xx off its schema ⇒
 *   `indisponivel`; a second credential refusal, or a conta or credential class
 *   the getter threw ⇒ `conta-indisponivel`; anything else ⇒ `relancar`.
 */
export function desfechoImpressaoAgendamentoAmazon(
  acao: typeof ACAO_AGENDAMENTO_AMAZON.agendar | typeof ACAO_AGENDAMENTO_AMAZON.jaAgendado,
  desfecho: ResultadoBulkImpressaoAgendamentoAmazon,
): DesfechoImpressaoAgendamentoAmazon {
  const sobreAgendamento = acao === ACAO_AGENDAMENTO_AMAZON.jaAgendado;
  if (desfecho.tipo === 'resposta') {
    const r = desfecho.resposta;
    switch (r.tipo) {
      case TIPO_RESPOSTA_AGENDAMENTO_AMAZON.agendado:
      case TIPO_RESPOSTA_AGENDAMENTO_AMAZON.jaAgendado:
        return r.url === null ? INDISPONIVEL : { tipo: 'baixar', url: r.url };
      case TIPO_RESPOSTA_AGENDAMENTO_AMAZON.transitorio:
        return AMAZON_INDISPONIVEL;
      case TIPO_RESPOSTA_AGENDAMENTO_AMAZON.recusado:
        if (!sobreAgendamento) return recusada(r.codigo);
        return r.url === null ? INDISPONIVEL : { tipo: 'baixar', url: r.url };
      case TIPO_RESPOSTA_AGENDAMENTO_AMAZON.semPedido:
        // The bulk names ONE order, so a URL in its answer can only carry that
        // order's documents: over an existing schedule it decides here too.
        return sobreAgendamento && r.url !== null ? { tipo: 'baixar', url: r.url } : INDISPONIVEL;
    }
  }
  const { erro } = desfecho;
  if (ehRecusaHttpDoBulk(erro)) {
    if (erro.codigosErro.includes(CODIGO_PACOTE_JA_AGENDADO_EASY_SHIP)) return INDISPONIVEL;
    if (erro.codigosErro.some((c) => CODIGOS_RETENTAVEIS_EASY_SHIP.has(c))) {
      return AMAZON_INDISPONIVEL;
    }
    if (sobreAgendamento) return INDISPONIVEL;
    // The same code reads the same motivo per order or top-level.
    return recusada(
      erro.codigosErro.includes(CODIGO_DIMENSOES_AUSENTES_EASY_SHIP)
        ? CODIGO_DIMENSOES_AUSENTES_EASY_SHIP
        : null,
    );
  }
  switch (classificarFalhaDeLeituraAmazon(erro)) {
    case FALHA_LEITURA_AMAZON.pausa:
    case FALHA_LEITURA_AMAZON.transitorio:
      return AMAZON_INDISPONIVEL;
    case FALHA_LEITURA_AMAZON.esquema:
    case FALHA_LEITURA_AMAZON.ilegivel:
    case FALHA_LEITURA_AMAZON.naoEncontrado:
    case FALHA_LEITURA_AMAZON.httpDefinitivo:
      return INDISPONIVEL;
    case FALHA_LEITURA_AMAZON.authLwa:
    case FALHA_LEITURA_AMAZON.authSpApi:
    case FALHA_LEITURA_AMAZON.contaInativa:
    case FALHA_LEITURA_AMAZON.contaIndisponivel:
      return { tipo: 'conta-indisponivel' };
    case FALHA_LEITURA_AMAZON.chamadasDesligadas:
      return { tipo: 'chamadas-desligadas' };
    case FALHA_LEITURA_AMAZON.relancar:
      return { tipo: 'relancar' };
  }
}

/* -------------------------------------------------------------------------- */
/*                            when scheduling has ended                        */
/* -------------------------------------------------------------------------- */

/** The ladder index of "already scheduled" (rung 8). */
const DEGRAU_AGENDADO_AMAZON = (ESCADA_FRETE_AMAZON as readonly EstadoFrete[]).indexOf(
  ESTADO_FRETE_AGENDADO_AMAZON,
);

/** Whether the live order shows scheduling has ENDED (module header). */
export function agendamentoEncerradoAmazon(
  order: Pick<PedidoWireAmazon, 'fulfillment' | 'tax' | 'packages'>,
): boolean {
  const fase = faseVendaAmazon(order.fulfillment?.fulfillmentStatus);
  if (fase === 'cancelado' || fase === 'env') return true;
  // `relogioUs` stamps only the diary rows this answer ignores; `null` stored
  // rows keep it a function of the live order alone.
  const frete = lerFreteAmazon(order, { relogioUs: 0, armazenados: null });
  if (frete.mercadoriaFora) return true;
  if (frete.dobra?.coletaCancelada === true) return true;
  return (
    frete.alvo !== null &&
    (ESCADA_FRETE_AMAZON as readonly EstadoFrete[]).indexOf(frete.alvo) >= DEGRAU_AGENDADO_AMAZON
  );
}
