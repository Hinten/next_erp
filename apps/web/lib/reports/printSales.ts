import { getDocs, limit, orderBy, query, where, type Firestore } from 'firebase/firestore';
import {
  add,
  and,
  array,
  arraySum,
  arrayTransform,
  conditional,
  constant,
  divide,
  execute,
  field,
  greaterThan,
  greaterThanOrEqual,
  isType,
  lessThanOrEqual,
  map,
  mapGet,
  multiply,
  subtract,
  sum,
  variable,
} from 'firebase/firestore/pipelines';
import { dataCivilNoFuso, microsDeDataHoraNoFuso, somarDiasCivis } from '@delfrance/core/datetime';
import { naoDocId, type EstadoPedido } from '@delfrance/schemas';
import { produtoCollection } from '@/lib/data/produtoCollection';
import {
  buildSalesOrdersPipeline,
  readProjectedDocuments,
  topProductsGroupFromResult,
} from './topProducts';

const SALES_TIME_ZONE = 'America/Sao_Paulo';
const LEGACY_PRINT_SKUS = ['108555999', '108556999', '108373999999', '108374999999'];
const PRODUCT_FIELDS = ['nome', 'sku', 'paiId', 'ehKit', 'componentesKit', 'componentesKitKeys'];

export interface PrintOption {
  id: string;
  nome: string;
  sku: string | null;
}

export interface PrintSalesFilters {
  startUs: number;
  endExclusiveUs: number;
  estados: readonly EstadoPedido[];
  printIds: readonly string[];
}

interface SalesAmounts {
  quantidade: number;
  receitaBruta: number;
  desconto: number;
  custo: number;
}

interface SaleGroup extends SalesAmounts {
  produtoId: string | null;
  invalidLines: number;
}

interface SoldProduct extends PrintOption {
  printIds: string[];
  quantidade: number;
  receitaLiquida: number;
}

export interface PrintSalesReport {
  comEstampa: SalesAmounts;
  semEstampa: SalesAmounts;
  semClassificacao: number;
  invalidLines: number;
  rows: SoldProduct[];
}

export function defaultPrintSalesDates(now = Date.now()) {
  const today = dataCivilNoFuso(now, SALES_TIME_ZONE);
  return { start: somarDiasCivis(today, -30) ?? '', end: somarDiasCivis(today, -1) ?? '' };
}

export function printSalesDateRange(start: string, end: string) {
  const next = somarDiasCivis(end, 1);
  const startUs = microsDeDataHoraNoFuso(start + 'T00:00:00', SALES_TIME_ZONE);
  const endExclusiveUs = next && microsDeDataHoraNoFuso(next + 'T00:00:00', SALES_TIME_ZONE);
  return startUs !== null && typeof endExclusiveUs === 'number' && startUs < endExclusiveUs
    ? { startUs, endExclusiveUs }
    : null;
}

export async function loadLegacyPrintOptions(db: Firestore): Promise<PrintOption[]> {
  const products = produtoCollection.ref(db, {});
  const snapshot = await getDocs(query(products, where('sku', 'in', LEGACY_PRINT_SKUS)));
  return snapshot.docs.map((doc) => {
    const { nome, sku } = doc.data();
    return { id: doc.id, nome, sku };
  });
}

export async function searchPrintOptions(db: Firestore, term: string): Promise<PrintOption[]> {
  const products = produtoCollection.ref(db, {});
  // The ERP's catalog search uses the (paiId, nome) prefix index. Exact SKU
  // lookup also lets operators select a specific variation.
  const [bySku, byName] = await Promise.all([
    getDocs(query(products, where('sku', '==', term), limit(20))),
    getDocs(
      query(
        products,
        where('paiId', '==', null),
        orderBy('nome'),
        where('nome', '>=', term),
        where('nome', '<=', term + '\uf8ff'),
        limit(20),
      ),
    ),
  ]);
  const options = new Map<string, PrintOption>();
  for (const doc of [...bySku.docs, ...byName.docs]) {
    const { nome, sku } = doc.data();
    options.set(doc.id, { id: doc.id, nome, sku });
  }
  return [...options.values()];
}

