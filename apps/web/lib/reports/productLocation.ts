import {
  documentId,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  where,
  type Firestore,
  type FirestoreDataConverter,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { groupQuery } from '@delfrance/data';
import {
  estoqueDisponivel,
  estoqueProdutoSchema,
  idFromRef,
  parseRef,
  toOuterRefOrNull,
  type EstoqueProduto,
  type Produto,
} from '@delfrance/schemas';
import { estoqueProdutoCollection } from '@/lib/data/estoqueProdutoCollection';
import { getDocsByIds } from '@/lib/data/getDocsByIds';
import { produtoCollection } from '@/lib/data/produtoCollection';

const PRODUTO_BATCH_SIZE = 30;
const ESTOQUE_PAGE_SIZE = 500;

export interface ProductLocationStock {
  /** Full Firestore path. The produto identity is derived from this, never `parentId`. */
  path: string;
  data: Pick<EstoqueProduto, 'localizacao' | 'quantidade' | 'quantidadeReservada' | 'parentId'>;
}

export interface ProductLocationProduct {
  sku: Produto['sku'];
  nome: Produto['nome'];
}

export interface ProductLocationRow {
  key: string;
  produtoId: string;
  sku: string | null;
  produto: string;
  localizacao: string;
  total: number;
  reservado: number;
  disponivel: number;
}

export type ProductLocationProgress =
  | { phase: 'estoques'; loaded: number }
  | { phase: 'produtos'; done: number; total: number };

export interface ProductLocationReader {
  readStocks(
    depositoOuterRefs: readonly [string, string],
    onPage: (loaded: number) => void,
  ): Promise<ProductLocationStock[]>;
  readProducts(ids: readonly string[]): Promise<Map<string, ProductLocationProduct>>;
}

/**
 * Report-only read converter. The migrated corpus carries bare outer refs, but
 * the shared schema intentionally accepts only the canonical wire shape. Make
 * that tolerated encoding canonical before parsing so all schema defaults are
 * still applied instead of falling through `parseSoftRead` as raw data.
 */
export const productLocationStockReadConverter: FirestoreDataConverter<EstoqueProduto> = {
  toFirestore: estoqueProdutoCollection.converter.toFirestore,
  fromFirestore(snapshot: QueryDocumentSnapshot, options) {
    const raw = snapshot.data(options);
    const depositoOuterRef = toOuterRefOrNull(raw['depositoOuterRef']);
    return estoqueProdutoSchema.parse({
      ...raw,
      depositoOuterRef: depositoOuterRef ?? raw['depositoOuterRef'],
    });
  },
};

/** Both string encodings present in the migrated corpus, canonical first. */
export function depositoOuterRefVariants(raw: unknown): readonly [string, string] {
  const canonical = toOuterRefOrNull(raw);
  if (canonical === null || parseRef(canonical).collection !== 'depositos') {
    throw new RangeError('Selecione um depósito válido.');
  }
  return [canonical, canonical.slice('documents/'.length)];
}

/**
 * `produtos/<produtoId>/estoques/<estoqueId>` → produto id.
 *
 * The denormalized `parentId` is intentionally irrelevant here: probes and
 * legacy rows can omit or disagree with it, while the document path is the
 * ownership fact Firestore itself supplies.
 */
export function produtoIdFromEstoquePath(path: string): string | null {
  const segments = path.split('/');
  return segments.length === 4 && segments[0] === 'produtos' && segments[2] === 'estoques'
    ? (segments[1] ?? null)
    : null;
}

/** Pure result transformation shared by the loader and its focused tests. */
export function shapeProductLocationRows(
  stocks: readonly ProductLocationStock[],
  products: ReadonlyMap<string, ProductLocationProduct>,
): ProductLocationRow[] {
  const rows: ProductLocationRow[] = [];

  for (const stock of stocks) {
    const produtoId = produtoIdFromEstoquePath(stock.path);
    const localizacao = stock.data.localizacao?.trim() ?? '';
    if (produtoId === null || localizacao === '') continue;

    const product = products.get(produtoId);
    rows.push({
      key: stock.path,
      produtoId,
      sku: product?.sku ?? null,
      produto: product?.nome ?? produtoId,
      localizacao,
      total: stock.data.quantidade,
      reservado: stock.data.quantidadeReservada,
      disponivel: estoqueDisponivel(stock.data),
    });
  }

  return rows.sort(
    (a, b) =>
      a.localizacao.localeCompare(b.localizacao, 'pt-BR', { numeric: true }) ||
      a.produto.localeCompare(b.produto, 'pt-BR', { sensitivity: 'base' }),
  );
}

/**
 * Run the report through a small data-source seam. Estoques load page by page;
 * produto details then load in sequential 30-id batches so both the Firestore
 * `in` cap and progress remain explicit.
 */
export async function buildProductLocationReport(
  reader: ProductLocationReader,
  depositoOuterRef: unknown,
  onProgress: (progress: ProductLocationProgress) => void = () => undefined,
): Promise<ProductLocationRow[]> {
  const variants = depositoOuterRefVariants(depositoOuterRef);
  onProgress({ phase: 'estoques', loaded: 0 });
  const stocks = await reader.readStocks(variants, (loaded) =>
    onProgress({ phase: 'estoques', loaded }),
  );

  const locatedStocks = stocks.filter((stock) => (stock.data.localizacao?.trim() ?? '') !== '');
  const produtoIds = [
    ...new Set(
      locatedStocks
        .map((stock) => produtoIdFromEstoquePath(stock.path))
        .filter((id): id is string => id !== null),
    ),
  ];

  const products = new Map<string, ProductLocationProduct>();
  onProgress({ phase: 'produtos', done: 0, total: produtoIds.length });
  for (let start = 0; start < produtoIds.length; start += PRODUTO_BATCH_SIZE) {
    const batch = produtoIds.slice(start, start + PRODUTO_BATCH_SIZE);
    const loaded = await reader.readProducts(batch);
    for (const [id, product] of loaded) products.set(id, product);
    onProgress({
      phase: 'produtos',
      done: Math.min(start + batch.length, produtoIds.length),
      total: produtoIds.length,
    });
  }

  return shapeProductLocationRows(locatedStocks, products);
}

function firestoreReader(db: Firestore): ProductLocationReader {
  return {
    async readStocks(depositoOuterRefs, onPage) {
      const base = query(
        groupQuery(db, 'estoques', productLocationStockReadConverter),
        where('depositoOuterRef', 'in', [...depositoOuterRefs]),
        orderBy(documentId()),
      );
      const stocks: ProductLocationStock[] = [];
      let cursor: QueryDocumentSnapshot<EstoqueProduto> | undefined;

      for (;;) {
        const page = await getDocs(
          cursor
            ? query(base, limit(ESTOQUE_PAGE_SIZE), startAfter(cursor))
            : query(base, limit(ESTOQUE_PAGE_SIZE)),
        );
        if (page.empty) break;
        for (const stock of page.docs) {
          stocks.push({ path: stock.ref.path, data: stock.data() });
        }
        onPage(stocks.length);
        if (page.size < ESTOQUE_PAGE_SIZE) break;
        cursor = page.docs[page.size - 1];
        if (cursor === undefined) break;
      }

      return stocks;
    },
    async readProducts(ids) {
      const products = await getDocsByIds(db, produtoCollection, ids);
      return new Map(
        [...products].map(([id, product]) => [
          id,
          { sku: product.sku, nome: product.nome } satisfies ProductLocationProduct,
        ]),
      );
    },
  };
}

/** Firestore adapter used by the client page. Read-only; no index or infra writes. */
export function loadProductLocationReport(
  db: Firestore,
  depositoOuterRef: unknown,
  onProgress?: (progress: ProductLocationProgress) => void,
): Promise<ProductLocationRow[]> {
  return buildProductLocationReport(firestoreReader(db), depositoOuterRef, onProgress);
}

/** Stable depósito id for filenames and UI labels. */
export function depositoIdFromOuterRef(raw: unknown): string {
  const [canonical] = depositoOuterRefVariants(raw);
  return idFromRef(canonical);
}
