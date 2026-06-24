import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Produto } from '@delfrance/schemas';

// Mock the Firestore SDK (only `getDoc` is used) and the produtoCollection
// handle (only `docRef`, which we make an identity stub so we can assert which
// id was looked up). `precoFromProduto` reads at most one parent doc.
vi.mock('firebase/firestore', () => ({
  getDoc: vi.fn(),
}));

vi.mock('@/lib/data/produtoCollection', () => ({
  produtoCollection: {
    docRef: vi.fn((_db: unknown, _ctx: unknown, id: string) => ({ id })),
  },
}));

import { getDoc } from 'firebase/firestore';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { directPreco, precoFromProduto } from './precoLookup';

const getDocMock = vi.mocked(getDoc);
const docRefMock = vi.mocked(produtoCollection.docRef);

function produto(overrides: Partial<Produto>): Produto {
  return { nome: 'Produto', ...overrides } as Produto;
}

const db = {} as never;

afterEach(() => {
  vi.clearAllMocks();
});

describe('directPreco', () => {
  it('returns the valor when the lista has an entry', () => {
    const p = produto({ precos: { listaA: { valor: 30 }, listaB: { valor: 50 } } });
    expect(directPreco(p, 'listaA')).toBe(30);
    expect(directPreco(p, 'listaB')).toBe(50);
  });

  it('returns null when the lista is missing from the precos map', () => {
    const p = produto({ precos: { listaA: { valor: 30 } } });
    expect(directPreco(p, 'listaX')).toBeNull();
  });

  it('returns null when there is no precos map', () => {
    expect(directPreco(produto({ precos: null }), 'listaA')).toBeNull();
    expect(directPreco(produto({}), 'listaA')).toBeNull();
  });

  it('returns null when valor is not a number', () => {
    const p = produto({ precos: { listaA: { valor: undefined as unknown as number } } });
    expect(directPreco(p, 'listaA')).toBeNull();
  });
});

describe('precoFromProduto', () => {
  it('returns the direct price without reading the parent', async () => {
    const p = produto({ precos: { listaA: { valor: 42 } } });
    await expect(precoFromProduto(db, p, 'listaA')).resolves.toBe(42);
    expect(getDocMock).not.toHaveBeenCalled();
  });

  it('falls back to the parent price when the child has none', async () => {
    const child = produto({ paiId: 'parent-1', precos: { listaA: { valor: 0 } } });
    // The child has no entry for listaB; the parent does.
    getDocMock.mockResolvedValue({
      data: () => produto({ precos: { listaB: { valor: 99 } } }),
    } as never);

    await expect(precoFromProduto(db, child, 'listaB')).resolves.toBe(99);
    expect(docRefMock).toHaveBeenCalledWith(db, {}, 'parent-1');
    expect(getDocMock).toHaveBeenCalledTimes(1);
  });

  it('returns null when there is no direct price and no paiId', async () => {
    const p = produto({ paiId: null, precos: { listaA: { valor: 10 } } });
    await expect(precoFromProduto(db, p, 'listaB')).resolves.toBeNull();
    expect(getDocMock).not.toHaveBeenCalled();
  });

  it('returns null when the parent doc is missing', async () => {
    const child = produto({ paiId: 'parent-missing', precos: null });
    getDocMock.mockResolvedValue({ data: () => undefined } as never);

    await expect(precoFromProduto(db, child, 'listaA')).resolves.toBeNull();
    expect(getDocMock).toHaveBeenCalledTimes(1);
  });

  it('returns null when the parent has no price for the lista', async () => {
    const child = produto({ paiId: 'parent-1', precos: null });
    getDocMock.mockResolvedValue({
      data: () => produto({ precos: { listaZ: { valor: 5 } } }),
    } as never);

    await expect(precoFromProduto(db, child, 'listaA')).resolves.toBeNull();
  });
});
