import { beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { FirebaseError } from 'firebase/app';
import type { Firestore } from 'firebase/firestore';

// Hoisted mocks (vi.mock factories can't close over normal consts).
const h = vi.hoisted(() => {
  const counter = { n: 0 };
  const skuCounter = { n: 0 };
  return {
    counter,
    skuCounter,
    getDocFromServer: vi.fn(),
    getDocsFromServer: vi.fn(),
    buildDuplicarProdutoWriteOps: vi.fn(() => [
      { type: 'set' as const, path: 'produtos/novo-1', data: {} },
    ]),
    ehFamiliaDeUmParaDuplicar: vi.fn(() => false),
    commit: vi.fn(async () => undefined),
    newDocId: vi.fn(() => `novo-${++counter.n}`),
    gerarSkuUnico: vi.fn(async (): Promise<string | null> => `SKU-${++skuCounter.n}`),
    docRef: vi.fn((_db: unknown, _ctx: unknown, id: string) => ({ __ref: `produtos/${id}` })),
    ref: vi.fn(() => ({ __coll: 'produtos' })),
    extraDocRef: vi.fn((_db: unknown, ctx: { produtoId: string }, id: string) => ({
      __ref: `produtos/${ctx.produtoId}/extraData/${id}`,
    })),
    impostoRef: vi.fn((_db: unknown, ctx: { produtoId: string }) => ({
      __coll: `produtos/${ctx.produtoId}/imposto`,
    })),
  };
});

vi.mock('firebase/firestore', () => ({
  getDocFromServer: h.getDocFromServer,
  getDocsFromServer: h.getDocsFromServer,
}));
vi.mock('@delfrance/data', () => ({
  buildQuery: (base: unknown) => base,
  limit: (n: number) => ({ limit: n }),
  whereEqual: (field: string, value: unknown) => ({ field, value }),
}));
vi.mock('@delfrance/data/produto', () => ({
  buildDuplicarProdutoWriteOps: h.buildDuplicarProdutoWriteOps,
  ehFamiliaDeUmParaDuplicar: h.ehFamiliaDeUmParaDuplicar,
}));
vi.mock('@/lib/data/produtoCollection', () => ({
  produtoCollection: { docRef: h.docRef, ref: h.ref },
}));
vi.mock('@/lib/data/produtoExtraDataCollection', () => ({
  produtoExtraDataCollection: { docRef: h.extraDocRef },
}));
vi.mock('@/lib/data/impostoProdutoCollection', () => ({
  impostoProdutoCollection: { ref: h.impostoRef },
}));
vi.mock('./docId', () => ({ newDocId: h.newDocId }));
vi.mock('./skuUnico', () => ({ gerarSkuUnico: h.gerarSkuUnico }));
vi.mock('./clientPort', () => ({
  BATCH_LIMIT: 499,
  createClientProdutoPort: () => ({ commit: h.commit }),
}));

import {
  duplicarProduto,
  ProdutoFamiliaGrandeDemaisError,
  ProdutoFilhoNaoDuplicavelError,
  ProdutoNaoEncontradoError,
} from './duplicar';

const db = {} as Firestore;

/** A produto doc snapshot; `paiId` defaults to a PARENT (the only duplicable shape). */
const snapDe = (dados: Record<string, unknown>) => ({
  exists: () => true,
  data: () => ({ paiId: null, sku: null, filhoUnicoId: null, ...dados }),
});

const vazio = { docs: [] as unknown[] };
const semExtraData = { exists: () => false };

beforeEach(() => {
  vi.clearAllMocks();
  h.counter.n = 0;
  h.skuCounter.n = 0;
  h.ehFamiliaDeUmParaDuplicar.mockReturnValue(false);
  h.gerarSkuUnico.mockImplementation(async () => `SKU-${++h.skuCounter.n}`);
});

describe('duplicarProduto', () => {
  it('throws when the selected produto no longer exists', async () => {
    h.getDocFromServer.mockResolvedValueOnce({ exists: () => false });

    await expect(duplicarProduto(db, 'p1')).rejects.toThrow(ProdutoNaoEncontradoError);
    expect(h.getDocsFromServer).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
  });

  // ⚠️ A child cloned as a parent becomes a rootless produto in the catalogue.
  // `/produtos` can't select one, so this can only be reached in code — and must
  // refuse rather than write.
  it('refuses to duplicate a variation child', async () => {
    h.getDocFromServer.mockResolvedValueOnce(snapDe({ nome: 'Camisa - P', paiId: 'p0' }));

    await expect(duplicarProduto(db, 'c1')).rejects.toThrow(ProdutoFilhoNaoDuplicavelError);
    expect(h.getDocsFromServer).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
  });

  it('reads the parent + children + subdocs, mints fresh ids and SKUs, and commits', async () => {
    const parentData = { nome: 'Camisa Azul', sku: 'CAM-1' };
    const childData = { nome: 'Camisa Azul - P', sku: 'CAM-P', paiId: 'p1' };
    const extraData = { descricao: 'Camisa de algodão' };
    const imposto = { id: 'op1', cfop: '5102' };

    h.getDocFromServer
      .mockResolvedValueOnce(snapDe(parentData)) // the produto
      .mockResolvedValueOnce({ exists: () => true, data: () => extraData }) // parent extraData
      .mockResolvedValueOnce(semExtraData); // child extraData
    h.getDocsFromServer
      .mockResolvedValueOnce({ docs: [{ id: 'c1', data: () => childData }] }) // children
      .mockResolvedValueOnce({ docs: [{ data: () => imposto }] }) // parent imposto
      .mockResolvedValueOnce(vazio); // child imposto

    const novoId = await duplicarProduto(db, 'p1');

    // First id minted is the new PARENT's; the second is the one child's.
    expect(h.newDocId).toHaveBeenCalledTimes(2);
    // One SKU per document that HAD one, both distinct.
    expect(h.gerarSkuUnico).toHaveBeenCalledTimes(2);
    expect(h.buildDuplicarProdutoWriteOps).toHaveBeenCalledWith({
      novoParentId: 'novo-1',
      parentOrigem: expect.objectContaining({ nome: 'Camisa Azul', sku: 'CAM-1' }),
      novoParentSku: 'SKU-1',
      parentExtraData: extraData,
      parentImpostos: [imposto],
      filhos: [
        {
          id: 'c1',
          dados: expect.objectContaining({ nome: 'Camisa Azul - P' }),
          novoId: 'novo-2',
          novoSku: 'SKU-2',
          extraData: null,
          impostos: [],
        },
      ],
      now: expect.any(Number),
    });
    expect(h.commit).toHaveBeenCalledWith([{ type: 'set', path: 'produtos/novo-1', data: {} }]);
    expect(novoId).toBe('novo-1');
  });

  it('mints no child ids or SKUs for a childless produto', async () => {
    h.getDocFromServer
      .mockResolvedValueOnce(snapDe({ nome: 'Sem filhos', sku: 'S-1' }))
      .mockResolvedValueOnce(semExtraData);
    h.getDocsFromServer.mockResolvedValueOnce(vazio).mockResolvedValueOnce(vazio);

    await duplicarProduto(db, 'p1');

    expect(h.newDocId).toHaveBeenCalledTimes(1);
    expect(h.gerarSkuUnico).toHaveBeenCalledTimes(1);
    expect(h.buildDuplicarProdutoWriteOps).toHaveBeenCalledWith(
      expect.objectContaining({ novoParentSku: 'SKU-1', filhos: [] }),
    );
  });

  // ⚠️ Never invent an identifier the operator never had.
  it('mints no SKU for a source that had none', async () => {
    h.getDocFromServer
      .mockResolvedValueOnce(snapDe({ nome: 'Sem sku', sku: null }))
      .mockResolvedValueOnce(semExtraData);
    h.getDocsFromServer.mockResolvedValueOnce(vazio).mockResolvedValueOnce(vazio);

    await duplicarProduto(db, 'p1');

    expect(h.gerarSkuUnico).not.toHaveBeenCalled();
    expect(h.buildDuplicarProdutoWriteOps).toHaveBeenCalledWith(
      expect.objectContaining({ novoParentSku: null }),
    );
  });

  // The mirrored sole member takes the parent's SKU, so minting one for it would
  // spend a probe on a value the builder drops.
  it('mints only the parent SKU for a genuine family of one', async () => {
    h.ehFamiliaDeUmParaDuplicar.mockReturnValue(true);
    h.getDocFromServer
      .mockResolvedValueOnce(snapDe({ nome: 'Camisa', sku: 'CAM-1', filhoUnicoId: 'c1' }))
      .mockResolvedValueOnce(semExtraData)
      .mockResolvedValueOnce(semExtraData);
    h.getDocsFromServer
      .mockResolvedValueOnce({ docs: [{ id: 'c1', data: () => ({ sku: 'CAM-1', paiId: 'p1' }) }] })
      .mockResolvedValueOnce(vazio)
      .mockResolvedValueOnce(vazio);

    await duplicarProduto(db, 'p1');

    expect(h.gerarSkuUnico).toHaveBeenCalledTimes(1);
    expect(h.buildDuplicarProdutoWriteOps).toHaveBeenCalledWith(
      expect.objectContaining({
        novoParentSku: 'SKU-1',
        filhos: [expect.objectContaining({ novoSku: null })],
      }),
    );
  });

  // Every SKU probe runs BEFORE the batch opens, so an unverifiable SKU aborts
  // the whole duplication instead of half-cloning a family.
  it('commits nothing when a SKU probe fails', async () => {
    h.getDocFromServer.mockResolvedValueOnce(snapDe({ nome: 'Camisa', sku: 'CAM-1' }));
    h.getDocsFromServer.mockResolvedValueOnce(vazio);
    h.gerarSkuUnico.mockRejectedValueOnce(new FirebaseError('unavailable', 'offline'));

    await expect(duplicarProduto(db, 'p1')).rejects.toThrow(FirebaseError);
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.buildDuplicarProdutoWriteOps).not.toHaveBeenCalled();
  });

  // An exhausted generator leaves the SKU empty on the editor this action opens
  // — visible — rather than copying the source's.
  it('leaves the SKU null when the generator gives up', async () => {
    h.getDocFromServer
      .mockResolvedValueOnce(snapDe({ nome: 'Camisa', sku: 'CAM-1' }))
      .mockResolvedValueOnce(semExtraData);
    h.getDocsFromServer.mockResolvedValueOnce(vazio).mockResolvedValueOnce(vazio);
    h.gerarSkuUnico.mockResolvedValueOnce(null);

    await duplicarProduto(db, 'p1');

    expect(h.buildDuplicarProdutoWriteOps).toHaveBeenCalledWith(
      expect.objectContaining({ novoParentSku: null }),
    );
    expect(h.commit).toHaveBeenCalled();
  });
  /**
   * ⚠️ `commit` chunks at `BATCH_LIMIT` and is atomic only WITHIN a chunk, so an
   * oversized set does not fail cleanly — it half-clones the family. Both cases
   * below are needed: one that the guard FIRES and writes nothing, and the
   * near-miss at exactly the limit proving it does not refuse a set that commits
   * atomically. A guard tested only on what it rejects is satisfied by `() => true`.
   */
  const opsDe = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      type: 'set' as const,
      path: `produtos/x${i}`,
      data: {},
    }));

  it('refuses — writing NOTHING — when the clone needs more ops than one atomic batch', async () => {
    h.getDocFromServer
      .mockResolvedValueOnce(snapDe({ nome: 'Camisa' }))
      .mockResolvedValueOnce(semExtraData);
    h.getDocsFromServer.mockResolvedValueOnce(vazio).mockResolvedValueOnce(vazio);
    h.buildDuplicarProdutoWriteOps.mockReturnValueOnce(opsDe(500));

    await expect(duplicarProduto(db, 'p1')).rejects.toThrow(ProdutoFamiliaGrandeDemaisError);
    expect(h.commit).not.toHaveBeenCalled();
  });

  it('still commits a family sitting exactly on the limit', async () => {
    h.getDocFromServer
      .mockResolvedValueOnce(snapDe({ nome: 'Camisa' }))
      .mockResolvedValueOnce(semExtraData);
    h.getDocsFromServer.mockResolvedValueOnce(vazio).mockResolvedValueOnce(vazio);
    h.buildDuplicarProdutoWriteOps.mockReturnValueOnce(opsDe(499));

    await expect(duplicarProduto(db, 'p1')).resolves.toBe('novo-1');
    expect(h.commit).toHaveBeenCalled();
  });
});
