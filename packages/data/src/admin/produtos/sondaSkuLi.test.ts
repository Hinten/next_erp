import { describe, expect, it } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

import { MAX_VALORES_IN_SONDA_SKU_LI, sondarSkusLi } from './sondaSkuLi';

/* -------------------------------------------------------------------------- */
/*                               fake Firestore                               */
/* -------------------------------------------------------------------------- */
/**
 * The `produtos` half of a Firestore double, just wide enough for the probe: `where(field, 'in',
 * values)`, `select(...)` and `get()`. Every query is recorded, so a test can assert the read
 * COUNT and SHAPE (a probe scoped to roots would add a `paiId` clause).
 *
 * ⚠️ `in` is matched with `===`, so it is TYPE-strict like Firestore: a stored number never
 * matches its decimal string. Any other operator throws, so the double cannot quietly answer a
 * query shape the probe was never meant to issue.
 */
type DocData = Record<string, unknown>;

interface Consulta {
  clausulas: Array<[string, string, unknown]>;
  projecao: string[] | null;
}

class FakeDb {
  readonly produtos = new Map<string, DocData>();
  readonly consultas: Consulta[] = [];

  seed(id: string, data: DocData): this {
    this.produtos.set(id, data);
    return this;
  }

  collection(path: string) {
    if (path !== 'produtos') throw new Error(`coleção inesperada: ${path}`);
    const consulta: Consulta = { clausulas: [], projecao: null };
    const linhas = [...this.produtos.entries()];
    const consultas = this.consultas;
    const q = {
      where(campo: string, op: string, valor: unknown) {
        if (op !== 'in' || !Array.isArray(valor)) throw new Error(`operador inesperado: ${op}`);
        consulta.clausulas.push([campo, op, valor]);
        return q;
      },
      select(...campos: string[]) {
        consulta.projecao = campos;
        return q;
      },
      async get() {
        consultas.push(consulta);
        const hits = linhas.filter(([, d]) =>
          consulta.clausulas.every(([campo, , valor]) => (valor as unknown[]).includes(d[campo])),
        );
        return {
          docs: hits.map(([id, d]) => ({
            id,
            data: () =>
              consulta.projecao === null
                ? d
                : Object.fromEntries(consulta.projecao.map((c) => [c, d[c]])),
          })),
        };
      },
    };
    return q;
  }
}

const asDb = (db: FakeDb) => db as unknown as Firestore;

async function sondar(db: FakeDb, skus: string[]) {
  return sondarSkusLi(asDb(db), skus);
}

/* -------------------------------------------------------------------------- */

describe('sondarSkusLi — exact hits (the whole catalogue, roots and variations alike)', () => {
  it('EQUAL pair: a store variation SKU equal to an ERP ROOT is an exact hit', async () => {
    const db = new FakeDb().seed('raiz-1', { sku: 'X-AZ', paiId: null });
    const r = await sondar(db, ['X-AZ']);
    expect(r.get('X-AZ')).toEqual({ exatos: ['raiz-1'], parecidos: [] });
  });

  it('EQUAL pair: equal to ANOTHER family’s variation is an exact hit too — the probe is never scoped to roots', async () => {
    const db = new FakeDb().seed('filho-de-outra', { sku: 'X-AZ', paiId: 'outra-raiz' });
    const r = await sondar(db, ['X-AZ']);
    expect(r.get('X-AZ')).toEqual({ exatos: ['filho-de-outra'], parecidos: [] });
    // One clause, on `sku` alone: no `paiId` filter anywhere.
    for (const c of db.consultas) expect(c.clausulas.map(([campo]) => campo)).toEqual(['sku']);
  });

  it('EQUAL pair: a derived sole-member SKU equal to an existing produto is an exact hit', async () => {
    const db = new FakeDb().seed('membro', { sku: 'X-UN', paiId: 'x' });
    const r = await sondar(db, ['X', 'X-UN']);
    expect(r.get('X-UN')?.exatos).toEqual(['membro']);
    expect(r.get('X')).toEqual({ exatos: [], parecidos: [] });
  });

  it('two produtos with the SKU are both named, sorted', async () => {
    const db = new FakeDb().seed('b', { sku: 'DUP' }).seed('a', { sku: 'DUP' });
    expect((await sondar(db, ['DUP'])).get('DUP')?.exatos).toEqual(['a', 'b']);
  });
});

