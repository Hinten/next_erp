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
  MERCADORIA_FORA_POR_ESTADO_FRETE,
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
 * decision 47), never "`postado` or later". A cancellation at a `true` estado
 * must NOT restock, because the units are not on the shelf; at a `false` one
 * (packed and earlier, `fulfillment` included) it restocks correctly.
 *
 * It is the SHARED `MERCADORIA_FORA_POR_ESTADO_FRETE` (`@delfrance/schemas`),
 * named here for the ladder: the web checkout reads the same table so it never
 * writes `checkFinalizado` over a goods-out estado, which made a later CANCELLED
 * read restock units the carrier holds (the #2042 review). `freteAmazon.test.ts`
 * still pins the exact `true` set.
 */
export const MERCADORIA_FORA: Readonly<Record<EstadoFrete, boolean>> =
  MERCADORIA_FORA_POR_ESTADO_FRETE;

/**
 * Whether the goods are out at ONE freight estado (`null` = no block, no
 * target, or a value outside the enum: read as in the warehouse, like
 * `desconhecido`). Since PR 7 the CANCELLED predicate ORs three readings
 * (`pedidoMapeamento.ts`, plan §3 decision 47): the STORED block estado,
 * through the ladder's legacy-residue projection, widened in PR 5-f to a read
 * without `fulfilledBy` unless the pedido holds our own AFN error
 * (`estadoFreteParaMercadoriaForaAmazon`);
 * ANY package of this read (`DobraPacotesAmazon.mercadoriaFora`: its token
 * through this table, or — the token unknown, absent included — its closed
 * `packageStatus.status`, PR 5-f), because the stored freight lags the same
 * read's packages whenever Amazon's clock does not move on them; and ANY
 * stored diary row of this importer's own block (`diarioComMercadoriaForaAmazon`:
 * its `estado`, or the same status fallback over its verbatim statuses; never
 * on a block the first reading reads as `fulfillment`, whose diary an AFN read
 * wrote), because the block sits at
 * the least-advanced package and never shows a KEYED one that left beside a
 * sibling still waiting — once a later read cancels that package's pickup or
 * stops naming it, its row is the only record. A package without a usable key
 * leaves no row, so its goods out is read only from a read that carries it
 * (the residual in `frete/estadoFreteAmazon.ts`). The freight verdict and the
 * diary's row gate never move the first and the third from goods out to goods
 * in — except a row whose goods out came from the status fallback, which a
 * later goods-in read of the same package rewrites (the second residual there).
 * The status fallback never reaches this table: no estado is ever derived
 * from `packageStatus.status`.
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
