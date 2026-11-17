/**
 * The stock family read (step 12, PR 12-e1), offline against the counting fake
 * db: what it reads, masked to what, in how many calls, and that what it hands
 * the pure family model gives the quantity the core computes. The emulator
 * suite (`familiaEstoqueFirestore.firestore.test.ts`) proves the same reads on
 * a real server.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { makeEstoqueUid } from '@delfrance/schemas';

import { FakeDb, asDb } from '../testing/fakeDb';
import {
  CAMPOS_LINHA_ESTOQUE_AMAZON,
  CAMPOS_UNIDADE_ESTOQUE_AMAZON,
  quantidadeEstoqueAmazon,
} from './familiaEstoque';
import {
  LARGURA_PARTICOES_ESTOQUE_AMAZON,
  MAX_REFS_GETALL_ESTOQUE_AMAZON,
  lerFamiliaEstoqueAmazon,
  lerFamiliasEstoqueAmazon,
  lerMembrosEstoqueAmazon,
} from './familiaEstoqueFirestore';

const DEP = 'dep-1';
const REF_DEP = `documents/depositos/${DEP}`;

let db: FakeDb;

beforeEach(() => {
  db = new FakeDb();
  // Every read of a produto or an estoque row must be masked.
  db.exigirMascaraEm('produtos');
  db.exigirMascaraEm('estoques');
});

const produto = (id: string, dados: Record<string, unknown> = {}) =>
  db.seed(`produtos/${id}`, { nome: `Produto ${id}`, precos: { varejo: 10 }, ...dados });

/** A row at the canonical id of `produtoId` at the conta's depósito. */
const estoque = (produtoId: string, dados: Record<string, unknown> = {}) =>
  db.seed(`produtos/${produtoId}/estoques/${makeEstoqueUid(produtoId, DEP)}`, {
    depositoOuterRef: REF_DEP,
    parentId: produtoId,
    historico: ['nunca lido'],
    ...dados,
  });

const ler = (unidadeIds: string[]) =>
  lerFamiliasEstoqueAmazon(asDb(db), { unidadeIds, depositoId: DEP });

async function quantidadeDe(unidadeId: string): Promise<number | null> {
  const membro = await lerFamiliaEstoqueAmazon(asDb(db), unidadeId, DEP);
  return membro === null ? null : quantidadeEstoqueAmazon(membro);
}

/** Every document path read, as often as it was read. */
const lidos = () => db.leiturasDetalhadas.map((l) => l.caminho);

