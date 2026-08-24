/**
 * Small pure helpers for working with the Mercado Livre listing-link docs and
 * the notification `resource` string. Shared by the import flow (`import.ts`)
 * and the `items` webhook status-sync (`itemsStatusSync.ts`) so the
 * `contaOuterRef` matching + path parsing stay identical across both.
 */

/**
 * True when a stored `contaOuterRef` points at `integracaoId`. Tolerates both
 * the canonical `documents/integracao/<id>` form the migrated corpus stores —
 * the Flutter writer is gone, the stored refs remain — and a
 * bare `integracao/<id>`.
 */
export function refMatchesIntegracao(ref: unknown, integracaoId: string): boolean {
  if (typeof ref !== 'string') return false;
  return ref === `integracao/${integracaoId}` || ref.endsWith(`/integracao/${integracaoId}`);
}

/**
 * Is this request-body value unusable as a Firestore **document id**?
 *
 * Every route that takes an id from a body and feeds it to `.doc()` needs this,
 * because `.doc()` validates the resulting PATH, not the id, and it does so
 * outside any `try` the handler owns — so a bad value escapes as a 500 for what
 * is plainly a client error. Measured against a real `firebase-admin` Firestore:
 *
 * ```
 * ''      → throws  "Path must be a non-empty string"
 * 'a/b'   → throws  "must point to a document … not an even number of components"
 * 'a/b/c' → NO throw: resolves to produtos/<id>/produtoMercadoLivre/a/b/c
 * ```
 *
 * ⚠️ That third row is why the test is `includes('/')` and not just "does
 * `.doc()` throw". An odd number of extra segments builds a perfectly valid path
 * to a document two levels below the collection we meant — no error, no security
 * consequence (it stays under the produto the caller already named, and the
 * publisher re-derives ownership from its own snapshot anyway), but it is a
 * document the caller had no business naming, and it comes back as a puzzling
 * 404. Rejecting the separator outright covers both rows with one condition.
 */
export function naoDocId(v: unknown): boolean {
  return typeof v !== 'string' || v === '' || v.includes('/');
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
