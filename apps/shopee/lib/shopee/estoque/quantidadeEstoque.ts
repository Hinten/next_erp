/**
 * **Shopee's BINDING of the shared quantity core** — how many units this
 * channel advertises for one produto at one depósito.
 *
 * There is no arithmetic in this file, and that is the point. Every kit fold,
 * every floor and every clamp lives once, in
 * `@delfrance/data/admin/estoque` (`quantidades.ts` / `politica.ts`), promoted
 * there when Shopee needed the same answers Mercado Livre had been computing
 * since #678. What a channel owns is not the formula but its **parameters**:
 * which environment names it reads, what it pins, and what ceiling applies to
 * the listing in front of it. That is {@link opcoesShopee}, and it is the whole
 * of Shopee's half.
 *
 * ⚠️ **ONE function, TWO bindings — the #1369 lesson, applied before it bites.**
 * The alternative was a second copy of the fold under `apps/shopee`, with a
 * comment claiming it mirrors Mercado Livre's. Two such copies do not stay
 * equal: they drift *toward plausible*, so they read correct while disagreeing,
 * and no reviewer diffs two files by eye. The compiler can — once there is only
 * one. Mercado Livre's own binding is `opcoesML` in
 * `apps/mercado-livre/lib/marketplace/estoque/bulkEstoquePlan.ts`; this is its
 * twin, and neither may reach for the other's.
 *
 * ## The three parameters, and why each is what it is
 *
 * - **`incluirEstoqueProprioDoKit`** — `SHOPEE_STOCK_KIT_INCLUI_PROPRIO`,
 *   shipping OFF. A Shopee-scoped flag: the Mercado Livre variable of the same
 *   shape must not steer this channel, which is exactly what a shared reader
 *   inside the core would have caused.
 * - **`pularKitVirtual`** — **PINNED `false`**, never read from the
 *   environment. "Publish no quantity for this produto" is *inexpressible* on
 *   this wire: `seller_stock` is REQUIRED per model on `init_tier_variation`
 *   and on `add_model`, so there is no body that omits it. A kit Shopee itself
 *   composes is excluded much earlier and by a different field — the stored
 *   link's `kitNativo` — so the virtual-kit escape hatch has nothing left to do
 *   here. A flag for it was PRUNED from the env block rather than shipped OFF,
 *   because an OFF flag invites someone to turn it on.
 * - **`estoqueMax`** — the category band's `stock_limit.max` for THIS listing,
 *   or `Number.POSITIVE_INFINITY` when no band resolved. ⚠️ Never `0`: zero is
 *   a legal quantity on this wire, so a `0` ceiling would silently zero every
 *   listing it touched and nothing downstream would flag it. The sandbox probe
 *   came back with BOTH bounds null on its category, so "no band" is an
 *   ordinary, expected state — not a bug to be defended against with a number.
 *
 * ## Where the band is, and where it is not
 *
 * At SWEEP time the band is `null` on purpose ({@link quantidadesDaFamiliaShopee}
 * and {@link quantidadesAnterioresShopee} pass it so): the ceiling is a
 * per-(conta, categoria) WIRE bound, and it belongs where the wire body is
 * built — the SENDER clamps. ⚠️ The named residual is that
 * {@link deveEnviarFamiliaShopee} therefore compares UNCLAMPED numbers, so two
 * ticks whose availability both sit above one band's maximum can each decide to
 * send the same clamped value. With realistic maxima that is unobservable, and
 * the alternative — clamping at sweep time — would make the send decision
 * depend on a read the sweep does not make.
 *
 * PURE: no Firestore, no Shopee call, no clock. The only ambient read is the
 * environment, and it happens in {@link opcoesShopee} alone, lazily, at call
 * time.
 */
import type { ComponentesKit } from '@delfrance/schemas';
import {
  type LinhaDeFamilia,
  type MembroDaFamilia,
  type MovimentosDaJanela,
  type OpcoesDeQuantidade,
  deveEnviarFamiliaCore,
  quantidadeDoMembroCore,
  quantidadeParaEnvioCore,
  quantidadesAnterioresCore,
  quantidadesDaFamiliaCore,
} from '@delfrance/data/admin/estoque';

import type { FaixaDto } from '../taxonomia/limites';
import { kitIncluiEstoqueProprio, limiarEstoqueAlto } from './constantesEstoque';

/**
 * Shopee's three parameters for the shared quantity fold.
 *
 * `bandaMax` is the listing's category ceiling, or `null` when none resolved —
 * see the module header for why that becomes `Infinity` and never `0`.
 */
export function opcoesShopee(bandaMax: number | null): OpcoesDeQuantidade {
  return {
    incluirEstoqueProprioDoKit: kitIncluiEstoqueProprio(),
    // PINNED — `seller_stock` is required per model on this wire, so "no
    // quantity" cannot be expressed. See the module header.
    pularKitVirtual: false,
    estoqueMax: bandaMax ?? Number.POSITIVE_INFINITY,
  };
}

/**
 * A band's maximum, but only when it is a usable ceiling.
 *
 * `FaixaDto.max` is `number | null` and an absent band is `null` as well, so
 * three spellings of "no ceiling" collapse here into one.
 */
function bandaFinita(banda: FaixaDto | null): number | null {
  const max = banda?.max;
  return typeof max === 'number' && Number.isFinite(max) ? max : null;
}

