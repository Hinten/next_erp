import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import {
  type DocumentData,
  type Firestore,
  type QueryDocumentSnapshot,
  getFirestore,
} from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

/**
 * END-TO-END proof for the pedido modification history: write a real document,
 * let the REAL trigger fire, watch the row appear. Requires the functions
 * emulator, not just Firestore.
 *
 * The unit suites cover the row SHAPE; only this can catch a trigger that never
 * fires — a wrong `document` pattern, a missing `database`, or the
 * `withAuthContext` event-type switch registering something the emulator (and
 * Eventarc) never routes to.
 *
 * ⚠️ The acting user is deliberately NOT asserted here. The emulator hardcodes
 * the Firestore event's `authId` to `fake-auth-id@gmail.com`
 * (firebase-tools#7609, closed as not-planned), so every row written here
 * resolves to `usuarioOuterRef: null` no matter who wrote it. The resolver is
 * unit-tested in `../lib/authContext.test.ts`, and the real actor is asserted in
 * a staging `vendas` e2e.
 */
const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const projectId = process.env.GCLOUD_PROJECT ?? 'demo-erp';

function getDb(): Firestore {
  const app = getApps()[0] ?? initializeApp({ projectId });
  return getFirestore(app, process.env.FIREBASE_DATABASE_ID ?? 'default');
}

function freshId(prefix = 'ped') {
  return `${prefix}${randomUUID().replace(/-/g, '')}`;
}

function historyRef(db: Firestore, pedidoId: string) {
  return db.collection('pedidos').doc(pedidoId).collection('historicoDeModificacoes');
}

