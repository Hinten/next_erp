import { beforeEach, describe, expect, it } from 'vitest';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';

import { relogioDoDocumentoUs } from '../avisos/avisos';
import { FakeDb, asDb } from '../testing/fakeDb';
import { SPID_A, SPID_B, caminhoConta, seedConta } from '../testing/fixtures';
import {
  contasPorSellingPartnerId,
  idDeContaValido,
  lerContaAmazon,
  listarContasAmazon,
} from './contas';

let db: FakeDb;

beforeEach(() => {
  db = new FakeDb();
});

describe('idDeContaValido', () => {
  it.each(['abc', 'AbC_09-x', 'a'.repeat(128), 'Xy3kP0q9RZ2LmNbV7tWc'])('accepts %j', (id) => {
    expect(idDeContaValido(id)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['a slash', 'a/b'],
    ['a dot', 'a.b'],
    ['dot-dot', '..'],
    ['a space', 'a b'],
    ['too long', 'a'.repeat(129)],
    ['non-ASCII', 'conta-é'],
    ['a number', 123],
    ['undefined', undefined],
  ])('refuses %s', (_c, id) => {
    expect(idDeContaValido(id)).toBe(false);
  });
});

describe('lerContaAmazon', () => {
  it('reads an Amazon conta uncached, with its updateTime', async () => {
    const carimbo = seedConta(db, 'c1', { ativo: false });
    const lida = await lerContaAmazon(asDb(db), 'c1');
    expect(lida?.conta.tipo).toBe(INTEGRACAO_TIPO.amazon);
    // An INACTIVE conta is still read: it must stay connectable.
    expect(lida?.conta.ativo).toBe(false);
    expect(lida?.updateTime.isEqual(carimbo as never)).toBe(true);
    expect(db.leituras).toEqual([caminhoConta('c1')]);
  });

  it('answers null for a missing conta and for another tipo', async () => {
    expect(await lerContaAmazon(asDb(db), 'nao-existe')).toBeNull();
    seedConta(db, 'shopee', { tipo: INTEGRACAO_TIPO.shopee });
    expect(await lerContaAmazon(asDb(db), 'shopee')).toBeNull();
  });
});

describe('contasPorSellingPartnerId', () => {
  it('runs EXACTLY the PR-r index shape: tipo, selling_partner_id, ativo — limit 2', async () => {
    await contasPorSellingPartnerId(asDb(db), SPID_A);
    expect(db.consultas).toEqual([
      {
        colecao: 'integracao',
        filtros: [
          ['tipo', INTEGRACAO_TIPO.amazon],
          ['selling_partner_id', SPID_A],
          ['ativo', true],
        ],
        ordens: [],
        limite: 2,
        apos: null,
      },
    ]);
  });

  it('finds active holders only, of tipo 8 only, at most two', async () => {
    seedConta(db, 'a1', { selling_partner_id: SPID_A });
    seedConta(db, 'a2', { selling_partner_id: SPID_A });
    seedConta(db, 'a3', { selling_partner_id: SPID_A });
    seedConta(db, 'inativa', { selling_partner_id: SPID_A, ativo: false });
    seedConta(db, 'shopee', { selling_partner_id: SPID_A, tipo: INTEGRACAO_TIPO.shopee });
    seedConta(db, 'outro', { selling_partner_id: SPID_B });
    const ids = await contasPorSellingPartnerId(asDb(db), SPID_A);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(['a1', 'a2', 'a3']).toContain(id);
  });

  it('compares EXACTLY — a case-folded id is a different seller (near-miss)', async () => {
    seedConta(db, 'a1', { selling_partner_id: SPID_A });
    expect(await contasPorSellingPartnerId(asDb(db), SPID_A.toLowerCase())).toEqual([]);
    expect(await contasPorSellingPartnerId(asDb(db), ` ${SPID_A}`)).toEqual([]);
  });
});

describe('listarContasAmazon', () => {
  it('runs EXACTLY the (tipo, nome) shape and lists active AND inactive contas by nome', async () => {
    seedConta(db, 'z', { nome: 'Zeta' });
    seedConta(db, 'a', { nome: 'Alfa', ativo: false });
    seedConta(db, 'shopee', { nome: 'Beta', tipo: INTEGRACAO_TIPO.shopee });
    const { contas, leituraUs } = await listarContasAmazon(asDb(db));
    expect(contas).toEqual([
      { integracaoId: 'a', nome: 'Alfa', ativo: false },
      { integracaoId: 'z', nome: 'Zeta', ativo: true },
    ]);
    expect(db.consultas[0]).toMatchObject({
      filtros: [['tipo', INTEGRACAO_TIPO.amazon]],
      ordens: [['nome', 'asc']],
      limite: null,
    });
    expect(leituraUs).toBeGreaterThan(0);
  });

  it('PINNED: a conta LACKING `nome` falls outside the enumeration (orderBy filters existence)', async () => {
    db.seed(caminhoConta('sem-nome'), { tipo: INTEGRACAO_TIPO.amazon, ativo: true });
    seedConta(db, 'com-nome');
    const { contas } = await listarContasAmazon(asDb(db));
    expect(contas.map((c) => c.integracaoId)).toEqual(['com-nome']);
  });

  it('a non-string nome reads as "" (a malformed legacy row), never a crash', async () => {
    db.seed(caminhoConta('nulo'), { tipo: INTEGRACAO_TIPO.amazon, nome: null, ativo: true });
    const { contas } = await listarContasAmazon(asDb(db));
    expect(contas).toEqual([{ integracaoId: 'nulo', nome: '', ativo: true }]);
  });

  it('leituraUs is the query readTime in µs: a later write is stamped after it', async () => {
    const { leituraUs } = await listarContasAmazon(asDb(db));
    const depois = seedConta(db, 'nova');
    expect(relogioDoDocumentoUs(depois)).toBeGreaterThan(leituraUs);
  });
});
