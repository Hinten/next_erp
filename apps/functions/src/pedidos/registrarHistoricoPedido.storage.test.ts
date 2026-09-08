import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { ESTADO_FRETE } from '@delfrance/schemas';

import {
  buildEstadoHistoryEntry,
  buildFreteHistoryEntry,
  recordEstadoHistory,
  recordFreteHistory,
} from './registrarHistoricoPedido';

import {
  WAIT_LABELS,
  type WaitLabel,
  expectNoRowForEvent,
  waitForTrigger,
} from '../testing/emulatorWaits';

// Integration test — requires the Firebase emulators. Two layers:
//
//  1. the I/O core, driven directly (firestore emulator only) — the row shape
//     and the idempotency contract, same idiom as the onProdutoChanged /
//     sincronizarEstoquePedido storage suites;
//  2. the REAL trigger end-to-end (needs the functions emulator too, as
//     `resizeProductImage.storage.test.ts` does).
//
// Layer 2 exists because `onPedidoChanged` is this repo's first
// `onDocumentWrittenWithAuthContext`. That variant registers a DIFFERENT
// Eventarc event type than plain `onDocumentWritten`, and a mis-registration
// would satisfy every unit test and every core-level assertion here while
// silently never firing in production. Only writing a real pedido doc and
// watching a row appear can catch that.
//
// NOTE: the acting user cannot be exercised in either layer. The emulator
// hardcodes the Firestore event's `authId` to 'fake-auth-id@gmail.com'
// (firebase-tools#7609, closed as not-planned), so `resolveUsuarioOuterRef` is
// unit-tested instead and the end-to-end actor is verified against staging
// after deploy.
const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const projectId = process.env.GCLOUD_PROJECT ?? 'demo-erp';

function getDb(): Firestore {
  const app = getApps()[0] ?? initializeApp({ projectId });
  return getFirestore(app, process.env.FIREBASE_DATABASE_ID ?? 'default');
}

function freshId(prefix = 'ped') {
  return `${prefix}${randomUUID().replace(/-/g, '')}`;
}

/** Fixed event time — a constant so the redelivery assertion can compare
 *  content-identical docs (timestamp included). The two units are the same
 *  instant: the estado trail stores micros, the frete trail millis. */
const EVENT_TIME_MILLIS = Date.parse('2026-07-28T12:00:00.000Z');
const EVENT_TIME_MICROS = EVENT_TIME_MILLIS * 1000;

const USUARIO_REF = 'documents/usuarios/kJ8fL2mNp9QrS4tUvW6xY0zA1bC3';

async function historyRows(db: Firestore, pedidoId: string) {
  const snap = await db
    .collection('pedidos')
    .doc(pedidoId)
    .collection('historicoEstadoPedido')
    .get();
  return snap.docs;
}

async function freteHistoryRows(db: Firestore, pedidoId: string) {
  const snap = await db.collection('pedidos').doc(pedidoId).collection('historicoFtIni').get();
  return snap.docs;
}

/**
 * The third trail the same trigger writes. Used as a positive ANCHOR: a write
 * whose fields are not ignored must produce a row here, so observing it proves
 * the handler ran for that event — which is what lets a "the other trails did
 * NOT grow" claim mean anything.
 */
async function modificationRows(db: Firestore, pedidoId: string) {
  const snap = await db
    .collection('pedidos')
    .doc(pedidoId)
    .collection('historicoDeModificacoes')
    .get();
  return snap.docs;
}

