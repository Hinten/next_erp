import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  documentId: vi.fn(() => '__name__'),
  getDocs: vi.fn(),
  groupQuery: vi.fn(() => ({ kind: 'group' })),
  limit: vi.fn((size: number) => ({ kind: 'limit', size })),
  orderBy: vi.fn((field: unknown) => ({ kind: 'orderBy', field })),
  query: vi.fn((base: unknown, ...constraints: unknown[]) => ({ base, constraints })),
  startAfter: vi.fn((cursor: unknown) => ({ kind: 'startAfter', cursor })),
  where: vi.fn((field: string, operator: string, value: unknown) => ({
    kind: 'where',
    field,
    operator,
    value,
  })),
}));

vi.mock('firebase/firestore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('firebase/firestore')>()),
  documentId: h.documentId,
  getDocs: h.getDocs,
  limit: h.limit,
  orderBy: h.orderBy,
  query: h.query,
  startAfter: h.startAfter,
  where: h.where,
}));

vi.mock('@delfrance/data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@delfrance/data')>()),
  groupQuery: h.groupQuery,
}));

vi.mock('@/lib/data/getDocsByIds', () => ({ getDocsByIds: vi.fn(async () => new Map()) }));

import { loadProductLocationReport } from './productLocation';

function stockDoc(index: number) {
  return {
    ref: { path: `produtos/p${index}/estoques/e${index}` },
    data: () => ({
      parentId: null,
      localizacao: null,
      quantidade: 0,
      quantidadeReservada: 0,
    }),
  };
}

beforeEach(() => vi.clearAllMocks());

describe('loadProductLocationReport estoque pagination', () => {
  it('uses one two-ref query and advances a document cursor every 500 rows', async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) => stockDoc(index));
    const lastPage = [stockDoc(500)];
    h.getDocs
      .mockResolvedValueOnce({ empty: false, size: firstPage.length, docs: firstPage })
      .mockResolvedValueOnce({ empty: false, size: lastPage.length, docs: lastPage });
    const progress = vi.fn();

    await loadProductLocationReport({} as never, 'documents/depositos/dep-1', progress);

    expect(h.where).toHaveBeenCalledWith('depositoOuterRef', 'in', [
      'documents/depositos/dep-1',
      'depositos/dep-1',
    ]);
    expect(h.limit).toHaveBeenCalledTimes(2);
    expect(h.limit).toHaveBeenNthCalledWith(1, 500);
    expect(h.limit).toHaveBeenNthCalledWith(2, 500);
    expect(h.startAfter).toHaveBeenCalledOnce();
    expect(h.startAfter).toHaveBeenCalledWith(firstPage[499]);
    expect(progress).toHaveBeenCalledWith({ phase: 'estoques', loaded: 500 });
    expect(progress).toHaveBeenCalledWith({ phase: 'estoques', loaded: 501 });
  });
});