describe('the reads and their masks', () => {
  it('a simple produto: ONE getAll for the unit, ONE for its canonical row, each masked; no query', async () => {
    produto('P');
    estoque('P', { quantidade: 10, quantidadeReservada: 3 });
    expect(await quantidadeDe('P')).toBe(7);
    expect(db.contagem).toEqual({ leituras: 2, chamadasGetAll: 2, consultas: 0, escritas: 0 });
    expect(db.leiturasDetalhadas).toEqual([
      {
        caminho: 'produtos/P',
        via: 'getAll',
        chamada: 1,
        mascara: [...CAMPOS_UNIDADE_ESTOQUE_AMAZON],
      },
      {
        caminho: `produtos/P/estoques/${makeEstoqueUid('P', DEP)}`,
        via: 'getAll',
        chamada: 2,
        mascara: [...CAMPOS_LINHA_ESTOQUE_AMAZON],
      },
    ]);
  });

  it('★ the masks carry exactly what the family model reads: a masked read gives the quantity a whole read gives', async () => {
    produto('K', { ehKit: true, componentesKit: { A: { quantidade: 2 }, B: { quantidade: 1 } } });
    estoque('K', { quantidade: 3 });
    estoque('A', { quantidade: 9 });
    estoque('B', { quantidade: 5 });
    const membro = await lerFamiliaEstoqueAmazon(asDb(db), 'K', DEP);
    expect(membro?.estoque).toEqual({
      depositoOuterRef: REF_DEP,
      quantidade: 3,
      estoqueDocId: makeEstoqueUid('K', DEP),
    });
    expect(membro !== null && quantidadeEstoqueAmazon(membro)).toBe(4);
  });

  it('a unit whose produto does not exist answers null (unidade-ausente), never a 0, and reads no row', async () => {
    estoque('X', { quantidade: 10 });
    const lidas = await ler(['X']);
    expect([...lidas.entries()]).toEqual([['X', null]]);
    expect(lidos()).toEqual(['produtos/X']);
    expect(db.contagem.consultas).toBe(0);
  });

  it('a unit with no row at the depósito: its canonical id read, then ONE listing of its partition; estoque null (reads 0)', async () => {
    produto('P');
    db.seed('produtos/P/estoques/auto-1', {
      depositoOuterRef: 'documents/depositos/outro',
      quantidade: 8,
    });
    const membro = await lerFamiliaEstoqueAmazon(asDb(db), 'P', DEP);
    expect(membro?.estoque).toBeNull();
    expect(membro !== null && quantidadeEstoqueAmazon(membro)).toBe(0);
    expect(db.consultas).toEqual([
      {
        colecao: 'produtos/P/estoques',
        filtros: [],
        ordens: [],
        limite: null,
        apos: null,
        selecao: [...CAMPOS_LINHA_ESTOQUE_AMAZON],
      },
    ]);
  });

  it('a legacy auto-id row at the depósito (the bare ref form) is found through the partition listing', async () => {
    produto('P');
    db.seed('produtos/P/estoques/auto-1', { depositoOuterRef: `depositos/${DEP}`, quantidade: 6 });
    expect(await quantidadeDe('P')).toBe(6);
  });

  it('NEAR-MISS: a produto WITH its canonical row lists no partition', async () => {
    produto('P');
    estoque('P', { quantidade: 2 });
    db.seed('produtos/P/estoques/auto-1', { depositoOuterRef: REF_DEP, quantidade: 50 });
    expect(await quantidadeDe('P')).toBe(2);
    expect(db.contagem.consultas).toBe(0);
  });
});

