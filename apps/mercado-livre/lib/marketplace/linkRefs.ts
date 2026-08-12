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

/**
 * Split a `produtoMercadoLivreOuterRef` into the parent produto + link doc ids.
 * Tolerates both the canonical `documents/produtos/<id>/produtoMercadoLivre/<docId>`
 * and a bare `produtos/...`; returns null for anything else, including a ref
 * whose third segment is not the literal `produtoMercadoLivre` leaf.
 *
 * ⚠️ `import.ts`, `importMigration.ts` and `orderProdutoResolve.ts` each carry a
 * private copy that predates this one. They are byte-identical; collapsing them
 * onto this export is mechanical follow-up, deliberately not bundled with #920.
 */
export function parsePmlOuterRef(ref: string): { produtoId: string; linkId: string } | null {
  const segs = ref.split('/').filter(Boolean);
  const i = segs.indexOf('produtos');
  if (i === -1 || i + 3 >= segs.length) return null;
  if (segs[i + 2] !== 'produtoMercadoLivre') return null;
  return { produtoId: segs[i + 1]!, linkId: segs[i + 3]! };
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
