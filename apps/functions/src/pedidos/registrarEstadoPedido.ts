import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { onDocumentWrittenWithAuthContext } from 'firebase-functions/v2/firestore';
import { millisToMicros, nowMicros } from '@delfrance/core/datetime';
import { historicoEstadoPedidoCollection } from '@delfrance/data/admin/collections';
import { type EstadoPedido, estadoPedidoSchema, pedidoMeta } from '@delfrance/schemas';

import { getDb } from '../lib/admin';

/**
 * Pedido estado audit trail (`pedidos/{pedidoId}/historicoEstadoPedido`).
 *
 * This trigger is the SOLE writer of that subcollection. It replaces the three
 * hand-written appends that used to sit at the call sites (the web editor's
 * `recordEstadoChange`, the client pagamento reconcile, and the Mercado Pago
 * webhook's admin reconcile), which between them covered only 3 of the ~12 code
 * paths that change `estado` — every Mercado Livre writer and every creation
 * path wrote no row at all. Observing the document instead of the call site
 * makes coverage total and automatic: any writer, from anywhere (including
 * Flutter), now produces a row.
 *
 * Targets the NAMED `default` database (gotcha #8).
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
 *    resolve to `null` rather than to a bogus ref;
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

/** One `historicoEstadoPedido` row — the shape the schema validates. */
export interface EstadoHistoryEntry {
  estado: EstadoPedido;
  usuarioHistoricoEstadosPedidoOuterRef: string | null;
  data: number;
  eventId: string;
}

/**
 * Decide whether a pedido write is an `estado` transition worth recording, and
 * build the row for it. Pure — no I/O — so the guard logic is unit-testable
 * without a live db.
 *
 * Returns `null` for: a delete (the row would outlive its parent), a write that
 * left `estado` untouched (the overwhelmingly common case — every pedido edit
 * that is not a state change), and a value that is not a known `EstadoPedido`.
 * A CREATE records the opening state, so the trail shows where a pedido began
 * instead of starting mid-life.
 */
export function buildEstadoHistoryEntry(input: {
  before: DocumentData | undefined;
  after: DocumentData | undefined;
  usuarioOuterRef: string | null;
  eventId: string;
  /** Event time as MICROSECONDS since epoch (`microsSinceEpoch` convention). */
  eventTimeMicros: number;
}): EstadoHistoryEntry | null {
  if (!input.after) return null;

  const estado = input.after.estado;
  if (input.before && input.before.estado === estado) return null;

  const parsed = estadoPedidoSchema.safeParse(estado);
  if (!parsed.success) return null;

  return {
    estado: parsed.data,
    usuarioHistoricoEstadosPedidoOuterRef: input.usuarioOuterRef,
    data: input.eventTimeMicros,
    eventId: input.eventId,
  };
}

/**
 * Persist one row at a deterministic id (`entry.eventId`) — Firestore triggers
 * are at-least-once, so a redelivery of the same CloudEvent must rewrite a
 * content-identical doc rather than append a duplicate. That is also why `data`
 * comes from `event.time` and never `Date.now()`.
 */
export async function recordEstadoHistory(
  db: Firestore,
  pedidoId: string,
  entry: EstadoHistoryEntry,
): Promise<void> {
  const ref = historicoEstadoPedidoCollection.docRef(db, { pedidoId }, entry.eventId);
  await ref.set(historicoEstadoPedidoCollection.parse(entry) as DocumentData);
}

/**
 * Fires on EVERY pedido write (create/update/delete) from any writer and records
 * one row per `estado` transition. Uses the `WithAuthContext` variant so the row
 * can name the acting user when the write came from a signed-in client.
 *
 * No self-retrigger: the write lands in a SUBcollection, and document triggers
 * on `pedidos/{pedidoId}` do not fire for subcollection writes.
 */
export const onPedidoEstadoChanged = onDocumentWrittenWithAuthContext(
  {
    document: `${pedidoMeta.collectionPath}/{pedidoId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
  },
  async (event) => {
    const { pedidoId } = event.params;
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();

    // `event.time` is the CloudEvent occurrence time — stable across
    // redeliveries of the SAME event, so the deterministic row stays
    // content-identical on retries. Stored as MICROSECONDS since epoch
    // (`microsSinceEpoch`, the repo's datetime standard).
    const eventTimeMillis = Date.parse(event.time);

    const entry = buildEstadoHistoryEntry({
      before,
      after,
      usuarioOuterRef: resolveUsuarioOuterRef(event.authType, event.authId),
      eventId: event.id,
      eventTimeMicros: Number.isNaN(eventTimeMillis)
        ? nowMicros()
        : millisToMicros(eventTimeMillis),
    });
    // Fast path: no estado change → no reads, no writes, no next event.
    if (entry === null) return;

    await recordEstadoHistory(getDb(), pedidoId, entry);
    logger.info(
      `onPedidoEstadoChanged: pedido ${pedidoId} → ${entry.estado}` +
        ` (por ${entry.usuarioHistoricoEstadosPedidoOuterRef ?? 'sistema'})`,
    );
  },
);
