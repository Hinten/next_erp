/**
 * The three app-owner signals the weekly integration watch compares against a
 * committed baseline, and the pure logic that decides whether anything moved.
 *
 * | | Endpoint | Detects |
 * | --- | --- | --- |
 * | **A** | `GET /applications/{APP_ID}` | our scopes, rate limit, `active`, `certification_status` drifting |
 * | **B** | `GET /applications/v1/{APP_ID}/consumed-applications` | **ML actually rejecting us** — request counts by HTTP status and by resource, D-1 |
 * | **C** | `GET /communications/notices` | ML *announcing* a change |
 *
 * ⭐ **B is the load-bearing one.** A and C depend on ML telling us something; B
 * is our own traffic. A new `400` against `items` is drift whether or not anyone
 * announced it, and it is the only one of the three that can catch a change ML
 * shipped silently.
 *
 * ## ⚠️ Nothing here filters notices by `category`
 * The docs describe `category`/`sub_category` (`ALERT`, `NEW`, `RELEASE`, …) and
 * a `tags` taxonomy. Neither appears in either sample response on the
 * Comunicações page, and the integrator example carries `tags: []`. Filtering on
 * a field nobody has observed populated produces a watcher that matches nothing
 * and reports zero for ever — indistinguishable from "ML never announced
 * anything", which is the exact failure this whole design is meant to avoid.
 *
 * So: take every notice, diff by `id`, and let the AI triage relevance. The AI
 * gate is what saves tokens; a filter on an unverified field would only save
 * them by being broken.
 *
 * ## ⚠️ Every parser here FAILS LOUD rather than returning empty
 * A watcher's worst outcome is not a crash — it is a green run that examined
 * nothing. If ML's response is not the shape expected, that is itself the news,
 * and it must surface as a failure rather than as "no changes this week".
 */

export class WatchShapeError extends Error {
  readonly endpoint: string;

  constructor(endpoint: string, detail: string) {
    super(`Resposta inesperada do Mercado Livre em ${endpoint}: ${detail}`);
    this.name = 'WatchShapeError';
    this.endpoint = endpoint;
  }
}

// ─────────────────────────────── Signal C: notices ───────────────────────────

export interface Notice {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Absent on the integrator sample; kept as data, never used as a filter. */
  readonly category: string | null;
  readonly subCategory: string | null;
  readonly fromDate: string | null;
  readonly tags: readonly string[];
  readonly links: readonly string[];
}

function asRecord(value: unknown, endpoint: string, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WatchShapeError(endpoint, `${what} não é um objeto`);
  }
  return value as Record<string, unknown>;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Parse `GET /communications/notices`.
 *
 * ⚠️ A missing `results` array throws. Returning `[]` there would report "no
 * notices" for a response that never contained the field, which is the silent
 * half of a broken watcher.
 */
