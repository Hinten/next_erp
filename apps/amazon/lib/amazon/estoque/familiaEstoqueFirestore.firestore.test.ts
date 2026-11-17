/**
 * The stock family read on a REAL Firestore — the emulator of `ci-amazon.yml`,
 * not the in-memory fake (step 12, PR 12-e1). The offline suite counts every
 * read against `testing/fakeDb.ts`; this file proves, on the real server, what
 * only holds if the server behaves as the fake says:
 *
 *  - a kit whose component rows are stored with `parentId: null` (or none)
 *    still publishes the quantity its components constrain: each component's
 *    produto is taken from the row's PATH;
 *  - two kits sharing a component read its estoque row ONCE, in one `getAll`
 *    of every canonical row (the `getAll` calls are spied, never replaced);
 *  - the masks: a unit's `getAll` and an estoque row's answer only the listed
 *    fields, and the partition listing's classic `select` does the same and
 *    finds a legacy auto-id row in the bare ref form.
 *
 * Reads only: no write of the code under test, no network, no task (nothing
 * here reaches a client).
 *
 * ⚠️ The emulator is SHARED: every document id here starts with
 * `e2e-estoque-familia-`, which no other suite seeds; no `integracao` document
 * is written, so the conta trigger never fires, and `produtos` and their
 * `estoques` are no trigger path. Every case wipes what it seeds first, and the
 * file leaves nothing behind.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEstoqueUid } from '@delfrance/schemas';

import { getAdminFirestore } from '@/lib/firebase/admin';

import { quantidadeEstoqueAmazon } from './familiaEstoque';
import { lerFamiliaEstoqueAmazon, lerFamiliasEstoqueAmazon } from './familiaEstoqueFirestore';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const P = 'e2e-estoque-familia-';
const DEP = `${P}dep`;
const REF_DEP = `documents/depositos/${DEP}`;

function db(): Firestore {
  return getAdminFirestore();
}

/** Every path this file may seed, so each case starts clean and the file ends clean. */
const CAMINHOS: string[] = [];

async function semear(caminho: string, dados: Record<string, unknown>): Promise<void> {
  if (!CAMINHOS.includes(caminho)) CAMINHOS.push(caminho);
  await db().doc(caminho).set(dados);
}

async function limpar(): Promise<void> {
  await Promise.all(CAMINHOS.map((c) => db().doc(c).delete()));
}

const produto = (id: string, dados: Record<string, unknown> = {}) =>
  semear(`produtos/${P}${id}`, { nome: `Produto ${id}`, precos: { varejo: 10 }, ...dados });

/** A row at the canonical id of `id` at this file's depósito. */
const estoque = (id: string, dados: Record<string, unknown> = {}) =>
  semear(`produtos/${P}${id}/estoques/${makeEstoqueUid(`${P}${id}`, DEP)}`, {
    depositoOuterRef: REF_DEP,
    historico: ['nunca lido'],
    ...dados,
  });

async function quantidadeDe(id: string): Promise<number | null> {
  const membro = await lerFamiliaEstoqueAmazon(db(), `${P}${id}`, DEP);
  return membro === null ? null : quantidadeEstoqueAmazon(membro);
}

