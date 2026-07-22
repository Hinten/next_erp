/**
 * Streamed catalog load for the bulk price-recalculation screen (#544) — every
 * PARENT produto (`paiId == null`), projected down to the slim fields the
 * price-formula engine (`calcularPreco` + the kit cost/weight helpers) needs.
 *
 * Mirrors the cursor-paginated pattern in
 * `apps/web/lib/nfe/export/exportQuery.ts`: each page's raw docs are mapped to
 * slim `ProdutoPrecoRow`s immediately, so the full `Produto` documents are
 * never retained across pages — only `sku`/`nome`/`custo`/`precos`/weights/kit
 * shape survive. `startAfter` cursors off the LAST RAW SNAPSHOT of the
 * previous page, same as `pageNotes`.
 */
import {
  type Firestore,
  type QueryConstraint,
  type QueryDocumentSnapshot,
  getCountFromServer,
  getDocs,
  startAfter,
} from 'firebase/firestore';
import { buildQuery, limit, orderByField, whereEqual } from '@delfrance/data';
import { idFromRef, type ComponentesKit, type PrecosMap, type Produto } from '@delfrance/schemas';

import { getDocsByIds } from '@/lib/data/getDocsByIds';
import { produtoCollection } from '@/lib/data/produtoCollection';

/** Slim projection of a parent `Produto` — everything `calcularPreco` and the
 * kit cost/weight helpers need, nothing else (so a page of docs can be
 * dropped as soon as it's mapped). */
export interface ProdutoPrecoRow {
  id: string;
  sku: string | null;
  nome: string;
  custo: number | null;
  precos: PrecosMap;
  /** Trailing doc id of `categoriaProdutoOuterRef` (`documents/categorias/<id>`),
   * or `null` when the produto has no category. */
  categoriaId: string | null;
  pesoBrutoKg: number | null;
  pesoLiquidoKg: number | null;
  ehKit: boolean;
  componentesKit: ComponentesKit | null;
}

/** Project a raw parent-produto snapshot to its slim row. Exported (pure, no
 * Firestore call) so the mapping — including the `categoriaId` extraction and
 * null-safety on every optional field — is unit-testable without mocking the
 * SDK. */
export function toProdutoPrecoRow(d: QueryDocumentSnapshot<Produto>): ProdutoPrecoRow {
  const p = d.data();
  return {
    id: d.id,
    sku: p.sku,
    nome: p.nome,
    custo: p.custo,
    precos: p.precos,
    categoriaId: p.categoriaProdutoOuterRef ? idFromRef(p.categoriaProdutoOuterRef) : null,
    pesoBrutoKg: p.pesoBrutoKg,
    pesoLiquidoKg: p.pesoLiquidoKg,
    ehKit: p.ehKit,
    componentesKit: p.componentesKit,
  };
}

/** Page size for `pageParentProdutos` — smaller than `exportQuery.ts`'s 500
 * because every row here also feeds the kit-resolution by-ids fetch. */
export const CATALOGO_PAGE = 300;

/** Server-side count of parent produtos (`paiId == null`) — the `total` for
 * the load progress bar. */
export async function countParentProdutos(db: Firestore): Promise<number> {
  const snap = await getCountFromServer(
    buildQuery(produtoCollection.ref(db, {}), [whereEqual('paiId', null)]),
  );
  return snap.data().count;
}

export interface PageParentProdutosOptions {
  pageSize?: number;
  /** Checked at each page boundary; an aborted signal stops the stream by
   * throwing (see the `AbortError` docs below) instead of silently returning
   * a truncated result. */
  signal?: AbortSignal;
  /** Extra constraints inserted after the `paiId`/`orderBy` constraints (e.g.
   * a name-prefix filter), same slot `defaultQueryConstraints` reserves. */
  extraConstraints?: QueryConstraint[];
}

/** No repo-wide `AbortError` class exists yet — `grep -r AbortError` over
 * `apps/web` turns up nothing. This follows the platform-standard shape
 * (`DOMException` with `name: 'AbortError'`, the same shape `fetch`/
 * `AbortController` throw) so callers can narrow with
 * `err instanceof DOMException && err.name === 'AbortError'`. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException('Carregamento do catálogo cancelado', 'AbortError');
  }
}

/**
 * Stream every parent produto (`paiId == null`, ordered by `nome`) page by
 * page. Every filter is server-side; cursor pagination via `startAfter` on
 * the previous page's last raw doc, exactly the `pageNotes` pattern in
 * `exportQuery.ts`.
 */
