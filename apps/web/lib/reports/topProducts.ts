import { FirebaseError } from 'firebase/app';
import type { Firestore } from 'firebase/firestore';
import {
  and,
  array,
  conditional,
  constant,
  documentId,
  equal,
  equalAny,
  execute,
  field,
  greaterThanOrEqual,
  isType,
  lessThan,
  lessThanOrEqual,
  map,
  mapEntries,
  sum,
} from 'firebase/firestore/pipelines';
import {
  componentesKitEntries,
  estadoPedidoSchema,
  fotoSchema,
  fotosForVariacao,
  naoDocId,
  toDocPathOrNull,
  toOuterRefOrNull,
  type ComponentesKit,
  type EstadoPedido,
  type Foto,
} from '@delfrance/schemas';
import { coverArquivoIds } from '@/lib/produtos/fotoRefs';
import { checkoutDateRange } from './checkouts';

export interface TopProductsFilters {
  startUs: number;
  endExclusiveUs: number;
  estados: readonly EstadoPedido[];
  /** Integration document IDs; an empty selection includes every account. */
  accountIds: readonly string[];
  ehSaida: boolean;
}

export interface TopProductsSaleGroup {
  produtoId: string | null;
  quantidade: number;
  invalidLines: number;
}

export interface TopProductsVariation {
  produtoId: string;
  quantidade: number;
}

export interface TopProductsRow extends TopProductsVariation {
  variations: TopProductsVariation[];
}

export type TopProductsDiagnosticKind =
  | 'unlinked-items'
  | 'invalid-quantity'
  | 'missing-product'
  | 'invalid-product'
  | 'invalid-kit'
  | 'nested-kit';

export interface TopProductsDiagnostic {
  kind: TopProductsDiagnosticKind;
  produtoId: string | null;
  /** Known sold units affected; not an estimate of unknown component quantities. */
  quantidade: number;
  message: string;
}

export interface TopProductsReport {
  rows: TopProductsRow[];
  totalQuantidade: number;
  diagnostics: TopProductsDiagnostic[];
}

/** Raw projections remain unknown until their individual fields are inspected. */
export interface TopProductsProduct {
  [key: string]: unknown;
  paiId?: unknown;
  ehKit?: unknown;
  componentesKit?: unknown;
}

export interface TopProductsDecoration {
  nome: string;
  sku: string | null;
  photoUrl: string | null;
}

export interface HydratedTopProductsVariation extends TopProductsVariation, TopProductsDecoration {}

export interface HydratedTopProductsRow extends TopProductsVariation, TopProductsDecoration {
  variations: HydratedTopProductsVariation[];
}

const DOCUMENT_BATCH_SIZE = 30;
const STRUCTURAL_FIELDS = ['paiId', 'ehKit', 'componentesKit'];
const DISPLAY_FIELDS = ['nome', 'sku', 'fotos', 'variacoesUid'];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && !naoDocId(value);
}

/** Same inclusive calendar-day behavior as Checkouts, converted to pedido's µs unit. */
export function topProductsDateRange(start: string | null, end: string | null) {
  const range = checkoutDateRange(start, end);
  if (!range) return null;
  const startUs = range.startMs * 1000;
  const endExclusiveUs = range.endExclusiveMs * 1000;
  return Number.isSafeInteger(startUs) && Number.isSafeInteger(endExclusiveUs)
    ? { startUs, endExclusiveUs }
    : null;
}

/** Canonical selection order also gives the persistent cache a stable request key. */
export function normalizeTopProductsFilters(filters: TopProductsFilters): TopProductsFilters {
  if (
    !Number.isSafeInteger(filters.startUs) ||
    !Number.isSafeInteger(filters.endExclusiveUs) ||
    filters.startUs >= filters.endExclusiveUs ||
    typeof filters.ehSaida !== 'boolean'
  ) {
    throw new RangeError('Selecione um período válido para o relatório.');
  }
  if (filters.estados.length === 0) {
    throw new RangeError('Selecione pelo menos um estado de pedido.');
  }
  for (const state of filters.estados) {
    if (!estadoPedidoSchema.safeParse(state).success) {
      throw new RangeError('Estado de pedido inválido.');
    }
  }
  if (filters.accountIds.some((id) => !validId(id))) {
    throw new RangeError('Conta de marketplace inválida.');
  }
  return {
    ...filters,
    estados: [...new Set(filters.estados)].sort(),
    accountIds: [...new Set(filters.accountIds)].sort(),
  };
}

