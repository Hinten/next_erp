import { afterEach, describe, expect, it, vi } from 'vitest';
import { precoDoFilhoNaTabela, propagaPrecoAosFilhos, type Produto } from '@delfrance/schemas';

// Mock the Firestore SDK (only `getDoc` is used) and the produtoCollection
// handle (only `docRef`, which we make an identity stub so we can assert which
// id was looked up).
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
import { lerProdutoUmaVez, precoDoProdutoNaLista, precoFromProduto } from './precoLookup';

const getDocMock = vi.mocked(getDoc);
const docRefMock = vi.mocked(produtoCollection.docRef);

function produto(overrides: Partial<Produto>): Produto {
  return { nome: 'Produto', ...overrides } as Produto;
}

/** A price map with one entry in `listaA`, or none. */
function precosA(valor: number | null): Produto['precos'] {
  return valor === null ? null : { listaA: { valor } };
}

function pai(valor: number | null, propagatePriceToChildren: boolean): Produto {
  return produto({ precos: precosA(valor), propagatePriceToChildren });
}

function filho(valor: number | null): Produto {
  return produto({ paiId: 'pai-1', precos: precosA(valor) });
}

const db = {} as never;

afterEach(() => {
  vi.clearAllMocks();
});

describe('precoDoProdutoNaLista — the pedido line binds the channels’ child-price rule', () => {
  it('a produto with no paiId prices from its OWN entry and needs no parent', () => {
    expect(precoDoProdutoNaLista(produto({ precos: precosA(30) }), undefined, 'listaA')).toBe(30);
    expect(precoDoProdutoNaLista(produto({ precos: precosA(30) }), undefined, 'listaX')).toBeNull();
  });

  // The three rows the probe measured, each now EQUAL to what the channels send.
  it('probe 1 — propagating parent 10.5 + a stale child 12 ⇒ 10.5, the channels’ price (NEAR-MISS: never the child’s 12)', () => {
    const pedido = precoDoProdutoNaLista(filho(12), pai(10.5, true), 'listaA');
    expect(pedido).toBe(10.5);
    expect(pedido).toBe(
      precoDoFilhoNaTabela(
        { precosDoPai: precosA(10.5), propagaPreco: true, precosDoFilho: precosA(12) },
        'listaA',
      ),
    );
  });

  it('probe 2 — propagating parent UNPRICED + child 12 ⇒ null, as the channels (the child is never a fallback)', () => {
    expect(precoDoProdutoNaLista(filho(12), pai(null, true), 'listaA')).toBeNull();
  });

  it('probe 3 — NON-propagating parent 10.5 + child UNPRICED ⇒ null, as the channels (the parent is never borrowed)', () => {
    expect(precoDoProdutoNaLista(filho(null), pai(10.5, false), 'listaA')).toBeNull();
  });

  it('NEAR-MISS of probe 1: only the flag differs — NON-propagating parent 10.5 + child 12 ⇒ the child’s 12', () => {
    expect(precoDoProdutoNaLista(filho(12), pai(10.5, false), 'listaA')).toBe(12);
  });

  it('EQUAL pair: a propagating parent prices an unpriced child and a priced one ALIKE', () => {
    expect(precoDoProdutoNaLista(filho(null), pai(10.5, true), 'listaA')).toBe(10.5);
    expect(precoDoProdutoNaLista(filho(12), pai(10.5, true), 'listaA')).toBe(10.5);
  });

  it('only a stored literal `false` turns propagation off — an absent (legacy) flag propagates, NEAR-MISS a junk "false" string propagates too', () => {
    const legado = produto({ precos: precosA(10.5) });
    delete (legado as Partial<Produto>).propagatePriceToChildren;
    expect(precoDoProdutoNaLista(filho(12), legado, 'listaA')).toBe(10.5);

    const lixo = produto({
      precos: precosA(10.5),
      propagatePriceToChildren: 'false' as unknown as boolean,
    });
    expect(precoDoProdutoNaLista(filho(12), lixo, 'listaA')).toBe(10.5);
  });

  it('a child whose parent document is missing ⇒ null even with its own price, as the channels', () => {
    expect(precoDoProdutoNaLista(filho(12), undefined, 'listaA')).toBeNull();
  });

  it('precoDaTabela’s normalisation holds on the parentless arm AND the child arms: a stored 0 is no price, NEAR-MISS 10.006 rounds to 10.01', () => {
    expect(precoDoProdutoNaLista(produto({ precos: precosA(0) }), undefined, 'listaA')).toBeNull();
    expect(precoDoProdutoNaLista(filho(0), pai(null, false), 'listaA')).toBeNull();
    expect(precoDoProdutoNaLista(filho(12), pai(0.004, true), 'listaA')).toBeNull();
    expect(precoDoProdutoNaLista(produto({ precos: precosA(10.006) }), undefined, 'listaA')).toBe(
      10.01,
    );
    expect(precoDoProdutoNaLista(filho(null), pai(10.006, true), 'listaA')).toBe(10.01);
  });

  it('pedido ≡ channels across the whole flag × parent × child matrix', () => {
    for (const propaga of [true, false]) {
      for (const valorPai of [10.5, null]) {
        for (const valorFilho of [12, null]) {
          const esperado = precoDoFilhoNaTabela(
            {
              precosDoPai: precosA(valorPai),
              propagaPreco: propagaPrecoAosFilhos(propaga),
              precosDoFilho: precosA(valorFilho),
            },
            'listaA',
          );
          expect(
            precoDoProdutoNaLista(filho(valorFilho), pai(valorPai, propaga), 'listaA'),
            `propaga=${propaga} pai=${valorPai} filho=${valorFilho}`,
          ).toBe(esperado);
        }
      }
    }
  });
});