/**
 * The kit-aware quantity to PUBLISH, floored and clamped DOWN — never up.
 *
 * ⚠️ **It never raises a quantity to the band's minimum**, and that is the whole
 * point (O3). The shop's `stock_limit.min_limit` was measured at **2** on
 * 2026-09-17 and Shopee refused a create at `1` outright; clamping UP would
 * publish an availability the operator never authorised, and overselling across
 * channels is unrecoverable. Below the minimum, `montarAnuncio` raises
 * `estoque-abaixo-do-minimo` naming the band instead. The band's MAXIMUM is
 * clamped, because there the safe direction is down.
 *
 * ⚠️ The non-finite guard on `ownDisponivel` stays HERE rather than moving into
 * the core: the core floors with `Math.floor`, and `Math.floor(NaN)` is `NaN`,
 * which would survive the clamp and reach the wire. A produto's own availability
 * arrives from a soft-parsed document on this side of the seam, so the
 * tolerance belongs on this side too.
 *
 * Everything else is {@link opcoesShopee} over the shared core. It answers
 * `number | null`, and the `?? 0` tail is the TYPE's, not a behaviour: the only
 * producer of `null` is the virtual-kit skip, which this channel pins off.
 */
export function quantidadeParaPublicarShopee(args: {
  readonly ehKit: boolean;
  readonly ehKitVirtual: boolean;
  readonly componentesKit: ComponentesKit | null;
  readonly ownDisponivel: number;
  readonly disponivelByProdutoId: Record<string, number | null | undefined>;
  readonly banda: FaixaDto | null;
}): number {
  const proprio = Number.isFinite(args.ownDisponivel) ? args.ownDisponivel : 0;
  return (
    quantidadeParaEnvioCore(
      {
        ehKit: args.ehKit,
        ehKitVirtual: args.ehKitVirtual,
        componentesKit: args.componentesKit,
        ownDisponivel: proprio,
        disponivelByProdutoId: args.disponivelByProdutoId,
      },
      opcoesShopee(bandaFinita(args.banda)),
    ) ?? 0
  );
}

/** What {@link quantidadeDoMembroShopee} needs beyond the member itself. */
export interface OpcoesDoMembroShopee {
  /** The listing's category ceiling — `null` at sweep time, by design. */
  readonly bandaMax: number | null;
  /**
   * Whether Shopee composes this listing itself (`add_kit_item`) and derives
   * its stock from the components on ITS side.
   *
   * ⚠️ The caller supplies `link.kitNativo === true` and NOTHING else. The
   * stored field is three-valued, and both `false` and `null` (a link written
   * before the field existed) must SEND — narrowing it any other way would
   * silence every legacy link at once. The produto's own `ehKit` has no vote
   * here: it describes the ERP's composition, not Shopee's.
   */
  readonly kitNativo: boolean;
}

/**
 * ONE member's send quantity from its own joined estoque rows.
 *
 * `null` means "omit this member entirely" — never sent, never compared — and
 * the ONLY producer of it is a native Shopee kit. The shared core cannot answer
 * `null` for this channel (see {@link opcoesShopee}), so the two `null` sources
 * can never be confused.
 */
export function quantidadeDoMembroShopee(
  member: MembroDaFamilia,
  opcoes: OpcoesDoMembroShopee,
): number | null {
  if (opcoes.kitNativo) return null;
  return quantidadeDoMembroCore(member, opcoesShopee(opcoes.bandaMax));
}

/**
 * Every family member's send quantity, keyed by produto id.
 *
 * The band is deliberately `null`: at sweep time no category ceiling has been
 * read, and the sender clamps. See the module header's residual.
 */
export function quantidadesDaFamiliaShopee(row: LinhaDeFamilia): Map<string, number> {
  return quantidadesDaFamiliaCore(row, opcoesShopee(null));
}

/**
 * Every family member's send quantity **as it stood at the window start**.
 *
 * ⚠️ **THE OMISSION IS THE MECHANISM** (ADR 0014 §5b). A member whose stock the
 * ledger cannot reconstruct is LEFT OUT of this map, and
 * {@link deveEnviarFamiliaShopee} reads a missing entry as *unknown* and SENDS.
 * A fallback to the current row would read as "unchanged" and skip a real
 * movement. The core owns both arms; nothing here may soften them.
 *
 * Same `null` band as {@link quantidadesDaFamiliaShopee}, and for the same
 * reason — the two maps are compared against each other, so a ceiling applied
 * to one and not the other would manufacture a difference.
 */
export function quantidadesAnterioresShopee(
  row: LinhaDeFamilia,
  depositoId: string,
  movimentos: MovimentosDaJanela,
): Map<string, number> {
  return quantidadesAnterioresCore(row, depositoId, movimentos, opcoesShopee(null));
}

/**
 * The send policy, bound to Shopee's high-stock threshold
 * (`SHOPEE_STOCK_LIMIAR_ALTO`, default 100).
 *
 * ⚠️ The core compares `min(anterior, atual)`, never `atual` alone: `110 → 95`
 * must send, because that is the movement walking a listing INTO the danger
 * zone. Read ADR 0014 before touching the core; nothing here can change it.
 */
export function deveEnviarFamiliaShopee(
  quantidadesAtuais: ReadonlyMap<string, number>,
  anteriores: ReadonlyMap<string, number> | null,
  incremental: boolean,
): boolean {
  return deveEnviarFamiliaCore(quantidadesAtuais, anteriores, incremental, limiarEstoqueAlto());
}