/**
 * Filter BEFORE expanding arrays. Only grouped SKU totals cross the wire;
 * neither complete pedidos nor the whole product catalog are downloaded.
 */
export function buildTopProductsPipeline(db: Firestore, input: TopProductsFilters) {
  const filters = normalizeTopProductsFilters(input);
  const predicates = [
    equal(field('ehSaida'), filters.ehSaida),
    greaterThanOrEqual(field('timestamp'), filters.startUs),
    lessThan(field('timestamp'), filters.endExclusiveUs),
  ];
  if (filters.estados.length > 0) {
    predicates.push(equalAny(field('estado'), [...filters.estados]));
  }
  if (filters.accountIds.length > 0) {
    predicates.push(
      equalAny(
        field('integracaoPedidoOuterRef'),
        filters.accountIds.flatMap((id) => ['documents/integracao/' + id, 'integracao/' + id]),
      ),
    );
  }
  // A malformed legacy bucket is represented by one invalid line, so it is
  // visible in diagnostics instead of disappearing behind unnest/sum semantics.
  const items = field('itens').ifAbsent({}).ifNull(false);
  const groups = mapEntries(conditional(isType(items, 'map'), items, map({ NONE: [{}] })));
  // isType on absent/null values can itself be absent/error. Give it a
  // defined, non-null operand, then compare only the numeric projection.
  const rawQuantity = field('item.quantidade').ifAbsent(false).ifNull(false);
  const quantity = conditional(isType(rawQuantity, 'number'), rawQuantity, constant(-1));
  const groupItems = field('itemGroups.v').ifAbsent(false).ifNull(false);
  const validQuantity = and(
    greaterThanOrEqual(quantity, 0),
    lessThanOrEqual(quantity, Number.MAX_VALUE),
  );
  return db
    .pipeline()
    .collection('pedidos')
    .where(and(predicates[0]!, predicates[1]!, ...predicates.slice(2)))
    .select(groups.as('itemGroups'))
    .unnest(field('itemGroups'))
    .unnest(conditional(isType(groupItems, 'array'), groupItems, array([{}])).as('item'))
    .aggregate({
      groups: [field('itemGroups.k').as('produtoId')],
      accumulators: [
        sum(conditional(validQuantity, quantity, constant(0))).as('quantidade'),
        sum(conditional(validQuantity, constant(0), constant(1))).as('invalidLines'),
      ],
    });
}

/** Aggregate rows are ad-hoc records and bypass collection converters. */
export function topProductsGroupFromResult(data: Record<string, unknown>): TopProductsSaleGroup {
  if (
    typeof data.quantidade !== 'number' ||
    !Number.isFinite(data.quantidade) ||
    data.quantidade < 0 ||
    typeof data.invalidLines !== 'number' ||
    !Number.isSafeInteger(data.invalidLines) ||
    data.invalidLines < 0 ||
    typeof data.produtoId !== 'string'
  ) {
    throw new TypeError('Quantidade de produtos vendidos inválida.');
  }
  return {
    produtoId: validId(data.produtoId) && data.produtoId !== 'NONE' ? data.produtoId : null,
    quantidade: data.quantidade,
    invalidLines: data.invalidLines,
  };
}

/**
 * Expand kits using their CURRENT catalog recipe, once, including every
 * component. limitarEstoque is deprecated and must not change sales counts.
 * Parent ranking happens only AFTER all direct and expanded variation units join.
 */