describe.skipIf(!EMULATED)('the stock family read on real Firestore (emulator)', () => {
  beforeEach(async () => {
    await limpar();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await limpar();
  });

  it('★ a kit whose component rows carry parentId null (or none) still publishes the constrained quantity', async () => {
    await produto('K', {
      ehKit: true,
      componentesKit: { [`${P}A`]: { quantidade: 2 }, [`${P}B`]: { quantidade: 1 } },
    });
    await estoque('K', { quantidade: 3, parentId: `${P}K` });
    await estoque('A', { quantidade: 9, parentId: null });
    await estoque('B', { quantidade: 5 });
    // Positive first: the unit exists and its own row was found.
    const membro = await lerFamiliaEstoqueAmazon(db(), `${P}K`, DEP);
    expect(membro?.estoque?.quantidade).toBe(3);
    expect(membro !== null && quantidadeEstoqueAmazon(membro)).toBe(4);
    // NEAR-MISS: a missing component floors the kit to 0 (the core's rule).
    await db()
      .doc(`produtos/${P}B/estoques/${makeEstoqueUid(`${P}B`, DEP)}`)
      .delete();
    expect(await quantidadeDe('K')).toBe(0);
  });

  it('★ two kits sharing a component read its estoque ONCE: one getAll of every canonical row', async () => {
    await produto('K1', {
      ehKit: true,
      componentesKit: { [`${P}A`]: { quantidade: 2 }, [`${P}B`]: { quantidade: 1 } },
    });
    await produto('K2', { ehKit: true, componentesKit: { [`${P}A`]: { quantidade: 3 } } });
    await estoque('K1', { quantidade: 1 });
    await estoque('K2', { quantidade: 1 });
    await estoque('A', { quantidade: 9 });
    await estoque('B', { quantidade: 5 });
    const getAll = vi.spyOn(db(), 'getAll');

    const lidas = await lerFamiliasEstoqueAmazon(db(), {
      unidadeIds: [`${P}K1`, `${P}K2`],
      depositoId: DEP,
    });
    expect(quantidadeEstoqueAmazon(lidas.get(`${P}K1`)!)).toBe(4);
    expect(quantidadeEstoqueAmazon(lidas.get(`${P}K2`)!)).toBe(3);
    const caminhos = getAll.mock.calls.map((args) =>
      args
        .filter((a) => typeof a === 'object' && a !== null && 'path' in a)
        .map((a) => (a as { path: string }).path),
    );
    expect(caminhos).toHaveLength(2);
    const caminhoA = `produtos/${P}A/estoques/${makeEstoqueUid(`${P}A`, DEP)}`;
    expect(caminhos.flat().filter((c) => c === caminhoA)).toHaveLength(1);
  });

  it('two kits sharing a component with NO canonical row — only a legacy auto-id row — both publish the quantity it constrains', async () => {
    await produto('K3', {
      ehKit: true,
      componentesKit: { [`${P}C`]: { quantidade: 2 }, [`${P}B`]: { quantidade: 1 } },
    });
    await produto('K4', { ehKit: true, componentesKit: { [`${P}C`]: { quantidade: 3 } } });
    await estoque('K3', { quantidade: 1 });
    await estoque('K4', { quantidade: 1 });
    await estoque('B', { quantidade: 5 });
    await semear(`produtos/${P}C/estoques/${P}auto-legado`, {
      depositoOuterRef: `depositos/${DEP}`,
      quantidade: 9,
    });
    const lidas = await lerFamiliasEstoqueAmazon(db(), {
      unidadeIds: [`${P}K3`, `${P}K4`],
      depositoId: DEP,
    });
    expect(quantidadeEstoqueAmazon(lidas.get(`${P}K3`)!)).toBe(4);
    expect(quantidadeEstoqueAmazon(lidas.get(`${P}K4`)!)).toBe(3);
  });

  it('the masks: the unit and the row answer only the listed fields', async () => {
    await produto('S', { ehKit: false });
    await estoque('S', { quantidade: 10, quantidadeReservada: 4, parentId: `${P}S` });
    const membro = await lerFamiliaEstoqueAmazon(db(), `${P}S`, DEP);
    expect(membro?.estoque).toEqual({
      depositoOuterRef: REF_DEP,
      quantidade: 10,
      quantidadeReservada: 4,
      estoqueDocId: makeEstoqueUid(`${P}S`, DEP),
    });
    expect(membro !== null && quantidadeEstoqueAmazon(membro)).toBe(6);
  });

  it('a legacy auto-id row in the bare ref form is found through the projected partition listing; another depósito’s is not', async () => {
    await produto('L');
    await semear(`produtos/${P}L/estoques/${P}auto-2`, {
      depositoOuterRef: `depositos/${P}outro`,
      quantidade: 50,
    });
    await semear(`produtos/${P}L/estoques/${P}auto-1`, {
      depositoOuterRef: `depositos/${DEP}`,
      quantidade: 6,
      historico: ['nunca lido'],
    });
    const membro = await lerFamiliaEstoqueAmazon(db(), `${P}L`, DEP);
    expect(membro?.estoque).toEqual({
      depositoOuterRef: `depositos/${DEP}`,
      quantidade: 6,
      estoqueDocId: `${P}auto-1`,
    });
    expect(membro !== null && quantidadeEstoqueAmazon(membro)).toBe(6);
  });

  it('a unit whose produto does not exist answers null (unidade-ausente), never a 0', async () => {
    await produto('VIVO');
    await estoque('VIVO', { quantidade: 2 });
    await estoque('SUMIDO', { quantidade: 7 });
    const lidas = await lerFamiliasEstoqueAmazon(db(), {
      unidadeIds: [`${P}VIVO`, `${P}SUMIDO`],
      depositoId: DEP,
    });
    // Positive first: the live unit was read on this database.
    expect(quantidadeEstoqueAmazon(lidas.get(`${P}VIVO`)!)).toBe(2);
    expect(lidas.get(`${P}SUMIDO`)).toBeNull();
  });
});
