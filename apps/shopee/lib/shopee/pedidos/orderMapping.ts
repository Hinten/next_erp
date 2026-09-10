/**
 * One Shopee order → the pedido body, split into the FIELD GROUPS the
 * transaction applies separately (#1513, step 5, plan W1/W4/W5/W8/W9).
 *
 * PURE: no Firestore, no wire call, no clock. The single clock read and the
 * produto/cliente resolution are the importer's (`importarPedido.ts`); the
 * groups below are what `orderPedidoTx.ts` re-applies against its own `tx.get`
 * snapshot.
 *
 * ## Why GROUPS and not one body
 *
 * A re-import is not an overwrite. Four different rules govern four sets of
 * fields, and mixing them is how a marketplace importer eats an operator's work:
 *
 *  - **`sempre`** — the marketplace's own verdict and this importer's diary.
 *    Written on every accepted delivery. `estado` belongs here too but is
 *    decided from the SNAPSHOT (`estadoShopeeAplicavel`), never from the wire
 *    alone, so it rides `alvo` rather than this bag.
 *  - **`dados`** — the operator's line-up and money. Frozen the moment
 *    `hasUserInteraction === true`.
 *  - **`preencherUmaVez`** — links and creation facts. Written only where the
 *    stored document has nothing.
 *  - **`criacao`** — create-only, and never revisited.
 *
 * ⚠️ `hasUserInteraction` freezes the operator's DATA, never the marketplace's
 * LIFECYCLE. Freezing `estado` would hold a stock reservation on a cancelled
 * sale for ever — the leak #1087 fixed on the ML side, pointed the other way.
 * The line is: the operator owns the line-up, not the sale.
 */
import { roundReais } from '@delfrance/core/money';
import { millisToMicros } from '@delfrance/core/datetime';
import {
  CAPTURA_COMPRADOR_ESTADO,
  MARKETPLACE_PEDIDO_TIPO,
  valorUtilizavel,
  type CapturaCompradorEstado,
  type FreteDoPedido,
  type ItemDoPedido,
  type MarketplacePedido,
} from '@delfrance/schemas';
import type { ShopeeEscrowDetail, ShopeeOrderDetailRow } from '@delfrance/integrations-shopee';

import type { CapturaComprador } from './comprador';
import type { ConferenciaDoPedido } from './itens';
import { estadoPedidoDeOrderStatus, type AlvoEstadoShopee } from './orderStatusMaps';

/* -------------------------------------------------------------------------- */
/*                              the seconds → µs seam                          */
/* -------------------------------------------------------------------------- */

/**
 * Shopee's epoch floor: 2020-01-01T00:00:00Z, in SECONDS.
 *
 * Every Shopee timestamp is a `uint32` of seconds, and every ABSENT one arrives
 * as `0` (the zero-fill this wire uses throughout). A `0` read as a date is
 * 1970 — "data de 1969" in São Paulo — which is how the legacy importer produced
 * dispatch deadlines fifty years in the past. Anything below this floor is
 * therefore absence, not a date.
 */
export const PISO_SEGUNDOS_SHOPEE = 1_577_836_800;

/**
 * A Shopee numeric field that is really present.
 *
 * ⚠️ `0` is ABSENT on this wire — Shopee zero-fills every unset numeric, and the
 * Singapore sandbox order proves it: `actual_shipping_fee: 0` while the buyer
 * had paid 1.99, beside `edt_from`/`edt_to`/`pickup_done_time` and both
 * chargeable weights at `0`. So this is deliberately NOT `?? null`: the two
 * answers differ on exactly the values that cost money, and the legacy's
 * `actual ?? estimated` wrote `valorCobrado: 0` onto every unshipped order.
 * Negative is refused too — no fee, weight or timestamp here is legitimately
 * negative, and one reaching `roundReais` would store a credit as a charge.
 *
 * ⚠️ It lives HERE, beside the other wire readers, and is re-exported from
 * `orderFreteMapping.ts`, where the plan names it. Two import paths, ONE fold —
 * the alternative was a second copy, which is the shape the root `CLAUDE.md`
 * names.
 */
