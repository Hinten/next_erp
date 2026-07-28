import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { buildEstadoHistoryEntry, recordEstadoHistory } from './registrarEstadoPedido';

// Integration test — requires the firestore emulator. Drives the I/O core
// directly (the trigger wrapper needs no emulation: its guards are unit-tested
// and it only forwards to the core). Same idiom as the onProdutoChanged /
// sincronizarEstoquePedido storage suites.
//
// NOTE: the acting user cannot be exercised here. The emulator hardcodes the
// Firestore event's `authId` to 'fake-auth-id@gmail.com' (firebase-tools#7609,
// closed as not-planned), so `resolveUsuarioOuterRef` is unit-tested instead and
// the end-to-end actor is verified against staging after deploy.
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
