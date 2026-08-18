/**
 * Mapping a Firestore CloudEvent's auth context to an acting user.
 *
 * Lives in `lib/` because two trigger families need it now — the pedido estado
 * trails (`../pedidos/registrarHistoricoPedido`) and the modification-history
 * factory (`./modificationHistory`) — and it must not drift between them.
 *
 * Deliberately NOT in `@delfrance/core` or `@delfrance/schemas`: it encodes
 * firebase-functions CloudEvent semantics (`authType`/`authId`, the `AuthType`
 * union's missing `user` literal, the emulator's hardcoded id), and nothing
 * outside `apps/functions` can produce that input.
 */

/** Auth types that can never correspond to an end user. */
const NON_USER_AUTH_TYPES: ReadonlySet<string> = new Set([
  'service_account',
  'system',
  'unauthenticated',
]);

/**
 * Firebase Auth uids: 28 alphanumeric chars from the standard providers, but a
 * uid set explicitly via the Admin SDK (`createUser({ uid })`) or an imported
 * user may also carry `_` and `-`, up to 128 chars. Both are accepted so a real
 * actor is never dropped to `null`.
 *
 * Every call site in this repo currently lets Firebase generate the uid
 * (`apps/integrations/.../admin/users/route.ts`, `tools/test-fixtures`), so the
 * wider class costs nothing today — it just removes a silent trap if a custom
 * uid ever appears.
 *
 * The class stays strict about what it EXCLUDES, which is the whole point: no
 * `@` and no `.`, so emails never pass. That is what rejects Firebase-console
 * writes (operator email), service-account identifiers, and the emulator's
 * hardcoded `fake-auth-id@gmail.com`. The 20-char floor keeps short junk out;
 * every uid this project mints is 28.
 */
const UID_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

/**
 * Map a Firestore event's auth context to the repo's `documents/usuarios/<uid>`
 * outer-ref, or `null` when no end user can be established.
 *
 * `authId` only carries a uid when the write came straight from a signed-in
 * client SDK. Everything else — the Mercado Pago webhook, Mercado Livre import,
 * other functions, scripts — reaches Firestore through the Admin SDK and has no
 * end user, which is exactly when this must return `null`.
 *
 * Three reasons this cannot simply trust `authType`:
 *  - the `AuthType` union has NO `user` literal (it is
 *    `service_account | api_key | system | unauthenticated | unknown`), and
 *    client-SDK writes arrive as `api_key` while Firebase-console writes arrive
 *    as `unknown` carrying an EMAIL in `authId`;
 *  - the Firestore emulator hardcodes `authId` to `'fake-auth-id@gmail.com'`
 *    (firebase-tools#7609, closed as not-planned), so the emulator lane must
 *    resolve to `null` rather than to a bogus ref — which also means the actor
 *    CANNOT be asserted in the emulator suite; assert it in a staging e2e;
 *  - a service account's id is an email too.
 *
 * Hence the shape guard: anything that is not uid-shaped yields `null`. Storing
 * nothing is always better than storing the wrong actor in an audit trail.
 */
export function resolveUsuarioOuterRef(
  authType: string | undefined,
  authId: string | undefined,
): string | null {
  if (!authId) return null;
  if (authType && NON_USER_AUTH_TYPES.has(authType)) return null;
  if (!UID_PATTERN.test(authId)) return null;
  return `documents/usuarios/${authId}`;
}
