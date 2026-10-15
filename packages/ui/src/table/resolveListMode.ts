/**
 * Which transport a `TableView` uses for its rows, and why.
 *
 * The list has two engines and they are not interchangeable:
 *
 *  - **live** — a classic Firestore query behind `onSnapshot`. Streams, serves
 *    the first paint from the IndexedDB cache, and bills only deltas after.
 *  - **static** — the Pipelines API (`execute`), which runs ONCE. It is the only
 *    engine that can do `contains` / accent-folded regex, an arbitrary `idIn`
 *    set, and a `select()` projection — none of which a classic query expresses.
 *
 * `live` is therefore not "better", it is NARROWER. This function decides which
 * one a given screen state is allowed to use.
 *
 * ⚠️ THE RULE, and the reason it is this strict: LIVE is permitted only when the
 * query about to be issued is byte-for-byte the collection's DECLARED
 * `meta.defaultQuery` — same filters (none beyond the declared base), same sort.
 * That is what makes the live query set provably identical to what
 * `deriveRequiredIndex` derives, and therefore to what the
 * `delfrance/default-query-needs-index` rule and `defaultQuery.indexes.test.ts`
 * already assert an index exists for. So the live path needs no new index and no
 * new guard: an unindexed streaming listener is unreachable BY CONSTRUCTION.
 *
 * Widening this — letting a filter or a non-declared sort stay live — is exactly
 * the mistake that rule prevents. Firestore Enterprise never raises
 * `FAILED_PRECONDITION` for a missing index; it silently full-scans and bills
 * data scanned. Today an unindexed sort costs ONE scan. Live, it becomes a
 * PERSISTENT watch over a full collection scan, held open until the operator
 * navigates away, with no error, no lint failure and no red test.
 *
 * ⚠️ So a header sort drops to `static` too, not just a filter. `/clientes` has
 * eight indexes and none on `tipo`; clicking that header while live would open
 * precisely that watch.
 *
 * To widen it later (the intended path — some pedidos filters should stream),
 * you must FIRST teach `deriveRequiredIndex` to derive an index per declared
 * filter and per declared sort, and declare them on the meta. Until then the
 * index guard cannot see the shapes a widened rule would issue.
 * `resolveListMode.test.ts` carries a tripwire that fails the moment this rule
 * is loosened, with those instructions attached.
 */
export type ListMode = 'live' | 'static';

/**
 * Why a screen is static. `null` when it is live. Surfaced to the operator, so
 * every value names the control they can remove to get streaming back.
 */
export type StaticReason =
  | 'override' // the caller supplied its own query; it owns the transport
  | 'no-declared-query' // no meta.defaultQuery to compare against
  | 'filter' // a column filter or a page-owned extra filter
  | 'search' // a free-text search term
  | 'ids' // an id restriction (search.resolveIds / subcollection lookup)
  | 'sort'; // a sort other than the declared one

export interface ResolveListModeInput {
  /** The caller passed `queryOverride`. */
  hasQueryOverride: boolean;
  /** The collection declares `meta.defaultQuery`. */
  hasDeclaredQuery: boolean;
  /** Active per-column filters. */
  columnFilterCount: number;
  /** Active page-owned `extraFilters`. */
  extraFilterCount: number;
  /** The free-text search term, already trimmed by the caller. */
  searchTerm: string;
  /** A subcollection lookup or async id resolution is active or resolving. */
  idRestrictionActive: boolean;
  /** Serialized order the query WILL issue. */
  orderBySerial: string;
  /** Serialized order `meta.defaultQuery` declares. */
  declaredOrderBySerial: string;
}

export interface ListModeResult {
  mode: ListMode;
  reason: StaticReason | null;
}

/**
 * Pure. The single place the live/static rule is expressed — widening the rule
 * is a change HERE and nowhere else, which is what makes the seam real.
 */
export function resolveListMode(input: ResolveListModeInput): ListModeResult {
  // Ordered most-specific first, because the reason is shown to the operator
  // and the first true cause is the one they can act on.
  if (input.hasQueryOverride) return { mode: 'static', reason: 'override' };
  if (!input.hasDeclaredQuery) return { mode: 'static', reason: 'no-declared-query' };
  if (input.idRestrictionActive) return { mode: 'static', reason: 'ids' };
  if (input.searchTerm !== '') return { mode: 'static', reason: 'search' };
  if (input.columnFilterCount > 0 || input.extraFilterCount > 0) {
    return { mode: 'static', reason: 'filter' };
  }
  if (input.orderBySerial !== input.declaredOrderBySerial) {
    return { mode: 'static', reason: 'sort' };
  }
  return { mode: 'live', reason: null };
}

/** Operator-facing text for the mode badge. */
export const STATIC_REASON_LABEL: Record<StaticReason, string> = {
  override: 'Resultado fixo — esta tela monta a própria consulta.',
  'no-declared-query': 'Resultado fixo — esta tela não declara uma consulta padrão.',
  filter: 'Resultado fixo — limpe os filtros para voltar ao tempo real.',
  search: 'Resultado fixo — limpe a busca para voltar ao tempo real.',
  ids: 'Resultado fixo — limpe a busca para voltar ao tempo real.',
  sort: 'Resultado fixo — limpe a ordenação para voltar ao tempo real.',
};

/** Badge text for the live mode. */
export const LIVE_LABEL = 'Tempo real — a lista se atualiza sozinha.';

/**
 * Tooltip for the reset control beside the badge.
 *
 * ⚠️ Takes the POLICY (`ListMode`), and the parameter type is the point: the
 * badge next to this control reads the TRANSPORT (`pipeline === null`), the two
 * disagree under `queryOverride`, and the first version of this branch used the
 * transport by mistake. It then told an operator "a lista já está na consulta
 * padrão" about a list running the CALLER's query, and the message written for
 * that very case was unreachable from it. A boolean parameter would have
 * accepted `transportIsLive` again; `ListMode` cannot.
 */
export function resetControlLabel(hasOwnState: boolean, mode: ListMode): string {
  if (hasOwnState) return 'Limpa a ordenação, os filtros de coluna e a busca desta lista.';
  return mode === 'live'
    ? 'Nada para limpar: a lista já está na consulta padrão.'
    : 'Nada para limpar aqui — o resultado fixo vem desta tela, não de um filtro seu.';
}
