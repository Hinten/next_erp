import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { onDocumentWrittenWithAuthContext } from 'firebase-functions/v2/firestore';
import { millisToMicros, nowMillis } from '@delfrance/core/datetime';
import {
  historicoEstadoPedidoCollection,
  historicoFreteInicialCollection,
} from '@delfrance/data/admin/collections';
import {
  type EstadoFrete,
  type EstadoPedido,
  estadoFreteSchema,
  estadoPedidoSchema,
  pedidoMeta,
} from '@delfrance/schemas';

import { getDb } from '../lib/admin';

/**
 * Pedido audit trails, both derived from the same `pedidos/{pedidoId}` write:
 * the estado trail (`…/historicoEstadoPedido`) and the frete trail
 * (`…/historicoFtIni`).
 *
 * This trigger is the SOLE writer of BOTH subcollections. It replaces the
 * hand-written appends that used to sit at the call sites (the web editor's
 * `recordEstadoChange`, the client pagamento reconcile, and the Mercado Pago
 * webhook's admin reconcile), which between them covered only 3 of the ~12 code
 * paths that change `estado` — every Mercado Livre writer and every creation
 * path wrote no row at all. The frete trail had it worse: in the legacy Flutter
 * app only `Pedido.save()` and the Melhor Envio tracking task appended rows, so
 * every marketplace-driven shipment move was invisible. Observing the document
 * instead of the call site makes coverage total and automatic: any writer, from
 * anywhere (including Flutter), now produces a row in whichever trail moved.
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

/**
 * Everything both row builders need from one pedido write. Shared so the
 * handler resolves the actor and the event time ONCE and the two trails can
 * never disagree about when the same write happened.
 *
 * The two time fields are the same instant in different units — the estado
 * trail stores `microsSinceEpoch` (the repo standard) while the frete trail
 * stores `millisSinceEpoch` (legacy parity, see `historicoFtIni.ts`), so both
 * are derived from a single `Date.parse(event.time)` rather than read twice.
 */
export interface HistoryEntryInput {
  before: DocumentData | undefined;
  after: DocumentData | undefined;
  usuarioOuterRef: string | null;
  eventId: string;
  /** Event time as MICROSECONDS since epoch (`microsSinceEpoch` convention). */
  eventTimeMicros: number;
  /** The SAME instant as MILLISECONDS since epoch (`millisSinceEpoch`). */
  eventTimeMillis: number;
}

/** One `historicoEstadoPedido` row — the shape the schema validates. */
export interface EstadoHistoryEntry {
  estado: EstadoPedido;
  usuarioHistoricoEstadosPedidoOuterRef: string | null;
  data: number;
  eventId: string;
}

