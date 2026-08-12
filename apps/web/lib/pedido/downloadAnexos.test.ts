import { describe, expect, it, vi } from 'vitest';
import type { Arquivo, Pedido, Produto } from '@delfrance/schemas';
import { FILETYPE } from '@delfrance/schemas';
import type { Firestore } from 'firebase/firestore';

import { createMemoryArquivoCache } from '@/lib/arquivos/localArquivoCache';

import {
  arquivoIdFromOuterRef,
  collectDistinctArquivoIds,
  downloadAnexos,
  fileNamesForBatch,
  parentIdsMissing,
  productIdsFromPedidos,
} from './downloadAnexos';

function pedido(itens: Pedido['itens']): Pedido {
  return { itens } as Pedido;
}

function produto(partial: Partial<Produto> & { id?: string }): Produto {
  return {
    nome: 'p',
    paiId: null,
    anexos: null,
    ...partial,
  } as Produto;
}

function arquivo(partial: Partial<Arquivo> & { filename?: string }): Arquivo {
  return {
    filename: partial.filename ?? 'file.bin',
    originalFilename: partial.originalFilename ?? null,
    contentType: partial.contentType ?? 'application/pdf',
    url: partial.url ?? 'https://example.test/a',
    filetype: FILETYPE.document,
    filepath: null,
    externalIds: [],
    criadoEm: 0,
    resizeState: null,
    uploadState: 'finalized',
    markedForDeletionAt: null,
    ...partial,
  } as Arquivo;
}

describe('arquivoIdFromOuterRef', () => {
  it('parses a bare arquivos/<id> ref', () => {
    expect(arquivoIdFromOuterRef('arquivos/abc123')).toBe('abc123');
  });

  it('rejects bad shapes', () => {
    expect(arquivoIdFromOuterRef('documents/arquivos/x')).toBeNull();
    expect(arquivoIdFromOuterRef('arquivos/')).toBeNull();
    expect(arquivoIdFromOuterRef('')).toBeNull();
  });
});

describe('collectDistinctArquivoIds', () => {
  it('uses the parent produto anexos when the line item is a variation', () => {
    const parent = produto({
      anexos: [{ arquivoOuterRef: 'arquivos/a1' }],
    });
    const child = produto({ paiId: 'parent-1', anexos: null });
    const map = new Map<string, Produto>([
      ['child-1', child],
      ['parent-1', parent],
    ]);
    const { arquivoIds } = collectDistinctArquivoIds(
      [
        pedido({
          'child-1': [{ produtoUid: 'child-1', quantidade: 1, ordem: 0, precoDeVenda: 1 } as never],
        }),
      ],
      map,
    );
    expect(arquivoIds).toEqual(['a1']);
  });

  it('dedupes the same arquivo across pedidos/items', () => {
    const p = produto({
      anexos: [{ arquivoOuterRef: 'arquivos/shared' }, { arquivoOuterRef: 'arquivos/shared' }],
    });
    const map = new Map([['p1', p]]);
    const ped = pedido({
      p1: [{ produtoUid: 'p1', quantidade: 1, ordem: 0, precoDeVenda: 1 } as never],
    });
    const { arquivoIds } = collectDistinctArquivoIds([ped, ped], map);
    expect(arquivoIds).toEqual(['shared']);
  });

  it('skips missing products and unbound lines', () => {
    const { arquivoIds } = collectDistinctArquivoIds(
      [
        pedido({
          NONE: [{ produtoUid: null, quantidade: 1, ordem: 0, precoDeVenda: 1 } as never],
          gone: [{ produtoUid: 'gone', quantidade: 1, ordem: 1, precoDeVenda: 1 } as never],
        }),
      ],
      new Map(),
    );
    expect(arquivoIds).toEqual([]);
  });
});

