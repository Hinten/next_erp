import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase/firestore';
import type { FirebaseStorage } from 'firebase/storage';
import {
  productAnexoPath,
  productArquivoId,
  productOriginalPath,
  productVideoPath,
  tabMediArquivoId,
  tabMediOriginalPath,
} from '@delfrance/schemas';

import { sha512Hex } from './hash';

const mocks = vi.hoisted(() => ({
  getDoc: vi.fn(),
  setDoc: vi.fn(),
  updateDoc: vi.fn(),
  uploadBytes: vi.fn(),
  getDownloadURL: vi.fn(),
}));

vi.mock('firebase/firestore', () => ({
  getDoc: mocks.getDoc,
  setDoc: mocks.setDoc,
  updateDoc: mocks.updateDoc,
}));

vi.mock('firebase/storage', () => ({
  ref: (_storage: unknown, path: string) => ({ __path: path }),
  uploadBytes: mocks.uploadBytes,
  getDownloadURL: mocks.getDownloadURL,
}));

vi.mock('./collection', () => ({
  arquivoCollection: {
    docRef: (_db: unknown, _ctx: unknown, id: string) => ({ __id: id }),
  },
}));

// Imported after the mocks are registered (vi.mock is hoisted).
const {
  uploadProductImage,
  uploadTabMediImage,
  uploadProductVideo,
  uploadProductAnexo,
  uploadFile,
} = await import('./upload');

const db = {} as unknown as Firestore;
const storage = {} as unknown as FirebaseStorage;
const bytes = new Uint8Array([1, 2, 3, 4]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getDoc.mockResolvedValue({ exists: () => false, data: () => undefined });
  mocks.uploadBytes.mockResolvedValue(undefined);
  mocks.getDownloadURL.mockImplementation(
    async (r: { __path: string }) => `https://dl/${r.__path}`,
  );
  mocks.setDoc.mockResolvedValue(undefined);
  mocks.updateDoc.mockResolvedValue(undefined);
});

describe('uploadProductImage', () => {
  it('uploads the original to the product-scoped path + id and writes the Arquivo', async () => {
    const hash = await sha512Hex(bytes);
    const result = await uploadProductImage({
      storage,
      db,
      produtoId: 'p1',
      bytes,
      contentType: 'image/png',
      originalFilename: 'foto.png',
    });

    expect(result.id).toBe(productArquivoId('p1', hash));
    expect(result.arquivo.filepath).toBe('produtos/p1/originals');
    expect(result.arquivo.filename).toBe(`${hash}.png`);
    expect(result.arquivo.filetype).toBe('image');
    expect(result.arquivo.contentType).toBe('image/png');
    expect(result.arquivo.originalFilename).toBe('foto.png');
    expect(result.arquivo.url).toBe(`https://dl/${productOriginalPath('p1', hash, 'png')}`);
    // Product originals are marked 'pending' so the resize fn / reconcile sweep track them.
    expect(result.arquivo.resizeState).toBe('pending');
    // Every create-first upload is born 'pending'; the finalize trigger flips it.
    expect(result.arquivo.uploadState).toBe('pending');

    expect(mocks.uploadBytes).toHaveBeenCalledTimes(1);
    expect(mocks.setDoc).toHaveBeenCalledTimes(1);
    expect(mocks.updateDoc).toHaveBeenCalledTimes(1);

    // Create-first: the anchor doc is written BEFORE the bytes are uploaded.
    expect(mocks.setDoc.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.uploadBytes.mock.invocationCallOrder[0]!,
    );
    // The object carries its owning doc id so the trigger / sweep can map back.
    const uploadOpts = mocks.uploadBytes.mock.calls[0]![2] as {
      customMetadata?: { arquivoId?: string };
    };
    expect(uploadOpts.customMetadata?.arquivoId).toBe(productArquivoId('p1', hash));
  });

  it('rejects a non-image content type', async () => {
    await expect(
      uploadProductImage({
        storage,
        db,
        produtoId: 'p1',
        bytes,
        contentType: 'application/pdf',
      }),
    ).rejects.toThrow(/image\/\*/);
    expect(mocks.uploadBytes).not.toHaveBeenCalled();
  });

  it('dedups: reuses an existing Arquivo and skips the upload', async () => {
    const existing = {
      filetype: 'image',
      filepath: 'produtos/p1/originals',
      filename: 'x.png',
      url: 'https://dl/existing',
      // Already resized — the ordinary dedup hit, which must write nothing.
      resizeState: 'done',
    };
    mocks.getDoc.mockResolvedValue({ exists: () => true, data: () => existing });

    const result = await uploadProductImage({
      storage,
      db,
      produtoId: 'p1',
      bytes,
      contentType: 'image/png',
    });

    expect(result.arquivo).toEqual(existing);
    expect(mocks.uploadBytes).not.toHaveBeenCalled();
    expect(mocks.setDoc).not.toHaveBeenCalled();
    expect(mocks.updateDoc).not.toHaveBeenCalled();
  });
});

