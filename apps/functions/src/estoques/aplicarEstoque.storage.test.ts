import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { makeEstoqueUid } from '@delfrance/schemas';

import { aplicarLocalizacao, aplicarMovimento } from './aplicarEstoque';

// Integration test — requires the firestore emulator. Drives the per-op
// transaction functions directly (the onCall wrapper's auth needn't be mocked).
// Skipped bare.
const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const projectId = process.env.GCLOUD_PROJECT ?? 'demo-erp';

function getDb() {
  const app = getApps()[0] ?? initializeApp({ projectId });
  return getFirestore(app, process.env.FIREBASE_DATABASE_ID ?? 'default');
}

interface EstoqueDoc {
  quantidade?: number;
  quantidadeReservada?: number;
  localizacao?: string | null;
}

function estoqueRef(db: Firestore, produtoId: string, depositoId: string) {
  return db
    .collection('produtos')
    .doc(produtoId)
    .collection('estoques')
    .doc(makeEstoqueUid(produtoId, depositoId));
}

describe.skipIf(!EMULATED)('aplicarEstoque core (emulator)', () => {
  it('first movimento creates the estoque + one historico, then increments', async () => {
    const db = getDb();
    const produtoId = `p${randomUUID().replace(/-/g, '')}`;
    const depositoId = 'dep1';
    const ref = estoqueRef(db, produtoId, depositoId);

    await aplicarMovimento(
      db,
      {
        op: 'movimento',
        produtoId,
        depositoId,
        input: { tipo: 'entrada', quantidade: 5, quantidadeReservada: 0, motivo: null },
      },
      1,
    );
    let snap = await ref.get();
    expect(snap.exists).toBe(true);
    expect((snap.data() as EstoqueDoc).quantidade).toBe(5);
    expect((await ref.collection('historicoEstoque').get()).size).toBe(1);

    // Second entrada applies the delta to the value read in-transaction.
    await aplicarMovimento(
      db,
      {
        op: 'movimento',
        produtoId,
        depositoId,
        input: { tipo: 'entrada', quantidade: 3, quantidadeReservada: 0, motivo: null },
      },
      2,
    );
    snap = await ref.get();
    expect((snap.data() as EstoqueDoc).quantidade).toBe(8);
    expect((await ref.collection('historicoEstoque').get()).size).toBe(2);
  });

  it('saída subtracts and balanço sets the absolute value', async () => {
    const db = getDb();
    const produtoId = `p${randomUUID().replace(/-/g, '')}`;
    const depositoId = 'dep1';
    const ref = estoqueRef(db, produtoId, depositoId);

    await aplicarMovimento(
      db,
      {
        op: 'movimento',
        produtoId,
        depositoId,
        input: { tipo: 'entrada', quantidade: 10, quantidadeReservada: 0, motivo: null },
      },
      1,
    );
    await aplicarMovimento(
      db,
      {
        op: 'movimento',
        produtoId,
        depositoId,
        input: { tipo: 'saida', quantidade: 3, quantidadeReservada: 0, motivo: null },
      },
      2,
    );
    expect(((await ref.get()).data() as EstoqueDoc).quantidade).toBe(7);

    await aplicarMovimento(
      db,
      {
        op: 'movimento',
        produtoId,
        depositoId,
        input: { tipo: 'balanco', quantidade: 4, quantidadeReservada: 0, motivo: 'contagem' },
      },
      3,
    );
    expect(((await ref.get()).data() as EstoqueDoc).quantidade).toBe(4);
  });

  it('localizacao getOrCreates with quantidade 0 and writes no historico', async () => {
    const db = getDb();
    const produtoId = `p${randomUUID().replace(/-/g, '')}`;
    const depositoId = 'dep1';
    const ref = estoqueRef(db, produtoId, depositoId);

    await aplicarLocalizacao(
      db,
      { op: 'localizacao', produtoId, depositoId, localizacao: 'A1' },
      1,
    );
    const data = (await ref.get()).data() as EstoqueDoc;
    expect(data.quantidade).toBe(0);
    expect(data.localizacao).toBe('A1');
    expect((await ref.collection('historicoEstoque').get()).empty).toBe(true);
  });
});