describe.skipIf(!EMULATED)('registrarHistoricoPedido core (emulator)', () => {
  it('writes one row per transition, keyed by the event id', async () => {
    const db = getDb();
    const pedidoId = freshId();
    const eventId = freshId('evt');

    const entry = buildEstadoHistoryEntry({
      before: { estado: 'iniciado' },
      after: { estado: 'pago' },
      usuarioOuterRef: USUARIO_REF,
      eventId,
      eventTimeMicros: EVENT_TIME_MICROS,
      eventTimeMillis: EVENT_TIME_MILLIS,
    })!;
    await recordEstadoHistory(db, pedidoId, entry);

    const rows = await historyRows(db, pedidoId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(eventId);
    expect(rows[0]!.data()).toMatchObject({
      estado: 'pago',
      usuarioHistoricoEstadosPedidoOuterRef: USUARIO_REF,
      data: EVENT_TIME_MICROS,
      eventId,
    });
  });

  it('is idempotent: a redelivered event rewrites the same row', async () => {
    const db = getDb();
    const pedidoId = freshId();
    const eventId = freshId('evt');
    const entry = buildEstadoHistoryEntry({
      before: { estado: 'iniciado' },
      after: { estado: 'cancelado' },
      usuarioOuterRef: null,
      eventId,
      eventTimeMicros: EVENT_TIME_MICROS,
      eventTimeMillis: EVENT_TIME_MILLIS,
    })!;

    await recordEstadoHistory(db, pedidoId, entry);
    const firstDelivery = (await historyRows(db, pedidoId))[0]!.data();

    await recordEstadoHistory(db, pedidoId, entry);

    const rows = await historyRows(db, pedidoId);
    expect(rows).toHaveLength(1);
    // Content-identical, not merely "still one doc". Reading the first delivery
    // BACK out of Firestore is the point: comparing the in-memory `entry` to
    // itself would prove nothing, whereas this fails if anything in
    // `recordEstadoHistory` or the converter re-stamps a field on rewrite — the
    // reason `data` comes from `event.time` and never `Date.now()`.
    expect(rows[0]!.data()).toEqual(firstDelivery);
    expect(rows[0]!.data()).toMatchObject({
      estado: 'cancelado',
      usuarioHistoricoEstadosPedidoOuterRef: null,
      data: EVENT_TIME_MICROS,
      eventId,
    });
  });

  it('accumulates one row per successive transition', async () => {
    const db = getDb();
    const pedidoId = freshId();

    const transitions: Array<[string, string]> = [
      ['iniciado', 'emProcessamento'],
      ['emProcessamento', 'pago'],
      ['pago', 'finalizado'],
    ];
    for (const [before, after] of transitions) {
      const entry = buildEstadoHistoryEntry({
        before: { estado: before },
        after: { estado: after },
        usuarioOuterRef: null,
        eventId: freshId('evt'),
        eventTimeMicros: EVENT_TIME_MICROS,
        eventTimeMillis: EVENT_TIME_MILLIS,
      })!;
      await recordEstadoHistory(db, pedidoId, entry);
    }

    const rows = await historyRows(db, pedidoId);
    expect(rows.map((d) => d.data().estado as string).sort()).toEqual(
      ['emProcessamento', 'finalizado', 'pago'].sort(),
    );
  });
});

describe.skipIf(!EMULATED)('registrarFreteHistory core (emulator)', () => {
  it('writes one frete row per transition, keyed by the event id', async () => {
    const db = getDb();
    const pedidoId = freshId();
    const eventId = freshId('evt');

    const entry = buildFreteHistoryEntry({
      before: { freteInicial: { estado: ESTADO_FRETE.empacotado } },
      after: { freteInicial: { estado: ESTADO_FRETE.postado } },
      usuarioOuterRef: USUARIO_REF,
      eventId,
      eventTimeMicros: EVENT_TIME_MICROS,
      eventTimeMillis: EVENT_TIME_MILLIS,
    })!;
    await recordFreteHistory(db, pedidoId, entry);

    const rows = await freteHistoryRows(db, pedidoId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(eventId);
    expect(rows[0]!.data()).toMatchObject({
      estado: ESTADO_FRETE.postado,
      obs: null,
      usuarioHistoricoFreteInicialOuterRef: USUARIO_REF,
      // MILLISECONDS on this trail — a micros value here would be off by 1000×
      // and only a real round-trip through the schema can prove the unit stuck.
      data: EVENT_TIME_MILLIS,
      eventId,
    });
  });

  it('is idempotent: a redelivered event rewrites the same frete row', async () => {
    const db = getDb();
    const pedidoId = freshId();
    const eventId = freshId('evt');
    const entry = buildFreteHistoryEntry({
      before: { freteInicial: { estado: ESTADO_FRETE.aCaminho } },
      after: { freteInicial: { estado: ESTADO_FRETE.entregue } },
      usuarioOuterRef: null,
      eventId,
      eventTimeMicros: EVENT_TIME_MICROS,
      eventTimeMillis: EVENT_TIME_MILLIS,
    })!;

    await recordFreteHistory(db, pedidoId, entry);
    await recordFreteHistory(db, pedidoId, entry);

    const rows = await freteHistoryRows(db, pedidoId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data()).toMatchObject({
      estado: ESTADO_FRETE.entregue,
      usuarioHistoricoFreteInicialOuterRef: null,
    });
  });

  it('accumulates one frete row per successive transition', async () => {
    const db = getDb();
    const pedidoId = freshId();

    const transitions: Array<[string, string]> = [
      [ESTADO_FRETE.iniciado, ESTADO_FRETE.despachoAutorizado],
      [ESTADO_FRETE.despachoAutorizado, ESTADO_FRETE.empacotado],
      [ESTADO_FRETE.empacotado, ESTADO_FRETE.postado],
    ];
    for (const [before, after] of transitions) {
      const entry = buildFreteHistoryEntry({
        before: { freteInicial: { estado: before } },
        after: { freteInicial: { estado: after } },
        usuarioOuterRef: null,
        eventId: freshId('evt'),
        eventTimeMicros: EVENT_TIME_MICROS,
        eventTimeMillis: EVENT_TIME_MILLIS,
      })!;
      await recordFreteHistory(db, pedidoId, entry);
    }

    const rows = await freteHistoryRows(db, pedidoId);
    expect(rows.map((d) => d.data().estado as string).sort()).toEqual(
      [ESTADO_FRETE.despachoAutorizado, ESTADO_FRETE.empacotado, ESTADO_FRETE.postado].sort(),
    );
  });
});

/**
 * Wait for the trigger to produce something. The deadline is the suite-wide one
 * (`../testing/emulatorWaits`); this file used to carry its own 20s.
 */
async function waitFor<T>(
  fn: () => Promise<T | null>,
  label: WaitLabel = WAIT_LABELS.estadoTrail,
): Promise<T> {
  const value = await waitForTrigger(
    fn,
    (v) => v !== null,
    'the trigger to fire',
    () => 'nothing had arrived',
    { label },
  );
  return value as T;
}

/**
 * End-to-end through the deployed trigger — requires the FUNCTIONS emulator on
 * top of firestore (the `ci-storage.yml` lane boots both). Proves the
 * `onDocumentWrittenWithAuthContext` registration actually delivers events; the
 * core-level tests above cannot.
 */
describe.skipIf(!EMULATED)('onPedidoChanged trigger (emulator, end-to-end)', () => {
  it('records the opening estado when a pedido is created', async () => {
    const db = getDb();
    const pedidoId = freshId();

    await db.collection('pedidos').doc(pedidoId).set({ estado: 'iniciado', ehSaida: true });

    const rows = await waitFor(async () => {
      const docs = await historyRows(db, pedidoId);
      return docs.length > 0 ? docs : null;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data()).toMatchObject({ estado: 'iniciado' });
    // Written by the Admin SDK, so there is no end user behind it — and the
    // emulator's fake authId is not uid-shaped either. Both resolve to null.
    expect(rows[0]!.data().usuarioHistoricoEstadosPedidoOuterRef).toBeNull();
    // The row is keyed by (and carries) the CloudEvent id.
    expect(rows[0]!.data().eventId).toBe(rows[0]!.id);
    // …and no frete block was written, so the frete trail must stay empty.
    // Bounded, keyed on the same CloudEvent: had the builder wrongly emitted an
    // entry, its write would race the estado one rather than precede it.
    await expectNoRowForEvent(
      () => freteHistoryRows(db, pedidoId),
      (d) => d.id,
      rows[0]!.id,
    );
    expect(await freteHistoryRows(db, pedidoId)).toHaveLength(0);
  });

  it('appends a row on a transition and stays quiet on an unrelated edit', async () => {
    const db = getDb();
    const pedidoId = freshId();
    const ref = db.collection('pedidos').doc(pedidoId);

    await ref.set({ estado: 'iniciado', ehSaida: true });
    await waitFor(async () => {
      const docs = await historyRows(db, pedidoId);
      return docs.length >= 1 ? docs : null;
    });

    await ref.update({ estado: 'pago' });
    const afterTransition = await waitFor(async () => {
      const docs = await historyRows(db, pedidoId);
      return docs.length >= 2 ? docs : null;
    });
    expect(afterTransition.map((d) => d.data().estado as string).sort()).toEqual([
      'iniciado',
      'pago',
    ]);

    // A write that leaves `estado` alone must take the fast path — no new row.
    // `numero` touches neither `estado` nor `freteInicial`, so BOTH trails must
    // stay exactly where they were.
    // ⚠️ This was `sleep(3_000)` then a one-shot count — 70 lines below this
    // file's own docstring explaining why a one-shot read is unsound. #1201
    // measured delivery at p99 7083ms and max 10712ms, so a REGRESSED fast path
    // would write its row well after the read, and the assertion would go green
    // in exactly the case it exists to catch. A bigger sleep only lowers the
    // odds; it cannot make the claim provable.
    //
    // `numero` is not in PEDIDO_HISTORY_IGNORE_FIELDS, so this write DOES produce
    // a modification row. Waiting for THAT row is positive proof the handler ran
    // for this event.
    //
    // ⚠️ But that anchor alone does NOT license a one-shot count, and the reason
    // is the `Promise.all` itself: the three trail writes are issued CONCURRENTLY,
    // so seeing the modification row proves the handler ran — not that a regressed
    // fast path's `recordEstadoHistory`/`recordFreteHistory` `set()` has finished
    // landing. A plain read here could slip between them and pass in exactly the
    // regressed case, which is the vacuity this test was rewritten to remove.
    //
    // The marker hands us the fix for free: all three trails key their row at
    // `entry.eventId`, so the modification row's DOC ID is this write's CloudEvent
    // id. Scoping the negatives to that id is strictly stronger than a quiet
    // window — it can never be satisfied by an unrelated row, and it fails on the
    // first tick that sees one.
    await ref.update({ numero: 'A-123' });
    const modRows = await waitFor(async () => {
      const docs = await modificationRows(db, pedidoId);
      const seen = docs.some((d) =>
        ((d.data().campos as string[] | undefined) ?? []).includes('numero'),
      );
      return seen ? docs : null;
    }, WAIT_LABELS.historicoDeModificacoes);

    const markerEventId = modRows.find((d) =>
      ((d.data().campos as string[] | undefined) ?? []).includes('numero'),
    )!.id;

    await expectNoRowForEvent(
      () => historyRows(db, pedidoId),
      (d) => d.id,
      markerEventId,
    );
    await expectNoRowForEvent(
      () => freteHistoryRows(db, pedidoId),
      (d) => d.id,
      markerEventId,
    );

    expect(await historyRows(db, pedidoId)).toHaveLength(2);
    expect(await freteHistoryRows(db, pedidoId)).toHaveLength(0);
  });

  it('opens BOTH trails when a pedido is created with a frete block', async () => {
    const db = getDb();
    const pedidoId = freshId();

    await db
      .collection('pedidos')
      .doc(pedidoId)
      .set({
        estado: 'iniciado',
        ehSaida: true,
        freteInicial: { estado: ESTADO_FRETE.iniciado, codRastreio: null },
      });

    const freteRows = await waitFor(async () => {
      const docs = await freteHistoryRows(db, pedidoId);
      return docs.length > 0 ? docs : null;
    }, WAIT_LABELS.freteTrail);
    expect(freteRows).toHaveLength(1);
    expect(freteRows[0]!.data()).toMatchObject({
      estado: ESTADO_FRETE.iniciado,
      obs: null,
      usuarioHistoricoFreteInicialOuterRef: null,
    });
    expect(freteRows[0]!.data().eventId).toBe(freteRows[0]!.id);

    const estadoRows = await waitFor(async () => {
      const docs = await historyRows(db, pedidoId);
      return docs.length > 0 ? docs : null;
    });
    expect(estadoRows).toHaveLength(1);
    expect(estadoRows[0]!.data()).toMatchObject({ estado: 'iniciado' });
    // One create, one row in each trail, both keyed on the same CloudEvent.
    expect(freteRows[0]!.id).toBe(estadoRows[0]!.id);
  });

  it('records a frete-only move without touching the estado trail', async () => {
    const db = getDb();
    const pedidoId = freshId();
    const ref = db.collection('pedidos').doc(pedidoId);

    await ref.set({
      estado: 'pago',
      ehSaida: true,
      freteInicial: { estado: ESTADO_FRETE.empacotado, codRastreio: null },
    });
    await waitFor(async () => {
      const docs = await freteHistoryRows(db, pedidoId);
      return docs.length >= 1 ? docs : null;
    }, WAIT_LABELS.freteTrail);

    // A DOTTED patch — how the Frete tab and the tracking pollers write.
    await ref.update({ 'freteInicial.estado': ESTADO_FRETE.postado });

    const freteRows = await waitFor(async () => {
      const docs = await freteHistoryRows(db, pedidoId);
      return docs.length >= 2 ? docs : null;
    }, WAIT_LABELS.freteTrail);
    expect(freteRows.map((d) => d.data().estado as string).sort()).toEqual(
      [ESTADO_FRETE.empacotado, ESTADO_FRETE.postado].sort(),
    );
    // The pedido's own estado never moved: still just the opening row. This
    // half of the pair is what catches a builder keyed off the wrong field.
    // Asserted by EVENT ID over a bounded window — see `expectNoRowForEvent`
    // for why a single read would pass vacuously against the concurrent writes.
    const postadoRow = freteRows.find((d) => d.data().estado === ESTADO_FRETE.postado)!;
    await expectNoRowForEvent(
      () => historyRows(db, pedidoId),
      (d) => d.id,
      postadoRow.id,
    );
    expect(await historyRows(db, pedidoId)).toHaveLength(1);
  });

  it('records an estado-only move without touching the frete trail', async () => {
    const db = getDb();
    const pedidoId = freshId();
    const ref = db.collection('pedidos').doc(pedidoId);

    await ref.set({
      estado: 'iniciado',
      ehSaida: true,
      freteInicial: { estado: ESTADO_FRETE.empacotado, codRastreio: null },
    });
    await waitFor(async () => {
      const docs = await historyRows(db, pedidoId);
      return docs.length >= 1 ? docs : null;
    });

    // The #702 shape end-to-end: the pedido gets paid, the packed shipment does
    // not move.
    await ref.update({ estado: 'pago' });

    const estadoRows = await waitFor(async () => {
      const docs = await historyRows(db, pedidoId);
      return docs.length >= 2 ? docs : null;
    });
    expect(estadoRows.map((d) => d.data().estado as string).sort()).toEqual(['iniciado', 'pago']);
    // Only the opening frete row — the second pedido write appended nothing.
    // Same bounded event-id proof as its mirror above.
    const pagoRow = estadoRows.find((d) => d.data().estado === 'pago')!;
    await expectNoRowForEvent(
      () => freteHistoryRows(db, pedidoId),
      (d) => d.id,
      pagoRow.id,
    );
    const freteRows = await freteHistoryRows(db, pedidoId);
    expect(freteRows).toHaveLength(1);
    expect(freteRows[0]!.data().estado).toBe(ESTADO_FRETE.empacotado);
  });

  it('records one row in each trail, sharing the event id, when a write moves both', async () => {
    const db = getDb();
    const pedidoId = freshId();
    const ref = db.collection('pedidos').doc(pedidoId);

    await ref.set({
      estado: 'iniciado',
      ehSaida: true,
      freteInicial: { estado: ESTADO_FRETE.iniciado, codRastreio: null },
    });
    await waitFor(async () => {
      const estados = await historyRows(db, pedidoId);
      const fretes = await freteHistoryRows(db, pedidoId);
      return estados.length >= 1 && fretes.length >= 1 ? true : null;
    });

    // One update, both fields — exactly what `pedidoReconcile` commits when a
    // full payment also authorizes despatch.
    await ref.update({
      estado: 'pago',
      freteInicial: { estado: ESTADO_FRETE.despachoAutorizado, codRastreio: null },
    });

    const estadoRows = await waitFor(async () => {
      const docs = await historyRows(db, pedidoId);
      return docs.length >= 2 ? docs : null;
    });
    const freteRows = await waitFor(async () => {
      const docs = await freteHistoryRows(db, pedidoId);
      return docs.length >= 2 ? docs : null;
    }, WAIT_LABELS.freteTrail);
    expect(estadoRows).toHaveLength(2);
    expect(freteRows).toHaveLength(2);

    // The two rows produced by the SECOND write carry the same CloudEvent id:
    // different subcollections, so it is a correlation key, not a collision.
    const pagoRow = estadoRows.find((d) => d.data().estado === 'pago')!;
    const autorizadoRow = freteRows.find(
      (d) => d.data().estado === ESTADO_FRETE.despachoAutorizado,
    )!;
    expect(pagoRow.id).toBe(autorizadoRow.id);
    expect(pagoRow.data().eventId).toBe(autorizadoRow.data().eventId);
  });
});
