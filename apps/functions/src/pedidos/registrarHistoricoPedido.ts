import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { onDocumentWrittenWithAuthContext } from 'firebase-functions/v2/firestore';
import { millisToMicros, nowMillis } from '@delfrance/core/datetime';
import {
  historicoEstadoPedidoCollection,
  historicoFreteInicialCollection,
} from '@delfrance/data/admin/collections';
import { CAMPOS_ESTOQUE_SYNC } from '@delfrance/data/pedido';
import {
  PEDIDO_ITENS_EXPAND,
  type EstadoFrete,
  type EstadoPedido,
  estadoFreteSchema,
  estadoPedidoSchema,
  pedidoMeta,
} from '@delfrance/schemas';

import { getDb } from '../lib/admin';
import { resolveUsuarioOuterRef } from '../lib/authContext';
import { PEDIDO_HISTORY_ROOT } from '../lib/historyRoots';
import { buildModificationEntry, recordModification } from '../lib/modificationHistory';

/**
 * ALL of a pedido's audit trails, derived from the same `pedidos/{pedidoId}`
 * write:
 *  - the estado trail (`…/historicoEstadoPedido`),
 *  - the frete trail (`…/historicoFtIni`), tracking the EMBEDDED
 *    `freteInicial.estado`, and
 *  - the unified field-level history (`…/historicoDeModificacoes`), which
 *    records every other change to the document — and, on a delete, a
 *    tombstone.
 *
 * Three trails, ONE trigger, because they all observe the same document: a
 * second trigger on `pedidos/{pedidoId}` would double the event cost to record
 * the same write. (The pedido's `pagamentos` and `incidentes` feed the same
 * history collection from their own triggers, since they are different
 * documents.)
 *
 * This trigger is the SOLE writer of all three subcollections. It replaces the
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

// `resolveUsuarioOuterRef` moved to `../lib/authContext` when the
// modification-history factory became a second consumer. Re-exported here so
// this file stays the readable entry point for the pedido trails.
export { resolveUsuarioOuterRef } from '../lib/authContext';

/**
 * Fields whose churn is a stamp, a watermark, or state a trigger owns — never
 * an operator edit — so they must not produce a modification-history row.
 *
 * The rule (borrowed from `CONCURRENCY_IGNORE`, which exists for the same
 * reason): a field is ignored iff no interactive editor in this app can author
 * it.
 *
 * ⚠️ `CAMPOS_ESTOQUE_SYNC` is IMPORTED, never retyped. `sincronizarEstoquePedido`
 * writes those three fields back onto the pedido seconds after the save that
 * caused them and deliberately does NOT stamp `ultimaModificacao` — so without
 * this, every stock-moving save would produce TWO rows: the operator's edit,
 * then a phantom `estoqueAplicado` row attributed to "Sistema". Same failure
 * `CONCURRENCY_IGNORE` was extended for (#972); one list means the writer and
 * both guards cannot drift.
 *
 * Deliberately NOT ignored: `estado`, `freteInicial`, `itens`, `numero`,
 * `observacoesInternas`, `infCpl`, every `*OuterRef`, and the derived money
 * caches. The caches echo an item edit, but they are one row each and are
 * exactly what an auditor wants to see move — a price change that did NOT come
 * from an item edit is only visible through them.
 */