describe('putArquivo — healing the resize marker on a dedup hit', () => {
  /** A doc stored before its owner was watched by the resize function. */
  const legacy = {
    filetype: 'image',
    filepath: 'tabMedi/tm1/originals',
    filename: 'x.png',
    url: 'https://dl/existing',
    resizeState: null,
  };

  it('stamps a null marker as pending, so the sweep generates the derivatives', async () => {
    // The sequence this exists for: a size-chart photo uploaded before tabMedi
    // was resized is removed, then re-added within the 1h delete grace. The
    // dedup hit writes nothing, while the caller writes optimistic derivative
    // refs — leaving the foto pointing at three docs that never appear.
    mocks.getDoc.mockResolvedValue({ exists: () => true, data: () => legacy });

    const result = await uploadTabMediImage({
      storage,
      db,
      tabMediId: 'tm1',
      bytes,
      contentType: 'image/png',
    });

    expect(mocks.updateDoc).toHaveBeenCalledTimes(1);
    expect(mocks.updateDoc.mock.calls[0]![1]).toEqual({ resizeState: 'pending' });
    // The returned doc reflects the patch, so a caller reading it back is not
    // told the marker is still null.
    expect(result.arquivo.resizeState).toBe('pending');
    // Still a dedup: no re-upload of identical bytes.
    expect(mocks.uploadBytes).not.toHaveBeenCalled();
    expect(mocks.setDoc).not.toHaveBeenCalled();
  });

  it('heals a legacy PRODUTO original the same way', async () => {
    // Flutter-written originals predate the marker entirely; they get the same
    // treatment rather than a second mechanism.
    mocks.getDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({ ...legacy, filepath: 'produtos/p1/originals' }),
    });

    await uploadProductImage({ storage, db, produtoId: 'p1', bytes, contentType: 'image/png' });
    expect(mocks.updateDoc.mock.calls[0]![1]).toEqual({ resizeState: 'pending' });
  });

  it("NEVER resets a 'done' marker back to pending", async () => {
    // Re-adding an already-resized photo must not re-run the resize; that would
    // turn every dedup hit into work the sweep then has to do again.
    mocks.getDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({ ...legacy, resizeState: 'done' }),
    });

    await uploadTabMediImage({ storage, db, tabMediId: 'tm1', bytes, contentType: 'image/png' });
    expect(mocks.updateDoc).not.toHaveBeenCalled();
  });

  it('does NOT stamp an owner that is not resized at all', async () => {
    // A video or generic file has no derivatives by design, so healing it would
    // hand the sweep a doc it can never complete — it would stay 'pending'
    // forever and be warned about on every run.
    mocks.getDoc.mockResolvedValue({ exists: () => true, data: () => legacy });

    await uploadProductVideo({ storage, db, produtoId: 'p1', bytes, contentType: 'video/mp4' });
    expect(mocks.updateDoc).not.toHaveBeenCalled();
  });
});

