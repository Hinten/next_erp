import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { buildPagamentoHistoryEntry, recordPagamentoHistory } from './registrarHistoricoPagamento';

// Integration test — requires the Firebase emulators. Same two-layer idiom as
// `registrarEstadoPedido.storage.test.ts`:
//
//  1. the I/O core, driven directly (firestore emulator only) — row shape +
//     idempotency;
//  2. the REAL trigger end-to-end (needs the functions emulator too), which
//     is the only thing that can catch an `onDocumentWrittenWithAuthContext`
//     mis-registration.
const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const projectId = process.env.GCLOUD_PROJECT ?? 'demo-erp';

function getDb(): Firestore {
  const app = getApps()[0] ?? initializeApp({ projectId });
  return getFirestore(app, process.env.FIREBASE_DATABASE_ID ?? 'default');
}

function freshId(prefix = 'ped') {
  return `${prefix}${randomUUID().replace(/-/g, '')}`;
}

const EVENT_TIME_MILLIS = Date.parse('2026-08-14T12:00:00.000Z');
const USUARIO_REF = 'documents/usuarios/kJ8fL2mNp9QrS4tUvW6xY0zA1bC3';

async function historyRows(db: Firestore, pedidoId: string, pagamentoId: string) {
  const snap = await db
    .collection('pedidos')
    .doc(pedidoId)
    .collection('pagamentos')
    .doc(pagamentoId)
    .collection('histpgto')
    .get();
  return snap.docs;
}

describe.skipIf(!EMULATED)('registrarHistoricoPagamento core (emulator)', () => {
  it('writes one row per transition, keyed by the event id', async () => {
    const db = getDb();
    const pedidoId = freshId();
    const pagamentoId = freshId('pgto');
    const eventId = freshId('evt');

    const entry = buildPagamentoHistoryEntry({
      before: { status_pagamento: 0 },
      after: { status_pagamento: 4 },
      usuarioOuterRef: USUARIO_REF,
      eventId,
      eventTimeMillis: EVENT_TIME_MILLIS,
    })!;
    await recordPagamentoHistory(db, pedidoId, pagamentoId, entry);

    const rows = await historyRows(db, pedidoId, pagamentoId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(eventId);
    expect(rows[0]!.data()).toMatchObject({
      status_anterior: 0,
      status_atual: 4,
      usuarioHistoricoPagamentoOuterRef: USUARIO_REF,
      timestamp: EVENT_TIME_MILLIS,
      eventId,
    });
  });

  it('is idempotent: a redelivered event rewrites the same row', async () => {
    const db = getDb();
    const pedidoId = freshId();
    const pagamentoId = freshId('pgto');
    const eventId = freshId('evt');
    const entry = buildPagamentoHistoryEntry({
      before: { status_pagamento: 0 },
      after: { status_pagamento: 6 },
      usuarioOuterRef: null,
      eventId,
      eventTimeMillis: EVENT_TIME_MILLIS,
    })!;

    await recordPagamentoHistory(db, pedidoId, pagamentoId, entry);
    const firstDelivery = (await historyRows(db, pedidoId, pagamentoId))[0]!.data();

    await recordPagamentoHistory(db, pedidoId, pagamentoId, entry);

    const rows = await historyRows(db, pedidoId, pagamentoId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data()).toEqual(firstDelivery);
  });

  it('accumulates one row per successive transition', async () => {
    const db = getDb();
    const pedidoId = freshId();
    const pagamentoId = freshId('pgto');

    const transitions: Array<[number | null, number | null]> = [
      [null, 0],
      [0, 3],
      [3, 4],
    ];
    for (const [before, after] of transitions) {
      const entry = buildPagamentoHistoryEntry({
        before: { status_pagamento: before },
        after: { status_pagamento: after },
        usuarioOuterRef: null,
        eventId: freshId('evt'),
        eventTimeMillis: EVENT_TIME_MILLIS,
      })!;
      await recordPagamentoHistory(db, pedidoId, pagamentoId, entry);
    }

    const rows = await historyRows(db, pedidoId, pagamentoId);
    expect(rows.map((d) => d.data().status_atual as number | null).sort()).toEqual([0, 3, 4]);
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
 * End-to-end through the deployed trigger — requires the FUNCTIONS emulator
 * on top of firestore. Proves the `onDocumentWrittenWithAuthContext`
 * registration actually delivers events for the pagamento path; the
 * core-level tests above cannot.
 */
describe.skipIf(!EMULATED)('onPagamentoStatusChanged trigger (emulator, end-to-end)', () => {
  it('records the opening status when a pagamento is created', async () => {
    const db = getDb();
    const pedidoId = freshId();
    const pagamentoId = freshId('pgto');

    await db
      .collection('pedidos')
      .doc(pedidoId)
      .collection('pagamentos')
      .doc(pagamentoId)
      .set({ status_pagamento: 0, valor: 100, forma_de_pagamento: 1 });

    const rows = await waitFor(async () => {
      const docs = await historyRows(db, pedidoId, pagamentoId);
      return docs.length > 0 ? docs : null;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data()).toMatchObject({ status_anterior: null, status_atual: 0 });
    // Written by the Admin SDK — no end user behind it, and the emulator's
    // fake authId is not uid-shaped either. Resolves to null.
    expect(rows[0]!.data().usuarioHistoricoPagamentoOuterRef).toBeNull();
    expect(rows[0]!.data().eventId).toBe(rows[0]!.id);
  }, 60_000);

  it('appends a row on a status transition and stays quiet on an unrelated edit', async () => {
    const db = getDb();
    const pedidoId = freshId();
    const pagamentoId = freshId('pgto');
    const ref = db.collection('pedidos').doc(pedidoId).collection('pagamentos').doc(pagamentoId);

    await ref.set({ status_pagamento: 0, valor: 100, forma_de_pagamento: 1 });
    await waitFor(async () => {
      const docs = await historyRows(db, pedidoId, pagamentoId);
      return docs.length >= 1 ? docs : null;
    });

    await ref.update({ status_pagamento: 4 });
    const afterTransition = await waitFor(async () => {
      const docs = await historyRows(db, pedidoId, pagamentoId);
      return docs.length >= 2 ? docs : null;
    });
    expect(afterTransition.map((d) => d.data().status_atual as number | null).sort()).toEqual([
      0, 4,
    ]);

    // A write that leaves `status_pagamento` alone must take the fast path.
    await ref.update({ valor: 150 });
    await sleep(3_000);
    expect(await historyRows(db, pedidoId, pagamentoId)).toHaveLength(2);
  }, 90_000);
});
