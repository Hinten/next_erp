import { describe, expect, it } from 'vitest';

import { FakeDb, asDb } from '../testing/fakeDb';
import {
  TOKEN_A,
  TOKEN_B,
  caminhoConta,
  loggerEspiao,
  seedConta,
  seedCredencial,
} from '../testing/fixtures';
import { fingerprintDoToken } from './credencial';
import { contaComOMesmoToken, lerContaLojaIntegrada, listarContasLojaIntegrada } from './contas';

describe('lerContaLojaIntegrada (uncached)', () => {
  it('a tipo-3 conta, active or not', async () => {
    const db = new FakeDb();
    seedConta(db, 'a', { ativo: false });
    expect(await lerContaLojaIntegrada(asDb(db), 'a')).toMatchObject({ tipo: 3, ativo: false });
  });

  it('near-miss: tipo 5 and a missing conta are both null', async () => {
    const db = new FakeDb();
    seedConta(db, 'shopee', { tipo: 5 });
    expect(await lerContaLojaIntegrada(asDb(db), 'shopee')).toBeNull();
    expect(await lerContaLojaIntegrada(asDb(db), 'nada')).toBeNull();
  });

  it('reads Firestore every time (never the cache)', async () => {
    const db = new FakeDb();
    seedConta(db, 'a');
    await lerContaLojaIntegrada(asDb(db), 'a');
    await lerContaLojaIntegrada(asDb(db), 'a');
    expect(db.leituras.filter((p) => p === caminhoConta('a'))).toHaveLength(2);
  });
});

describe('listarContasLojaIntegrada', () => {
  it('every tipo-3 conta, active or not, ordered by nome, on the declared (tipo, nome) query', async () => {
    const db = new FakeDb();
    seedConta(db, 'b', { nome: 'Beta', ativo: false });
    seedConta(db, 'a', { nome: 'Alfa' });
    seedConta(db, 's', { nome: 'Shopee', tipo: 5 });
    expect(await listarContasLojaIntegrada(asDb(db))).toEqual([
      { integracaoId: 'a', nome: 'Alfa', ativo: true },
      { integracaoId: 'b', nome: 'Beta', ativo: false },
    ]);
    expect(db.consultas).toEqual([
      {
        colecao: 'integracao',
        filtros: [['tipo', '==', 3]],
        ordens: [['nome', 'asc']],
        limite: null,
        apos: null,
      },
    ]);
  });
});

describe('contaComOMesmoToken (the wrong-store guard)', () => {
  it('another ACTIVE conta holding the token → its id', async () => {
    const db = new FakeDb();
    seedConta(db, 'a');
    seedConta(db, 'b');
    seedCredencial(db, 'b', { personalToken: TOKEN_A });
    expect(await contaComOMesmoToken(asDb(db), 'a', TOKEN_A)).toBe('b');
  });

  it('another INACTIVE conta holding the token → its id too', async () => {
    const db = new FakeDb();
    seedConta(db, 'a');
    seedConta(db, 'b', { ativo: false });
    seedCredencial(db, 'b', { personalToken: TOKEN_A });
    expect(await contaComOMesmoToken(asDb(db), 'a', TOKEN_A)).toBe('b');
  });

  it('near-miss: the token re-saved on the SAME conta → null (never compares a conta with itself)', async () => {
    const db = new FakeDb();
    seedConta(db, 'a');
    seedCredencial(db, 'a', { personalToken: TOKEN_A });
    seedConta(db, 'b');
    seedCredencial(db, 'b', { personalToken: TOKEN_B });
    expect(await contaComOMesmoToken(asDb(db), 'a', TOKEN_A)).toBeNull();
  });

  it('compares a fingerprint DERIVED from the stored token, never the stored field', async () => {
    const db = new FakeDb();
    seedConta(db, 'a');
    seedConta(db, 'b');
    // b's stored field lies, claiming TOKEN_A's fingerprint while holding TOKEN_B.
    seedCredencial(db, 'b', {
      personalToken: TOKEN_B,
      tokenFingerprint: fingerprintDoToken(TOKEN_A),
    });
    expect(await contaComOMesmoToken(asDb(db), 'a', TOKEN_A)).toBeNull();
    expect(await contaComOMesmoToken(asDb(db), 'a', TOKEN_B)).toBe('b');
  });

  it('skips a conta with no credential, and one with a CORRUPT credential (logged by id, no token)', async () => {
    const db = new FakeDb();
    seedConta(db, 'a');
    seedConta(db, 'b');
    seedConta(db, 'c');
    seedCredencial(db, 'c', { personalToken: TOKEN_A, tokenExpiraEmMs: 'quebrado' });
    const { logger, chamadas } = loggerEspiao();
    expect(await contaComOMesmoToken(asDb(db), 'a', TOKEN_A, { logger })).toBeNull();
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]?.[1]).toMatchObject({ integracaoId: 'c', campos: ['tokenExpiraEmMs'] });
    expect(JSON.stringify(chamadas)).not.toContain(TOKEN_A);
  });

  it('a Firestore failure on another conta propagates', async () => {
    const db = new FakeDb();
    seedConta(db, 'a');
    seedConta(db, 'b');
    db.falharLeitura(
      'integracao/b/credenciaisLojaIntegrada/current',
      Object.assign(new Error('UNAVAILABLE'), { code: 14 }),
    );
    await expect(contaComOMesmoToken(asDb(db), 'a', TOKEN_A)).rejects.toMatchObject({ code: 14 });
  });
});