describe('★ kits: components from the PATH, read once', () => {
  const KIT = { A: { quantidade: 2 }, B: { quantidade: 1 } };

  it('★ a kit whose component rows carry parentId null (or none) still publishes the constrained quantity', async () => {
    produto('K', { ehKit: true, componentesKit: KIT });
    estoque('K', { quantidade: 3 });
    estoque('A', { quantidade: 9, parentId: null });
    db.seed(`produtos/B/estoques/${makeEstoqueUid('B', DEP)}`, {
      depositoOuterRef: REF_DEP,
      quantidade: 5,
    });
    expect(await quantidadeDe('K')).toBe(4);
  });

  it('★ two kits sharing a component read its estoque ONCE (one getAll of every canonical row)', async () => {
    produto('K1', { ehKit: true, componentesKit: { A: { quantidade: 2 }, B: { quantidade: 1 } } });
    produto('K2', { ehKit: true, componentesKit: { A: { quantidade: 3 } } });
    estoque('K1', { quantidade: 1 });
    estoque('K2', { quantidade: 1 });
    estoque('A', { quantidade: 9 });
    estoque('B', { quantidade: 5 });
    const lidas = await ler(['K1', 'K2']);
    expect(quantidadeEstoqueAmazon(lidas.get('K1')!)).toBe(4);
    expect(quantidadeEstoqueAmazon(lidas.get('K2')!)).toBe(3);
    const caminhoA = `produtos/A/estoques/${makeEstoqueUid('A', DEP)}`;
    expect(lidos().filter((c) => c === caminhoA)).toHaveLength(1);
    // Two calls in all: the units, then every canonical row (own and components) at once.
    expect(db.contagem).toEqual({ leituras: 6, chamadasGetAll: 2, consultas: 0, escritas: 0 });
  });

  it('★ two kits sharing a component with NO canonical row (only a legacy auto-id row) list its partition ONCE', async () => {
    produto('K1', { ehKit: true, componentesKit: { A: { quantidade: 2 }, B: { quantidade: 1 } } });
    produto('K2', { ehKit: true, componentesKit: { A: { quantidade: 3 } } });
    estoque('K1', { quantidade: 1 });
    estoque('K2', { quantidade: 1 });
    estoque('B', { quantidade: 5 });
    db.seed('produtos/A/estoques/auto-legado', {
      depositoOuterRef: `depositos/${DEP}`,
      quantidade: 9,
    });
    const lidas = await ler(['K1', 'K2']);
    expect(quantidadeEstoqueAmazon(lidas.get('K1')!)).toBe(4);
    expect(quantidadeEstoqueAmazon(lidas.get('K2')!)).toBe(3);
    expect(db.consultas.map((c) => c.colecao)).toEqual(['produtos/A/estoques']);
  });

  it('NEAR-MISS: a component that is also a unit of the same call is still one read', async () => {
    produto('K', { ehKit: true, componentesKit: { A: { quantidade: 2 } } });
    produto('A');
    estoque('K', { quantidade: 0 });
    estoque('A', { quantidade: 8 });
    const lidas = await ler(['K', 'A']);
    expect(quantidadeEstoqueAmazon(lidas.get('K')!)).toBe(4);
    expect(quantidadeEstoqueAmazon(lidas.get('A')!)).toBe(8);
    expect(db.contagem.leituras).toBe(4);
  });

  it('a missing component (no row anywhere) counts 0 and floors the kit (the core’s rule), after one partition listing', async () => {
    produto('K', { ehKit: true, componentesKit: KIT });
    estoque('K', { quantidade: 3 });
    estoque('A', { quantidade: 9 });
    expect(await quantidadeDe('K')).toBe(0);
    expect(db.consultas.map((c) => c.colecao)).toEqual(['produtos/B/estoques']);
  });

  it('NEAR-MISS: a produto the core does not treat as a kit reads no component, whatever componentesKit it carries', async () => {
    produto('P', { ehKit: false, componentesKit: KIT });
    estoque('P', { quantidade: 4 });
    estoque('A', { quantidade: 9 });
    expect(await quantidadeDe('P')).toBe(4);
    expect(lidos()).toEqual(['produtos/P', `produtos/P/estoques/${makeEstoqueUid('P', DEP)}`]);
  });

  it('a virtual kit is folded as a kit: its components are read', async () => {
    produto('V', { ehKitVirtual: true, componentesKit: { A: { quantidade: 2 } } });
    estoque('V', { quantidade: 100 });
    estoque('A', { quantidade: 7 });
    expect(await quantidadeDe('V')).toBe(3);
  });

  it('a component key that is not a document id is never read (the core counts it missing)', async () => {
    produto('K', {
      ehKit: true,
      componentesKit: { 'a/b': { quantidade: 1 }, A: { quantidade: 1 } },
    });
    estoque('K', { quantidade: 3 });
    estoque('A', { quantidade: 9 });
    expect(await quantidadeDe('K')).toBe(0);
    expect(lidos().some((c) => c.includes('a/b'))).toBe(false);
  });
});

