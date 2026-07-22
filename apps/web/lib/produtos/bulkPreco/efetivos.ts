/**
 * Effective custo/peso for a produto row — the two inputs `calcularPreco`
 * needs (`custo`, `pesoKg`) resolved through the kit fallback chains. Pure:
 * every lookup goes through the batched `KitResolucao` maps `loadKitResolucao`
 * built, no Firestore reads here.
 */
import {
  custoDoKit,
  pesoDoKit,
  KIT_PESO_BRUTO_FALLBACK_KG,
  KIT_PESO_LIQUIDO_FALLBACK_KG,
  type CustoKitResult,
} from '@delfrance/schemas';

import type { KitResolucao, ProdutoPrecoRow } from './loadCatalogo';

/**
 * Effective cost — port of the kit branch of Flutter's
 * `Produto.custoProdutoContabilizandoKit` via the pure `custoDoKit` engine.
 * Non-kit produtos use their own `custo` as-is (never "missing" here — a null/
 * absent custo is a valid value the caller reports as an error upstream, same
 * as the legacy `custo == null` check in `alterarPrecoMassa2.dart:400`).
 */
export function custoEfetivo(p: ProdutoPrecoRow, r: KitResolucao): CustoKitResult {
  if (!p.ehKit) return { custo: p.custo, faltando: [] };
  return custoDoKit(p.componentesKit, r.custoByProdutoId, r.paiByProdutoId);
}

/**
 * Effective weight fed into `calcularPreco`'s `pesoKg` — the legacy fallback
 * chain `getPesoBrutoKg() ?? getPesoLiquidoKg() ?? 0.25`
 * (`alterarPrecoMassa2.dart:426-430`, `recalcularPrecos.dart:460`).
 *
 * For a kit, each side of that chain is itself the KIT's summed weight
 * (`pesoDoKit` over bruto, then over líquido) rather than the produto's own
 * field — `pesoDoKit` returns `null` ONLY when `componentesKit` is empty/
 * absent (an unresolved individual component weight uses its own
 * `KIT_PESO_*_FALLBACK_KG` internally and never propagates as "missing"), so
 * the outer chain only reaches the crude 0.25kg default when the kit has no
 * components at all.
 */
export function pesoEfetivoKg(p: ProdutoPrecoRow, r: KitResolucao): number {
  if (!p.ehKit) {
    return p.pesoBrutoKg ?? p.pesoLiquidoKg ?? 0.25;
  }
  const bruto = pesoDoKit(
    p.componentesKit,
    r.pesoBrutoByProdutoId,
    r.paiByProdutoId,
    KIT_PESO_BRUTO_FALLBACK_KG,
  );
  if (bruto !== null) return bruto;
  const liquido = pesoDoKit(
    p.componentesKit,
    r.pesoLiquidoByProdutoId,
    r.paiByProdutoId,
    KIT_PESO_LIQUIDO_FALLBACK_KG,
  );
  if (liquido !== null) return liquido;
  return 0.25;
}
