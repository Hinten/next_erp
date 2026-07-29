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
} from './registrarEstadoPedido';

// Integration test — requires the Firebase emulators. Two layers:
//
//  1. the I/O core, driven directly (firestore emulator only) — the row shape
//     and the idempotency contract, same idiom as the onProdutoChanged /
//     sincronizarEstoquePedido storage suites;
//  2. the REAL trigger end-to-end (needs the functions emulator too, as
//     `resizeProductImage.storage.test.ts` does).
//
// Layer 2 exists because `onPedidoEstadoChanged` is this repo's first
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

describe.skipIf(!EMULATED)('registrarEstadoPedido core (emulator)', () => {
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
    await recordEstadoHistory(db, pedidoId, entry);

    const rows = await historyRows(db, pedidoId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data()).toMatchObject({
      estado: 'cancelado',
      usuarioHistoricoEstadosPedidoOuterRef: null,
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(
  fn: () => Promise<T | null>,
  timeoutMs = 20_000,
  stepMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== null) return v;
    if (Date.now() > deadline) throw new Error('timed out waiting for the trigger to fire');
    await sleep(stepMs);
  }
}

/**
 * Bounded negative: assert a trail never gains a row keyed on `eventId`,
 * re-reading across `windowMs`.
 *
 * A ONE-SHOT read is not sound here, and the difference is exactly the bug this
 * guards. The handler launches both trails' writes concurrently (`Promise.all`
 * in `registrarEstadoPedido.ts`), so observing ONE trail's row proves the
 * trigger RAN for that CloudEvent — it does NOT prove the other trail's `set()`
 * has settled. A regressed builder's row could land a moment later, and a single
 * read would miss it: the assertion would pass in precisely the broken case it
 * exists to catch.
 *
 * Re-reading across a window closes that without degrading into a
 * sleep-then-count: the claim stays keyed on the CloudEvent id, so it can never
 * be satisfied by an unrelated row, and it fails on the FIRST tick that sees the
 * row rather than after the whole window.
 */
async function expectNoRowForEvent(
  readRows: () => Promise<Array<{ id: string }>>,
  eventId: string,
  windowMs = 2_000,
  stepMs = 250,
): Promise<void> {
  const deadline = Date.now() + windowMs;
  for (;;) {
    const rows = await readRows();
    expect(rows.some((d) => d.id === eventId)).toBe(false);
    if (Date.now() >= deadline) return;
    await sleep(stepMs);
  }
}

/**
 * End-to-end through the deployed trigger — requires the FUNCTIONS emulator on
 * top of firestore (the `ci-storage.yml` lane boots both). Proves the
 * `onDocumentWrittenWithAuthContext` registration actually delivers events; the
 * core-level tests above cannot.
 */
describe.skipIf(!EMULATED)('onPedidoEstadoChanged trigger (emulator, end-to-end)', () => {
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
    await expectNoRowForEvent(() => freteHistoryRows(db, pedidoId), rows[0]!.id);
    expect(await freteHistoryRows(db, pedidoId)).toHaveLength(0);
    // Explicit timeout: the suite default is 30s, and a first invocation pays
    // the functions emulator's cold start on top of trigger delivery.
  }, 60_000);

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
    await ref.update({ numero: 'A-123' });
    await sleep(3_000);
    expect(await historyRows(db, pedidoId)).toHaveLength(2);
    expect(await freteHistoryRows(db, pedidoId)).toHaveLength(0);
    // Two sequential waits plus the quiet-window sleep can exceed the suite's
    // 30s default even when each step is fast.
  }, 90_000);

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
    });
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
  }, 60_000);

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
    });

    // A DOTTED patch — how the Frete tab and the tracking pollers write.
    await ref.update({ 'freteInicial.estado': ESTADO_FRETE.postado });

    const freteRows = await waitFor(async () => {
      const docs = await freteHistoryRows(db, pedidoId);
      return docs.length >= 2 ? docs : null;
    });
    expect(freteRows.map((d) => d.data().estado as string).sort()).toEqual(
      [ESTADO_FRETE.empacotado, ESTADO_FRETE.postado].sort(),
    );
    // The pedido's own estado never moved: still just the opening row. This
    // half of the pair is what catches a builder keyed off the wrong field.
    // Asserted by EVENT ID over a bounded window — see `expectNoRowForEvent`
    // for why a single read would pass vacuously against the concurrent writes.
    const postadoRow = freteRows.find((d) => d.data().estado === ESTADO_FRETE.postado)!;
    await expectNoRowForEvent(() => historyRows(db, pedidoId), postadoRow.id);
    expect(await historyRows(db, pedidoId)).toHaveLength(1);
  }, 90_000);

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
    await expectNoRowForEvent(() => freteHistoryRows(db, pedidoId), pagoRow.id);
    const freteRows = await freteHistoryRows(db, pedidoId);
    expect(freteRows).toHaveLength(1);
    expect(freteRows[0]!.data().estado).toBe(ESTADO_FRETE.empacotado);
  }, 90_000);

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
    });
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
  }, 90_000);
});
