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
  ultimaModificacao?: number | null;
  dataCriacao?: number | null;
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

  it('quantidadeReservada floors at 0 — first-movement saída and overshoot (#387)', async () => {
    const db = getDb();
    const produtoId = `p${randomUUID().replace(/-/g, '')}`;
    const depositoId = 'dep1';
    const ref = estoqueRef(db, produtoId, depositoId);

    // First movement is a saída: quantidade may go negative, reservada must not.
    await aplicarMovimento(
      db,
      {
        op: 'movimento',
        produtoId,
        depositoId,
        input: { tipo: 'saida', quantidade: 2, quantidadeReservada: 1, motivo: null },
      },
      1,
    );
    let data = (await ref.get()).data() as EstoqueDoc;
    expect(data.quantidade).toBe(-2);
    expect(data.quantidadeReservada).toBe(0);

    // Reserve 3, then a saída releasing 5 overshoots → floored at 0, not -2.
    await aplicarMovimento(
      db,
      {
        op: 'movimento',
        produtoId,
        depositoId,
        input: { tipo: 'entrada', quantidade: 10, quantidadeReservada: 3, motivo: null },
      },
      2,
    );
    await aplicarMovimento(
      db,
      {
        op: 'movimento',
        produtoId,
        depositoId,
        input: { tipo: 'saida', quantidade: 4, quantidadeReservada: 5, motivo: null },
      },
      3,
    );
    data = (await ref.get()).data() as EstoqueDoc;
    expect(data.quantidade).toBe(4); // -2 + 10 - 4
    expect(data.quantidadeReservada).toBe(0); // max(0 + 3 - 5, 0)
  });

  it('a stale now cannot move ultimaModificacao backwards (#387)', async () => {
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
      100,
    );
    // Out-of-order timestamp: the movement still applies, the clock stays put.
    await aplicarMovimento(
      db,
      {
        op: 'movimento',
        produtoId,
        depositoId,
        input: { tipo: 'entrada', quantidade: 3, quantidadeReservada: 0, motivo: null },
      },
      50,
    );
    const data = (await ref.get()).data() as EstoqueDoc;
    expect(data.quantidade).toBe(8);
    expect(data.ultimaModificacao).toBe(100);
  });

  it('balanço clamps reservada at 0 and keeps dataCriacao (#387)', async () => {
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
        input: { tipo: 'entrada', quantidade: 10, quantidadeReservada: 2, motivo: null },
      },
      1,
    );
    // The callable's schema rejects negative magnitudes; drive the exported core
    // directly to prove the balanço clamp is not schema-dependent.
    await aplicarMovimento(
      db,
      {
        op: 'movimento',
        produtoId,
        depositoId,
        input: { tipo: 'balanco', quantidade: 4, quantidadeReservada: -3, motivo: 'contagem' },
      },
      5,
    );
    const data = (await ref.get()).data() as EstoqueDoc;
    expect(data.quantidade).toBe(4);
    expect(data.quantidadeReservada).toBe(0);
    expect(data.dataCriacao).toBe(1); // minimum(now) keeps the older creation time
    expect(data.ultimaModificacao).toBe(5);
  });

  it('heals stored non-number quantities instead of corrupting them (#387)', async () => {
    const db = getDb();
    const produtoId = `p${randomUUID().replace(/-/g, '')}`;
    const depositoId = 'dep1';
    const ref = estoqueRef(db, produtoId, depositoId);

    // Rules stay open (ADR 0010) and the migrated corpus carries garbage rows —
    // the tolerance is still needed, the "live legacy writer" reason is not.
    await ref.set({ quantidade: 'muito', quantidadeReservada: 'abc', ultimaModificacao: 'nunca' });
    await aplicarMovimento(
      db,
      {
        op: 'movimento',
        produtoId,
        depositoId,
        input: { tipo: 'entrada', quantidade: 5, quantidadeReservada: 0, motivo: null },
      },
      7,
    );
    const data = (await ref.get()).data() as EstoqueDoc;
    expect(data.quantidade).toBe(5); // increment on a non-number SETS the operand
    expect(data.quantidadeReservada).toBe(0);
    expect(data.ultimaModificacao).toBe(7);
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
    // Create path initializes ultimaModificacao like every other create path.
    expect(data.ultimaModificacao).toBe(1);
    expect((await ref.collection('historicoEstoque').get()).empty).toBe(true);
  });

  it('localizacao on a stocked estoque leaves quantities untouched', async () => {
    const db = getDb();
    const produtoId = `p${randomUUID().replace(/-/g, '')}`;
    const depositoId = 'dep1';
    const ref = estoqueRef(db, produtoId, depositoId);

    // Stock it first via a movement, then set the localização.
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
    await aplicarLocalizacao(
      db,
      { op: 'localizacao', produtoId, depositoId, localizacao: 'B2' },
      2,
    );

    const data = (await ref.get()).data() as EstoqueDoc;
    expect(data.quantidade).toBe(5); // untouched by the localização write
    expect(data.localizacao).toBe('B2');
    // Updating an existing doc touches ONLY localizacao — no ultimaModificacao bump
    // (the movement at now=1 set it; the localização write at now=2 must not move it).
    expect(data.ultimaModificacao).toBe(1);
  });
});