describe('precoFromProduto — reads the parent for every variation child', () => {
  it('a produto with no paiId never reads Firestore', async () => {
    await expect(precoFromProduto(db, produto({ precos: precosA(42) }), 'listaA')).resolves.toBe(
      42,
    );
    expect(getDocMock).not.toHaveBeenCalled();
  });

  it('a PRICED child still reads its parent — its own price no longer short-circuits — and takes the propagating parent’s', async () => {
    getDocMock.mockResolvedValue({ data: () => pai(10.5, true) } as never);

    await expect(precoFromProduto(db, filho(12), 'listaA')).resolves.toBe(10.5);
    expect(docRefMock).toHaveBeenCalledWith(db, {}, 'pai-1');
    expect(getDocMock).toHaveBeenCalledTimes(1);
  });

  it('a non-propagating parent leaves the child its own price', async () => {
    getDocMock.mockResolvedValue({ data: () => pai(10.5, false) } as never);

    await expect(precoFromProduto(db, filho(12), 'listaA')).resolves.toBe(12);
  });

  it('a missing parent document ⇒ null', async () => {
    getDocMock.mockResolvedValue({ data: () => undefined } as never);

    await expect(precoFromProduto(db, filho(12), 'listaA')).resolves.toBeNull();
  });

  it('uses the reader it is given instead of its own getDoc', async () => {
    const lerPai = vi.fn(async () => pai(10.5, true));

    await expect(precoFromProduto(db, filho(12), 'listaA', lerPai)).resolves.toBe(10.5);
    expect(lerPai).toHaveBeenCalledWith('pai-1');
    expect(getDocMock).not.toHaveBeenCalled();
  });
});

describe('lerProdutoUmaVez — one read per id for the life of the reader', () => {
  it('two sizes of one family read their parent ONCE; a different id is its own read', async () => {
    getDocMock.mockImplementation(
      async (ref) =>
        ({
          data: () =>
            (ref as unknown as { id: string }).id === 'pai-1' ? pai(10.5, true) : undefined,
        }) as never,
    );
    const ler = lerProdutoUmaVez(db);

    const [p, m] = await Promise.all([
      precoFromProduto(db, filho(12), 'listaA', ler),
      precoFromProduto(db, filho(null), 'listaA', ler),
    ]);
    expect([p, m]).toEqual([10.5, 10.5]);
    expect(getDocMock).toHaveBeenCalledTimes(1);

    await ler('outro');
    expect(getDocMock).toHaveBeenCalledTimes(2);
  });

  it('a NEW reader reads again — the memo never outlives its batch', async () => {
    getDocMock.mockResolvedValue({ data: () => pai(10.5, true) } as never);

    await lerProdutoUmaVez(db)('pai-1');
    await lerProdutoUmaVez(db)('pai-1');
    expect(getDocMock).toHaveBeenCalledTimes(2);
  });
});