/** Poll until at least `minRows` rows exist, or fail with what was actually seen. */
async function waitForRows(
  db: Firestore,
  pedidoId: string,
  minRows: number,
  timeoutMs = 15_000,
): Promise<QueryDocumentSnapshot<DocumentData>[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = await historyRef(db, pedidoId).get();
    if (snap.size >= minRows) return snap.docs;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${minRows} historicoDeModificacoes row(s); saw ${snap.size}`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** A minimal pedido the schema will accept on read-back. */
function novoPedido(extra: DocumentData = {}): DocumentData {
  return {
    ehSaida: true,
    estado: 'iniciado',
    numero: 1,
    itens: {},
    valorCobrado: 0,
    ...extra,
  };
}

describe.skipIf(!EMULATED)('pedido modification history (emulator, end-to-end)', () => {
  it('records the pedido document itself, tagged with a null subcolecao', async () => {
    const db = getDb();
    const pedidoId = freshId();

    await db.collection('pedidos').doc(pedidoId).set(novoPedido());
    const rows = await waitForRows(db, pedidoId, 1);

    expect(rows).toHaveLength(1);
    const row = rows[0]!.data();
    expect(row).toMatchObject({
      subcolecao: null,
      docId: pedidoId,
      kind: 'create',
      path: `pedidos/${pedidoId}`,
    });
    // Always PRESENT, even though it is null in the emulator — the schema's
    // "absent" state is reserved for rows predating the field.
    expect('usuarioOuterRef' in row).toBe(true);
    expect(row.usuarioOuterRef).toBeNull();
  });

  it('records a pagamento under the PEDIDO, tagged subcolecao: pagamentos', async () => {
    const db = getDb();
    const pedidoId = freshId();
    await db.collection('pedidos').doc(pedidoId).set(novoPedido());
    await waitForRows(db, pedidoId, 1);

    const pagamentoId = freshId('pag');
    await db
      .collection('pedidos')
      .doc(pedidoId)
      .collection('pagamentos')
      .doc(pagamentoId)
      .set({ valor: 150, status_pagamento: 3, forma_de_pagamento: 1 });

    const rows = await waitForRows(db, pedidoId, 2);
    const pagamentoRow = rows.map((d) => d.data()).find((r) => r.subcolecao === 'pagamentos');
    expect(pagamentoRow).toBeDefined();
    expect(pagamentoRow).toMatchObject({ docId: pagamentoId, kind: 'create' });
    expect(pagamentoRow?.campos).toContain('valor');
    expect(pagamentoRow?.campos).toContain('status_pagamento');
  });

  it('records an incidente under the PEDIDO, tagged subcolecao: incidentes', async () => {
    const db = getDb();
    const pedidoId = freshId();
    await db.collection('pedidos').doc(pedidoId).set(novoPedido());
    await waitForRows(db, pedidoId, 1);

    const incidenteId = freshId('inc');
    await db
      .collection('pedidos')
      .doc(pedidoId)
      .collection('incidentes')
      .doc(incidenteId)
      .set({ tipo: 1, motivoDoIncidente: 'Avaria no transporte' });

    const rows = await waitForRows(db, pedidoId, 2);
    const incidenteRow = rows.map((d) => d.data()).find((r) => r.subcolecao === 'incidentes');
    expect(incidenteRow).toBeDefined();
    expect(incidenteRow).toMatchObject({ docId: incidenteId, kind: 'create' });
    expect(incidenteRow?.campos).toContain('motivoDoIncidente');
  });

  it('writes NO row for an estoque-sync write-back (the phantom-row guard)', async () => {
    // `sincronizarEstoquePedido` writes these back seconds after a save and does
    // NOT stamp `ultimaModificacao`. If they were not ignored, every
    // stock-moving save would leave a second, "Sistema"-attributed row for a
    // change no operator made (#972's failure, one trail later).
    const db = getDb();
    const pedidoId = freshId();
    const ref = db.collection('pedidos').doc(pedidoId);

    await ref.set(novoPedido());
    await waitForRows(db, pedidoId, 1);

    await ref.update({
      estoqueAplicado: { depositoId: 'd1', ehSaida: true },
      dataRemocaoEstoque: 1_700_000_000_000_000,
      ultimaModificacao: 1_700_000_000_000_000,
    });

    // Give the trigger the same budget a real row would need, then assert the
    // count did NOT grow.
    await new Promise((r) => setTimeout(r, 3_000));
    const snap = await historyRef(db, pedidoId).get();
    expect(snap.size).toBe(1);
  });

  it('expands itens per line instead of storing both whole maps', async () => {
    const db = getDb();
    const pedidoId = freshId();
    const ref = db.collection('pedidos').doc(pedidoId);
    const linha = (quantidade: number) => ({
      produtoUid: 'prod1',
      ordem: 1,
      ensureUniqueId: null,
      quantidade,
      precoDeVenda: 10,
    });

    await ref.set(novoPedido({ itens: { prod1: [linha(2)] } }));
    await waitForRows(db, pedidoId, 1);

    await ref.update({ itens: { prod1: [linha(5)] } });
    const rows = await waitForRows(db, pedidoId, 2);

    const updateRow = rows.map((d) => d.data()).find((r) => r.kind === 'update');
    expect(updateRow).toBeDefined();
    // The fine key names the LINE, and the coarse name stays for array-contains.
    expect(updateRow?.campos).toContain('itens');
    expect(updateRow?.campos).toContain('itens.prod1#1.quantidade');
    expect(updateRow?.changes['itens.prod1#1.quantidade']).toEqual({ old: 2, new: 5 });
    // The whole-map value is NOT stored once the field is expanded.
    expect(updateRow?.changes.itens).toBeUndefined();
  });

  it('leaves a delete TOMBSTONE that survives its pedido', async () => {
    // `pedidos` has no delete cascade (owner call, 2026-08), so nothing sweeps
    // this row — which is the point: it is the only surviving record that the
    // order existed and who removed it.
    const db = getDb();
    const pedidoId = freshId();
    const ref = db.collection('pedidos').doc(pedidoId);

    await ref.set(novoPedido({ numero: 4242 }));
    await waitForRows(db, pedidoId, 1);

    await ref.delete();
    const rows = await waitForRows(db, pedidoId, 2);

    const tombstone = rows.map((d) => d.data()).find((r) => r.kind === 'delete');
    expect(tombstone).toBeDefined();
    expect(tombstone?.changes.numero).toEqual({ old: 4242, new: null });
    // The parent really is gone, and the row is still there.
    expect((await ref.get()).exists).toBe(false);
    expect((await historyRef(db, pedidoId).get()).size).toBeGreaterThanOrEqual(2);
  });
});
