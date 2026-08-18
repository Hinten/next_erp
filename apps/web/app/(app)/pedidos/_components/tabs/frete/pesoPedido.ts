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
 * Port of `getPesoPedido` (`.old/lib/pedido/providers/cadastroPedidoProvider.dart:1394-1448`,
 * see issue #371's legacy-context comment for the full trace) — the pedido's
 * total weight in **kg**, used to auto-seed the Frete tab's default Volume so
 * freight can be quoted without manual entry.
 *
 * `itens` must already exclude staged-for-deletion rows (`FlatItem._delete`) —
 * this function has no delete-marker concept of its own. `produtoPesoById` is
 * a pre-batched map keyed by produto id; for a produto whose own weights are
 * both null/0 AND carries a `paiId`, the map must ALSO hold that parent's
 * entry (the variation→parent fallback below reads it from the same map, one
 * lookup, no nested fetch).
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
    if (!item.produtoUid) {
      peso += 1 * quantidade;
      continue;
    }
    const produto = produtoPesoById[item.produtoUid];
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
 * not read product dimensions).
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

/**
 * Whether the Frete tab should auto-seed a default Volume right now — pure
 * decision extracted from the tab's effect so it is unit-testable without
 * mounting the form. Port of the legacy ME widget's "seed only when volumes
 * is empty" init behavior (`_adicionarVolumeInicial`,
 * `.old/lib/integracoes_frete/melhor_envios/widgets.dart:87`), generalized to
 * every tipo per #371 — with two guards the legacy single-tipo widget didn't
 * need:
 *
 * - `pendingActivation` — true only for a frete-just-turned-on transition
 *   THIS mount (the caller latches it the moment `temFrete` flips false→true
 *   from a live `onModalidadeChange`, e.g. picking a modalidade on a fresh
 *   pedido). An already-active pedido loaded straight from Firestore with
 *   `volumes` empty (a legacy data gap, or a volume the operator removed and
 *   saved on purpose) never gets one fabricated back on a later open — only a
 *   genuine same-session activation seeds, so the seed's `shouldDirty: true`
 *   always reflects a real user action, never a passive-mount side effect
 *   that could race the page's post-load server-truth correction (a dirty
 *   form is never repainted with server truth).
 * - `marketplaceOwned` — a marketplace-imported freteInicial is owned
 *   entirely by the order importer (`MarketplaceReadOnly` renders no editor
 *   at all); this must never inject a locally-fabricated Volume into it.
 */
export function shouldSeedVolume(input: {
  /** A false→true `temFrete` transition happened this mount and is unresolved. */
  pendingActivation: boolean;
  marketplaceOwned: boolean;
  volumes: readonly VolumeFormState[] | null | undefined;
  /** `undefined` = the batched produto weight lookup is still in flight. */
  produtoPesoById: Readonly<Record<string, ProdutoPesoInfo | null>> | undefined;
}): boolean {
  if (!input.pendingActivation) return false;
  if (input.marketplaceOwned) return false;
  if (input.volumes && input.volumes.length > 0) return false;
  if (input.produtoPesoById === undefined) return false;
  return true;
}
