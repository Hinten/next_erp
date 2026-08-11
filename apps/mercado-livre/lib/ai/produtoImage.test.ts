import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import type { Foto } from '@delfrance/schemas';

const h = vi.hoisted(() => ({
  /** arquivo doc id → stored data, or absent for "not created yet". */
  docs: new Map<string, Record<string, unknown>>(),
}));

vi.mock('@delfrance/data/admin/collections', () => ({
  arquivoCollection: {
    docRef: (_db: unknown, _ctx: unknown, id: string) => ({
      get: async () => ({ exists: h.docs.has(id), data: () => h.docs.get(id) }),
    }),
    docPath: (_ctx: unknown, id: string) => `arquivos/${id}`,
    parseRead: (data: unknown) => data,
  },
}));

const { loadProdutoImage } = await import('./produtoImage');

function foto(over: Partial<Foto> = {}): Foto {
  return {
    arquivoOuterRef: 'arquivos/prod_hash',
    arquivo200pxOuterRef: 'arquivos/prod_hash_200',
    arquivo400pxOuterRef: 'arquivos/prod_hash_400',
    arquivoJpegOuterRef: 'arquivos/prod_hash_jpeg',
    ...over,
  } as Foto;
}

function deps(download = vi.fn(async () => new Uint8Array([1, 2, 3]))) {
  return { db: {} as Firestore, download };
}

beforeEach(() => {
  h.docs.clear();
});

describe('loadProdutoImage', () => {
  it('prefers the 400 px derivative', () => {
    h.docs.set('prod_hash_400', { filepath: 'produtos/p/derivatives/hash_400.jpeg' });
    h.docs.set('prod_hash_200', { filepath: 'produtos/p/derivatives/hash_200.jpeg' });
    const d = deps();
    return loadProdutoImage(d, [foto()]).then((image) => {
      expect(d.download).toHaveBeenCalledWith('produtos/p/derivatives/hash_400.jpeg');
      expect(image).toEqual({ base64: 'AQID', mimeType: 'image/jpeg' });
    });
  });

  it('falls back to 200 px when only it has landed', async () => {
    // The resize function is asynchronous — a freshly uploaded photo can have
    // one derivative and not the other.
    h.docs.set('prod_hash_200', { filepath: 'produtos/p/derivatives/hash_200.jpeg' });
    const d = deps();
    await loadProdutoImage(d, [foto()]);
    expect(d.download).toHaveBeenCalledWith('produtos/p/derivatives/hash_200.jpeg');
  });

  it('NEVER falls back to the original', async () => {
    // An original can be many megabytes and there is no server-side resize
    // here; a text-only suggestion beats shipping one.
    h.docs.set('prod_hash', { filepath: 'produtos/p/originals/hash.jpg' });
    const d = deps();
    await expect(loadProdutoImage(d, [foto()])).resolves.toBeNull();
    expect(d.download).not.toHaveBeenCalled();
  });

  it('runs without an image when the produto has no photos', async () => {
    await expect(loadProdutoImage(deps(), [])).resolves.toBeNull();
    await expect(loadProdutoImage(deps(), null)).resolves.toBeNull();
  });

  it('skips a derivative whose arquivo doc has no storage path', async () => {
    h.docs.set('prod_hash_400', { filepath: null });
    h.docs.set('prod_hash_200', { filepath: null });
    await expect(loadProdutoImage(deps(), [foto()])).resolves.toBeNull();
  });

  it('skips an image larger than the ceiling', async () => {
    // A 400 px JPEG is tens of KB; anything near the cap means the ref points
    // somewhere unexpected.
    h.docs.set('prod_hash_400', { filepath: 'produtos/p/derivatives/hash_400.jpeg' });
    const d = deps(vi.fn(async () => new Uint8Array(3 * 1024 * 1024)));
    await expect(loadProdutoImage(d, [foto()])).resolves.toBeNull();
  });

  it('skips an empty download rather than sending zero bytes', async () => {
    h.docs.set('prod_hash_400', { filepath: 'produtos/p/derivatives/hash_400.jpeg' });
    const d = deps(vi.fn(async () => new Uint8Array()));
    await expect(loadProdutoImage(d, [foto()])).resolves.toBeNull();
  });

  it('honours the arquivo content type', async () => {
    h.docs.set('prod_hash_400', {
      filepath: 'produtos/p/derivatives/hash_400.jpeg',
      contentType: 'image/png',
    });
    const image = await loadProdutoImage(deps(), [foto()]);
    expect(image?.mimeType).toBe('image/png');
  });

  it('tolerates a foto whose derivative refs are null (non-produto owner)', async () => {
    await expect(
      loadProdutoImage(deps(), [foto({ arquivo200pxOuterRef: null, arquivo400pxOuterRef: null })]),
    ).resolves.toBeNull();
  });
});
