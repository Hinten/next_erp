import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase/firestore';
import type { FirebaseStorage } from 'firebase/storage';
import { productArquivoId, productOriginalPath, productVideoPath } from '@delfrance/schemas';

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
const { uploadProductImage, uploadProductVideo, uploadFile } = await import('./upload');

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
    expect(mocks.updateDoc).not.toHaveBeenCalled();
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
