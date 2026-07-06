import type { ComponentesKit } from '../collection/embedded/kit';

/**
 * Kit available-stock computation — pure port of the kit branch of Flutter's
 * `Produto.getEstoqueDisponivel` (`packages/produtos/lib/src/models.dart:1420`).
 * Like `custoDoKit`/`pesoDoKit`, this is pure: the caller batches the component
 * estoque reads for ONE depósito into `disponivelByProdutoId` (component
 * produto id → its `disponivel` there, i.e. `estoqueDisponivel(doc)`).
 */

/**
 * How many kits the components allow building: the **min** over components with
 * `limitarEstoque !== false` of `disponivel / quantidade` — plain division,
 * unrounded (fractional values surface as-is; the legacy int/marketplace
 * variant truncates, display formats). Returns `null` when no component
 * constrains stock (empty/absent map, or every entry has
 * `limitarEstoque: false`) — the produto's own stock then stands alone.
 *
 * Deliberate divergence from Flutter (decided 2026-07-06, #238): a component
 * with NO resolvable disponivel (absent key, `null`, or a non-finite value from
 * a soft-parsed doc) counts as **0** — the legacy code silently skipped it,
 * overstating kit availability when a required component was never stocked at
 * that depósito. Treating it as 0 matches the pedido→estoque sync, which
 * decrements every `limitarEstoque` component on sale.
 *
 * Defensive (also divergent): an entry whose `quantidade` is not a finite
 * number > 0 is ignored — the schema enforces int ≥ 1, but soft-parsed raw
 * docs can carry junk that would otherwise yield `Infinity`/`NaN`.
 */
export function kitEstoqueDisponivel(
  componentes: ComponentesKit | null | undefined,
  disponivelByProdutoId: Record<string, number | null | undefined>,
): number | null {
  let min: number | null = null;
  for (const [produtoId, kit] of Object.entries(componentes ?? {})) {
    if (kit.limitarEstoque === false) continue;
    if (!Number.isFinite(kit.quantidade) || kit.quantidade <= 0) continue;
    const raw = disponivelByProdutoId[produtoId];
    const disponivel = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    const candidate = disponivel / kit.quantidade;
    if (min === null || candidate < min) min = candidate;
  }
  return min;
}

/**
 * A produto's total available stock at one depósito — the full
 * `Produto.getEstoqueDisponivel` (`models.dart:1420`): the produto's own
 * `disponivel` plus, for kits, what the components allow building
 * (`kitEstoqueDisponivel`). Component-derived stock ADDS to the kit's own —
 * a kit can carry pre-assembled stock of itself.
 */
export function estoqueDisponivelComKit(
  produto: { ehKit: boolean; componentesKit: ComponentesKit | null | undefined },
  ownDisponivel: number,
  disponivelByProdutoId: Record<string, number | null | undefined>,
): number {
  if (!produto.ehKit) return ownDisponivel;
  return ownDisponivel + (kitEstoqueDisponivel(produto.componentesKit, disponivelByProdutoId) ?? 0);
}
