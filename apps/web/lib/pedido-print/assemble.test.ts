import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase/firestore';
import type { Produto } from '@delfrance/schemas';

/**
 * Read-count coverage for the print path's cover-photo resolver.
 *
 * The comum print is the BATCH path — `batch.ts` drives many pedidos in bounded
 * waves — so how many documents this resolver reads per photo is a real cost on
 * a database that bills data scanned (root `CLAUDE.md` rule 1). Resolving the
 * candidate ladder eagerly would triple it permanently, so the healthy case is
 * pinned here at one read per distinct photo.
 */
/**
 * `docs` serves BOTH resolvers in this file — an arquivo carries `url`, an
 * estoque row carries the counters — so the fixture type is the union rather
 * than either one. Each test seeds only the shape its resolver reads.
 */
type DocFixture =
  | { url: string | null }
  | { quantidade: number; quantidadeReservada: number; localizacao: string };

const { reads, docs } = vi.hoisted(() => ({
  reads: { current: [] as string[] },
  docs: { current: {} as Record<string, DocFixture | undefined> },
}));

vi.mock('firebase/firestore', async () => {
  const actual = await vi.importActual<typeof import('firebase/firestore')>('firebase/firestore');
  return {
    ...actual,
    getDoc: async (ref: { id: string }) => {
      reads.current.push(ref.id);
      const data = docs.current[ref.id];
      return { exists: () => data !== undefined, data: () => data };
    },
  };
});

vi.mock('@/lib/data/estoqueProdutoCollection', () => ({
  estoqueProdutoCollection: {
    docRef: (_db: unknown, _scope: unknown, id: string) => ({ id }),
  },
}));

vi.mock('@delfrance/storage', () => ({
  arquivoCollection: {
    docRef: (_db: unknown, _scope: unknown, id: string) => ({ id }),
  },
}));

import { buildFotoResolver, buildStockResolver } from './assemble';

const db = {} as Firestore;

/** A produto whose upload wrote all three optimistic derivative refs. */
function produto(id: string): Produto {
  return {
    fotos: [
      {
        arquivoOuterRef: `arquivos/${id}`,
        arquivo200pxOuterRef: `arquivos/${id}_200`,
        arquivo400pxOuterRef: `arquivos/${id}_400`,
        arquivoJpegOuterRef: `arquivos/${id}_jpeg`,
      },
    ],
  } as unknown as Produto;
}

afterEach(() => {
  reads.current = [];
  docs.current = {};
  vi.clearAllMocks();
});