export function parseNotices(body: unknown): Notice[] {
  const endpoint = '/communications/notices';
  const root = asRecord(body, endpoint, 'o corpo');
  const results = root.results;
  if (!Array.isArray(results)) {
    throw new WatchShapeError(endpoint, '`results` ausente ou não é uma lista');
  }

  // ⚠️ `?limit=50` TRUNCATES, and nothing downstream would notice: `results`
  // would simply be short, and `proximaBaseline` unions only the ids it SAW, so
  // anything past the page boundary stays unseen next week too. That is "a green
  // run that examined nothing", scoped to a page. Throwing keeps it visible; a
  // human raising the limit is a one-line change, a silent gap is not.
  const paging = root.paging;
  if (typeof paging === 'object' && paging !== null && !Array.isArray(paging)) {
    const total = (paging as Record<string, unknown>).total;
    if (typeof total === 'number' && total > results.length) {
      throw new WatchShapeError(
        endpoint,
        `${total} comunicados vigentes, mas só ${results.length} vieram — pagine ou aumente o limit`,
      );
    }
  }

  return results.map((entry, i) => {
    const rec = asRecord(entry, endpoint, `results[${i}]`);
    const id = str(rec.id) ?? (typeof rec.id === 'number' ? String(rec.id) : null);
    // ⚠️ The id is the dedup key. Without one, a notice would re-report every
    // week for ever, so an id-less entry is a shape failure, not a skip.
    if (id === null) throw new WatchShapeError(endpoint, `results[${i}] sem \`id\``);

    const actions = Array.isArray(rec.actions) ? rec.actions : [];
    const tags = Array.isArray(rec.tags) ? rec.tags : [];

    return {
      id,
      label: str(rec.label) ?? str(rec.title) ?? '(sem título)',
      description: str(rec.description) ?? '',
      category: str(rec.category),
      subCategory: str(rec.sub_category),
      fromDate: str(rec.from_date),
      tags: tags
        .map((t) =>
          typeof t === 'object' && t !== null ? str((t as Record<string, unknown>).tag) : str(t),
        )
        .filter((t): t is string => t !== null),
      links: actions
        .map((a) =>
          typeof a === 'object' && a !== null ? str((a as Record<string, unknown>).link) : null,
        )
        .filter((l): l is string => l !== null),
    };
  });
}

// ──────────────────────────── Signal A: application ──────────────────────────

export interface ApplicationSnapshot {
  readonly id: string;
  readonly active: boolean | null;
  readonly maxRequestsPerHour: number | null;
  readonly certificationStatus: string | null;
  readonly siteId: string | null;
  /** Sorted, so a reordering by ML is not a false positive. */
  readonly scopes: readonly string[];
}

/** Parse `GET /applications/{id}`. */
export function parseApplication(body: unknown): ApplicationSnapshot {
  const endpoint = '/applications/{id}';
  const rec = asRecord(body, endpoint, 'o corpo');
  const id = str(rec.id) ?? (typeof rec.id === 'number' ? String(rec.id) : null);
  if (id === null) throw new WatchShapeError(endpoint, 'sem `id`');

  const scopes = Array.isArray(rec.scopes)
    ? rec.scopes.filter((s): s is string => typeof s === 'string')
    : [];

  return {
    id,
    active: typeof rec.active === 'boolean' ? rec.active : null,
    maxRequestsPerHour:
      typeof rec.max_requests_per_hour === 'number' ? rec.max_requests_per_hour : null,
    certificationStatus: str(rec.certification_status),
    siteId: str(rec.site_id),
    scopes: [...scopes].sort(),
  };
}

// ─────────────────────────── Signal B: consumption ───────────────────────────

export interface StatusShare {
  readonly status: number;
  readonly percentage: number;
}

export interface ConsumptionSnapshot {
  readonly totalRequests: number;
  /** Sorted by status, so the comparison is order-independent. */
  readonly byStatus: readonly StatusShare[];
}

/** Parse `GET /applications/v1/{id}/consumed-applications`. */
export function parseConsumption(body: unknown): ConsumptionSnapshot {
  const endpoint = '/applications/v1/{id}/consumed-applications';
  const rec = asRecord(body, endpoint, 'o corpo');
  const rows = rec.request_by_status;
  if (!Array.isArray(rows)) {
    throw new WatchShapeError(endpoint, '`request_by_status` ausente ou não é uma lista');
  }

  const byStatus = rows
    .map((row, i) => {
      const r = asRecord(row, endpoint, `request_by_status[${i}]`);
      if (typeof r.status !== 'number') {
        throw new WatchShapeError(endpoint, `request_by_status[${i}] sem \`status\` numérico`);
      }
      return {
        status: r.status,
        percentage: typeof r.percentage === 'number' ? r.percentage : 0,
      };
    })
    .sort((a, b) => a.status - b.status);

  return {
    totalRequests: typeof rec.total_request === 'number' ? rec.total_request : 0,
    byStatus,
  };
}
