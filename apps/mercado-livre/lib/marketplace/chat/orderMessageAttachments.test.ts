import { createHash } from 'node:crypto';
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import {
  type MercadoLivreApi,
  MercadoLivreHttpError,
  MercadoLivreNetworkError,
} from '@delfrance/integrations-mercado-livre';

// Mock the upload seam only — the cache-read path runs against the FakeDb
// through the real `arquivoCollection` handle.
const h = vi.hoisted(() => ({
  putArquivoAdmin: vi.fn(async () => ({ id: 'x', created: true })),
}));
vi.mock('../core/arquivoUpload', async (importActual) => {
  const actual = await importActual<typeof import('../core/arquivoUpload')>();
  return { ...actual, putArquivoAdmin: h.putArquivoAdmin };
});

import type { Bucket } from '../core/arquivoUpload';
import {
  ensureOrderMessageAttachmentArquivo,
  orderMessageAttachmentArquivoId,
} from './orderMessageAttachments';

/* --------------------------------- fakes ----------------------------------- */

type DocData = Record<string, unknown>;

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();

  private col(path: string): Map<string, DocData> {
    let c = this.cols.get(path);
    if (!c) this.cols.set(path, (c = new Map()));
    return c;
  }
  seed(path: string, id: string, data: DocData): void {
    this.col(path).set(id, data);
  }

  collection(path: string) {
    const col = this.col(path);
    return {
      doc: (id: string) => ({
        id,
        get: async () => ({ exists: col.has(id), id, data: () => col.get(id) }),
      }),
    };
  }
}

const asDb = (db: FakeDb) => db as unknown as Firestore;

const BUCKET = { name: 'demo-erp.appspot.com' } as unknown as Bucket;
const CONTA = 'conta-A';
const PACK_ID = '2000000089077943';
// ML mints `<userId>_<uuid>.<ext>` — already unique per conta, which is why the
// digest below can key on the filename alone.
const FILENAME = '415460047_a96d8dea-38cd-4402-938e-80a1c134fc5d.jpg';
const DOC_ID = createHash('sha256')
  .update(`/documents/integracao/${CONTA}-${FILENAME}`, 'utf8')
  .digest('hex');

function apiWithDownload(impl: () => Promise<unknown>) {
  const download = vi.fn(impl);
  const api = { downloadPostSaleAttachment: download } as unknown as MercadoLivreApi;
  return { api, download };
}

const deps = (db: FakeDb, api: MercadoLivreApi) => ({ db: asDb(db), api, bucket: BUCKET });
const args = { contaId: CONTA, packId: PACK_ID, filename: FILENAME };

const bytes = () => new Uint8Array([1, 2, 3]);

let warnSpy: MockInstance;
beforeEach(() => {
  h.putArquivoAdmin.mockClear();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warnSpy.mockRestore();
});

/* --------------------------------- tests ----------------------------------- */

describe('orderMessageAttachmentArquivoId', () => {
  it('is the leading-slash conta-path digest, keyed on the ML filename', () => {
    // ⚠️ `contaPathLegacyMl` keeps the LEADING slash. Normalizing it through
    // `toOuterRef` would silently change every id.
    expect(orderMessageAttachmentArquivoId(CONTA, FILENAME)).toBe(DOC_ID);
  });

  it('is stable across calls — a re-processed pack must not fork the arquivo', () => {
    expect(orderMessageAttachmentArquivoId(CONTA, FILENAME)).toBe(
      orderMessageAttachmentArquivoId(CONTA, FILENAME),
    );
  });
});

