import {
  flattenPedidoItens,
  itemDoPedidoSchema,
  pedidoSchema,
  type EngineProduto,
  type ItemDoPedido,
} from '@delfrance/schemas';
import type { CheckoutData } from '@/lib/checkout/loadPedidoCheckout';

/**
 * PR 7 perf/leak harness — the fixture BUILDER.
 *
 * `buildFixturePedido` synthesizes a fully in-memory `CheckoutData` (the exact
 * shape `loadCheckoutData` returns) for a large pedido, so the dev harness page
 * and the LOCAL Playwright spec can drive the real `CheckoutScreen` through the
 * fixture seam (`staticFixture`) with NO Firestore round-trip. It is a pure,
 * DETERMINISTIC function — every value is derived from the item index (no
 * `Math.random` / `Date.now`), so two calls with the same options produce
 * byte-identical data and the vitest below can assert exact counts.
 *
 * The output mirrors `loadCheckoutData` faithfully: `itens` is the
 * `flattenPedidoItens`-flattened, ordem-sorted projection of the (parsed)
 * grouped `pedido.itens`, and `produtos` holds every line produto PLUS every kit
 * component produto (loadCheckoutData fetches those in its wave-2 read), so the
 * scan index resolves both.
 */

export interface BuildFixtureOptions {
  /** number of line items (distinct produtos). Default 1000. */
  count?: number;
  /** fraction of produtos that are kits (2 components each). Default 0.3. */
  kitRatio?: number;
  /**
   * Namespaces every id. Seed 0 (the default) yields the documented ids
   * (`p0`, `p1`, … / components `c0a`, `c0b`, …); a non-zero seed produces a
   * disjoint id space so the harness's "Cycle pedido" gets a genuinely fresh
   * pedido on each remount.
   */
  seed?: number;
}

const DEFAULT_COUNT = 1000;
const DEFAULT_KIT_RATIO = 0.3;

/** A minimal non-kit `EngineProduto` (used for line produtos and kit components). */
function engineProduto(
  id: string,
  nome: string,
  sku: string,
  ehKit: boolean,
  componentesKit: Record<string, { quantidade: number }> | null,
): EngineProduto {
  return { id, nome, sku, ehKit, componentesKit, fotos: [] };
}

/**
 * Build a deterministic in-memory `CheckoutData` for a `count`-line pedido where
 * every line is `quantidade: 1`, ~`kitRatio` of the produtos are kits, and each
 * kit has two single-unit components. Scanning each item's `produtoUid` once
 * completes its line (a unit scan for a plain produto, a whole-kit scan for a
 * kit) — see `fixtureBarcodes`.
 */
export function buildFixturePedido(opts: BuildFixtureOptions = {}): CheckoutData {
  const count = opts.count ?? DEFAULT_COUNT;
  const kitRatio = opts.kitRatio ?? DEFAULT_KIT_RATIO;
  const seed = opts.seed ?? 0;

  // Seed 0 → no prefix (documented ids); any other seed namespaces every id.
  const sfx = seed === 0 ? '' : `${seed}_`;
  // ~kitRatio of produtos are kits, chosen by position in every 10-item window
  // (deterministic, no RNG): 0.3 → 3 of every 10 are kits.
  const kitCutoff = Math.round(kitRatio * 10);
  const isKitAt = (i: number): boolean => i % 10 < kitCutoff;

  const produtos = new Map<string, EngineProduto>();
  const grouped: Record<string, ItemDoPedido[]> = {};
  const itensIds: string[] = [];

  for (let i = 0; i < count; i++) {
    const produtoUid = `p${sfx}${i}`;
    const sku = `SKU${sfx}${i}`;
    const ehKit = isKitAt(i);
    const nome = ehKit ? `Kit ${sfx}${i}` : `Produto ${sfx}${i}`;

    let componentesKit: Record<string, { quantidade: number }> | null = null;
    if (ehKit) {
      const compA = `c${sfx}${i}a`;
      const compB = `c${sfx}${i}b`;
      componentesKit = { [compA]: { quantidade: 1 }, [compB]: { quantidade: 1 } };
      // Kit components are real produtos too (loadCheckoutData wave 2) — add them
      // so the scan index + ExpectedPane can resolve each component row.
      produtos.set(compA, engineProduto(compA, `Componente ${sfx}${i}A`, `${sku}-A`, false, null));
      produtos.set(compB, engineProduto(compB, `Componente ${sfx}${i}B`, `${sku}-B`, false, null));
    }

    produtos.set(produtoUid, engineProduto(produtoUid, nome, sku, ehKit, componentesKit));

    // `precoDeVenda` (min 0) + `quantidade` (min 0) are required; the rest
    // fill from schema defaults. Ascending `ordem` keeps the flattened order stable.
    const item = itemDoPedidoSchema.parse({
      produtoUid,
      ordem: i,
      quantidade: 1,
      precoDeVenda: 10,
      sku,
      gtin: `GTIN${sfx}${i}`,
      nomeDeVenda: nome,
    });
    grouped[produtoUid] = [item];
    itensIds.push(produtoUid);
  }

  const pedido = pedidoSchema.parse({
    numero: `HARNESS-${seed}`,
    ehSaida: true,
    estado: 'pago',
    itens: grouped,
    itensIds,
  });

  // Exactly what loadCheckoutData does: the screen's `itens` is the flattened,
  // ordem-sorted projection of the parsed grouped itens — so the two always
  // reconcile by construction.
  const itens = flattenPedidoItens(pedido.itens);

  return {
    pedido,
    pedidoId: `harness-pedido-${seed}`,
    itens,
    produtos,
    existingCheckout: null,
    incidentes: [],
  };
}

/**
 * The ordered list of codes to auto-scan: each line item's `produtoUid`. Because
 * a produtoUid is also its produto's id (and thus a key in the scan index),
 * feeding these back through the scan input resolves O(1) with no Firestore
 * fallback, and one scan per code completes the whole pedido.
 */
export function fixtureBarcodes(data: CheckoutData): string[] {
  return data.itens.map((item) => item.produtoUid).filter((uid): uid is string => uid !== null);
}