export function aggregateTopProducts(
  groups: readonly TopProductsSaleGroup[],
  products: ReadonlyMap<string, TopProductsProduct>,
): TopProductsReport {
  const diagnostics: TopProductsDiagnostic[] = [];
  const quantities = new Map<string, number>();
  const add = (id: string, quantity: number) => {
    const next = (quantities.get(id) ?? 0) + quantity;
    if (!Number.isFinite(next)) throw new RangeError('Quantidade de produtos fora do limite.');
    quantities.set(id, next);
  };
  const diagnostic = (
    kind: TopProductsDiagnosticKind,
    produtoId: string | null,
    quantidade: number,
    message: string,
  ) => diagnostics.push({ kind, produtoId, quantidade, message });

  for (const group of groups) {
    const { produtoId, quantidade } = group;
    if (group.invalidLines > 0) {
      diagnostic(
        'invalid-quantity',
        produtoId,
        quantidade,
        group.invalidLines +
          ' item(ns) com quantidade ou estrutura inválida foram desconsiderados.',
      );
    }
    if (quantidade <= 0) continue;
    if (produtoId === null) {
      diagnostic(
        'unlinked-items',
        null,
        quantidade,
        'Itens sem vínculo com produto foram desconsiderados.',
      );
      continue;
    }
    const product = products.get(produtoId);
    if (!product) {
      add(produtoId, quantidade);
      diagnostic(
        'missing-product',
        produtoId,
        quantidade,
        'Produto não encontrado; quantidade mantida pelo identificador.',
      );
      continue;
    }
    if (product.ehKit != null && typeof product.ehKit !== 'boolean') {
      diagnostic(
        'invalid-product',
        produtoId,
        quantidade,
        'Tipo de produto inválido; composição não pôde ser determinada.',
      );
      continue;
    }
    if (product.ehKit !== true) {
      add(produtoId, quantidade);
      continue;
    }
    if (!record(product.componentesKit) || Object.keys(product.componentesKit).length === 0) {
      diagnostic(
        'invalid-kit',
        produtoId,
        quantidade,
        'Kit sem composição válida; unidades de componentes desconhecidas.',
      );
      continue;
    }
    // This shared helper deliberately accepts soft-read legacy values. Its
    // output is checked below before a component participates in arithmetic.
    const components = componentesKitEntries(product.componentesKit as ComponentesKit);
    let invalid = components.length !== Object.keys(product.componentesKit).length;
    for (const [componentId, component] of components) {
      if (
        !validId(componentId) ||
        typeof component.quantidade !== 'number' ||
        !Number.isFinite(component.quantidade) ||
        component.quantidade <= 0
      ) {
        invalid = true;
        continue;
      }
      const componentProduct = products.get(componentId);
      if (componentProduct?.ehKit === true) {
        diagnostic(
          'nested-kit',
          produtoId,
          quantidade,
          'Kit contendo outro kit; componente não expandido.',
        );
        continue;
      }
      if (componentProduct?.ehKit != null && typeof componentProduct.ehKit !== 'boolean') {
        diagnostic(
          'invalid-product',
          componentId,
          quantidade,
          'Tipo do componente inválido; composição não pôde ser determinada.',
        );
        continue;
      }
      const expanded = quantidade * component.quantidade;
      if (!Number.isFinite(expanded))
        throw new RangeError('Quantidade de componentes fora do limite.');
      add(componentId, expanded);
      if (!componentProduct) {
        diagnostic(
          'missing-product',
          componentId,
          expanded,
          'Componente não encontrado; quantidade mantida pelo identificador.',
        );
      }
    }
    if (invalid) {
      diagnostic(
        'invalid-kit',
        produtoId,
        quantidade,
        'Composição do kit contém componentes inválidos; relatório parcial.',
      );
    }
  }

  const parents = new Map<string, TopProductsRow>();
  for (const [produtoId, quantidade] of quantities) {
    const rawParent = products.get(produtoId)?.paiId;
    const parentId = validId(rawParent) ? rawParent : produtoId;
    if (rawParent != null && rawParent !== '' && !validId(rawParent)) {
      diagnostic(
        'invalid-product',
        produtoId,
        quantidade,
        'Produto pai inválido; quantidade mantida no produto.',
      );
    }
    const row = parents.get(parentId) ?? { produtoId: parentId, quantidade: 0, variations: [] };
    row.quantidade += quantidade;
    if (!Number.isFinite(row.quantidade))
      throw new RangeError('Quantidade de produtos fora do limite.');
    row.variations.push({ produtoId, quantidade });
    parents.set(parentId, row);
  }
  const rank = (a: TopProductsVariation, b: TopProductsVariation) =>
    b.quantidade - a.quantidade ||
    (a.produtoId < b.produtoId ? -1 : a.produtoId > b.produtoId ? 1 : 0);
  const rows = [...parents.values()].sort(rank);
  for (const row of rows) row.variations.sort(rank);
  const totalQuantidade = rows.reduce((total, row) => total + row.quantidade, 0);
  if (!Number.isFinite(totalQuantidade))
    throw new RangeError('Quantidade de produtos fora do limite.');
  return { rows, totalQuantidade, diagnostics };
}