describe('uploadTabMediImage', () => {
  it('uploads to the tabMedi-scoped path + id, marked for resize', async () => {
    const hash = await sha512Hex(bytes);
    const result = await uploadTabMediImage({
      storage,
      db,
      tabMediId: 'tm1',
      bytes,
      contentType: 'image/png',
      originalFilename: 'tabela.png',
    });

    expect(result.id).toBe(tabMediArquivoId('tm1', hash));
    expect(result.arquivo.filepath).toBe('tabMedi/tm1/originals');
    expect(result.arquivo.filename).toBe(`${hash}.png`);
    expect(result.arquivo.filetype).toBe('image');
    expect(result.arquivo.url).toBe(`https://dl/${tabMediOriginalPath('tm1', hash, 'png')}`);
    // tabMedi photos ARE resized now, exactly like product images — the marker
    // is what the 48h reconcile sweep queries, so a dropped trigger delivery
    // heals instead of leaving a size chart the AI agent can never read.
    expect(result.arquivo.resizeState).toBe('pending');
    // Still create-first + tracked for the phantom-doc sweep + finalize trigger.
    expect(result.arquivo.uploadState).toBe('pending');

    expect(mocks.uploadBytes).toHaveBeenCalledTimes(1);
    expect(mocks.setDoc).toHaveBeenCalledTimes(1);
    expect(mocks.setDoc.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.uploadBytes.mock.invocationCallOrder[0]!,
    );
    const uploadOpts = mocks.uploadBytes.mock.calls[0]![2] as {
      customMetadata?: { arquivoId?: string };
    };
    expect(uploadOpts.customMetadata?.arquivoId).toBe(tabMediArquivoId('tm1', hash));
  });

  it('rejects a non-image content type', async () => {
    await expect(
      uploadTabMediImage({ storage, db, tabMediId: 'tm1', bytes, contentType: 'application/pdf' }),
    ).rejects.toThrow(/image\/\*/);
    expect(mocks.uploadBytes).not.toHaveBeenCalled();
  });

  it('dedups: reuses an existing Arquivo and skips the upload', async () => {
    // `resizeState: 'done'` = an ordinary dedup hit. A null marker is the
    // legacy case, and it is HEALED rather than passed through — see the
    // "healing the resize marker" block below.
    const existing = {
      filetype: 'image',
      filepath: 'tabMedi/tm1/originals',
      filename: 'x.png',
      resizeState: 'done',
    };
    mocks.getDoc.mockResolvedValue({ exists: () => true, data: () => existing });

    const result = await uploadTabMediImage({
      storage,
      db,
      tabMediId: 'tm1',
      bytes,
      contentType: 'image/png',
    });

    expect(result.arquivo).toEqual(existing);
    expect(mocks.uploadBytes).not.toHaveBeenCalled();
    expect(mocks.setDoc).not.toHaveBeenCalled();
  });
});

describe('uploadProductVideo', () => {
  it('uploads to the product-scoped video path + id and writes the Arquivo', async () => {
    const hash = await sha512Hex(bytes);
    const result = await uploadProductVideo({
      storage,
      db,
      produtoId: 'p1',
      bytes,
      contentType: 'video/mp4',
      originalFilename: 'clip.mp4',
    });

    expect(result.id).toBe(productArquivoId('p1', hash));
    expect(result.arquivo.filepath).toBe('produtos/p1/videos');
    expect(result.arquivo.filename).toBe(`${hash}.mp4`);
    expect(result.arquivo.filetype).toBe('video');
    expect(result.arquivo.url).toBe(`https://dl/${productVideoPath('p1', hash, 'mp4')}`);
    // Videos are not resized → no resize marker (only product-image originals get one)...
    expect(result.arquivo.resizeState).toBeNull();
    // ...but they ARE tracked for the phantom-doc sweep via uploadState.
    expect(result.arquivo.uploadState).toBe('pending');
    expect(mocks.uploadBytes).toHaveBeenCalledTimes(1);
    expect(mocks.setDoc).toHaveBeenCalledTimes(1);
    // Create-first contract applies to videos too: URL is patched, and the object
    // carries its arquivoId so the finalize trigger can flip uploadState (else a
    // video upload would stay stuck 'pending').
    expect(mocks.updateDoc).toHaveBeenCalledTimes(1);
    const uploadOpts = mocks.uploadBytes.mock.calls[0]![2] as {
      customMetadata?: { arquivoId?: string };
    };
    expect(uploadOpts.customMetadata?.arquivoId).toBe(productArquivoId('p1', hash));
  });

  it('rejects a non-video content type', async () => {
    await expect(
      uploadProductVideo({ storage, db, produtoId: 'p1', bytes, contentType: 'image/png' }),
    ).rejects.toThrow(/video\/\*/);
    expect(mocks.uploadBytes).not.toHaveBeenCalled();
  });

  it('dedups: reuses an existing Arquivo and skips the upload', async () => {
    const existing = { filetype: 'video', filepath: 'produtos/p1/videos', filename: 'x.mp4' };
    mocks.getDoc.mockResolvedValue({ exists: () => true, data: () => existing });

    const result = await uploadProductVideo({
      storage,
      db,
      produtoId: 'p1',
      bytes,
      contentType: 'video/mp4',
    });

    expect(result.arquivo).toEqual(existing);
    expect(mocks.uploadBytes).not.toHaveBeenCalled();
    expect(mocks.setDoc).not.toHaveBeenCalled();
    expect(mocks.updateDoc).not.toHaveBeenCalled();
  });
});

