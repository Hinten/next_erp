/**
 * The Amazon freight block's step-5 half (master plan step 5, PR 5-c): the
 * "goods out" table, the seed of a new `freteInicial`, and the non-money fields
 * a re-import refreshes. The freight ESTADO from Easy Ship packages, the
 * `pacotes[]` diary and `codRastreio` are PR 7's (`frete/estadoFreteAmazon.ts`).
 *
 * PURE: every instant comes through `lerInstanteAmazon` (offset REQUIRED, µs
 * read from Amazon's own text) — there is no clock conversion here, and no
 * clock at all.
 */
import type { PedidoWireAmazon } from '@delfrance/integrations-amazon-sp-api';
import {
  ESTADO_FRETE,
  INTEGRACAO_FRETE,
  MODALIDADE_FRETE,
  freteDoPedidoSchema,
  seedFreteInicial,
  type EstadoFrete,
  type FreteDoPedido,
  type ModalidadeFrete,
} from '@delfrance/schemas';

import { lerInstanteAmazon } from './janelaPoll';

/* -------------------------------------------------------------------------- */
/*                                 goods out                                  */
/* -------------------------------------------------------------------------- */

/**
 * Whether the goods have LEFT the warehouse (or their whereabouts are the
 * carrier's) at each freight estado — an EXPLICIT, EXHAUSTIVE table (plan §3
 * decision 47), never "`postado` or later".
 *
 * `true`: posted and everything after it, the failures, the return leg,
 * `suspenso` and `aguardandoRetirada` — a cancellation there must NOT restock,
 * because the units are not on the shelf (a lost or in-transit parcel included).
 * `false`: everything up to `checkFinalizado` (packed, still in the warehouse,
 * so a cancellation restocks correctly), `despachoNegado`, `cancelado`,
 * `desconhecido`, `error`, and `fulfillment` (AFN: never this ERP's stock).
 *
 * The `Record` makes a missing member a compile error; `freteAmazon.test.ts`
 * iterates `estadoFreteSchema.options` and pins the exact `true` set.
 */
export const MERCADORIA_FORA: Readonly<Record<EstadoFrete, boolean>> = Object.freeze({
  fulfillment: false,
  iniciado: false,
  aguardandoAutorizacao: false,
  aguardandoNFe: false,
  aguardandoValidacaoTransporadora: false,
  despachoAutorizado: false,
  aguardandoAgendamento: false,
  despachoNegado: false,
  emSeparacao: false,
  empacotado: false,
  aguardandoPostagem: false,
  checkFinalizado: false,
  postado: true,
  recebidoPelaTransportadora: true,
  aCaminho: true,
  tentandoRealizarEntrega: true,
  entregue: true,
  falhaNaEntrega: true,
  suspenso: true,
  enderecoNaoEncontrado: true,
  aCaminhoDoRemetente: true,
  devolvido: true,
  objetoExtraviado: true,
  cancelado: false,
  desconhecido: false,
  error: false,
  aguardandoRetirada: true,
});

/**
 * Whether the goods are out at ONE freight estado (`null` = no block, no
 * target, or a value outside the enum: read as in the warehouse, like
 * `desconhecido`). Since PR 7 the CANCELLED predicate ORs two readings
 * (`pedidoMapeamento.ts`, plan §3 decision 47): the STORED estado, through the
 * ladder's legacy-residue projection (`estadoFreteEfetivoAmazon`), and ANY
 * package of this read (`DobraPacotesAmazon.mercadoriaFora`) — because the
 * stored freight lags the same read's packages whenever Amazon's clock does not
 * move on them.
 */
export function mercadoriaFora(estado: EstadoFrete | null): boolean {
  return estado !== null && MERCADORIA_FORA[estado];
}

/* -------------------------------------------------------------------------- */
/*                           the refreshed fields                             */
/* -------------------------------------------------------------------------- */

/**
 * The NON-money Amazon-owned fields a re-import refreshes on an `amz` block.
 * The freight money (`valorCobrado`) belongs to the order-money group and is
 * decided with it (D17), never here.
 */
export const CAMPOS_FRETE_AMAZON = [
  'prazoDespacho',
  'dataPrevisaoEntrega',
  'ultimaModificacao',
] as const satisfies ReadonlyArray<keyof FreteDoPedido>;

export type CamposFreteAmazon = {
  readonly [K in (typeof CAMPOS_FRETE_AMAZON)[number]]: K extends 'ultimaModificacao'
    ? number
    : number | null;
};

/** An Amazon instant in µs, or `null` (absent, or no offset). */
function instanteUs(texto: string | null | undefined): number | null {
  return typeof texto === 'string' ? (lerInstanteAmazon(texto)?.us ?? null) : null;
}

/**
 * {@link CAMPOS_FRETE_AMAZON} from one order: the ship-by and deliver-by
 * deadlines (each window's `latestDateTime`), and `ultimaModificacao` = the
 * ORDER clock (`relogioPedidoUs`) — an unstamped block defeats every later
 * freshness check.
 */
export function camposFreteAmazon(
  order: PedidoWireAmazon,
  relogioPedidoUs: number,
): CamposFreteAmazon {
  return {
    prazoDespacho: instanteUs(order.fulfillment?.shipByWindow?.latestDateTime),
    dataPrevisaoEntrega: instanteUs(order.fulfillment?.deliverByWindow?.latestDateTime),
    ultimaModificacao: relogioPedidoUs,
  };
}

/* -------------------------------------------------------------------------- */
/*                                  the seed                                  */
/* -------------------------------------------------------------------------- */

export interface SementeFreteAmazon {
  /** The conta's `modalidadeFreteImportacao`; `null` ⇒ FOB (`'1'`). */
  readonly modalidade: ModalidadeFrete | null;
  /** `fulfilledBy: AMAZON`: the block is `fulfillment` (never this ERP's stock). */
  readonly afn: boolean;
  /** The conta's active `amz` freight doc, or `null` (PR 5-d). */
  readonly integracaoFreteOuterRef: string | null;
  /** The delivery endereço, or `null` (PR 5-d, only for an approved order). */
  readonly enderecoFreteOuterReference: string | null;
  readonly campos: CamposFreteAmazon;
  /** The freight money, when the order-money group is written; `null` otherwise. */
  readonly valorCobrado: number | null;
}

/**
 * A new `freteInicial` for an Amazon pedido: the shared seed (`ehSaida`, the
 * modalidade), then `externalOptionIntegracao: 'amz'` — which also keeps
 * `freteComDespachoAutorizado` off the block — and the fields above.
 */
export function seedFreteAmazon(semente: SementeFreteAmazon): FreteDoPedido {
  const base = seedFreteInicial(semente.modalidade ?? MODALIDADE_FRETE.fob, true);
  return freteDoPedidoSchema.parse({
    ...base,
    estado: semente.afn ? ESTADO_FRETE.fulfillment : ESTADO_FRETE.iniciado,
    externalOptionIntegracao: INTEGRACAO_FRETE.amazon,
    integracaoFreteOuterRef: semente.integracaoFreteOuterRef,
    enderecoFreteOuterReference: semente.enderecoFreteOuterReference,
    prazoDespacho: semente.campos.prazoDespacho,
    dataPrevisaoEntrega: semente.campos.dataPrevisaoEntrega,
    ultimaModificacao: semente.campos.ultimaModificacao,
    valorCobrado: semente.valorCobrado,
  });
}
