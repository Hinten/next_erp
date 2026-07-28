/**
 * Small pure helpers for working with the Mercado Livre listing-link docs and
 * the notification `resource` string. Shared by the import flow (`import.ts`)
 * and the `items` webhook status-sync (`itemsStatusSync.ts`) so the
 * `contaOuterRef` matching + path parsing stay identical across both.
 */

/**
 * True when a stored `contaOuterRef` points at `integracaoId`. Tolerates both
 * the canonical `documents/integracao/<id>` form the Flutter app writes and a
 * bare `integracao/<id>`.
 */
export function refMatchesIntegracao(ref: unknown, integracaoId: string): boolean {
  if (typeof ref !== 'string') return false;
  return ref === `integracao/${integracaoId}` || ref.endsWith(`/integracao/${integracaoId}`);
}

/** Last non-empty path segment of a `documents/<col>/<id>` (or bare) ref. */
export function lastSegment(ref: string): string {
  const parts = ref.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? ref;
}

/**
 * The ML item id from an `items`-topic notification `resource`
 * (`/items/MLB123` → `MLB123`). ML resources are `<collection>/<id>`, so a bare
 * `/items` (no id segment) returns null rather than the collection word `items`.
 */
export function parseItemIdFromResource(resource: string): string | null {
  const parts = resource.split('/').filter(Boolean);
  if (parts.length < 2) return null; // collection only, no id
  const id = parts[parts.length - 1];
  return id && id.length > 0 ? id : null;
}

/**
 * The ML item id from an `items_prices`-topic notification `resource`
 * (`/items/MLB123/prices` → `MLB123`). The resource nests one level deeper
 * than the `items` topic's, so `parseItemIdFromResource` would return the
 * trailing collection word `prices` — this parser requires that literal last
 * segment and returns the second-to-last instead. Anything else (no `prices`
 * suffix, no id segment) is null.
 */
export function parseItemIdFromPricesResource(resource: string): string | null {
  const parts = resource.split('/').filter(Boolean);
  if (parts.length < 2 || parts[parts.length - 1] !== 'prices') return null;
  const id = parts[parts.length - 2];
  return id && id.length > 0 ? id : null;
}