describe('sondarSkusLi — the parecido forms', () => {
  it.each([
    ['abc-1', 'ABC-1'],
    ['ABC-1 ', 'ABC-1'],
    [' Abc-1', 'ABC-1'],
    [' abc-1 ', 'abc-1'],
  ])(
    'PARECIDO: store %j against ERP %j is a near duplicate, never an exact hit',
    async (li, erp) => {
      const db = new FakeDb().seed('erp', { sku: erp });
      expect((await sondar(db, [li])).get(li)).toEqual({ exatos: [], parecidos: ['erp'] });
    },
  );

  it('one SKU can have an exact hit AND a near duplicate at once', async () => {
    const db = new FakeDb().seed('igual', { sku: 'abc' }).seed('maiusculo', { sku: 'ABC' });
    expect((await sondar(db, ['abc'])).get('abc')).toEqual({
      exatos: ['igual'],
      parecidos: ['maiusculo'],
    });
  });

  it('each SKU is judged on its own: a produto exact for one is parecido for the other', async () => {
    const db = new FakeDb().seed('p', { sku: 'ABC' });
    const r = await sondar(db, ['abc', 'ABC']);
    expect(r.get('ABC')).toEqual({ exatos: ['p'], parecidos: [] });
    expect(r.get('abc')).toEqual({ exatos: [], parecidos: ['p'] });
  });
});

describe('sondarSkusLi — near-misses and the stated limit', () => {
  it.each([
    ['X-AZ', 'X-AZUL'],
    ['ABC-1', 'ABC-2'],
    ['ABC-1', 'ABC1'],
    ['ABC-1', 'ABC-1-UN'],
    ['ABC-1', 'ABC-1 '],
  ])('⚠️ NEAR-MISS: store %j against ERP %j is NO hit — a create may proceed', async (li, erp) => {
    const db = new FakeDb().seed('erp', { sku: erp });
    expect((await sondar(db, [li])).get(li)).toEqual({ exatos: [], parecidos: [] });
  });

  it('⚠️ NEAR-MISS: a stored NUMBER never matches its decimal string (Firestore equality is type-strict)', async () => {
    const db = new FakeDb().seed('numerico', { sku: 123 });
    expect((await sondar(db, ['123'])).get('123')).toEqual({ exatos: [], parecidos: [] });
  });

  it.each([
    ['abc-1', 'Abc-1'],
    ['ABC-1', 'ABC-1 '],
  ])(
    'STATED LIMIT: store %j against ERP %j is NOT reached — only the store side is folded',
    async (li, erp) => {
      // Pinned on purpose: the probe is a guard for the common cases, never a full fold, and the
      // Simular report is the backstop. A change that starts catching these is a design change.
      const db = new FakeDb().seed('erp', { sku: erp });
      expect((await sondar(db, [li])).get(li)).toEqual({ exatos: [], parecidos: [] });
    },
  );
});

describe('sondarSkusLi — the query shape', () => {
  it('asks ONE `sku in` per 30 probe forms, projected to `sku`, every form exactly once', async () => {
    // 6 distinct forms per SKU (verbatim, trimmed, upper, lower, trimmed upper, trimmed lower).
    const skus = Array.from({ length: 6 }, (_, i) => ` Sku-${i} `);
    const db = new FakeDb();
    await sondar(db, [...skus, skus[0]!]);

    const valores = db.consultas.flatMap((c) => c.clausulas[0]![2] as string[]);
    expect(valores).toHaveLength(36);
    expect(new Set(valores).size).toBe(36);
    expect(db.consultas).toHaveLength(2);
    for (const c of db.consultas) {
      expect(c.clausulas).toHaveLength(1);
      expect(c.clausulas[0]![0]).toBe('sku');
      expect((c.clausulas[0]![2] as string[]).length).toBeLessThanOrEqual(
        MAX_VALORES_IN_SONDA_SKU_LI,
      );
      expect(c.projecao).toEqual(['sku']);
    }
  });

  it('a repeated SKU is answered once and probed once', async () => {
    const db = new FakeDb().seed('p', { sku: 'X' });
    const r = await sondar(db, ['X', 'X']);
    expect([...r.keys()]).toEqual(['X']);
    expect(db.consultas).toHaveLength(1);
    expect(db.consultas[0]!.clausulas[0]![2]).toEqual(['X', 'x']);
  });

  it('an empty list reads nothing', async () => {
    const db = new FakeDb();
    expect((await sondar(db, [])).size).toBe(0);
    expect(db.consultas).toHaveLength(0);
  });

  it('⚠️ an EMPTY SKU throws before any read — never "no collision" for a SKU nothing can be created with', async () => {
    const db = new FakeDb().seed('p', { sku: '' });
    await expect(sondar(db, ['X', ''])).rejects.toBeInstanceOf(RangeError);
    expect(db.consultas).toHaveLength(0);
  });
});
