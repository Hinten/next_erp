import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';

import type { Bucket } from '../core/arquivoUpload';
import { importProdutoPhotos } from './importPhotos';

/* ------------------------------ fakes ------------------------------------- */

type DocData = Record<string, unknown>;

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  readonly updates: Array<{ path: string; patch: DocData }> = [];

  private col(path: string): Map<string, DocData> {
    let c = this.cols.get(path);
    if (!c) this.cols.set(path, (c = new Map()));
    return c;
  }
  seed(path: string, id: string, data: DocData): void {
    this.col(path).set(id, data);
  }
  docData(path: string, id: string): DocData | undefined {
    return this.col(path).get(id);
  }

  collection(path: string) {
    const col = this.col(path);
    const self = this;
    return {
      doc: (id: string) => ({
        id,
        get: async () => ({ exists: col.has(id), id, data: () => col.get(id) }),
        set: async (data: DocData, opts?: { merge?: boolean }) => {
          col.set(id, opts?.merge ? { ...(col.get(id) ?? {}), ...data } : { ...data });
        },
        update: async (patch: DocData) => {
          self.updates.push({ path: `${path}/${id}`, patch });
          col.set(id, { ...(col.get(id) ?? {}), ...patch });
        },
      }),
    };
  }
}
const asDb = (db: FakeDb) => db as unknown as Firestore;

class FakeBucket {
  readonly saved: string[] = [];
  readonly name = 'demo-erp.appspot.com';
  file(path: string) {
    const self = this;
    return {
      save: async () => {
        self.saved.push(path);
      },
    };
  }
}
const asBucket = (b: FakeBucket) => b as unknown as Bucket;

type FetchEntry = { status?: number; contentType?: string; body?: string } | 'network-error';

