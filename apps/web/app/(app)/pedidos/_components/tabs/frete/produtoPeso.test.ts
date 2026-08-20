import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase/firestore';
import { FirebaseError } from 'firebase/app';
import { fetchProdutoPesoMap, produtoPesoIds } from './produtoPeso';
import { getDocsByIds } from '@/lib/data/getDocsByIds';

vi.mock('@/lib/data/getDocsByIds', () => ({ getDocsByIds: vi.fn() }));
const batchMock = vi.mocked(getDocsByIds);

const db = {} as Firestore;

type Row = {
  pesoBrutoKg: number | null;
  pesoLiquidoKg: number | null;
  alturaCm: number | null;
  larguraCm: number | null;
  profundidadeCm: number | null;
  paiId: string | null;
};
const row = (over: Partial<Row> = {}): Row => ({
  pesoBrutoKg: null,
  pesoLiquidoKg: null,
  alturaCm: null,
  larguraCm: null,
  profundidadeCm: null,
  paiId: null,
  ...over,
});

/** A produto that needs no parent: it has both its own weight and its own box. */
const completo = (over: Partial<Row> = {}): Row =>
  row({ pesoBrutoKg: 5, alturaCm: 10, larguraCm: 10, profundidadeCm: 10, ...over });

/** Serve each wave from a single catalogue, echoing only the ids asked for. */
function catalogue(docs: Record<string, Row>) {
  batchMock.mockImplementation(async (_db, _handle, ids) => {
    const out = new Map<string, Row>();
    for (const id of ids) if (docs[id]) out.set(id, docs[id]!);
    return out as never;
  });
}

beforeEach(() => {
  batchMock.mockReset();
});

describe('produtoPesoIds', () => {
  it('dedupes, drops empties and normalizes legacy full paths', () => {
    expect(produtoPesoIds(['produtos/p2', 'p1', 'p1', null, undefined, '', 'p2'])).toEqual([
      'p1',
      'p2',
    ]);
  });
});

describe('fetchProdutoPesoMap', () => {
  it('projects the weight fields and marks a missing produto as null', async () => {
    catalogue({ p1: row({ pesoBrutoKg: 2 }) });

    const map = await fetchProdutoPesoMap(db, ['p1', 'ghost']);

    expect(map).toEqual({
      p1: row({ pesoBrutoKg: 2 }),
      ghost: null,
    });
  });

  it('batches instead of reading one produto at a time', async () => {
    catalogue({
      p1: row({ pesoBrutoKg: 1 }),
      p2: row({ pesoBrutoKg: 2 }),
      p3: row({ pesoBrutoKg: 3 }),
    });

    await fetchProdutoPesoMap(db, ['p1', 'p2', 'p3']);

    // One call for the whole wave — `getDocsByIds` chunks internally.
    expect(batchMock).toHaveBeenCalledTimes(1);
    expect(batchMock.mock.calls[0]![2]).toEqual(['p1', 'p2', 'p3']);
  });

  it('fetches the parent of a zero-weight variation in a second wave', async () => {
    catalogue({
      child: row({ pesoBrutoKg: 0, pesoLiquidoKg: 0, paiId: 'parent' }),
      parent: row({ pesoBrutoKg: 4 }),
    });

    const map = await fetchProdutoPesoMap(db, ['child']);

    expect(batchMock).toHaveBeenCalledTimes(2);
    expect(batchMock.mock.calls[1]![2]).toEqual(['parent']);
    expect(map.parent).toEqual(row({ pesoBrutoKg: 4 }));
  });

  it('spends no second wave when every produto is self-sufficient', async () => {
    catalogue({ child: completo({ paiId: 'parent' }) });

    await fetchProdutoPesoMap(db, ['child']);

    // `paiId` is set but unused — the child has both its own weight and its own
    // box, so the parent is never needed and must not cost a query.
    expect(batchMock).toHaveBeenCalledTimes(1);
  });

  it('fetches the parent of a produto that has a weight but NO dimensions', async () => {
    // The dimension half of the wave-2 predicate: a variation very commonly
    // carries a weight and no box. Gating the wave on the weight alone would
    // leave `dimensoesPedido` with no parent to fall back to.
    catalogue({
      child: row({ pesoBrutoKg: 5, paiId: 'parent' }),
      parent: completo(),
    });

    await fetchProdutoPesoMap(db, ['child']);

    expect(batchMock).toHaveBeenCalledTimes(2);
    expect(batchMock.mock.calls[1]![2]).toEqual(['parent']);
  });

  it('does not re-fetch a parent already present in the first wave', async () => {
    catalogue({
      child: row({ pesoBrutoKg: 0, pesoLiquidoKg: 0, paiId: 'parent' }),
      parent: row({ pesoBrutoKg: 4 }),
    });

    await fetchProdutoPesoMap(db, ['child', 'parent']);

    expect(batchMock).toHaveBeenCalledTimes(1);
  });

  it('forces the server on both waves so an offline read cannot read as "missing"', async () => {
    catalogue({
      child: row({ pesoBrutoKg: 0, pesoLiquidoKg: 0, paiId: 'parent' }),
      parent: row({ pesoBrutoKg: 4 }),
    });

    await fetchProdutoPesoMap(db, ['child']);

    // A cache-backed snapshot would report an uncached produto as absent,
    // which `toPesoInfo` maps to null → a fabricated 1kg weight, persisted.
    expect(batchMock.mock.calls[0]![4]).toEqual({ source: 'server' });
    expect(batchMock.mock.calls[1]![4]).toEqual({ source: 'server' });
  });

  it('propagates a read failure instead of reporting the produtos as missing', async () => {
    batchMock.mockRejectedValue(new FirebaseError('permission-denied', 'denied'));

    await expect(fetchProdutoPesoMap(db, ['p1'])).rejects.toBeInstanceOf(FirebaseError);
  });
});
