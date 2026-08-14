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

const { loadFotoImage } = await import('./fotoImage');

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

describe('loadFotoImage', () => {
  it('prefers the 400 px derivative', () => {
    h.docs.set('prod_hash_400', { filepath: 'produtos/p/derivatives', filename: 'hash_400.jpeg' });
    h.docs.set('prod_hash_200', { filepath: 'produtos/p/derivatives', filename: 'hash_200.jpeg' });
    const d = deps();
    return loadFotoImage(d, [foto()]).then((image) => {
      expect(d.download).toHaveBeenCalledWith('produtos/p/derivatives/hash_400.jpeg');
      expect(image).toEqual({ base64: 'AQID', mimeType: 'image/jpeg' });
    });
  });

  it('falls back to 200 px when only it has landed', async () => {
    // The resize function is asynchronous — a freshly uploaded photo can have
    // one derivative and not the other.
    h.docs.set('prod_hash_200', { filepath: 'produtos/p/derivatives', filename: 'hash_200.jpeg' });
    const d = deps();
    await loadFotoImage(d, [foto()]);
    expect(d.download).toHaveBeenCalledWith('produtos/p/derivatives/hash_200.jpeg');
  });

  it('NEVER falls back to the original', async () => {
    // An original can be many megabytes and there is no server-side resize
    // here; a text-only suggestion beats shipping one.
    h.docs.set('prod_hash', { filepath: 'produtos/p/originals', filename: 'hash.jpg' });
    const d = deps();
    await expect(loadFotoImage(d, [foto()])).resolves.toBeNull();
    expect(d.download).not.toHaveBeenCalled();
  });

  it('runs without an image when the produto has no photos', async () => {
    await expect(loadFotoImage(deps(), [])).resolves.toBeNull();
    await expect(loadFotoImage(deps(), null)).resolves.toBeNull();
  });

  it('joins the DIRECTORY and the FILENAME to reach the object', async () => {
    // ⚠️ `Arquivo.filepath` is the Storage directory only — `arquivo.ts:131`
    // says so, and `processOriginal.ts` writes it that way. Downloading
    // `filepath` alone asks the bucket for `produtos/p/derivatives`, a 404 for
    // every produto whose derivative actually landed. This test exists because
    // the original fixtures put the whole object path in `filepath` and so went
    // green against the broken join.
    h.docs.set('prod_hash_400', { filepath: 'produtos/p/derivatives', filename: 'hash_400.jpeg' });
    const d = deps();
    await loadFotoImage(d, [foto()]);
    expect(d.download).toHaveBeenCalledWith('produtos/p/derivatives/hash_400.jpeg');
  });

  it('handles an object at the bucket root, where there is no directory', async () => {
    // The same null-filepath branch `onArquivoDeleted` carries. A missing
    // directory is not a missing object.
    h.docs.set('prod_hash_400', { filepath: null, filename: 'solto.jpeg' });
    const d = deps();
    await loadFotoImage(d, [foto()]);
    expect(d.download).toHaveBeenCalledWith('solto.jpeg');
  });

  it('skips a derivative whose arquivo doc has no filename', async () => {
    // `filename` is the object; without it there is nothing to fetch, whatever
    // the directory says.
    h.docs.set('prod_hash_400', { filepath: 'produtos/p/derivatives', filename: null });
    h.docs.set('prod_hash_200', { filepath: null, filename: null });
    const d = deps();
    await expect(loadFotoImage(d, [foto()])).resolves.toBeNull();
    expect(d.download).not.toHaveBeenCalled();
  });

  it('skips an image larger than the ceiling', async () => {
    // A 400 px JPEG is tens of KB; anything near the cap means the ref points
    // somewhere unexpected.
    h.docs.set('prod_hash_400', { filepath: 'produtos/p/derivatives', filename: 'hash_400.jpeg' });
    const d = deps(vi.fn(async () => new Uint8Array(3 * 1024 * 1024)));
    await expect(loadFotoImage(d, [foto()])).resolves.toBeNull();
  });

  it('skips an empty download rather than sending zero bytes', async () => {
    h.docs.set('prod_hash_400', { filepath: 'produtos/p/derivatives', filename: 'hash_400.jpeg' });
    const d = deps(vi.fn(async () => new Uint8Array()));
    await expect(loadFotoImage(d, [foto()])).resolves.toBeNull();
  });

  it('honours the arquivo content type', async () => {
    h.docs.set('prod_hash_400', {
      filepath: 'produtos/p/derivatives',
      filename: 'hash_400.jpeg',
      contentType: 'image/png',
    });
    const image = await loadFotoImage(deps(), [foto()]);
    expect(image?.mimeType).toBe('image/png');
  });

  it('tolerates a foto whose derivative refs are null (non-produto owner)', async () => {
    await expect(
      loadFotoImage(deps(), [foto({ arquivo200pxOuterRef: null, arquivo400pxOuterRef: null })]),
    ).resolves.toBeNull();
  });
});

/**
 * The measurement agent reads digits off a supplier's size table, where 400 px
 * resolves nothing. It asks for the full-size `jpeg` variant instead — which is
 * why the preference order is a parameter and the ceiling is per-variant.
 */
describe('loadFotoImage — variant preference', () => {
  const jpegDoc = { filepath: 'tabMedi/t/derivatives', filename: 'hash_jpeg.jpeg' };

  it('reads the full-size jpeg derivative when asked for it', async () => {
    h.docs.set('prod_hash_jpeg', jpegDoc);
    h.docs.set('prod_hash_400', { filepath: 'tabMedi/t/derivatives', filename: 'hash_400.jpeg' });
    const d = deps();
    await loadFotoImage(d, [foto()], { prefer: ['jpeg', '400'] });
    expect(d.download).toHaveBeenCalledWith('tabMedi/t/derivatives/hash_jpeg.jpeg');
  });

  it('falls through the requested order when the best variant is missing', async () => {
    h.docs.set('prod_hash_400', { filepath: 'tabMedi/t/derivatives', filename: 'hash_400.jpeg' });
    const d = deps();
    await loadFotoImage(d, [foto()], { prefer: ['jpeg', '400'] });
    expect(d.download).toHaveBeenCalledWith('tabMedi/t/derivatives/hash_400.jpeg');
  });

  it('allows a full-size jpeg past the thumbnail ceiling', async () => {
    // The same 3 MB payload the 400 px case rejects above: a full-resolution
    // re-encode legitimately reaches a few MB, so the ceiling rides on the
    // variant rather than on the loader.
    h.docs.set('prod_hash_jpeg', jpegDoc);
    const d = deps(vi.fn(async () => new Uint8Array(3 * 1024 * 1024)));
    await expect(loadFotoImage(d, [foto()], { prefer: ['jpeg'] })).resolves.not.toBeNull();
  });

  it('still refuses a jpeg past its own, larger ceiling', async () => {
    h.docs.set('prod_hash_jpeg', jpegDoc);
    const d = deps(vi.fn(async () => new Uint8Array(8 * 1024 * 1024)));
    await expect(loadFotoImage(d, [foto()], { prefer: ['jpeg'] })).resolves.toBeNull();
  });

  it('does NOT reach the jpeg variant by default', async () => {
    // Guards the attribute agent's token bill: this module moved packages and
    // gained the jpeg option in the same change, and quietly appending it to the
    // default order would multiply the cost of every attribute suggestion
    // without anything failing.
    h.docs.set('prod_hash_jpeg', jpegDoc);
    const d = deps();
    await expect(loadFotoImage(d, [foto()])).resolves.toBeNull();
    expect(d.download).not.toHaveBeenCalled();
  });
});