describe('uploadProductAnexo', () => {
  it('uploads any content type to the product-scoped anexo path + id, filetype from MIME', async () => {
    const hash = await sha512Hex(bytes);
    const result = await uploadProductAnexo({
      storage,
      db,
      produtoId: 'p1',
      bytes,
      contentType: 'application/pdf',
      originalFilename: 'manual.pdf',
    });

    expect(result.id).toBe(productArquivoId('p1', hash));
    expect(result.arquivo.filepath).toBe('produtos/p1/anexos');
    expect(result.arquivo.filename).toBe(`${hash}.pdf`);
    // The Flutter port hardcoded 'image'; we derive the filetype from the MIME.
    expect(result.arquivo.filetype).toBe('document');
    expect(result.arquivo.url).toBe(`https://dl/${productAnexoPath('p1', hash, 'pdf')}`);
    // Anexos are not resized → no resize marker...
    expect(result.arquivo.resizeState).toBeNull();
    // ...but ARE tracked for the phantom-doc sweep + finalize trigger.
    expect(result.arquivo.uploadState).toBe('pending');
    expect(mocks.uploadBytes).toHaveBeenCalledTimes(1);
    const uploadOpts = mocks.uploadBytes.mock.calls[0]![2] as {
      customMetadata?: { arquivoId?: string };
    };
    expect(uploadOpts.customMetadata?.arquivoId).toBe(productArquivoId('p1', hash));
  });

  it('accepts a content type that is neither image nor video (no guard)', async () => {
    await expect(
      uploadProductAnexo({ storage, db, produtoId: 'p1', bytes, contentType: 'application/zip' }),
    ).resolves.toMatchObject({ arquivo: { filetype: 'application' } });
    expect(mocks.uploadBytes).toHaveBeenCalledTimes(1);
  });

  it('dedups: reuses an existing Arquivo and skips the upload', async () => {
    const existing = { filetype: 'document', filepath: 'produtos/p1/anexos', filename: 'x.pdf' };
    mocks.getDoc.mockResolvedValue({ exists: () => true, data: () => existing });

    const result = await uploadProductAnexo({
      storage,
      db,
      produtoId: 'p1',
      bytes,
      contentType: 'application/pdf',
    });

    expect(result.arquivo).toEqual(existing);
    expect(mocks.uploadBytes).not.toHaveBeenCalled();
    expect(mocks.setDoc).not.toHaveBeenCalled();
  });
});

describe('uploadFile', () => {
  it('defaults to media/<hash>.<ext> with a bare-hash id', async () => {
    const hash = await sha512Hex(bytes);
    const result = await uploadFile({
      storage,
      db,
      bytes,
      contentType: 'application/pdf',
    });
    expect(result.id).toBe(hash);
    expect(result.arquivo.filepath).toBe('media');
    expect(result.arquivo.filename).toBe(`${hash}.pdf`);
    expect(result.arquivo.filetype).toBe('document');
  });
});
