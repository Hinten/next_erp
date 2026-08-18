import { roundReais } from '@delfrance/core/money';
import type { VolumeFormState } from '../../types';

/**
 * The produto fields `pesoPedido` needs — a produto's own weight plus its
 * `paiId` for the variation→parent fallback. Callers batch-fetch these
 * (`useProdutoPesoMap`) keyed by produto id, including any parent a
 * zero-weight variation needs.
 */
export interface ProdutoPesoInfo {
  pesoBrutoKg: number | null;
  pesoLiquidoKg: number | null;
  paiId: string | null;
}

/** The item fields `pesoPedido` reads — a `FlatItem`/`ItemDoPedido` subset. */
export interface PesoPedidoItem {
  produtoUid: string | null | undefined;
  quantidade: number | null | undefined;
}

/** `quantidade ?? 1`, with any non-finite or `<= 0` value also coerced to `1`. */
function coerceQuantidade(q: number | null | undefined): number {
  if (q == null || !Number.isFinite(q) || q <= 0) return 1;
  return q;
}

/**
 * A pedido item's `produtoUid` can be a legacy full path (`produtos/p2`, the
 * old Flutter ODM convention) instead of a bare id — the same fixup
 * `productIdsFromPedidos` applies (`lib/pedido/downloadAnexos.ts`) and the one
 * legacy `getPesoPedido` itself does (`.split('/').last`, per issue #371's
 * legacy-context comment). Every produtoUid lookup in this module goes
 * through this so a legacy row still resolves its produto instead of
 * silently falling back to the 1kg/unit default.
 */
export function normalizeProdutoId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const id = raw.includes('/') ? (raw.split('/').pop() ?? raw) : raw;
  return id || null;
}

/**
 * Port of `getPesoPedido` (`.old/lib/pedido/providers/cadastroPedidoProvider.dart:1394-1448`,
 * see issue #371's legacy-context comment for the full trace) — the pedido's
 * total weight in **kg**, used to default the Frete tab's "+ Novo volume"
 * weight so adding one doesn't start from a blind guess.
 *
 * `itens` must already exclude staged-for-deletion rows (`FlatItem._delete`) —
 * this function has no delete-marker concept of its own. `produtoPesoById` is
 * a pre-batched map keyed by **normalized** produto id (see
 * {@link normalizeProdutoId} — this function normalizes each item's
 * `produtoUid` before looking it up, so the caller may pass either bare ids
 * or legacy full paths); for a produto whose own weights are both null/0 AND
 * carries a `paiId`, the map must ALSO hold that parent's entry (the
 * variation→parent fallback below reads it from the same map, one lookup, no
 * nested fetch).
 *
 * - No items → `1` (1kg floor, never 0 — a freight quote must never request a
 *   0kg shipment).
 * - No `produtoUid` on a row → contributes `1 * quantidade` (quantidade
 *   defaults/coerces to `1`).
 * - `produtoUid` set but missing from the map (produto unresolvable) →
 *   contributes `1 * quantidade`.
 * - Otherwise: `pesoBrutoKg ?? pesoLiquidoKg ?? 1` — bruto preferred over
 *   líquido. If BOTH are null-or-zero and the produto has a `paiId`, use the
 *   parent's `pesoBrutoKg ?? pesoLiquidoKg ?? 1` instead (variation→parent,
 *   not BOM/kit expansion — a kit's own weight is used as-is).
 * - The sum is **not rounded**. A final `<= 0` total still floors to `1`.
 */
export function pesoPedido(
  itens: readonly PesoPedidoItem[],
  produtoPesoById: Readonly<Record<string, ProdutoPesoInfo | null | undefined>>,
): number {
  if (itens.length === 0) return 1;

  let peso = 0;
  for (const item of itens) {
    const quantidade = coerceQuantidade(item.quantidade);
    const produtoId = normalizeProdutoId(item.produtoUid);
    if (!produtoId) {
      peso += 1 * quantidade;
      continue;
    }
    const produto = produtoPesoById[produtoId];
    if (!produto) {
      peso += 1 * quantidade;
      continue;
    }
    let pesoProduto = produto.pesoBrutoKg ?? produto.pesoLiquidoKg ?? 1;
    if ((produto.pesoBrutoKg ?? 0) === 0 && (produto.pesoLiquidoKg ?? 0) === 0 && produto.paiId) {
      const pai = produtoPesoById[produto.paiId];
      pesoProduto = pai?.pesoBrutoKg ?? pai?.pesoLiquidoKg ?? 1;
    }
    peso += pesoProduto * quantidade;
  }
  return peso <= 0 ? 1 : peso;
}

/**
 * Port of `Volume.padrao` (`.old/packages/pedido/lib/src/models.dart:1021-1033`)
 * — a single default Volume built from a pedido weight: 1 unit, 90% of
 * `pesoBruto` as `pesoLiquido` (2 decimals, byte-parity `duasCasasDecimais`
 * rounding — {@link roundReais} despite the money-flavored name, see
 * `@delfrance/core/money`), 'Pacote', hardcoded 10×10×10cm (the factory does
 * not read product dimensions — see `VolumesEditor`'s "+ Novo volume" button
 * for why that fallback is only ever a *starting point* the operator reviews,
 * never auto-committed to a quote unseen).
 */
export function volumePadrao(pesoBruto = 1): VolumeFormState {
  return {
    quantidade: 1,
    especie: 'Pacote',
    marca: null,
    numero: null,
    pesoBruto,
    pesoLiquido: roundReais(pesoBruto * 0.9),
    dimensoes: { altura: 10, largura: 10, comprimento: 10 },
    lacres: null,
  };
}
