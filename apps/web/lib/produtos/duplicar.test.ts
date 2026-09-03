import { beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import type { Firestore } from 'firebase/firestore';

// Hoisted mocks (vi.mock factories can't close over normal consts).
const h = vi.hoisted(() => {
  const counter = { n: 0 };
  return {
    counter,
    getDocFromServer: vi.fn(),
    getDocsFromServer: vi.fn(),
    buildDuplicarProdutoWriteOps: vi.fn(() => [
      { type: 'set' as const, path: 'produtos/novo-1', data: {} },
    ]),
    commit: vi.fn(async () => undefined),
    newDocId: vi.fn(() => `novo-${++counter.n}`),
    docRef: vi.fn((_db: unknown, _ctx: unknown, id: string) => ({ __ref: `produtos/${id}` })),
    ref: vi.fn(() => ({ __coll: 'produtos' })),
  };
});

vi.mock('firebase/firestore', () => ({
  getDocFromServer: h.getDocFromServer,
  getDocsFromServer: h.getDocsFromServer,
}));
vi.mock('@delfrance/data', () => ({
  buildQuery: (base: unknown) => base,
  whereEqual: (field: string, value: unknown) => ({ field, value }),
}));
vi.mock('@delfrance/data/produto', () => ({
  buildDuplicarProdutoWriteOps: h.buildDuplicarProdutoWriteOps,
}));
vi.mock('@/lib/data/produtoCollection', () => ({
  produtoCollection: { docRef: h.docRef, ref: h.ref },
}));
vi.mock('./docId', () => ({ newDocId: h.newDocId }));
vi.mock('./clientPort', () => ({
  createClientProdutoPort: () => ({ commit: h.commit }),
}));

import { duplicarProduto, ProdutoNaoEncontradoError } from './duplicar';

const db = {} as Firestore;

beforeEach(() => {
  vi.clearAllMocks();
  h.counter.n = 0;
});

describe('duplicarProduto', () => {
  it('throws when the selected produto no longer exists', async () => {
    h.getDocFromServer.mockResolvedValueOnce({ exists: () => false });

    await expect(duplicarProduto(db, 'p1')).rejects.toThrow(ProdutoNaoEncontradoError);
    expect(h.getDocsFromServer).not.toHaveBeenCalled();
  });

  it('reads the parent + children, mints fresh ids, and commits the built ops', async () => {
    const parentData = { nome: 'Camisa Azul', filhoUnicoId: null };
    const childData = { nome: 'Camisa Azul - P' };
    h.getDocFromServer.mockResolvedValueOnce({ exists: () => true, data: () => parentData });
    h.getDocsFromServer.mockResolvedValueOnce({
      docs: [{ id: 'c1', data: () => childData }],
    });

    const novoId = await duplicarProduto(db, 'p1');

    // First id minted is the new PARENT's; the second is the one child's.
    expect(h.newDocId).toHaveBeenCalledTimes(2);
    expect(h.buildDuplicarProdutoWriteOps).toHaveBeenCalledWith(
      'novo-1',
      parentData,
      [{ id: 'c1', dados: childData }],
      ['novo-2'],
      expect.any(Number),
    );
    expect(h.commit).toHaveBeenCalledWith([{ type: 'set', path: 'produtos/novo-1', data: {} }]);
    expect(novoId).toBe('novo-1');
  });

  it('mints no child ids for a childless produto', async () => {
    h.getDocFromServer.mockResolvedValueOnce({
      exists: () => true,
      data: () => ({ nome: 'Sem filhos' }),
    });
    h.getDocsFromServer.mockResolvedValueOnce({ docs: [] });

    await duplicarProduto(db, 'p1');

    expect(h.newDocId).toHaveBeenCalledTimes(1);
    expect(h.buildDuplicarProdutoWriteOps).toHaveBeenCalledWith(
      'novo-1',
      { nome: 'Sem filhos' },
      [],
      [],
      expect.any(Number),
    );
  });
});