export function positivoOuNull(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

/** A Shopee timestamp that is really a timestamp, in SECONDS, or `null`. */
export function segundosShopeeUtilizaveis(segundos: number | null | undefined): number | null {
  return typeof segundos === 'number' &&
    Number.isFinite(segundos) &&
    segundos >= PISO_SEGUNDOS_SHOPEE
    ? segundos
    : null;
}

/**
 * Shopee SECONDS → microseconds since epoch. The ONE conversion in this channel.
 *
 * ⚠️ **Never route a Shopee timestamp through `coerceToMicros`.** That helper
 * classifies by MAGNITUDE: `1_788_973_354` is below `MILLIS_UPPER_BOUND` (9e12),
 * so it is read as MILLISECONDS and answers `1.789e12` µs — 1970-01-21. Feed it
 * the watermark and every freshness comparison says "older", for ever, with
 * nothing failing. `coerceToMicros` is for STORED values only, where the legacy
 * corpus really does hold ms ints and ISO strings.
 * `orderPedidoTx.test.ts` pins that trap directly against `coerceToMicros`.
 */
export function microsDeSegundosShopee(segundos: number): number {
  return millisToMicros(segundos * 1000);
}

/* -------------------------------------------------------------------------- */
/*                            small tolerant readers                           */
/* -------------------------------------------------------------------------- */

/**
 * A non-empty string, or `null`. Shopee sends `""` for every absent string
 * field, so a truthiness read would store empties and a `??` would never fire.
 *
 * ⚠️ NOT the masking predicate. `valorUtilizavel` additionally refuses anything
 * carrying a `*`, and that is right for BUYER data and wrong here — a
 * `cancel_reason` legitimately containing an asterisk is not a masked value, and
 * dropping it would lose the only explanation an operator gets.
 */
function textoOuNull(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  return t.length === 0 ? null : t;
}

/**
 * A field the row schema does not declare, read through `.passthrough()`.
 *
 * `completed_scenario` is documented on the push body (`'' | NORMAL | RRAOC`)
 * and is NOT in `get_order_detail`'s field table — but step 5 never trusts the
 * push body, so if the detail carries it we take it from there and otherwise
 * store `null`. Declaring it on the wire schema would assert a shape no sample
 * shows; reading it tolerantly asserts nothing.
 */
function campoDePassagem(detalhe: ShopeeOrderDetailRow, chave: string): unknown {
  return (detalhe as unknown as Record<string, unknown>)[chave];
}

/**
 * The ORDER-level region that makes a Shopee order fiscally Brazilian.
 *
 * ⚠️ Declared here as well as in `comprador.ts` because the two modules are read
 * independently and neither may depend on the other's constant to be correct;
 * `orderMapping.test.ts` asserts they are the same string.
 */
export const REGIAO_BR_PEDIDO = 'BR';

/* -------------------------------------------------------------------------- */
/*                                 the groups                                  */
/* -------------------------------------------------------------------------- */

/** How `pedido.error` should move on this delivery. */
export type AcaoErroShopee =
  /** An unknown status: write this message. */
  | { readonly tipo: 'definir'; readonly mensagem: string }
  /**
   * A known status: clear the stored message — but ONLY when it carries our
   * prefix, so an error another writer left is never erased.
   */
  | { readonly tipo: 'limpar-se-nosso' };

/** Written on every ACCEPTED delivery. */
export interface GrupoSempreShopee {
  readonly marketplace: MarketplacePedido;
  /** The capture verdict WITHOUT `tentativas`/`em` — the transaction stamps those. */
  readonly capturaComprador: {
    readonly estado: CapturaCompradorEstado;
    readonly statusObservado: string;
    readonly camposRecusados: readonly string[];
    /**
     * The IO-observed half of `camposRecusados` (`endereco:*`) on its own.
     *
     * ⚠️ Kept SEPARATE because the transaction's `capturado` latch has to drop
     * the BUYER refusals — a field that was captured was not refused — while an
     * endereço refusal survives the latch: a pedido whose cliente is linked but
     * whose endereço is not can never be fiscalizado, and that warning must not
     * be swallowed by a state it has nothing to do with.
     */
    readonly camposRecusadosExtra: readonly string[];
  };
  readonly erro: AcaoErroShopee;
}

/** Written only while `hasUserInteraction !== true`. */
export interface GrupoDadosShopee {
  readonly itens: readonly ItemDoPedido[];
  readonly valorCobrado: number | null;
  /**
   * The pedido's ORDER-level discount slot. Shopee fills it with `0` — see
   * {@link mapearPedidoShopee}.
   */
  readonly descontoTotal: number;
  readonly observacoesInternas: string | null;
  readonly freteInicial: FreteDoPedido;
}

/** Written only where the stored document holds nothing. */
export interface GrupoPreencherUmaVezShopee {
  readonly numero: string;
  readonly timestamp: number | null;
  readonly integracaoPedidoOuterRef: string | null;
  readonly listaDePrecosOuterRef: string | null;
  readonly operacaoPedidoOuterRef: string | null;
  readonly clientePedidoOuterRef: string | null;
  readonly enderecoFiscalOuterRef: string | null;
}

export interface PedidoMapeadoShopee {
  readonly numero: string;
  readonly orderStatus: string;
  /** What Shopee says the estado should be; the SNAPSHOT decides whether it lands. */
  readonly alvo: AlvoEstadoShopee;
  readonly sempre: GrupoSempreShopee;
  readonly dados: GrupoDadosShopee;
  readonly preencherUmaVez: GrupoPreencherUmaVezShopee;
  /**
   * CREATE-only. `bloquearEmissaoNFe` is here rather than in the fill-once group
   * on purpose — see {@link MapearPedidoShopeeArgs}.
   */
  readonly criacao: {
    readonly ehSaida: true;
    readonly bloquearEmissaoNFe: boolean | null;
  };
}

/** The conta fields a pedido inherits. Read once by the importer, never here. */
export interface ContaBagShopee {
  readonly integracaoPedidoOuterRef: string | null;
  readonly listaDePrecosOuterRef: string | null;
  readonly operacaoPedidoOuterRef: string | null;
}

export interface MapearPedidoShopeeArgs {
  readonly detalhe: ShopeeOrderDetailRow;
  /** `null` when the escrow call failed or the order is unpaid. */
  readonly escrow: ShopeeEscrowDetail | null;
  /** The flat rows from `mapearItensShopee`; the grouping is the transaction's. */
  readonly itens: readonly ItemDoPedido[];
  /** `mapearItensShopee`'s reconciliation — the item sum and the cross-check. */
  readonly conferencia: ConferenciaDoPedido;
  /** The already-mapped freight block (`mapearFreteInicialShopee`). */
  readonly frete: FreteDoPedido;
  readonly conta: ContaBagShopee;
  /** The buyer-capture verdict for THIS delivery (`avaliarCapturaComprador`). */
  readonly captura: CapturaComprador;
  /** Extra `<campo>:<veredito>` entries the IO layer observed (an endereço refusal). */
  readonly camposRecusadosExtra?: readonly string[];
  /** Resolved BEFORE the transaction; `null` means "nothing to fill". */
  readonly clientePedidoOuterRef: string | null;
  readonly enderecoFiscalOuterRef: string | null;
  /** The order-clock watermark, µs. */
  readonly watermarkUs: number;
}

/**
 * Map one `get_order_detail` row into the four groups.
 *
 * ⚠️ **`bloquearEmissaoNFe` reads the ORDER-level `region`, never
 * `recipient_address.region`.** The recipient block is exactly what masking
 * hides, and an unnamed optional field comes back ABSENT rather than empty — so
 * `undefined !== 'BR'` would mark every masked BR order foreign and block its
 * NF-e. The order-level `region` is one of the eleven fields returned by default
 * and is never masking-gated.
 *
 * ⚠️ It is CREATE-only, and the reason is the CLEAR rather than the set: the
 * field is operator-owned and client-writable (`emitir.ts`'s argument for the
 * dispute overlay applies verbatim), so an importer that also cleared it would
 * silently lift a block an operator set for their own reasons — and a boolean
 * carries no provenance that could tell the two `true`s apart. Seeding on create
 * destroys no intent (the document did not exist a moment ago) and `region`
 * cannot change afterwards, so create-only loses nothing. The masked-buyer case
 * is carried by `capturaComprador` plus the ABSENT `clientePedidoOuterRef`,
 * which the NF-e orchestrator already refuses on.
 *
 * ⚠️ `observacoesInternas` is COMPOSED, never interpolated: the legacy's
 * `"${note}\n${message_to_seller}"` wrote the literal string `"null"` into the
 * field. Here the two halves are filtered and joined, so `"null"`,
 * `"null\nnull"` and a bare `"\n"` are impossible by construction.
 *
 * ⚠️ The two halves have DIFFERENT authors and therefore different predicates —
 * plan W9 spells the pair as one `.filter(usable)`, and a single predicate is
 * what that spelling cannot express. `message_to_seller` is BUYER-authored, so
 * it goes through `valorUtilizavel` and a masked value is refused. `note` is the
 * SELLER's own Seller Centre note, returned to its own author and never masked
 * by Shopee; running it through the masking predicate would silently drop a
 * dispatch instruction like `"URGENTE *frágil*"` — the same argument
 * `textoOuNull`'s docblock makes for `cancel_reason`, and the same silence:
 * `camposRecusados` carries buyer field names only. Worse on a re-import, where
 * `orderPedidoTx` patches the field on any difference, so editing a stored note
 * to add an asterisk would overwrite it with `null`.
 */
export function mapearPedidoShopee(args: MapearPedidoShopeeArgs): PedidoMapeadoShopee {
  const { detalhe, itens, conferencia, frete, conta, captura, watermarkUs } = args;

  const alvo = estadoPedidoDeOrderStatus(detalhe.order_status);
  const criadoEm = segundosShopeeUtilizaveis(detalhe.create_time);

  const marketplace: MarketplacePedido = {
    tipo: MARKETPLACE_PEDIDO_TIPO.shopee,
    // VERBATIM. An unknown status must be storable as DATA — that is the whole
    // reason `marketplace.status` is `z.string()` and not an enum.
    status: detalhe.order_status,
    // Asserted equal to `pedido.lastMarketplaceUpdate` by `orderPedidoTx.test.ts`,
    // so a later step moving one and not the other is visible rather than silent.
    statusEm: watermarkUs,
    // `null` = we did not ask; `[]` = we asked and the order carries none. The
    // importer always asks (`requestOrderStatusPending: true`), so a null here
    // means Shopee answered without the field.
    pendingTerms: detalhe.pending_terms ?? null,
    completedScenario: textoOuNull(campoDePassagem(detalhe, 'completed_scenario')),
    cancelReason: textoOuNull(detalhe.cancel_reason),
    cancelBy: textoOuNull(detalhe.cancel_by),
  };

  // Split by AUTHORSHIP, not by convenience — see the docblock above.
  const notaDoVendedor = textoOuNull(detalhe.note);
  const mensagemDoComprador = valorUtilizavel(detalhe.message_to_seller);
  const observacoes = [notaDoVendedor, mensagemDoComprador]
    .filter((t): t is string => t !== null)
    .join('\n');

  return {
    numero: detalhe.order_sn,
    orderStatus: detalhe.order_status,
    alvo,
    sempre: {
      marketplace,
      capturaComprador: {
        estado: captura.estado,
        statusObservado: detalhe.order_status,
        camposRecusados: [...captura.camposRecusados, ...(args.camposRecusadosExtra ?? [])],
        camposRecusadosExtra: [...(args.camposRecusadosExtra ?? [])],
      },
      erro:
        alvo.tipo === 'erro'
          ? { tipo: 'definir', mensagem: alvo.motivo }
          : { tipo: 'limpar-se-nosso' },
    },
    dados: {
      itens,
      valorCobrado: valorCobradoDoPedido(detalhe, args.escrow, conferencia, frete),
      // ⚠️ ZERO, and it is not a stub. Shopee's five escrow discounts are
      // ITEM-level: each rides its own line's `descontoUnitario`, which
      // `itemSubtotal` already NETS out of `precoDeVenda` before summing. The
      // pedido's `descontoTotal` is the ORDER-level slot — the footer's
      // "Desconto", which Mercado Livre fills with `Σ coupon_amount` while
      // writing `descontoUnitario: 0` per line — and `derivePedidoFreteTotals`
      // subtracts it a SECOND time, after the item sum. Writing
      // `conferencia.descontoDasLinhas` here therefore short-changed
      // `valorCobrado` by Σ discounts on the operator's first save
      // (`packages/data/src/pedido/usecases.ts` recomputes it), in the footer
      // and in the print — while the value stored at IMPORT was right, because
      // `valorCobradoDoPedido` sums NET units. Shopee carries no order-level
      // discount field at all; `totais.test.ts` crosses the two modules and
      // pins it.
      descontoTotal: 0,
      observacoesInternas: observacoes.length === 0 ? null : observacoes,
      freteInicial: frete,
    },
    preencherUmaVez: {
      // `numero` is the `order_sn` VERBATIM, a string. `defaultQuery` orders by
      // `timestamp desc`, so the "digits sort below letters" problem #159 records
      // for a numeric `numero` does not arise.
      numero: detalhe.order_sn,
      timestamp: criadoEm == null ? null : microsDeSegundosShopee(criadoEm),
      integracaoPedidoOuterRef: conta.integracaoPedidoOuterRef,
      listaDePrecosOuterRef: conta.listaDePrecosOuterRef,
      operacaoPedidoOuterRef: conta.operacaoPedidoOuterRef,
      clientePedidoOuterRef: args.clientePedidoOuterRef,
      enderecoFiscalOuterRef: args.enderecoFiscalOuterRef,
    },
    criacao: {
      ehSaida: true,
      bloquearEmissaoNFe:
        detalhe.region !== null && detalhe.region !== REGIAO_BR_PEDIDO ? true : null,
    },
  };
}

/**
 * `pedido.valorCobrado` — what the buyer was charged, freight included.
 *
 * Precedence, and each rung is a different document:
 *
 * 1. `order_income.buyer_total_amount` — the ACCOUNTING answer, authoritative
 *    once money moved;
 * 2. `total_amount` — the order's own total, present only after payment;
 * 3. Σ (unit × qty) + the freight the buyer was charged — the computed fallback,
 *    so an UNPAID order still shows a value in the `/pedidos` `vlr` column while
 *    the buyer holds the unit.
 *
 * ⚠️ Both wire rungs go through `positivoOuNull`'s rule (`0` is absence on this
 * wire), so a zero-filled `total_amount` cannot beat the computed sum.
 *
 * ⚠️ This is the ONE money field still persisted on a pedido (#796/#1151): it
 * backs a server-side `orderBy` + currency filter on `/pedidos` and the two
 * indexes serving them. Everything else derives at read time — do not add a
 * second cache here.
 */
function valorCobradoDoPedido(
  detalhe: ShopeeOrderDetailRow,
  escrow: ShopeeEscrowDetail | null,
  conferencia: ConferenciaDoPedido,
  frete: FreteDoPedido,
): number {
  const escrowTotal = positivoOuNull(escrow?.order_income?.buyer_total_amount);
  if (escrowTotal != null) return roundReais(escrowTotal);
  const totalDaOrdem = positivoOuNull(detalhe.total_amount);
  if (totalDaOrdem != null) return roundReais(totalDaOrdem);
  return roundReais(conferencia.somaDosItens + (frete.valorCobrado ?? 0));
}

/** Re-exported so a reader of the capture diary finds its vocabulary here too. */
export { CAPTURA_COMPRADOR_ESTADO };