export const PEDIDO_HISTORY_IGNORE_FIELDS: ReadonlyArray<string> = [
  // Pure projection of `Object.keys(itens)` — cannot move without `itens`
  // moving, so recording it only doubles the noise.
  'itensIds',
  // The Mercado Livre order-clock watermark, advanced on every accepted poll.
  'lastMarketplaceUpdate',
  'timestamp',
  'ultimaModificacao',
  ...CAMPOS_ESTOQUE_SYNC,
  // The marketplace dispute overlay (#1322) — the SAME failure as
  // `CAMPOS_ESTOQUE_SYNC` above, one trigger later, and the half the first pass
  // missed. `onIncidenteBloqueioSync` writes these three whenever a claim opens,
  // closes or is released; without them every one of those events leaves an
  // extra `historicoDeModificacoes` row attributed to "Sistema", naming a field
  // the operator can neither see nor edit.
  //
  // ⚠️ This list and `CONCURRENCY_IGNORE` (`packages/data/src/pedido/usecases.ts`)
  // are a PAIR — same fields, two different symptoms (a phantom audit row here,
  // a phantom "Pedido alterado" conflict there). Extending one without the other
  // fixes half the bug, which is exactly what happened on the first pass.
  'disputaAbertaEm',
  'devolucaoAbertaEm',
  'bloqueiosLiberados',
];

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
 *  - `apps/mercado-livre/lib/marketplace/pedidos/orderShipmentImport.ts` writes
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
export const onPedidoChanged = onDocumentWrittenWithAuthContext(
  {
    document: `${pedidoMeta.collectionPath}/{pedidoId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
  },
  async (event) => {
    const { pedidoId } = event.params;
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();

    // `event.time` is the CloudEvent occurrence time — stable across
    // redeliveries of the SAME event, which is why `data` comes from it and
    // never from `Date.now()`: a retry then rewrites a content-identical row.
    // Parsed ONCE and handed to both builders in both units, so the two trails
    // can never date the same write differently.
    //
    // The `nowMillis()` fallback is the ONE case where that content-identity
    // does not hold: an unparseable `event.time` (a platform bug — the field is
    // required and RFC 3339) would make each delivery stamp its own wall clock.
    // The guarantee that actually matters survives regardless, because it rests
    // on the doc id, not the timestamp: every row is keyed on `event.id`, so a
    // redelivery still OVERWRITES its row instead of appending a duplicate. The
    // worst case is a row dated when it was retried rather than when it
    // occurred — never a double entry in the trail.
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

    /**
     * The unified field-level entry, recorded for the SAME pedido write.
     *
     * ⚠️ Unlike the produto counterpart, a DELETE is recorded rather than
     * skipped. `onProdutoChanged` returns early on delete because
     * `onProdutoDeleted` sweeps the produto's subtree moments later, so the row
     * would be swept or orphaned either way. `pedidos` declares a cascade and
     * deliberately has NO delete trigger (owner call, 2026-08 — `nfev4` holds
     * emitted fiscal documents), so nothing sweeps here and the row survives:
     * it is then the ONLY record that the order existed and who removed it.
     * `buildModificationEntry` gives a `kind: 'delete'` tombstone carrying every
     * non-ignored field's pre-delete value.
     *
     * This also closes a real gap — both trail builders above bail on a delete
     * ("the row would outlive its parent"), so until now a deleted pedido left
     * no trace anywhere.
     */
    const modificationEntry = buildModificationEntry({
      before,
      after,
      ignore: PEDIDO_HISTORY_IGNORE_FIELDS,
      path: `pedidos/${pedidoId}`,
      subcolecao: null,
      docId: pedidoId,
      eventId: event.id,
      eventTimeMicros: input.eventTimeMicros,
      // Only `itens` is expanded: a one-line quantity edit would otherwise store
      // both whole maps, and past ~121 lines both sides truncate to a sentinel
      // and the entry says nothing at all.
      expand: { itens: PEDIDO_ITENS_EXPAND },
      usuarioOuterRef: input.usuarioOuterRef,
    });

    // Fast path: nothing moved → no getDb(), no reads, no writes, no next
    // event. Still the common case (an edit touching only ignored fields — the
    // estoque sync's own write-back is the loudest example), so it must stay
    // free.
    if (estadoEntry === null && freteEntry === null && modificationEntry === null) return;

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
    const writes: Array<Promise<unknown>> = [];
    if (estadoEntry !== null) writes.push(recordEstadoHistory(db, pedidoId, estadoEntry));
    if (freteEntry !== null) writes.push(recordFreteHistory(db, pedidoId, freteEntry));
    if (modificationEntry !== null) {
      // No `requireParentExists`: nothing sweeps a pedido's subtree, so a row
      // that outlives its pedido is the point, not a leak (see the entry above).
      writes.push(recordModification(db, PEDIDO_HISTORY_ROOT, pedidoId, modificationEntry));
    }
    await Promise.all(writes);

    if (estadoEntry !== null) {
      logger.info(
        `onPedidoChanged: pedido ${pedidoId} → ${estadoEntry.estado}` +
          ` (por ${estadoEntry.usuarioHistoricoEstadosPedidoOuterRef ?? 'sistema'})`,
      );
    }
    if (freteEntry !== null) {
      logger.info(
        `onPedidoChanged: frete do pedido ${pedidoId} → ${freteEntry.estado}` +
          ` (por ${freteEntry.usuarioHistoricoFreteInicialOuterRef ?? 'sistema'})`,
      );
    }
  },
);