describe('the batching', () => {
  it('units are read in getAll calls of at most 300 refs', async () => {
    const ids = Array.from({ length: 301 }, (_, i) => `P${String(i)}`);
    for (const id of ids) {
      produto(id);
      estoque(id, { quantidade: 1 });
    }
    const lidas = await ler(ids);
    expect(lidas.size).toBe(301);
    expect(MAX_REFS_GETALL_ESTOQUE_AMAZON).toBe(300);
    const porChamada = new Map<number, number>();
    for (const l of db.leiturasDetalhadas) {
      porChamada.set(l.chamada ?? 0, (porChamada.get(l.chamada ?? 0) ?? 0) + 1);
    }
    expect([...porChamada.values()]).toEqual([300, 1, 300, 1]);
  });

  it('repeated unit ids are read once', async () => {
    produto('P');
    estoque('P', { quantidade: 1 });
    await ler(['P', 'P', 'P']);
    expect(lidos()).toEqual(['produtos/P', `produtos/P/estoques/${makeEstoqueUid('P', DEP)}`]);
  });

  it('partition listings run at most 16 at once, each produto listed once', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `P${String(i)}`);
    for (const id of ids) produto(id);
    // Every listing held open for a tick, counting how many are in flight.
    let emVoo = 0;
    let maximo = 0;
    const original = db.collection.bind(db);
    type Colecao = ReturnType<FakeDb['collection']>;
    (db as unknown as { collection: (c: string) => Colecao }).collection = (c: string) => {
      const colecao = original(c);
      return {
        ...colecao,
        select: (...campos: unknown[]) => {
          const projetada = colecao.select(...campos);
          return {
            ...projetada,
            get: async () => {
              emVoo += 1;
              maximo = Math.max(maximo, emVoo);
              await new Promise((r) => setTimeout(r, 1));
              emVoo -= 1;
              return projetada.get();
            },
          };
        },
      };
    };
    await ler(ids);
    expect(LARGURA_PARTICOES_ESTOQUE_AMAZON).toBe(16);
    expect(maximo).toBe(16);
    expect(db.consultas.map((c) => c.colecao).sort()).toEqual(
      ids.map((id) => `produtos/${id}/estoques`).sort(),
    );
  });

  it('nothing to read: no unit ⇒ no call', async () => {
    expect((await ler([])).size).toBe(0);
    expect(db.contagem).toEqual({ leituras: 0, chamadasGetAll: 0, consultas: 0, escritas: 0 });
  });

  it.each([
    ['a unit id with a slash', ['a/b'], DEP],
    ['an empty unit id', [''], DEP],
    ['a depósito that is not a document id', ['P'], 'x/y'],
  ])('%s is a RangeError, nothing read', async (_c, unidadeIds, depositoId) => {
    await expect(
      lerFamiliasEstoqueAmazon(asDb(db), { unidadeIds, depositoId }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(db.contagem.leituras).toBe(0);
  });
});

describe('lerMembrosEstoqueAmazon — units the caller already read', () => {
  it('reads ONLY the estoque rows (no produto read) and gives the quantity the full read gives', async () => {
    const componentesKit = { A: { quantidade: 2 }, B: { quantidade: 1 } };
    produto('K', { ehKit: true, componentesKit });
    estoque('K', { quantidade: 3 });
    estoque('A', { quantidade: 9 });
    estoque('B', { quantidade: 5 });
    const membros = await lerMembrosEstoqueAmazon(asDb(db), {
      // The caller's own read, wider than the family's mask.
      unidades: [{ id: 'K', raw: { ehKit: true, componentesKit, paiId: null } }],
      depositoId: DEP,
    });
    expect(quantidadeEstoqueAmazon(membros.get('K')!)).toBe(4);
    expect(lidos().filter((c) => !c.includes('/estoques/'))).toEqual([]);
    expect(db.contagem).toEqual({ leituras: 3, chamadasGetAll: 1, consultas: 0, escritas: 0 });
  });

  it('NEAR-MISS: the full entry reads the unit first — one produto read more', async () => {
    produto('K', { ehKit: true, componentesKit: { A: { quantidade: 2 }, B: { quantidade: 1 } } });
    estoque('K', { quantidade: 3 });
    estoque('A', { quantidade: 9 });
    estoque('B', { quantidade: 5 });
    expect(await quantidadeDe('K')).toBe(4);
    expect(lidos().filter((c) => !c.includes('/estoques/'))).toEqual(['produtos/K']);
  });

  it('a unit given twice is answered once, from its FIRST entry', async () => {
    estoque('P', { quantidade: 4 });
    estoque('A', { quantidade: 1 });
    const membros = await lerMembrosEstoqueAmazon(asDb(db), {
      unidades: [
        { id: 'P', raw: {} },
        { id: 'P', raw: { ehKit: true, componentesKit: { A: { quantidade: 1 } } } },
      ],
      depositoId: DEP,
    });
    expect([...membros.keys()]).toEqual(['P']);
    expect(quantidadeEstoqueAmazon(membros.get('P')!)).toBe(4);
    expect(lidos()).toEqual([`produtos/P/estoques/${makeEstoqueUid('P', DEP)}`]);
  });

  it.each([
    ['a unit id with a slash', 'a/b', DEP],
    ['a depósito that is not a document id', 'P', 'x/y'],
  ])('%s is a RangeError, nothing read', async (_c, id, depositoId) => {
    await expect(
      lerMembrosEstoqueAmazon(asDb(db), { unidades: [{ id, raw: {} }], depositoId }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(db.contagem.leituras).toBe(0);
  });
});
