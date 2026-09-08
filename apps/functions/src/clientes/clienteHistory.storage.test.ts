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
 * END-TO-END proof for the cliente modification history (#650's rollout of
 * `makeModificationHistoryTrigger`): write a real document, let the REAL
 * trigger fire, watch the row appear. Requires the functions emulator, not
 * just Firestore — same rationale as `pedidoHistory.storage.test.ts`, whose
 * shape (no delete-cascade root, so a delete leaves a surviving tombstone) this
 * mirrors closely.
 *
 * ⚠️ The acting user is deliberately NOT asserted here — same emulator
 * limitation as the pedido suite (firebase-tools#7609).
 */
const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const projectId = process.env.GCLOUD_PROJECT ?? 'demo-erp';

function getDb(): Firestore {
  const app = getApps()[0] ?? initializeApp({ projectId });
  return getFirestore(app, process.env.FIREBASE_DATABASE_ID ?? 'default');
}

function freshId(prefix = 'cli') {
  return `${prefix}${randomUUID().replace(/-/g, '')}`;
}

function historyRef(db: Firestore, clienteId: string) {
  return db.collection('clientes').doc(clienteId).collection('historicoDeModificacoes');
}

/** Poll until at least `minRows` rows exist, or fail with what was actually seen. */
async function waitForRows(
  db: Firestore,
  clienteId: string,
  minRows: number,
  timeoutMs = 15_000,
): Promise<QueryDocumentSnapshot<DocumentData>[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = await historyRef(db, clienteId).get();
    if (snap.size >= minRows) return snap.docs;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${minRows} historicoDeModificacoes row(s); saw ${snap.size}`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** A minimal cliente the schema will accept on read-back. */
function novoCliente(extra: DocumentData = {}): DocumentData {
  return {
    tipo: '0',
    nome: 'Cliente de Teste',
    cpf_cnpj: null,
    ...extra,
  };
}

describe.skipIf(!EMULATED)('cliente modification history (emulator, end-to-end)', () => {
  it('records the cliente document itself, tagged with a null subcolecao', async () => {
    const db = getDb();
    const clienteId = freshId();

    await db.collection('clientes').doc(clienteId).set(novoCliente());
    const rows = await waitForRows(db, clienteId, 1);

    expect(rows).toHaveLength(1);
    const row = rows[0]!.data();
    expect(row).toMatchObject({
      subcolecao: null,
      docId: clienteId,
      kind: 'create',
      path: `clientes/${clienteId}`,
    });
    // Always PRESENT, even though it is null in the emulator — the schema's
    // "absent" state is reserved for rows predating the field.
    expect('usuarioOuterRef' in row).toBe(true);
    expect(row.usuarioOuterRef).toBeNull();
  });

  it('records an endereço under the CLIENTE, tagged subcolecao: enderecos', async () => {
    const db = getDb();
    const clienteId = freshId();
    await db.collection('clientes').doc(clienteId).set(novoCliente());
    await waitForRows(db, clienteId, 1);

    const enderecoId = freshId('end');
    await db
      .collection('clientes')
      .doc(clienteId)
      .collection('enderecos')
      .doc(enderecoId)
      .set({ cep: '01310100', logradouro: 'Av. Paulista', numero: '1000', cidade: 'São Paulo' });

    const rows = await waitForRows(db, clienteId, 2);
    const enderecoRow = rows.map((d) => d.data()).find((r) => r.subcolecao === 'enderecos');
    expect(enderecoRow).toBeDefined();
    expect(enderecoRow).toMatchObject({ docId: enderecoId, kind: 'create' });
    expect(enderecoRow?.campos).toContain('logradouro');
  });

  it('leaves a delete TOMBSTONE that survives its cliente', async () => {
    // `clientes` declares a cascade over `enderecos` but has no delete trigger
    // enforcing it (owner call, 2026-08) — nothing sweeps this row, which is
    // the point: it is the only surviving record that the customer existed and
    // who removed it.
    const db = getDb();
    const clienteId = freshId();
    const ref = db.collection('clientes').doc(clienteId);

    await ref.set(novoCliente({ nome: 'Cliente a remover' }));
    await waitForRows(db, clienteId, 1);

    await ref.delete();
    const rows = await waitForRows(db, clienteId, 2);

    const tombstone = rows.map((d) => d.data()).find((r) => r.kind === 'delete');
    expect(tombstone).toBeDefined();
    expect(tombstone?.changes.nome).toEqual({ old: 'Cliente a remover', new: null });
    // The parent really is gone, and the row is still there.
    expect((await ref.get()).exists).toBe(false);
    expect((await historyRef(db, clienteId).get()).size).toBeGreaterThanOrEqual(2);
  });
});
