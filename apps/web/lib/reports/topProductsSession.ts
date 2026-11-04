import type { Firestore } from 'firebase/firestore';
import {
  hydrateTopProductsRows,
  isHydratedTopProductsRow,
  isTopProductsReport,
  loadTopProductsReport,
  normalizeTopProductsFilters,
  type HydratedTopProductsRow,
  type TopProductsFilters,
  type TopProductsReport,
} from './topProducts';
import {
  createReportCache,
  reportCacheKey,
  REPORT_CACHE_TTL_MS,
  type ReportCache,
  type ReportCacheScope,
} from './reportCache';

interface StoredTopProducts {
  report: TopProductsReport;
  hydratedRows: HydratedTopProductsRow[];
}

export interface TopProductsResult {
  report: TopProductsReport;
  rows: HydratedTopProductsRow[];
  generatedAt: number;
  expiresAt: number;
  fromCache: boolean;
}

export { normalizeTopProductsFilters } from './topProducts';

export function topProductsCacheKey(scope: ReportCacheScope, filters: TopProductsFilters): string {
  return reportCacheKey(scope, { ...normalizeTopProductsFilters(filters) });
}

function isStoredReport(value: unknown): value is StoredTopProducts {
  if (value === null || typeof value !== 'object') return false;
  if (!('report' in value) || !isTopProductsReport(value.report)) return false;
  if (!('hydratedRows' in value) || !Array.isArray(value.hydratedRows)) return false;
  const groups = new Map(value.report.rows.map((row) => [row.produtoId, row]));
  const ids = new Set<string>();
  for (const row of value.hydratedRows) {
    if (!isHydratedTopProductsRow(row) || ids.has(row.produtoId)) return false;
    const group = groups.get(row.produtoId);
    if (!group || group.quantidade !== row.quantidade) return false;
    if (group.variations.length !== row.variations.length) return false;
    const quantities = new Map(group.variations.map((item) => [item.produtoId, item.quantidade]));
    if (row.variations.some((item) => quantities.get(item.produtoId) !== item.quantidade)) {
      return false;
    }
    ids.add(row.produtoId);
  }
  return true;
}

/** Merge decorations by parent ID, retaining only rows valid for the incoming report. */
function mergeStoredReports(previous: unknown, incoming: unknown): unknown {
  if (!isStoredReport(incoming) || !isStoredReport(previous)) return incoming;
  const rows = new Map(previous.hydratedRows.map((row) => [row.produtoId, row]));
  for (const row of incoming.hydratedRows) rows.set(row.produtoId, row);
  const merged = { report: incoming.report, hydratedRows: [...rows.values()] };
  return isStoredReport(merged) ? merged : incoming;
}

/**
 * The persisted envelope owns freshness, including after a page reload. A query
 * library's updatedAt must never restart the six-hour clock on hydration.
 */
export function createTopProductsRunner(
  options: {
    cache?: ReportCache;
    now?: () => number;
    load?: typeof loadTopProductsReport;
    hydrate?: typeof hydrateTopProductsRows;
  } = {},
) {
  const cache = options.cache ?? createReportCache();
  const now = options.now ?? Date.now;
  const load = options.load ?? loadTopProductsReport;
  const hydrate = options.hydrate ?? hydrateTopProductsRows;
  const pending = new Map<string, Promise<TopProductsResult>>();
  const queues = new Map<string, Promise<unknown>>();

  return {
    run(
      db: Firestore,
      scope: ReportCacheScope,
      filters: TopProductsFilters,
      topN: number,
      force = false,
    ): Promise<TopProductsResult> {
      if (!Number.isInteger(topN) || topN < 1 || topN > 50) {
        return Promise.reject(new RangeError('Selecione um Top entre 1 e 50.'));
      }
      const normalized = normalizeTopProductsFilters(filters);
      const key = topProductsCacheKey(scope, normalized);
      const pendingKey = JSON.stringify([key, topN, force]);
      const existing = pending.get(pendingKey);
      if (existing) return existing;
      // Serializing enrichment prevents two Top-N views of the same snapshot
      // from overwriting each other's newly resolved photos/labels.
      const operation = async (): Promise<TopProductsResult> => {
        const cached = force ? null : await cache.get(key, isStoredReport, mergeStoredReports);
        const requestStartedAt = cached?.requestStartedAt ?? now();
        const report = cached?.data.report ?? (await load(db, normalized));
        const generatedAt = cached?.generatedAt ?? now();
        const hydrated = new Map(
          (cached?.data.hydratedRows ?? []).map((row) => [row.produtoId, row]),
        );
        const visible = report.rows.slice(0, topN);
        const missing = visible.filter((row) => !hydrated.has(row.produtoId));
        if (missing.length > 0) {
          const rows = await hydrate(db, missing);
          for (const row of rows) hydrated.set(row.produtoId, row);
        }
        const rows = visible.map((row) => {
          const resolved = hydrated.get(row.produtoId);
          if (!resolved) throw new TypeError('Produto do relatório não foi resolvido.');
          return resolved;
        });
        if (!cached || missing.length > 0) {
          await cache.put(
            key,
            {
              data: { report, hydratedRows: [...hydrated.values()] },
              generatedAt,
              requestStartedAt,
            },
            mergeStoredReports,
          );
        }
        return {
          report,
          rows,
          generatedAt,
          expiresAt: generatedAt + REPORT_CACHE_TTL_MS,
          fromCache: cached !== null,
        };
      };
      const previous = queues.get(key) ?? Promise.resolve();
      const promise = previous.then(operation, operation);
      pending.set(pendingKey, promise);
      queues.set(key, promise);
      const release = () => {
        if (pending.get(pendingKey) === promise) pending.delete(pendingKey);
        if (queues.get(key) === promise) queues.delete(key);
      };
      void promise.then(release, release);
      return promise;
    },
  };
}

export const topProductsRunner = createTopProductsRunner();
