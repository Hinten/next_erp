import type { ComponentesKit, Kit } from '../collection/embedded/kit';

/**
 * Kit available-stock computation — pure port of the kit branch of Flutter's
 * `Produto.getEstoqueDisponivel` (`packages/produtos/lib/src/models.dart:1420`).
 * Like `custoDoKit`/`pesoDoKit`, this is pure: the caller batches the component
 * estoque reads for ONE depósito into `disponivelByProdutoId` (component
 * produto id → its `disponivel` there, i.e. `estoqueDisponivel(doc)`).
 */

/**
 * The well-formed entries of a possibly-malformed `componentesKit`. Reads
 * soft-parse (`parseSoftRead`), so the map itself or any entry can be raw junk
 * at runtime — a non-record map or a non-object entry yields no entries instead
 * of throwing mid-render.
 */
export function componentesKitEntries(
  componentes: ComponentesKit | null | undefined,
): Array<[string, Kit]> {
  if (typeof componentes !== 'object' || componentes === null || Array.isArray(componentes)) {
    return [];
  }
  return Object.entries(componentes).filter(
    (entry): entry is [string, Kit] => typeof entry[1] === 'object' && entry[1] !== null,
  );
}

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
 * ⚠️ That divergence is **load-bearing downstream, not just a local nicety**:
 * the Mercado Livre stock sweep publishes the number this returns, and relies on
 * an unresolvable component producing 0 so an unverifiable kit is advertised as
 * out of stock rather than left at a stale positive quantity (ADR 0014; the
 * sweep additionally forces that 0 to actually be sent, and logs it). Reverting
 * to Flutter's skip-the-component behaviour here would silently overstate
 * availability on the marketplace — do not revisit it as an isolated change.
 *
 * Defensive (also divergent): a non-object entry, or one whose `quantidade` is
 * not a finite number > 0, is ignored — the schema enforces the shape, but
 * soft-parsed raw docs can carry junk that would otherwise throw or yield
 * `Infinity`/`NaN` (`componentesKitEntries` does the shape filtering).
 */
export function kitEstoqueDisponivel(
  componentes: ComponentesKit | null | undefined,
  disponivelByProdutoId: Record<string, number | null | undefined>,
): number | null {
  let min: number | null = null;
  for (const [produtoId, kit] of componentesKitEntries(componentes)) {
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