export async function* pageParentProdutos(
  db: Firestore,
  opts: PageParentProdutosOptions = {},
): AsyncGenerator<ProdutoPrecoRow[]> {
  const { pageSize = CATALOGO_PAGE, signal, extraConstraints = [] } = opts;
  const baseQ = buildQuery(produtoCollection.ref(db, {}), [
    whereEqual('paiId', null),
    orderByField('nome'),
    ...extraConstraints,
  ]);

  let cursor: QueryDocumentSnapshot<Produto> | undefined;

  for (;;) {
    throwIfAborted(signal);
    const pageConstraints = cursor ? [limit(pageSize), startAfter(cursor)] : [limit(pageSize)];
    const snap = await getDocs(buildQuery(baseQ, pageConstraints));
    throwIfAborted(signal);
    if (snap.empty) break;
    const docs = snap.docs as QueryDocumentSnapshot<Produto>[];

    yield docs.map(toProdutoPrecoRow);

    if (docs.length < pageSize) break;
    cursor = docs[docs.length - 1];
  }
}

/** The four maps `custoDoKit`/`pesoDoKit` (and their `resolveComponent*`
 * building blocks) need to resolve a kit's components, keyed by component
 * produto id. `paiByProdutoId` maps a component id to its `paiId` (or `null`)
 * so a variation-child component with no own cost/weight can fall back to its
 * parent's — the parent's data is expected to already be present (parents are
 * exactly the rows `pageParentProdutos` streams). */
export interface KitResolucao {
  custoByProdutoId: Record<string, number | null | undefined>;
  pesoBrutoByProdutoId: Record<string, number | null | undefined>;
  pesoLiquidoByProdutoId: Record<string, number | null | undefined>;
  paiByProdutoId: Record<string, string | null | undefined>;
}

/** The slim shape `loadKitResolucao` needs from a fetched kit-component doc —
 * a subset of `Produto`, matched by `getDocsByIds`' return value. */
export interface ComponenteProdutoData {
  custo: number | null;
  pesoBrutoKg: number | null;
  pesoLiquidoKg: number | null;
  paiId: string | null;
}

/** DI seam for the by-ids fetch — defaults to the real `getDocsByIds` against
 * `produtoCollection`; tests inject a stub so no Firestore mocking is needed. */
export type FetchComponentesByIds = (
  db: Firestore,
  ids: string[],
) => Promise<Map<string, ComponenteProdutoData>>;

async function defaultFetchComponentesByIds(
  db: Firestore,
  ids: string[],
): Promise<Map<string, ComponenteProdutoData>> {
  const docs = await getDocsByIds(db, produtoCollection, ids);
  const out = new Map<string, ComponenteProdutoData>();
  for (const [id, p] of docs) {
    out.set(id, {
      custo: p.custo,
      pesoBrutoKg: p.pesoBrutoKg,
      pesoLiquidoKg: p.pesoLiquidoKg,
      paiId: p.paiId,
    });
  }
  return out;
}

/**
 * Build the kit-resolution maps for a batch of already-loaded parent rows:
 * seed all four maps from the parents themselves (a parent's own `paiId` is
 * always `null` — that's the query that produced them), then fetch whichever
 * kit-component ids aren't already in that set (one batched `getDocsByIds`
 * call) and add their custo/pesos/`paiId`. A component id that's STILL
 * missing after the fetch (a dangling `componentesKit` reference to a
 * deleted/unreadable doc) simply stays absent from every map —
 * `custoDoKit`/`pesoDoKit` report it via `faltando` rather than this function
 * throwing or recursing further.
 */
export async function loadKitResolucao(
  db: Firestore,
  produtos: ProdutoPrecoRow[],
  fetchComponentesByIds: FetchComponentesByIds = defaultFetchComponentesByIds,
): Promise<KitResolucao> {
  const custoByProdutoId: Record<string, number | null | undefined> = {};
  const pesoBrutoByProdutoId: Record<string, number | null | undefined> = {};
  const pesoLiquidoByProdutoId: Record<string, number | null | undefined> = {};
  const paiByProdutoId: Record<string, string | null | undefined> = {};

  for (const p of produtos) {
    custoByProdutoId[p.id] = p.custo;
    pesoBrutoByProdutoId[p.id] = p.pesoBrutoKg;
    pesoLiquidoByProdutoId[p.id] = p.pesoLiquidoKg;
    paiByProdutoId[p.id] = null;
  }

  const missing = new Set<string>();
  for (const p of produtos) {
    if (!p.ehKit) continue;
    for (const componentId of Object.keys(p.componentesKit ?? {})) {
      if (!(componentId in custoByProdutoId)) missing.add(componentId);
    }
  }

  if (missing.size > 0) {
    const fetched = await fetchComponentesByIds(db, [...missing]);
    for (const [id, data] of fetched) {
      custoByProdutoId[id] = data.custo;
      pesoBrutoByProdutoId[id] = data.pesoBrutoKg;
      pesoLiquidoByProdutoId[id] = data.pesoLiquidoKg;
      paiByProdutoId[id] = data.paiId;
    }
  }

  return { custoByProdutoId, pesoBrutoByProdutoId, pesoLiquidoByProdutoId, paiByProdutoId };
}
