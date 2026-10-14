/**
 * #1888: the ML binding against the named Firestore emulator through the production accessor.
 * These tests prove persistence and transaction behavior, not Enterprise index scan performance.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { getAdminFirestore } from '@/lib/firebase/admin';

import { buscarIntFreteDaConta, reconciliarIntFreteDaConta } from './intFreteSync';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const CADASTRO = 1_700_000_000_000;
const FILIAL = 'documents/filiais/frete-1888';
const cleanup: string[] = [];

function newContaId() {
  const id = 'frete1888-' + randomUUID();
  cleanup.push('integracao/' + id, 'int_frete/mercadoLivre-' + id);
  return id;
}

function conta(over: Record<string, unknown> = {}) {
  return {
    tipo: 1,
    nome: 'ML freight emulator store',
    ativo: true,
    filialIntegracaoPedidoOuterRef: FILIAL,
    dataCadastro: CADASTRO,
    ...over,
  };
}

function frete(integracaoId: string, over: Record<string, unknown> = {}) {
  return {
    tipo: 'mercadoLivre',
    nome: 'ML freight emulator store',
    ativo: true,
    filialIntegracaoFreteOuterRef: FILIAL,
    contaMercadoLivreMercadoEnviosOuterRef: 'documents/integracao/' + integracaoId,
    dataCadastro: CADASTRO,
    ...over,
  };
}

afterEach(async () => {
  if (!EMULATED || cleanup.length === 0) return;
  const db = getAdminFirestore();
  const batch = db.batch();
  for (const docPath of cleanup.splice(0)) batch.delete(db.doc(docPath));
  await batch.commit();
});

describe.skipIf(!EMULATED)('ML freight current-state reconciliation (Firestore emulator)', () => {
  it('creates once, persists schema defaults and produces an unchanged second pass', async () => {
    const db = getAdminFirestore();
    const id = newContaId();
    await db.collection('integracao').doc(id).set(conta());

    const first = await reconciliarIntFreteDaConta(db, id);
    expect(first).toMatchObject({ action: 'criado', intFreteId: 'mercadoLivre-' + id });
    const freightRef = db.collection('int_frete').doc(first.intFreteId!);
    const saved = await freightRef.get();
    expect(saved.exists).toBe(true);
    expect(saved.data()).toMatchObject({
      ...frete(id),
      prazoExtra: 0,
      enderecoDeOrigem: null,
    });
    expect(saved.data()!.ultimaModificacao).toEqual(expect.any(Number));
    expect(await buscarIntFreteDaConta(db, id)).toMatchObject({ id: first.intFreteId });

    expect(await reconciliarIntFreteDaConta(db, id)).toEqual({
      action: 'inalterado',
      intFreteId: first.intFreteId,
    });
    expect((await freightRef.get()).updateTime!.isEqual(saved.updateTime!)).toBe(true);
  });

  it('adopts a bare legacy reference and preserves its ID and configuration', async () => {
    const db = getAdminFirestore();
    const id = newContaId();
    const legacyId = 'historical-' + id;
    cleanup.push('int_frete/' + legacyId);
    const config = {
      enderecoDeOrigem: { cep: '01001000' },
      horarioDeCorte: [{ diaDaSemana: 1 }],
      mapa: { personalizado: true },
      faixaCep: ['01000'],
      prazoExtra: 3,
    };
    await db.collection('integracao').doc(id).set(conta({ nome: 'Current store' }));
    await db
      .collection('int_frete')
      .doc(legacyId)
      .set(
        frete(id, {
          ...config,
          ativo: false,
          contaMercadoLivreMercadoEnviosOuterRef: 'integracao/' + id,
          ultimaModificacao: CADASTRO + 9_000_000_000_000,
        }),
      );

    expect(await buscarIntFreteDaConta(db, id)).toMatchObject({ id: legacyId });
    expect(await reconciliarIntFreteDaConta(db, id)).toMatchObject({
      action: 'atualizado',
      intFreteId: legacyId,
    });
    const saved = await db.collection('int_frete').doc(legacyId).get();
    expect(saved.exists).toBe(true);
    expect(saved.data()).toMatchObject({ ...frete(id), ...config, nome: 'Current store' });
    expect((await db.collection('int_frete').doc('mercadoLivre-' + id).get()).exists).toBe(false);
    expect(await reconciliarIntFreteDaConta(db, id)).toEqual({
      action: 'inalterado',
      intFreteId: legacyId,
    });
  });

  it('deactivates a retyped or deleted account and reactivates current ML state', async () => {
    const db = getAdminFirestore();
    const id = newContaId();
    const accountRef = db.collection('integracao').doc(id);
    const freightRef = db.collection('int_frete').doc('mercadoLivre-' + id);
    await accountRef.set(conta());
    await reconciliarIntFreteDaConta(db, id);
    expect((await freightRef.get()).exists).toBe(true);

    await accountRef.update({ tipo: 5 });
    expect((await reconciliarIntFreteDaConta(db, id)).action).toBe('desativado');
    expect((await freightRef.get()).data()!.ativo).toBe(false);
    await accountRef.update({ tipo: 1 });
    expect((await reconciliarIntFreteDaConta(db, id)).action).toBe('atualizado');
    expect((await freightRef.get()).data()!.ativo).toBe(true);
    await accountRef.delete();
    expect((await reconciliarIntFreteDaConta(db, id)).action).toBe('desativado');
    expect((await freightRef.get()).exists).toBe(true);
    expect((await freightRef.get()).data()!.ativo).toBe(false);
  });

  it('concurrent first calls create one deterministic freight record', async () => {
    const db = getAdminFirestore();
    const id = newContaId();
    await db.collection('integracao').doc(id).set(conta());

    const results = await Promise.all([
      reconciliarIntFreteDaConta(db, id),
      reconciliarIntFreteDaConta(db, id),
    ]);
    expect(results.map((result) => result.action).sort()).toEqual(['criado', 'inalterado']);
    const saved = await db
      .collection('int_frete')
      .where('tipo', '==', 'mercadoLivre')
      .where('contaMercadoLivreMercadoEnviosOuterRef', '==', 'documents/integracao/' + id)
      .get();
    expect(saved.docs.map((doc) => doc.id)).toEqual(['mercadoLivre-' + id]);
    expect(saved.docs[0]!.data()).toMatchObject(frete(id));
  });
});