/** One `historicoFtIni` row — the shape the schema validates. */
export interface FreteHistoryEntry {
  estado: EstadoFrete;
  obs: string | null;
  usuarioHistoricoFreteInicialOuterRef: string | null;
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
export function buildEstadoHistoryEntry(input: HistoryEntryInput): EstadoHistoryEntry | null {
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
 * Read `freteInicial.estado` off a pedido snapshot. Defensive on purpose: this
 * is raw `DocumentData` from any writer, so the block may be absent, `null`, or
 * (on a hand-edited/legacy doc) not an object at all. Anything that is not a
 * readable nested `estado` comes back `undefined`, which the builder's parse
 * guard then rejects.
 */
function readFreteEstado(doc: DocumentData | undefined): unknown {
  const frete = doc?.freteInicial;
  if (typeof frete !== 'object' || frete === null) return undefined;
  return (frete as Record<string, unknown>).estado;
}

/**
 * Frete counterpart of {@link buildEstadoHistoryEntry}: decide whether a pedido
 * write moved `freteInicial.estado`, and build the row for it. Pure — no I/O.
 *
 * ⚠️ The comparison is on the nested `estado` ONLY, never on the `freteInicial`
 * object. Every live writer of this field replaces the WHOLE block — a spread,
 * not a dotted patch — so object identity always differs, and the block's other
 * fields churn constantly without the shipment having moved. A block-level
 * `!==` (or a `JSON.stringify` diff) would append a bogus row on every one of
 * those writes:
 *  - `apps/mercado-livre/lib/marketplace/orderShipmentImport.ts` writes
 *    `freteInicial: targetFrete`, the output of `mergeFreteInicial`, whose
 *    entire design is an estado-PRESERVING merge (`mergeEstadoFretePreservando`)
 *    over refreshed tracking code, costs and timestamps. Every shipment poll
 *    rewrites the block; almost none of them change the state.
 *  - the Melhor Envio order-status webhook is the same shape from the other
 *    side: tracking-only patches that must stay silent here.
 *  - `packages/data/src/admin/pedidoReconcile.ts` spreads `freteRecord` into
 *    `{ ...freteRecord, estado: despachoAutorizado }` when a payment authorizes
 *    despatch. That one IS a real transition today, but it is one `podeAutorizar`
 *    tweak away from writing the block with the estado it already had.
 *
 * Guard order is cheapest-exit-first: delete → estado unchanged → unknown
 * value. A CREATE carrying a frete block records the opening state, matching
 * the legacy `Pedido.save()`, which appended a row whenever `freteInicial` was
 * non-null on creation.
 */
export function buildFreteHistoryEntry(input: HistoryEntryInput): FreteHistoryEntry | null {
  if (!input.after) return null;

  const estado = readFreteEstado(input.after);
  if (input.before && readFreteEstado(input.before) === estado) return null;

  const parsed = estadoFreteSchema.safeParse(estado);
  if (!parsed.success) return null;

  return {
    estado: parsed.data,
    // The legacy rows carried a free-text `obs` written by the call site (the
    // Melhor Envio task explained *why* a state moved). A document observer has
    // no such narrative — it only sees the resulting value — so it stores null
    // rather than inventing one.
    obs: null,
    usuarioHistoricoFreteInicialOuterRef: input.usuarioOuterRef,
    // MILLISECONDS here: `historicoFtIni.data` is `millisSinceEpoch`, unlike the
    // estado trail's micros. Same instant, different unit — see HistoryEntryInput.
    data: input.eventTimeMillis,
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

/** Frete counterpart of {@link recordEstadoHistory} — same deterministic-id
 *  idempotency contract, different subcollection. */
export async function recordFreteHistory(
  db: Firestore,
  pedidoId: string,
  entry: FreteHistoryEntry,
): Promise<void> {
  const ref = historicoFreteInicialCollection.docRef(db, { pedidoId }, entry.eventId);
  await ref.set(historicoFreteInicialCollection.parse(entry) as DocumentData);
}

/**
 * Fires on EVERY pedido write (create/update/delete) from any writer and records
 * one row per `estado` transition AND one per `freteInicial.estado` transition.
 * Uses the `WithAuthContext` variant so the rows can name the acting user when
 * the write came from a signed-in client.
 *
 * No self-retrigger: the writes land in SUBcollections, and document triggers
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
    // redeliveries of the SAME event, so the deterministic rows stay
    // content-identical on retries. Parsed ONCE and handed to both builders in
    // both units, so the two trails can never date the same write differently.
    const parsedMillis = Date.parse(event.time);
    const eventTimeMillis = Number.isNaN(parsedMillis) ? nowMillis() : parsedMillis;

    const input: HistoryEntryInput = {
      before,
      after,
      usuarioOuterRef: resolveUsuarioOuterRef(event.authType, event.authId),
      eventId: event.id,
      eventTimeMicros: millisToMicros(eventTimeMillis),
      eventTimeMillis,
    };

    const estadoEntry = buildEstadoHistoryEntry(input);
    const freteEntry = buildFreteHistoryEntry(input);
    // Fast path: neither trail moved → no getDb(), no reads, no writes, no next
    // event. This is the overwhelmingly common case (every pedido edit that is
    // not a state change), so it must stay free.
    if (estadoEntry === null && freteEntry === null) return;

    const db = getDb();
    // Both rows may be keyed on the SAME `event.id` — one `tx.update` can move
    // estado and freteInicial together (that is exactly what `pedidoReconcile`
    // does when it authorizes despatch on payment). They live in DIFFERENT
    // subcollections, so the shared id is a correlation key linking the two
    // trails at that instant, not a collision.
    //
    // `Promise.all` rather than a `WriteBatch`: the two rows are independent
    // records at deterministic ids, and the trigger is at-least-once — if one
    // write lands and the other throws, the redelivery rewrites the first
    // content-identically and completes the second. A partially-written pair is
    // self-healing, so atomicity buys nothing and costs a batch commit.
    const writes: Array<Promise<void>> = [];
    if (estadoEntry !== null) writes.push(recordEstadoHistory(db, pedidoId, estadoEntry));
    if (freteEntry !== null) writes.push(recordFreteHistory(db, pedidoId, freteEntry));
    await Promise.all(writes);

    if (estadoEntry !== null) {
      logger.info(
        `onPedidoEstadoChanged: pedido ${pedidoId} → ${estadoEntry.estado}` +
          ` (por ${estadoEntry.usuarioHistoricoEstadosPedidoOuterRef ?? 'sistema'})`,
      );
    }
    if (freteEntry !== null) {
      logger.info(
        `onPedidoEstadoChanged: frete do pedido ${pedidoId} → ${freteEntry.estado}` +
          ` (por ${freteEntry.usuarioHistoricoFreteInicialOuterRef ?? 'sistema'})`,
      );
    }
  },
);
