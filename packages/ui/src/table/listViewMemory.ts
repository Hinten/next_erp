/**
 * Per-screen memory of a `TableView`'s view state, backed by `sessionStorage`.
 *
 * Filters, sort and the "Carregar mais" window already round-trip through the
 * URL query string (`useTableUrlState`), which is what makes a list shareable,
 * deep-linkable and survivable across browser Back. This module is the second
 * tier: it remembers the query string a list was LAST left in, so reopening that
 * screen restores it even when the incoming URL is bare — which is exactly what
 * every "Cancelar" / `router.replace('/produtos')` in a detail page produces.
 *
 * One thing deliberately does NOT live in the URL and is kept here instead: the
 * scroll offset. It is ergonomics rather than identity — nobody wants
 * `?scroll=840` in a link they paste to a colleague. The page count used to sit
 * here for the same reason and was moved out, because it turned out to be
 * identity after all: an operator pressing Back onto a list they had grown was
 * dropped to one page, and no amount of remembering fixed that while the URL
 * outranked the memory.
 *
 * ⚠️ The URL always wins. A caller consults this memory only when the incoming
 * URL carries none of the table's own keys, so a shared or hand-edited link is
 * never overridden. Clearing every filter stores an empty `qs`, which makes the
 * mechanism self-healing: there is no filtered state an operator cannot get out
 * of.
 *
 * `sessionStorage` (not `localStorage`) is the chosen lifetime: it survives
 * navigation and a reload but dies with the tab, so a fresh tab always starts
 * clean. Column visibility/order stay in `localStorage` where they already are
 * — those are a per-user preference, this is a per-session position.
 */

const PREFIX = 'delfrance:tableview:view:';

export interface ListViewMemory {
  /**
   * The table's own query string (no leading `?`), e.g. `nome=contains%3Aab`.
   * Carries the window as `pages=` when it is above one, because
   * `encodeTableState` is the single serializer for this string and the URL.
   */
  qs: string;
  /** `window.scrollY` when the list was last left. */
  scroll: number;
}

export const EMPTY_LIST_VIEW_MEMORY: ListViewMemory = { qs: '', scroll: 0 };

/**
 * Storage key for one table.
 *
 * Keyed by BOTH the pathname and the resolved collection path. The collection
 * alone is not enough — `/canais/whatsapp` and `/canais/mercado-livre` are
 * different screens over the same `integracao` collection and must not share a
 * slot. The pathname alone is not enough either: `/clientes/<id>` renders the
 * cliente editor AND an embedded endereços `TableView`, so two tables can sit
 * on one path.
 */
export function listViewMemoryKey(pathname: string, collectionPath: string): string {
  return `${PREFIX}${pathname}|${collectionPath}`;
}

/** True for a value that is a finite, non-negative number. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Read one table's remembered view state, or `null` when there is none.
 *
 * Tolerant by construction: this feeds a render path, so a hand-edited or
 * truncated entry must degrade to "no memory" rather than throw. Every field is
 * checked individually — a partially-valid entry is rejected whole, since
 * restoring half of it would put the operator somewhere they were never at.
 */
export function readListViewMemory(key: string): ListViewMemory | null {
  if (typeof window === 'undefined') return null;
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(key);
  } catch (err) {
    // sessionStorage access throws a DOMException under private mode, disabled
    // storage or blocked cookies — that is "no memory", not a failure. Rethrow
    // anything else (repo rule: no generic catch).
    if (err instanceof DOMException) return null;
    throw err;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { qs, scroll } = parsed as Record<string, unknown>;
  if (typeof qs !== 'string' || !isCount(scroll)) return null;
  // A record written before the window moved into `qs` carries a `pages` field
  // that nothing reads any more. Ignored rather than rejected: this lives in
  // `sessionStorage`, so the only cost of tolerating it is that the tab the
  // upgrade landed in keeps its remembered offset.
  return { qs, scroll };
}

/** Persist one table's view state. A no-op on the server / when unavailable. */
export function writeListViewMemory(key: string, value: ListViewMemory): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    // Same rationale as the read, plus quota: losing the remembered position is
    // never worth throwing over.
    if (err instanceof DOMException) return;
    throw err;
  }
}

/** Forget one table's view state. */
export function clearListViewMemory(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(key);
  } catch (err) {
    if (err instanceof DOMException) return;
    throw err;
  }
}