async function readProjectedDocuments(
  db: Firestore,
  collection: string,
  inputIds: readonly string[],
  fields: readonly string[],
): Promise<Map<string, Record<string, unknown>>> {
  const ids = [...new Set(inputIds)].filter(validId);
  const documents = new Map<string, Record<string, unknown>>();
  for (let start = 0; start < ids.length; start += DOCUMENT_BATCH_SIZE) {
    const batch = ids.slice(start, start + DOCUMENT_BATCH_SIZE);
    const snapshot = await execute(
      db
        .pipeline()
        .documents(batch.map((id) => collection + '/' + id))
        .select(documentId(field('__name__')).as('rowId'), ...fields),
    );
    for (const result of snapshot.results) {
      const data = result.data();
      if (!validId(data.rowId) || !batch.includes(data.rowId)) {
        throw new TypeError('Identificador de documento projetado inválido.');
      }
      documents.set(data.rowId, data);
    }
  }
  return documents;
}

export async function loadTopProductsReport(
  db: Firestore,
  filters: TopProductsFilters,
): Promise<TopProductsReport> {
  const snapshot = await execute(buildTopProductsPipeline(db, filters));
  const groups = snapshot.results.map((result) => topProductsGroupFromResult(result.data()));
  const soldIds = groups.flatMap((group) =>
    group.produtoId && group.quantidade > 0 ? [group.produtoId] : [],
  );
  const products = await readProjectedDocuments(db, 'produtos', soldIds, STRUCTURAL_FIELDS);
  const componentIds = new Set<string>();
  for (const product of products.values()) {
    if (product.ehKit !== true || !record(product.componentesKit)) continue;
    for (const id of Object.keys(product.componentesKit)) {
      if (validId(id) && !products.has(id)) componentIds.add(id);
    }
  }
  const components = await readProjectedDocuments(
    db,
    'produtos',
    [...componentIds],
    STRUCTURAL_FIELDS,
  );
  for (const [id, product] of components) products.set(id, product);
  return aggregateTopProducts(groups, products);
}

function readFotos(value: unknown): Foto[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw: unknown) => {
    if (!record(raw)) return [];
    const ref = (value: unknown) => {
      const path = toDocPathOrNull(value);
      return path?.startsWith('arquivos/') ? path : null;
    };
    const parsed = fotoSchema.safeParse({
      ...raw,
      arquivoOuterRef: ref(raw.arquivoOuterRef),
      arquivo200pxOuterRef: ref(raw.arquivo200pxOuterRef),
      arquivo400pxOuterRef: ref(raw.arquivo400pxOuterRef),
      arquivoJpegOuterRef: ref(raw.arquivoJpegOuterRef),
      grupoDeVariacoesOuterRef: toOuterRefOrNull(raw.grupoDeVariacoesOuterRef),
    });
    return parsed.success ? [parsed.data] : [];
  });
}

