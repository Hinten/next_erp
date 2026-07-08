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
 * (`/items/MLB123` → `MLB123`). Null when the resource has no id segment.
 */
export function parseItemIdFromResource(resource: string): string | null {
  const seg = resource.split('/').filter(Boolean).pop();
  return seg && seg.length > 0 ? seg : null;
}
