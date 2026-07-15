import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mock the two side-effecting seams: the arquivo handle (Firestore dedup read)
 * and the shared Admin uploader. `@delfrance/schemas` (`filetypeFromMime`,
 * `toOuterRef`) stays REAL so the mime→filetype mapping and the outer-ref format
 * round-trip through the actual production code.
 */
const h = vi.hoisted(() => ({
  arquivoGet: vi.fn(),
  putArquivoAdmin: vi.fn(async () => ({ id: 'ignored', created: true })),
}));

vi.mock('@delfrance/data/admin/collections', () => ({
  arquivoCollection: {
    docRef: () => ({ get: h.arquivoGet }),
  },
}));

vi.mock('@delfrance/storage/admin', () => ({
  putArquivoAdmin: h.putArquivoAdmin,
}));

const { getAndUploadMedia } = await import('./media');

/** A fake WhatsAppClient exposing only the two methods media.ts calls. */
function fakeClient(over: { mime?: string; downloadContentType?: string | null } = {}) {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  return {
    getMediaData: vi.fn(async (mediaId: string) => ({
      id: mediaId,
      url: `https://lookaside.fbsbx.com/${mediaId}`,
      mime_type: over.mime ?? 'image/jpeg',
    })),
    downloadMedia: vi.fn(async () => ({
      data: bytes,
      contentType: over.downloadContentType === undefined ? 'image/jpeg' : over.downloadContentType,
    })),
    _bytes: bytes,
  };
}

function ctx(client: ReturnType<typeof fakeClient>) {
  return {
    db: {} as never,
    bucket: { name: 'b' } as never,
    client: client as never,
    contaId: 'conta_abc123',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.putArquivoAdmin.mockResolvedValue({ id: 'ignored', created: true });
});

describe('getAndUploadMedia — fresh upload', () => {
  it('downloads, uploads via putArquivoAdmin, and returns the documents/arquivos ref', async () => {
    h.arquivoGet.mockResolvedValue({ exists: false, data: () => undefined });
    const client = fakeClient();

    const ref = await getAndUploadMedia(ctx(client), 'MEDIA123');

    expect(ref).toBe('documents/arquivos/wa_MEDIA123');
    expect(client.getMediaData).toHaveBeenCalledWith('MEDIA123');
    expect(client.downloadMedia).toHaveBeenCalledWith('https://lookaside.fbsbx.com/MEDIA123');
    expect(h.putArquivoAdmin).toHaveBeenCalledTimes(1);
    expect(h.putArquivoAdmin).toHaveBeenCalledWith(
      expect.objectContaining({
        docId: 'wa_MEDIA123',
        storagePath: 'whatsapp/conta_abc123/MEDIA123',
        bytes: client._bytes,
        contentType: 'image/jpeg',
        filetype: 'image',
      }),
    );
  });

  it('falls back to the media metadata mime when the download sends no content-type', async () => {
    h.arquivoGet.mockResolvedValue({ exists: false, data: () => undefined });
    const client = fakeClient({ mime: 'audio/ogg', downloadContentType: null });

    await getAndUploadMedia(ctx(client), 'AUD1');

    expect(h.putArquivoAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: 'audio/ogg', filetype: 'audio' }),
    );
  });
});

describe('getAndUploadMedia — dedup', () => {
  it('short-circuits on a cached doc: no Graph call, no re-upload', async () => {
    h.arquivoGet.mockResolvedValue({
      exists: true,
      data: () => ({ url: 'https://firebasestorage.googleapis.com/x' }),
    });
    const client = fakeClient();

    const ref = await getAndUploadMedia(ctx(client), 'MEDIA123');

    expect(ref).toBe('documents/arquivos/wa_MEDIA123');
    expect(client.getMediaData).not.toHaveBeenCalled();
    expect(client.downloadMedia).not.toHaveBeenCalled();
    expect(h.putArquivoAdmin).not.toHaveBeenCalled();
  });

  it('re-uploads through a stale anchor (doc exists but url is empty/null)', async () => {
    h.arquivoGet.mockResolvedValue({ exists: true, data: () => ({ url: null }) });
    const client = fakeClient();

    await getAndUploadMedia(ctx(client), 'MEDIA123');

    expect(client.getMediaData).toHaveBeenCalledTimes(1);
    expect(h.putArquivoAdmin).toHaveBeenCalledTimes(1);
  });
});

describe('getAndUploadMedia — filetype per media type', () => {
  const cases: Array<[string, string]> = [
    ['image/jpeg', 'image'],
    ['video/mp4', 'video'],
    ['audio/ogg; codecs=opus', 'audio'],
    ['application/pdf', 'document'],
    ['application/zip', 'application'],
    ['text/plain', 'txt'],
  ];

  it.each(cases)('maps mime %s → filetype %s', async (mime, filetype) => {
    h.arquivoGet.mockResolvedValue({ exists: false, data: () => undefined });
    const client = fakeClient({ mime });

    await getAndUploadMedia(ctx(client), 'M');

    expect(h.putArquivoAdmin).toHaveBeenCalledWith(expect.objectContaining({ filetype }));
  });
});