describe('fileNamesForBatch', () => {
  it('keeps the original name when unique', () => {
    const names = fileNamesForBatch([
      { id: '1', originalFilename: 'manual.pdf', filename: 'x.pdf' },
    ]);
    expect(names.get('1')).toBe('manual.pdf');
  });

  it('disambiguates collisions within a batch', () => {
    const names = fileNamesForBatch([
      { id: 'aaaaaaaa', originalFilename: 'manual.pdf', filename: 'a.pdf' },
      { id: 'bbbbbbbb', originalFilename: 'manual.pdf', filename: 'b.pdf' },
    ]);
    expect(names.get('aaaaaaaa')).toBe('manual.pdf');
    expect(names.get('bbbbbbbb')).toBe('manual-bbbbbbbb.pdf');
  });
});

describe('productIdsFromPedidos / parentIdsMissing', () => {
  it('collects item product ids', () => {
    const ids = productIdsFromPedidos([
      pedido({
        p1: [{ produtoUid: 'p1', quantidade: 1, ordem: 0, precoDeVenda: 1 } as never],
        p2: [{ produtoUid: 'produtos/p2', quantidade: 1, ordem: 1, precoDeVenda: 1 } as never],
      }),
    ]);
    expect(ids.sort()).toEqual(['p1', 'p2']);
  });

  it('lists parent ids not already loaded', () => {
    const map = new Map([
      ['c1', produto({ paiId: 'parent-x' })],
      ['c2', produto({ paiId: null })],
    ]);
    expect(parentIdsMissing(map, new Set(['c1', 'c2']))).toEqual(['parent-x']);
    expect(parentIdsMissing(map, new Set(['c1', 'c2', 'parent-x']))).toEqual([]);
  });
});