function fakeFetch(map: Record<string, FetchEntry>) {
  return vi.fn(async (url: string | URL) => {
    const entry = map[String(url)];
    if (!entry) throw new TypeError(`no mock for ${String(url)}`);
    if (entry === 'network-error') throw new TypeError('fetch failed'); // undici network error
    const status = entry.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (h: string) =>
          h.toLowerCase() === 'content-type' ? (entry.contentType ?? 'image/jpeg') : null,
      },
      arrayBuffer: async () => {
        const b = Buffer.from(entry.body ?? 'imgbytes');
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      },
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
}

const CONTA = 'conta-A';
const INTEG_REF = `documents/integracao/${CONTA}`;
const hashOf = (body: string) => createHash('sha512').update(Buffer.from(body)).digest('hex');

function deps(db: FakeDb, bucket: FakeBucket, fetchImpl: typeof globalThis.fetch) {
  return { db: asDb(db), bucket: asBucket(bucket), integracaoId: CONTA, fetchImpl };
}

/* ------------------------------ tests ------------------------------------- */

describe('importProdutoPhotos', () => {
  it('imports a new picture: fetches the -F url, creates the arquivo, appends the foto', async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();
    db.seed('produtos', 'prod1', { nome: 'x' });
    const body = 'imgbytes-1';
    const fetch = fakeFetch({
      'https://http2.mlstatic.com/PIC1-F.jpg': { contentType: 'image/jpeg', body },
    });

    const res = await importProdutoPhotos(deps(db, bucket, fetch), 'prod1', [
      { id: 'PIC1', secure_url: 'https://http2.mlstatic.com/PIC1-O.jpg' },
    ]);
    expect(res).toEqual({ imported: 1, skipped: 0, failed: 0 });

    const hash = hashOf(body);
    const docId = `prod1_${hash}`;
    expect(db.docData('arquivos', docId)).toMatchObject({
      filetype: 'image',
      resizeState: 'pending',
      externalIds: [{ externalId: 'PIC1', integracaoPath: INTEG_REF }],
    });
    expect(bucket.saved).toContain(`produtos/prod1/originals/${hash}.jpeg`);

    const upd = db.updates.find((u) => u.path === 'produtos/prod1');
    expect(upd).toBeDefined();
    const expectedFoto = {
      arquivoOuterRef: `arquivos/${docId}`,
      arquivo200pxOuterRef: `arquivos/${docId}_200`,
      arquivo400pxOuterRef: `arquivos/${docId}_400`,
      arquivoJpegOuterRef: `arquivos/${docId}_jpeg`,
      grupoDeVariacoesOuterRef: null,
      variantePath: null,
    };
    expect((upd!.patch.fotos as FieldValue).isEqual(FieldValue.arrayUnion(expectedFoto))).toBe(
      true,
    );
    // jpeg derivative excluded from the denorm ids (legacy wire shape)
    expect(
      (upd!.patch.fotosArquivosIds as FieldValue).isEqual(
        FieldValue.arrayUnion(docId, `${docId}_200`, `${docId}_400`),
      ),
    ).toBe(true);
  });

  it('skips a picture already imported for this integração (NO fetch, NO upload)', async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();
    db.seed('produtos', 'prod1', { nome: 'x', fotos: [{ arquivoOuterRef: 'arquivos/prod1_OLD' }] });
    db.seed('arquivos', 'prod1_OLD', {
      filetype: 'image',
      filename: 'x',
      externalIds: [{ externalId: 'PIC1', integracaoPath: INTEG_REF }],
    });
    const fetch = fakeFetch({});

    const res = await importProdutoPhotos(deps(db, bucket, fetch), 'prod1', [
      { id: 'PIC1', secure_url: 'https://http2.mlstatic.com/PIC1-O.jpg' },
    ]);
    expect(res).toEqual({ imported: 0, skipped: 1, failed: 0 });
    expect(fetch).not.toHaveBeenCalled();
    expect(bucket.saved).toHaveLength(0);
  });

  it('best-effort: a 404 picture is skipped, the rest still import', async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();
    db.seed('produtos', 'prod1', { nome: 'x' });
    const fetch = fakeFetch({
      'https://http2.mlstatic.com/BAD-F.jpg': { status: 404 },
      'https://http2.mlstatic.com/GOOD-F.jpg': { contentType: 'image/jpeg', body: 'good' },
    });

    const res = await importProdutoPhotos(deps(db, bucket, fetch), 'prod1', [
      { id: 'BAD', secure_url: 'https://http2.mlstatic.com/BAD-O.jpg' },
      { id: 'GOOD', secure_url: 'https://http2.mlstatic.com/GOOD-O.jpg' },
    ]);
    expect(res).toEqual({ imported: 1, skipped: 0, failed: 1 });
    expect(bucket.saved).toHaveLength(1);
  });

  it('best-effort: a network failure (TypeError) is skipped, not fatal', async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();
    db.seed('produtos', 'prod1', { nome: 'x' });
    const fetch = fakeFetch({ 'https://http2.mlstatic.com/NET-F.jpg': 'network-error' });

    const res = await importProdutoPhotos(deps(db, bucket, fetch), 'prod1', [
      { id: 'NET', secure_url: 'https://http2.mlstatic.com/NET-O.jpg' },
    ]);
    expect(res).toEqual({ imported: 0, skipped: 0, failed: 1 });
  });

  it('skips a non-image response (content-type guard)', async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();
    db.seed('produtos', 'prod1', { nome: 'x' });
    const fetch = fakeFetch({
      'https://http2.mlstatic.com/HTML-F.jpg': { contentType: 'text/html', body: '<html>' },
    });

    const res = await importProdutoPhotos(deps(db, bucket, fetch), 'prod1', [
      { id: 'HTML', secure_url: 'https://http2.mlstatic.com/HTML-O.jpg' },
    ]);
    expect(res.failed).toBe(1);
    expect(res.imported).toBe(0);
    expect(bucket.saved).toHaveLength(0);
  });

  it('no pictures → no produto write', async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();
    db.seed('produtos', 'prod1', { nome: 'x' });
    const res = await importProdutoPhotos(deps(db, bucket, fakeFetch({})), 'prod1', []);
    expect(res).toEqual({ imported: 0, skipped: 0, failed: 0 });
    expect(db.updates).toHaveLength(0);
  });

  it('SSRF guard: refuses a non-mlstatic host WITHOUT fetching it', async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();
    db.seed('produtos', 'prod1', { nome: 'x' });
    const fetch = fakeFetch({}); // any call throws → proves we never fetched

    const res = await importProdutoPhotos(deps(db, bucket, fetch), 'prod1', [
      { id: 'EVIL', secure_url: 'https://evil.example.com/x-O.jpg' },
    ]);
    expect(res).toEqual({ imported: 0, skipped: 0, failed: 1 });
    expect(fetch).not.toHaveBeenCalled();
    expect(bucket.saved).toHaveLength(0);
  });

  it('SSRF guard: upgrades an http mlstatic fallback url to https before fetching', async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();
    db.seed('produtos', 'prod1', { nome: 'x' });
    // no secure_url → falls back to the http `url`; the guard forces https.
    const fetch = fakeFetch({
      'https://http2.mlstatic.com/Z-F.jpg': { contentType: 'image/jpeg', body: 'z' },
    });

    const res = await importProdutoPhotos(deps(db, bucket, fetch), 'prod1', [
      { id: 'Z', url: 'http://http2.mlstatic.com/Z-O.jpg' },
    ]);
    expect(res).toEqual({ imported: 1, skipped: 0, failed: 0 });
    expect(fetch).toHaveBeenCalledWith('https://http2.mlstatic.com/Z-F.jpg');
  });
});