export function buildPrintSalesPipeline(db: Firestore, filters: PrintSalesFilters) {
  const { pipeline, groups } = buildSalesOrdersPipeline(db, {
    ...filters,
    accountIds: [],
    ehSaida: true,
  });
  const bucket = variable('bucket');
  const items = mapGet(bucket, 'v').ifAbsent(false).ifNull(false);
  const rows = conditional(isType(items, 'array'), items, array([{}]));
  const item = variable('sale');
  const readAmount = (name: string, fallback: number | boolean) => {
    const raw = mapGet(item, name).ifAbsent(fallback).ifNull(fallback);
    const valid = isType(raw, 'number');
    return { value: conditional(valid, raw, constant(0)), valid };
  };
  const price = readAmount('precoDeVenda', false);
  const discount = readAmount('descontoUnitario', 0);
  const cost = readAmount('custo', 0);
  const { value: quantity, valid: isNumber } = readAmount('quantidade', false);
  const gross = multiply(price.value, quantity);
  const discounts = multiply(discount.value, quantity);
  const costs = multiply(cost.value, quantity);
  const validLine = and(
    isNumber,
    greaterThanOrEqual(quantity, 0),
    lessThanOrEqual(quantity, Number.MAX_VALUE),
    price.valid,
    discount.valid,
    cost.valid,
    greaterThanOrEqual(price.value, 0),
    lessThanOrEqual(price.value, Number.MAX_VALUE),
    greaterThanOrEqual(discount.value, 0),
    lessThanOrEqual(discount.value, Number.MAX_VALUE),
    greaterThanOrEqual(cost.value, -Number.MAX_VALUE),
    lessThanOrEqual(cost.value, Number.MAX_VALUE),
    lessThanOrEqual(gross, Number.MAX_VALUE),
    lessThanOrEqual(discounts, Number.MAX_VALUE),
    greaterThanOrEqual(costs, -Number.MAX_VALUE),
    lessThanOrEqual(costs, Number.MAX_VALUE),
  );
  const subtotal = subtract(gross, discounts);
  const itemGroups = arrayTransform(
    groups,
    'bucket',
    map({
      produtoId: mapGet(bucket, 'k'),
      linhas: arrayTransform(
        rows,
        'sale',
        map({
          quantidade: conditional(validLine, quantity, constant(0)),
          receitaBruta: conditional(validLine, gross, constant(0)),
          desconto: conditional(validLine, discounts, constant(0)),
          custo: conditional(validLine, costs, constant(0)),
          baseDesconto: conditional(
            and(validLine, greaterThan(subtotal, 0)),
            subtotal,
            constant(0),
          ),
          invalidLines: conditional(validLine, constant(0), constant(1)),
        }),
      ),
    }),
  );
  const orderSum = (name: string) =>
    arraySum(
      arrayTransform(
        field('grupos'),
        'group',
        arraySum(
          arrayTransform(
            mapGet(variable('group'), 'linhas'),
            'line',
            mapGet(variable('line'), name),
          ),
        ).ifNull(0),
      ),
    ).ifNull(0);
  const rawOrderDiscount = field('descontoTotal').ifAbsent(0).ifNull(0);
  const orderDiscount = conditional(
    isType(rawOrderDiscount, 'number'),
    rawOrderDiscount,
    constant(0),
  );
  const orderBase = field('basePedido');
  const hasSubtotal = greaterThan(orderBase, 0);
  const weight = conditional(hasSubtotal, field('linha.baseDesconto'), field('linha.quantidade'));
  const totalWeight = conditional(hasSubtotal, orderBase, field('quantidadePedido'));
  // Allocate on the order before grouping by product. The discount follows
  // positive subtotals after item discounts, or quantity for zero-value orders.
  // Use doubles for the ratio even when every stored amount is an integer.
  const allocatedDiscount = conditional(
    greaterThan(totalWeight, 0),
    multiply(field('descontoPedido'), divide(multiply(weight, 0.5), multiply(totalWeight, 0.5))),
    constant(0),
  );
  return pipeline
    .select(
      itemGroups.as('grupos'),
      conditional(
        and(
          greaterThanOrEqual(orderDiscount, -Number.MAX_VALUE),
          lessThanOrEqual(orderDiscount, Number.MAX_VALUE),
        ),
        orderDiscount,
        constant(0),
      ).as('descontoPedido'),
    )
    .addFields(
      orderSum('baseDesconto').as('basePedido'),
      orderSum('quantidade').as('quantidadePedido'),
    )
    .unnest(field('grupos'))
    .unnest(field('grupos.linhas').as('linha'))
    .aggregate({
      groups: [field('grupos.produtoId').as('produtoId')],
      accumulators: [
        sum('linha.quantidade').as('quantidade'),
        sum('linha.receitaBruta').as('receitaBruta'),
        sum(add(field('linha.desconto'), allocatedDiscount)).as('desconto'),
        sum('linha.custo').as('custo'),
        sum('linha.invalidLines').as('invalidLines'),
      ],
    });
}

function groupFromResult(data: Record<string, unknown>): SaleGroup {
  const { receitaBruta, desconto, custo } = data;
  if (
    typeof receitaBruta !== 'number' ||
    !Number.isFinite(receitaBruta) ||
    typeof desconto !== 'number' ||
    !Number.isFinite(desconto) ||
    typeof custo !== 'number' ||
    !Number.isFinite(custo)
  ) {
    throw new TypeError('Valores de venda inválidos.');
  }
  return { ...topProductsGroupFromResult(data), receitaBruta, desconto, custo };
}

