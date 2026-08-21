import { createHash } from 'node:crypto';
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import {
  type MercadoLivreApi,
  MercadoLivreHttpError,
  MercadoLivreNetworkError,
} from '@delfrance/integrations-mercado-livre';

// Mock the upload seam only — the cache-read path runs against the FakeDb
// through the real `arquivoCollection` handle; `putArquivoAdmin`'s own
// create-first behavior is covered by `@delfrance/storage`'s tests.
const h = vi.hoisted(() => ({
  putArquivoAdmin: vi.fn(async () => ({ id: 'x', created: true })),
}));
vi.mock('../core/arquivoUpload', async (importActual) => {
  const actual = await importActual<typeof import('../core/arquivoUpload')>();
  return { ...actual, putArquivoAdmin: h.putArquivoAdmin };
});

import type { Bucket } from '../core/arquivoUpload';
import { claimAttachmentArquivoId, ensureClaimAttachmentArquivo } from './claimAttachments';

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
const CLAIM_ID = 5020646855;
const FILENAME = 'a1b2c3_foto.jpg';
// sha256('/documents/integracao/<contaId>-<filename>') — the attachment
// MENSAGEM digest reused as the arquivo doc id (see the module doc: a NEW
// convention; legacy arquivos ended up keyed by sha512(bytes)).
const DOC_ID = createHash('sha256')
  .update(`/documents/integracao/${CONTA}-${FILENAME}`, 'utf8')
  .digest('hex');

// Package A (`@delfrance/integrations-mercado-livre`) is adding
// `downloadClaimAttachment` to `MercadoLivreApi`; this suite mocks it per the
// pinned contract and keeps a direct handle on the vi.fn for assertions.
function apiWithDownload(impl: () => Promise<unknown>) {
  const download = vi.fn(impl);
  const api = { downloadClaimAttachment: download } as unknown as MercadoLivreApi;
  return { api, download };
}

function deps(db: FakeDb, api: MercadoLivreApi) {
  return { db: asDb(db), api, bucket: BUCKET };
}

const args = { contaId: CONTA, claimId: CLAIM_ID, filename: FILENAME };

let warnSpy: MockInstance;
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
  h.putArquivoAdmin.mockClear();
});

/* --------------------------------- tests ----------------------------------- */

describe('claimAttachmentArquivoId', () => {
  it('hashes the leading-slash conta path + filename (legacy generateUid)', () => {
    expect(claimAttachmentArquivoId(CONTA, FILENAME)).toBe(DOC_ID);
  });

  it('equals the attachment mensagem doc id — one formula, no fork possible', async () => {
    const { makeAttachmentMensagemId } = await import('./claimIds');
    expect(claimAttachmentArquivoId(CONTA, FILENAME)).toBe(
      makeAttachmentMensagemId(CONTA, FILENAME),
    );
  });
});

describe('ensureClaimAttachmentArquivo', () => {
  it('short-circuits on a cached arquivo with a url — NO download, NO upload', async () => {
    const db = new FakeDb();
    db.seed('arquivos', DOC_ID, { url: 'https://storage.example/x?token=t' });
    const { api, download } = apiWithDownload(async () => {
      throw new Error('must not be called');
    });

    const out = await ensureClaimAttachmentArquivo(deps(db, api), args);

    expect(out).toEqual({ ok: true, arquivoOuterRef: `documents/arquivos/${DOC_ID}` });
    expect(download).not.toHaveBeenCalled();
    expect(h.putArquivoAdmin).not.toHaveBeenCalled();
  });

  it('downloads + uploads on a miss, at the legacy doc id and claim storage path', async () => {
    const db = new FakeDb();
    const bytes = new Uint8Array([1, 2, 3]);
    const { api, download } = apiWithDownload(async () => ({ bytes, contentType: 'image/jpeg' }));

    const out = await ensureClaimAttachmentArquivo(deps(db, api), args);

    expect(out).toEqual({ ok: true, arquivoOuterRef: `documents/arquivos/${DOC_ID}` });
    expect(download).toHaveBeenCalledWith(CLAIM_ID, FILENAME);
    expect(h.putArquivoAdmin).toHaveBeenCalledTimes(1);
    expect(h.putArquivoAdmin).toHaveBeenCalledWith({
      db: db as unknown as Firestore,
      bucket: BUCKET,
      docId: DOC_ID,
      storagePath: `mercado-livre/${CONTA}/claims/${CLAIM_ID}/${FILENAME}`,
      bytes,
      contentType: 'image/jpeg',
      filetype: 'image',
    });
  });

  it('re-downloads over a STALE create-first anchor (doc exists, url null)', async () => {
    const db = new FakeDb();
    db.seed('arquivos', DOC_ID, { url: null });
    const { api } = apiWithDownload(async () => ({
      bytes: new Uint8Array([9]),
      contentType: 'application/pdf',
    }));

    const out = await ensureClaimAttachmentArquivo(deps(db, api), args);

    expect(out).toEqual({ ok: true, arquivoOuterRef: `documents/arquivos/${DOC_ID}` });
    expect(h.putArquivoAdmin).toHaveBeenCalledTimes(1);
  });

  it('falls back to application/octet-stream when the download carries no content-type', async () => {
    const db = new FakeDb();
    const { api } = apiWithDownload(async () => ({
      bytes: new Uint8Array([9]),
      contentType: null,
    }));

    await ensureClaimAttachmentArquivo(deps(db, api), args);

    expect(h.putArquivoAdmin).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: 'application/octet-stream',
        filetype: 'application',
      }),
    );
  });

  it('classifies an EMPTY body (MercadoLivreHttpError with a 2xx status) with a warn — no upload', async () => {
    // The real client NEVER returns zero bytes: `downloadClaimAttachment`
    // throws an MercadoLivreHttpError carrying the 2xx status instead.
    const db = new FakeDb();
    const { api } = apiWithDownload(async () => {
      throw new MercadoLivreHttpError('O Mercado Livre retornou um anexo vazio.', 200, null);
    });

    const out = await ensureClaimAttachmentArquivo(deps(db, api), args);

    expect(out).toEqual({ ok: false, skipped: 'empty-body' });
    expect(h.putArquivoAdmin).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('skips a MercadoLivreHttpError (deterministic, any status) with a warn', async () => {
    const db = new FakeDb();
    const { api } = apiWithDownload(async () => {
      throw new MercadoLivreHttpError('HTTP 404', 404, { message: 'not found' });
    });

    const out = await ensureClaimAttachmentArquivo(deps(db, api), args);

    expect(out).toEqual({ ok: false, skipped: 'http-error' });
    expect(h.putArquivoAdmin).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('RETHROWS a MercadoLivreNetworkError (transient — the task retry re-lands it)', async () => {
    const db = new FakeDb();
    const { api } = apiWithDownload(async () => {
      throw new MercadoLivreNetworkError('fetch failed');
    });

    await expect(ensureClaimAttachmentArquivo(deps(db, api), args)).rejects.toBeInstanceOf(
      MercadoLivreNetworkError,
    );
    expect(h.putArquivoAdmin).not.toHaveBeenCalled();
  });

  it('rethrows any other error untouched (no generic swallow)', async () => {
    const db = new FakeDb();
    const boom = new RangeError('boom');
    const { api } = apiWithDownload(async () => {
      throw boom;
    });

    await expect(ensureClaimAttachmentArquivo(deps(db, api), args)).rejects.toBe(boom);
  });
});