describe('downloadAnexos orchestrator', () => {
  const db = {} as Firestore;

  it('returns noneFound when no anexos exist', async () => {
    const result = await downloadAnexos(db, ['ped-1'], {
      delayMs: 0,
      loadPedidos: async () =>
        new Map([
          [
            'ped-1',
            pedido({
              p1: [{ produtoUid: 'p1', quantidade: 1, ordem: 0, precoDeVenda: 1 } as never],
            }),
          ],
        ]),
      loadProdutos: async () => new Map([['p1', produto({ anexos: null })]]),
      loadArquivos: async () => new Map(),
    });
    expect(result.noneFound).toBe(true);
    expect(result.downloaded).toBe(0);
  });

  it('downloads distinct arquivos with delay between files', async () => {
    const cache = createMemoryArquivoCache();
    const save = vi.fn();
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes('a1')) return new Response(new Uint8Array([1]).buffer, { status: 200 });
      return new Response(new Uint8Array([2]).buffer, { status: 200 });
    });

    const result = await downloadAnexos(db, ['ped-1'], {
      cache,
      save,
      fetchImpl,
      sleep,
      delayMs: 250,
      loadPedidos: async () =>
        new Map([
          [
            'ped-1',
            pedido({
              child: [{ produtoUid: 'child', quantidade: 1, ordem: 0, precoDeVenda: 1 } as never],
            }),
          ],
        ]),
      loadProdutos: async (ids) => {
        const map = new Map<string, Produto>();
        if (ids.includes('child')) map.set('child', produto({ paiId: 'parent' }));
        if (ids.includes('parent')) {
          map.set(
            'parent',
            produto({
              anexos: [{ arquivoOuterRef: 'arquivos/a1' }, { arquivoOuterRef: 'arquivos/a2' }],
            }),
          );
        }
        return map;
      },
      loadArquivos: async () =>
        new Map([
          [
            'a1',
            arquivo({ filename: 'one.pdf', originalFilename: 'one.pdf', url: 'https://x/a1' }),
          ],
          [
            'a2',
            arquivo({ filename: 'two.pdf', originalFilename: 'two.pdf', url: 'https://x/a2' }),
          ],
        ]),
    });

    expect(result.downloaded).toBe(2);
    expect(result.fromCache).toBe(0);
    expect(result.noneFound).toBe(false);
    expect(save).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(250);
    // Second pass hits cache.
    const result2 = await downloadAnexos(db, ['ped-1'], {
      cache,
      save,
      fetchImpl,
      sleep,
      delayMs: 0,
      loadPedidos: async () =>
        new Map([
          [
            'ped-1',
            pedido({
              child: [{ produtoUid: 'child', quantidade: 1, ordem: 0, precoDeVenda: 1 } as never],
            }),
          ],
        ]),
      loadProdutos: async (ids) => {
        const map = new Map<string, Produto>();
        if (ids.includes('child')) map.set('child', produto({ paiId: 'parent' }));
        if (ids.includes('parent')) {
          map.set(
            'parent',
            produto({
              anexos: [{ arquivoOuterRef: 'arquivos/a1' }, { arquivoOuterRef: 'arquivos/a2' }],
            }),
          );
        }
        return map;
      },
      loadArquivos: async () =>
        new Map([
          [
            'a1',
            arquivo({ filename: 'one.pdf', originalFilename: 'one.pdf', url: 'https://x/a1' }),
          ],
          [
            'a2',
            arquivo({ filename: 'two.pdf', originalFilename: 'two.pdf', url: 'https://x/a2' }),
          ],
        ]),
    });
    expect(result2.fromCache).toBe(2);
    // No additional network after the first two fetches.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('skips a failed file and continues the batch', async () => {
    const cache = createMemoryArquivoCache();
    const save = vi.fn();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('bad')) return new Response(null, { status: 500 });
      return new Response(new Uint8Array([1]).buffer, { status: 200 });
    });

    const result = await downloadAnexos(db, ['ped-1'], {
      cache,
      save,
      fetchImpl,
      delayMs: 0,
      loadPedidos: async () =>
        new Map([
          [
            'ped-1',
            pedido({
              p1: [{ produtoUid: 'p1', quantidade: 1, ordem: 0, precoDeVenda: 1 } as never],
            }),
          ],
        ]),
      loadProdutos: async () =>
        new Map([
          [
            'p1',
            produto({
              anexos: [{ arquivoOuterRef: 'arquivos/bad' }, { arquivoOuterRef: 'arquivos/good' }],
            }),
          ],
        ]),
      loadArquivos: async () =>
        new Map([
          ['bad', arquivo({ filename: 'bad.pdf', url: 'https://x/bad' })],
          ['good', arquivo({ filename: 'good.pdf', url: 'https://x/good' })],
        ]),
    });

    expect(result.downloaded).toBe(1);
    expect(result.noneFound).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(save).toHaveBeenCalledOnce();
  });

  it('sets noneFound false when anexos exist but every download fails', async () => {
    const result = await downloadAnexos(db, ['ped-1'], {
      cache: createMemoryArquivoCache(),
      save: vi.fn(),
      fetchImpl: vi.fn(async () => new Response(null, { status: 500 })),
      delayMs: 0,
      loadPedidos: async () =>
        new Map([
          [
            'ped-1',
            pedido({
              p1: [{ produtoUid: 'p1', quantidade: 1, ordem: 0, precoDeVenda: 1 } as never],
            }),
          ],
        ]),
      loadProdutos: async () =>
        new Map([
          [
            'p1',
            produto({
              anexos: [{ arquivoOuterRef: 'arquivos/a1' }],
            }),
          ],
        ]),
      loadArquivos: async () =>
        new Map([['a1', arquivo({ filename: 'a.pdf', url: 'https://x/a1' })]]),
    });

    expect(result.noneFound).toBe(false);
    expect(result.downloaded).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('sets noneFound false when arquivo docs are missing', async () => {
    const result = await downloadAnexos(db, ['ped-1'], {
      delayMs: 0,
      loadPedidos: async () =>
        new Map([
          [
            'ped-1',
            pedido({
              p1: [{ produtoUid: 'p1', quantidade: 1, ordem: 0, precoDeVenda: 1 } as never],
            }),
          ],
        ]),
      loadProdutos: async () =>
        new Map([
          [
            'p1',
            produto({
              anexos: [{ arquivoOuterRef: 'arquivos/missing' }],
            }),
          ],
        ]),
      loadArquivos: async () => new Map(),
    });

    expect(result.noneFound).toBe(false);
    expect(result.downloaded).toBe(0);
    expect(result.errors.some((e) => /não encontrado/i.test(e))).toBe(true);
  });
});