describe('buildFotoResolver', () => {
  it('reads ONE document per photo when the preferred derivative exists', async () => {
    docs.current = { p1_200: { url: 'https://cdn/p1_200.jpg' } };
    const resolve = await buildFotoResolver(db, new Map([['p1', produto('p1')]]));
    expect(resolve('p1')).toBe('https://cdn/p1_200.jpg');
    // ⚠️ The whole point: NOT ['p1_200', 'p1_400', 'p1'].
    expect(reads.current).toEqual(['p1_200']);
  });

  it('only the produtos that missed pay for the next rung', async () => {
    // p1 healthy, p2 degraded (no derivatives, original intact).
    docs.current = {
      p1_200: { url: 'https://cdn/p1_200.jpg' },
      p2: { url: 'https://cdn/p2.jpg' },
    };
    const resolve = await buildFotoResolver(
      db,
      new Map([
        ['p1', produto('p1')],
        ['p2', produto('p2')],
      ]),
    );
    expect(resolve('p1')).toBe('https://cdn/p1_200.jpg');
    expect(resolve('p2')).toBe('https://cdn/p2.jpg');
    // Wave 1 asks both; wave 2 asks only p2; p1 never reaches its lower rungs.
    expect(reads.current).toEqual(['p1_200', 'p2_200', 'p2_400', 'p2']);
  });

  it('falls through to the original when no derivative document exists', async () => {
    docs.current = { p1: { url: 'https://cdn/p1.jpg' } };
    const resolve = await buildFotoResolver(db, new Map([['p1', produto('p1')]]));
    expect(resolve('p1')).toBe('https://cdn/p1.jpg');
    expect(reads.current).toEqual(['p1_200', 'p1_400', 'p1']);
  });

  it('fetches a shared photo once, however many produtos name it', async () => {
    docs.current = { shared_200: { url: 'https://cdn/shared.jpg' } };
    const p = produto('shared');
    const resolve = await buildFotoResolver(
      db,
      new Map([
        ['a', p],
        ['b', p],
      ]),
    );
    expect(resolve('a')).toBe('https://cdn/shared.jpg');
    expect(resolve('b')).toBe('https://cdn/shared.jpg');
    expect(reads.current).toEqual(['shared_200']);
  });

  it('returns null when every candidate is missing, and reads each once', async () => {
    docs.current = {};
    const resolve = await buildFotoResolver(db, new Map([['p1', produto('p1')]]));
    expect(resolve('p1')).toBeNull();
    expect(reads.current).toEqual(['p1_200', 'p1_400', 'p1']);
  });

  it('treats a doc that exists with a null url as an empty rung', async () => {
    docs.current = { p1_200: { url: null }, p1: { url: 'https://cdn/p1.jpg' } };
    const resolve = await buildFotoResolver(db, new Map([['p1', produto('p1')]]));
    expect(resolve('p1')).toBe('https://cdn/p1.jpg');
  });

  it('reads nothing for a produto with no photo, and resolves unknown ids to null', async () => {
    const semFoto = { fotos: null } as unknown as Produto;
    const resolve = await buildFotoResolver(db, new Map([['p1', semFoto]]));
    expect(resolve('p1')).toBeNull();
    expect(resolve('desconhecido')).toBeNull();
    expect(resolve(null)).toBeNull();
    expect(reads.current).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                    stock resolution through the sole member                */
/* -------------------------------------------------------------------------- */

/**
 * A produto with no variations is a family of one, and the AVAILABLE stock lives
 * on the child (#1398). A picking list someone walks the warehouse with must
 * print that number, not the parent's truthful, useless `0`.
 *
 * ⚠️ The resolution must cost nothing. Every produto on the sheet — line items
 * AND kit components — is already loaded, so no document may be read twice and
 * none may be read that was not read before. That is asserted, not assumed:
 * `reads` counts every `getDoc`.
 */
const prodFamilia = (over: Partial<Produto> = {}): Produto =>
  ({ nome: 'x', paiId: null, filhoUnicoId: null, ...over }) as Produto;

describe('buildStockResolver — a family of one reads its child', () => {
  afterEach(() => {
    reads.current = [];
    docs.current = {};
  });

  it('answers for the PARENT id with the CHILD row', async () => {
    docs.current = {
      'est-c1-dep1': { quantidade: 20, quantidadeReservada: 0, localizacao: 'A-1' },
    };
    const resolver = await buildStockResolver(
      db,
      new Map([['p1', prodFamilia({ filhoUnicoId: 'c1' })]]),
      'dep1',
    );
    // The pedido line names the parent; the sheet prints the child's stock.
    expect(resolver('p1')).toEqual({ disponivel: 20, localizacao: 'A-1' });
    // ⚠️ One read, and it is the CHILD's row — the parent's is never fetched.
    expect(reads.current).toEqual(['est-c1-dep1']);
  });

  it('resolves a KIT COMPONENT that is a family-of-one parent', async () => {
    // The harm #1398 opened on: kit components reading 0 while the stock sits
    // on their children.
    docs.current = {
      'est-comp-child-dep1': { quantidade: 14, quantidadeReservada: 0, localizacao: '' },
    };
    const resolver = await buildStockResolver(
      db,
      new Map([
        ['kit', prodFamilia({ ehKit: true })],
        ['comp', prodFamilia({ filhoUnicoId: 'comp-child' })],
      ]),
      'dep1',
    );
    expect(resolver('comp').disponivel).toBe(14);
  });

  it('leaves a produto that is not a family of one exactly as before', async () => {
    docs.current = { 'est-p1-dep1': { quantidade: 5, quantidadeReservada: 1, localizacao: 'B-2' } };
    const resolver = await buildStockResolver(db, new Map([['p1', prodFamilia()]]), 'dep1');
    expect(resolver('p1')).toEqual({ disponivel: 4, localizacao: 'B-2' });
    expect(reads.current).toEqual(['est-p1-dep1']);
  });

  // ⚠️ A CHILD carrying a stale `filhoUnicoId` must resolve to itself — the
  // `paiId` guard in `ehFamiliaDeUm`. Without it a drifted row would send the
  // picking list to some other produto entirely.
  it('does not follow a stale pointer on a child', async () => {
    docs.current = { 'est-c1-dep1': { quantidade: 7, quantidadeReservada: 0, localizacao: '' } };
    const resolver = await buildStockResolver(
      db,
      new Map([['c1', prodFamilia({ paiId: 'p1', filhoUnicoId: 'algum-outro' })]]),
      'dep1',
    );
    expect(resolver('c1').disponivel).toBe(7);
    expect(reads.current).toEqual(['est-c1-dep1']);
  });

  it('reads one document per distinct target, not per referencing produto', async () => {
    docs.current = { 'est-alvo-dep1': { quantidade: 3, quantidadeReservada: 0, localizacao: '' } };
    const resolver = await buildStockResolver(
      db,
      new Map([
        ['p1', prodFamilia({ filhoUnicoId: 'alvo' })],
        ['alvo', prodFamilia({ paiId: 'p1' })],
      ]),
      'dep1',
    );
    expect(reads.current).toEqual(['est-alvo-dep1']);
    expect(resolver('p1').disponivel).toBe(3);
    expect(resolver('alvo').disponivel).toBe(3);
  });

  it('reads nothing at all without a depósito', async () => {
    const resolver = await buildStockResolver(
      db,
      new Map([['p1', prodFamilia({ filhoUnicoId: 'c1' })]]),
      null,
    );
    expect(reads.current).toEqual([]);
    expect(resolver('p1')).toEqual({ disponivel: null, localizacao: '' });
  });
});

/**
 * ⚠️ `filhoUnicoId` records that the family has exactly ONE child. It says
 * nothing about where the units sit — `upSoleMember` moves them, but that is the
 * Mercado Livre publish path. A produto whose stock was lançado on the parent
 * and never moved still has the number there, and resolving past it printed `-`
 * for units that are on the shelf.
 */
describe('buildStockResolver — the sole member has no row at this depósito', () => {
  afterEach(() => {
    reads.current = [];
    docs.current = {};
  });

  it('falls back to the produto’s OWN row', async () => {
    docs.current = {
      'est-p1-dep1': { quantidade: 12, quantidadeReservada: 0, localizacao: 'C-3' },
    };
    const resolver = await buildStockResolver(
      db,
      new Map([['p1', prodFamilia({ filhoUnicoId: 'c1' })]]),
      'dep1',
    );
    expect(resolver('p1')).toEqual({ disponivel: 12, localizacao: 'C-3' });
    // The child is tried first; the parent's row is the second, anomalous read.
    expect(reads.current).toEqual(['est-c1-dep1', 'est-p1-dep1']);
  });

  // ⚠️ The fallback fires on ABSENCE, not on zero. When both rows exist the sole
  // member answers — the same thing the ERP does for any parent/child split, and
  // the parent's remainder is `residualEstoquePai`'s job.
  it('does NOT fall back when the sole member has a row, even a zero one', async () => {
    docs.current = {
      'est-c1-dep1': { quantidade: 0, quantidadeReservada: 0, localizacao: '' },
      'est-p1-dep1': { quantidade: 12, quantidadeReservada: 0, localizacao: 'C-3' },
    };
    const resolver = await buildStockResolver(
      db,
      new Map([['p1', prodFamilia({ filhoUnicoId: 'c1' })]]),
      'dep1',
    );
    expect(resolver('p1').disponivel).toBe(0);
    expect(reads.current).toEqual(['est-c1-dep1']);
  });

  it('costs no extra read when neither row exists', async () => {
    const resolver = await buildStockResolver(
      db,
      new Map([['p1', prodFamilia({ filhoUnicoId: 'c1' })]]),
      'dep1',
    );
    expect(resolver('p1')).toEqual({ disponivel: null, localizacao: '' });
    // Two reads: the target, then the one fallback. Never more.
    expect(reads.current).toEqual(['est-c1-dep1', 'est-p1-dep1']);
  });

  it('does not fall back for a produto that resolved to itself', async () => {
    const resolver = await buildStockResolver(db, new Map([['p1', prodFamilia()]]), 'dep1');
    expect(resolver('p1').disponivel).toBeNull();
    expect(reads.current).toEqual(['est-p1-dep1']);
  });
});