/** One-shot, deduplicated derivative ladder. Lower rungs load only after a miss. */
async function resolvePhotoUrls(db: Firestore, candidates: ReadonlyMap<string, string[]>) {
  const urls = new Map<string, string | null>();
  const files = new Map<string, string | null>();
  const maxDepth = Math.max(0, ...[...candidates.values()].map((ids) => ids.length));
  for (let depth = 0; depth < maxDepth; depth++) {
    const next = [
      ...new Set(
        [...candidates].flatMap(([id, ids]) => {
          const candidate = ids[depth];
          return !urls.has(id) && candidate && !files.has(candidate) ? [candidate] : [];
        }),
      ),
    ];
    if (next.length > 0) {
      try {
        const loaded = await readProjectedDocuments(db, 'arquivos', next, ['url']);
        for (const id of next) {
          const url = loaded.get(id)?.url;
          files.set(id, typeof url === 'string' && /^https?:\/\//.test(url) ? url : null);
        }
      } catch (error) {
        if (!(error instanceof FirebaseError && error.code === 'permission-denied')) throw error;
        for (const id of next) files.set(id, null);
      }
    }
    for (const [id, ids] of candidates) {
      if (urls.has(id)) continue;
      const candidate = ids[depth];
      const url = candidate ? files.get(candidate) : null;
      if (url) urls.set(id, url);
    }
  }
  return urls;
}

/** Decorate only the requested top-N rows; quantities remain independently cacheable. */
export async function hydrateTopProductsRows(
  db: Firestore,
  rows: readonly TopProductsRow[],
): Promise<HydratedTopProductsRow[]> {
  const ids = rows.flatMap((row) => [
    row.produtoId,
    ...row.variations.map((item) => item.produtoId),
  ]);
  const products = await readProjectedDocuments(db, 'produtos', ids, DISPLAY_FIELDS);
  const photos = new Map<string, string[]>();
  for (const row of rows) {
    const parentFotos = readFotos(products.get(row.produtoId)?.fotos);
    photos.set(row.produtoId, coverArquivoIds({ fotos: parentFotos }));
    for (const variation of row.variations) {
      if (variation.produtoId === row.produtoId) continue;
      const product = products.get(variation.produtoId);
      const variationIds = Array.isArray(product?.variacoesUid)
        ? product.variacoesUid.filter((uid): uid is string => typeof uid === 'string')
        : [];
      const fotos = fotosForVariacao(readFotos(product?.fotos), parentFotos, variationIds);
      photos.set(variation.produtoId, coverArquivoIds({ fotos }));
    }
  }
  const urls = await resolvePhotoUrls(db, photos);
  const decorate = (id: string): TopProductsDecoration => {
    const product = products.get(id);
    const nome = typeof product?.nome === 'string' ? product.nome.trim() : '';
    const sku = typeof product?.sku === 'string' ? product.sku : null;
    return { nome: nome || sku || id, sku, photoUrl: urls.get(id) ?? null };
  };
  return rows.map((row) => ({
    ...row,
    ...decorate(row.produtoId),
    variations: row.variations.map((variation) => ({
      ...variation,
      ...decorate(variation.produtoId),
    })),
  }));
}

const DIAGNOSTIC_KINDS: ReadonlySet<string> = new Set([
  'unlinked-items',
  'invalid-quantity',
  'missing-product',
  'invalid-product',
  'invalid-kit',
  'nested-kit',
]);

function validVariation(value: unknown): value is TopProductsVariation {
  return (
    record(value) &&
    validId(value.produtoId) &&
    typeof value.quantidade === 'number' &&
    Number.isFinite(value.quantidade) &&
    value.quantidade > 0
  );
}

function validRow(value: unknown): value is TopProductsRow {
  if (
    !record(value) ||
    !validVariation(value) ||
    !Array.isArray(value.variations) ||
    value.variations.length === 0 ||
    !value.variations.every(validVariation)
  )
    return false;
  const ids = new Set(
    value.variations.map((variation: TopProductsVariation) => variation.produtoId),
  );
  if (ids.size !== value.variations.length) return false;
  const total = value.variations.reduce(
    (sum: number, variation: TopProductsVariation) => sum + variation.quantidade,
    0,
  );
  // Ranking changes summation order. Permit only floating-point addition noise,
  // never a materially different component total in a persisted decoration.
  const tolerance =
    Number.EPSILON *
    Math.max(1, Math.abs(total), Math.abs(value.quantidade)) *
    value.variations.length;
  return Number.isFinite(total) && Math.abs(total - value.quantidade) <= tolerance;
}

function validDecoration(value: unknown): value is TopProductsDecoration {
  return (
    record(value) &&
    typeof value.nome === 'string' &&
    value.nome.trim() !== '' &&
    (value.sku === null || typeof value.sku === 'string') &&
    (value.photoUrl === null ||
      (typeof value.photoUrl === 'string' && /^https?:\/\//.test(value.photoUrl)))
  );
}

/** Runtime boundary for browser-persisted report records. */
export function isTopProductsReport(value: unknown): value is TopProductsReport {
  return (
    record(value) &&
    Array.isArray(value.rows) &&
    value.rows.every(validRow) &&
    new Set(value.rows.map((row: TopProductsRow) => row.produtoId)).size === value.rows.length &&
    value.rows.reduce((total: number, row: TopProductsRow) => total + row.quantidade, 0) ===
      value.totalQuantidade &&
    typeof value.totalQuantidade === 'number' &&
    Number.isFinite(value.totalQuantidade) &&
    value.totalQuantidade >= 0 &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every(
      (diagnostic: unknown) =>
        record(diagnostic) &&
        typeof diagnostic.kind === 'string' &&
        DIAGNOSTIC_KINDS.has(diagnostic.kind) &&
        (diagnostic.produtoId === null || validId(diagnostic.produtoId)) &&
        typeof diagnostic.quantidade === 'number' &&
        Number.isFinite(diagnostic.quantidade) &&
        diagnostic.quantidade >= 0 &&
        typeof diagnostic.message === 'string',
    )
  );
}

export function isHydratedTopProductsRow(value: unknown): value is HydratedTopProductsRow {
  return (
    record(value) &&
    validRow(value) &&
    validDecoration(value) &&
    value.variations.every(
      (variation: unknown) => validVariation(variation) && validDecoration(variation),
    )
  );
}