function isProductId(value: unknown): value is string {
  return typeof value === 'string' && value !== 'NONE' && !naoDocId(value);
}

function kitIds(product: Record<string, unknown>): unknown[] | null {
  if (product.ehKit === false) return [];
  const map = product.componentesKit;
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    const ids = Object.keys(map);
    if (ids.length > 0) return ids;
  }
  // Legacy rows can carry only the membership projection used by Flutter.
  if (
    map == null &&
    Array.isArray(product.componentesKitKeys) &&
    product.componentesKitKeys.length
  ) {
    return product.componentesKitKeys;
  }
  return product.ehKit === true || map != null ? null : [];
}

function emptyAmounts(): SalesAmounts {
  return { quantidade: 0, receitaBruta: 0, desconto: 0, custo: 0 };
}

export function aggregatePrintSales(
  groups: readonly SaleGroup[],
  catalog: ReadonlyMap<string, Record<string, unknown>>,
  printIds: readonly string[],
): PrintSalesReport {
  const selected = new Set(printIds);
  const report: PrintSalesReport = {
    comEstampa: emptyAmounts(),
    semEstampa: emptyAmounts(),
    semClassificacao: 0,
    invalidLines: 0,
    rows: [],
  };
  for (const group of groups) {
    report.invalidLines += group.invalidLines;
    if (group.quantidade === 0) continue;
    const { produtoId } = group;
    const product = produtoId ? catalog.get(produtoId) : undefined;
    if (!produtoId || !product) {
      report.semClassificacao += group.quantidade;
      continue;
    }
    const parentId = isProductId(product.paiId) ? product.paiId : null;
    const parent = parentId ? catalog.get(parentId) : undefined;
    const matched = new Set<string>();
    const match = (id: string, record: Record<string, unknown> | undefined) => {
      if (selected.has(id)) matched.add(id);
      if (isProductId(record?.paiId) && selected.has(record.paiId)) matched.add(record.paiId);
    };
    match(produtoId, product);

    const ownIds = kitIds(product);
    const inherits = parentId !== null && !ownIds?.length;
    const componentIds = inherits && parent ? kitIds(parent) : ownIds;
    let unresolved = componentIds === null || (inherits && !parent);
    for (const id of componentIds ?? []) {
      if (!isProductId(id)) {
        unresolved = true;
        continue;
      }
      const component = catalog.get(id);
      match(id, component);
      if (!component) unresolved = true;
    }

    if (matched.size === 0 && unresolved) {
      report.semClassificacao += group.quantidade;
      continue;
    }
    const totals = matched.size > 0 ? report.comEstampa : report.semEstampa;
    totals.quantidade += group.quantidade;
    totals.receitaBruta += group.receitaBruta;
    totals.desconto += group.desconto;
    totals.custo += group.custo;
    if (matched.size > 0) {
      report.rows.push({
        id: produtoId,
        nome: typeof product.nome === 'string' ? product.nome : produtoId,
        sku: typeof product.sku === 'string' ? product.sku : null,
        printIds: [...matched],
        quantidade: group.quantidade,
        receitaLiquida: group.receitaBruta - group.desconto,
      });
    }
  }
  report.rows.sort((a, b) => b.quantidade - a.quantidade || a.nome.localeCompare(b.nome, 'pt-BR'));
  return report;
}

export async function loadPrintSales(db: Firestore, filters: PrintSalesFilters) {
  const snapshot = await execute(buildPrintSalesPipeline(db, filters));
  const groups = snapshot.results.map((result) => groupFromResult(result.data()));
  const soldIds = groups.flatMap((group) =>
    group.produtoId && group.quantidade > 0 ? [group.produtoId] : [],
  );
  const catalog = await readProjectedDocuments(db, 'produtos', soldIds, PRODUCT_FIELDS);
  const loaded = new Set(soldIds);
  const readRelated = async (ids: readonly string[], fields: readonly string[]) => {
    const pending = ids.filter((id) => !loaded.has(id));
    const related = await readProjectedDocuments(db, 'produtos', pending, fields);
    for (const id of pending) loaded.add(id);
    for (const [id, product] of related) catalog.set(id, product);
  };
  await readRelated(
    [...catalog.values()].map((product) => product.paiId).filter(isProductId),
    PRODUCT_FIELDS,
  );
  await readRelated(
    [...catalog.values()].flatMap((product) => (kitIds(product) ?? []).filter(isProductId)),
    ['paiId'],
  );
  return aggregatePrintSales(groups, catalog, filters.printIds);
}