describe('ensureOrderMessageAttachmentArquivo', () => {
  it('downloads and uploads on a miss, returning the arquivo outer ref', async () => {
    const db = new FakeDb();
    const { api, download } = apiWithDownload(async () => ({
      bytes: bytes(),
      contentType: 'image/jpeg',
    }));

    const res = await ensureOrderMessageAttachmentArquivo(deps(db, api), args);

    expect(res).toEqual({ ok: true, arquivoOuterRef: `documents/arquivos/${DOC_ID}` });
    expect(download).toHaveBeenCalledWith(FILENAME);
    expect(h.putArquivoAdmin).toHaveBeenCalledTimes(1);
  });

  it('files the bytes under the PACK path, not the claims one', async () => {
    const db = new FakeDb();
    const { api } = apiWithDownload(async () => ({ bytes: bytes(), contentType: 'image/jpeg' }));

    await ensureOrderMessageAttachmentArquivo(deps(db, api), args);

    expect(h.putArquivoAdmin).toHaveBeenCalledWith(
      expect.objectContaining({
        docId: DOC_ID,
        storagePath: `mercado-livre/${CONTA}/packs/${PACK_ID}/${FILENAME}`,
      }),
    );
  });

  it('short-circuits on a cache hit WITHOUT calling ML', async () => {
    // The whole point of the cache: a re-processed pack must cost zero ML calls.
    const db = new FakeDb();
    db.seed('arquivos', DOC_ID, { url: 'https://storage/x.jpg' });
    const { api, download } = apiWithDownload(async () => {
      throw new Error('must not be called');
    });

    const res = await ensureOrderMessageAttachmentArquivo(deps(db, api), args);

    expect(res).toEqual({ ok: true, arquivoOuterRef: `documents/arquivos/${DOC_ID}` });
    expect(download).not.toHaveBeenCalled();
    expect(h.putArquivoAdmin).not.toHaveBeenCalled();
  });

  it('a stale create-first anchor (url: null) is NOT a hit — it re-downloads', async () => {
    const db = new FakeDb();
    db.seed('arquivos', DOC_ID, { url: null });
    const { api, download } = apiWithDownload(async () => ({
      bytes: bytes(),
      contentType: 'image/jpeg',
    }));

    const res = await ensureOrderMessageAttachmentArquivo(deps(db, api), args);

    expect(res).toMatchObject({ ok: true });
    expect(download).toHaveBeenCalledTimes(1);
  });

  describe('failure disposition', () => {
    // ⚠️ The half most easily got backwards. Deterministic → skip (the text
    // mensagem still lands with its `[n anexos]` note). Transient → RETHROW, so
    // the Cloud Tasks retry re-lands the whole message.

    it('skips a 500 — which is how ML reports a MISSING attachment on this route', async () => {
      // ML documents no 404 for `GET /messages/attachments/{id}`, only 400 and
      // 500. If a 500 rethrew, a permanently-gone file would retry forever.
      const db = new FakeDb();
      const { api } = apiWithDownload(async () => {
        throw new MercadoLivreHttpError('File can not be saved, try it later', 500, null);
      });

      const res = await ensureOrderMessageAttachmentArquivo(deps(db, api), args);

      expect(res).toEqual({ ok: false, skipped: 'http-error' });
      expect(warnSpy).toHaveBeenCalled();
      expect(h.putArquivoAdmin).not.toHaveBeenCalled();
    });

    it('skips a 400 (bad site_id and friends)', async () => {
      const db = new FakeDb();
      const { api } = apiWithDownload(async () => {
        throw new MercadoLivreHttpError("Invalid site_id: 'XYZ'", 400, null);
      });

      expect(await ensureOrderMessageAttachmentArquivo(deps(db, api), args)).toEqual({
        ok: false,
        skipped: 'http-error',
      });
    });

    it('distinguishes an EMPTY BODY from a refusal (2xx status)', async () => {
      // The client throws a 2xx-carrying HTTP error rather than handing back a
      // zero-byte file; the two are reported separately so a warn is readable.
      const db = new FakeDb();
      const { api } = apiWithDownload(async () => {
        throw new MercadoLivreHttpError('anexo vazio', 200, null);
      });

      expect(await ensureOrderMessageAttachmentArquivo(deps(db, api), args)).toEqual({
        ok: false,
        skipped: 'empty-body',
      });
    });

    it('RETHROWS a transient network error so the task retry re-lands it', async () => {
      const db = new FakeDb();
      const { api } = apiWithDownload(async () => {
        throw new MercadoLivreNetworkError('ECONNRESET');
      });

      await expect(ensureOrderMessageAttachmentArquivo(deps(db, api), args)).rejects.toThrow(
        MercadoLivreNetworkError,
      );
      expect(h.putArquivoAdmin).not.toHaveBeenCalled();
    });

    it('rethrows an unrecognised error rather than swallowing it', async () => {
      const db = new FakeDb();
      const { api } = apiWithDownload(async () => {
        throw new TypeError('bug');
      });

      await expect(ensureOrderMessageAttachmentArquivo(deps(db, api), args)).rejects.toThrow(
        TypeError,
      );
    });
  });

  it('defaults the content type when ML sends none', async () => {
    const db = new FakeDb();
    const { api } = apiWithDownload(async () => ({ bytes: bytes(), contentType: null }));

    await ensureOrderMessageAttachmentArquivo(deps(db, api), args);

    expect(h.putArquivoAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: 'application/octet-stream' }),
    );
  });
});
