import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { buildEstadoHistoryEntry, recordEstadoHistory } from './registrarEstadoPedido';

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
 *  content-identical docs (timestamp included). */
const EVENT_TIME_MICROS = Date.parse('2026-07-28T12:00:00.000Z') * 1000;

const USUARIO_REF = 'documents/usuarios/kJ8fL2mNp9QrS4tUvW6xY0zA1bC3';

async function historyRows(db: Firestore, pedidoId: string) {
  const snap = await db
    .collection('pedidos')
    .doc(pedidoId)
    .collection('historicoEstadoPedido')
    .get();
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
      })!;
      await recordEstadoHistory(db, pedidoId, entry);
    }

    const rows = await historyRows(db, pedidoId);
    expect(rows.map((d) => d.data().estado as string).sort()).toEqual(
      ['emProcessamento', 'finalizado', 'pago'].sort(),
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
    await ref.update({ numero: 'A-123' });
    await sleep(3_000);
    expect(await historyRows(db, pedidoId)).toHaveLength(2);
    // Two sequential waits plus the quiet-window sleep can exceed the suite's
    // 30s default even when each step is fast.
  }, 90_000);
});
