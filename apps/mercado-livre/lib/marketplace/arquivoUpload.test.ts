import { describe, expect, it } from 'vitest';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';

import { type Bucket, putArquivoAdmin } from './arquivoUpload';

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
  readonly saved: Array<{ path: string; bytes: Buffer; opts: Record<string, unknown> }> = [];
  readonly name = 'demo-erp.appspot.com';
  file(path: string) {
    const self = this;
    return {
      save: async (bytes: Buffer, opts: Record<string, unknown>) => {
        self.saved.push({ path, bytes, opts });
      },
    };
  }
}
const asBucket = (b: FakeBucket) => b as unknown as Bucket;

const EXT = { externalId: 'PIC1', integracaoPath: 'documents/integracao/conta-A' };
const PATH = 'produtos/prod1/originals/HASH.jpeg';
const DOC = 'prod1_HASH';

/* ------------------------------ tests ------------------------------------- */

describe('putArquivoAdmin — create-first', () => {
  it('writes the anchor, uploads bytes with metadata, patches the tokened url', async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();
    const r = await putArquivoAdmin({
      db: asDb(db),
      bucket: asBucket(bucket),
      docId: DOC,
      storagePath: PATH,
      bytes: Buffer.from('img'),
      contentType: 'image/jpeg',
      filetype: 'image',
      resizeState: 'pending',
      externalIds: [EXT],
    });
    expect(r).toEqual({ id: DOC, created: true });

    const doc = db.docData('arquivos', DOC)!;
    expect(doc).toMatchObject({
      filetype: 'image',
      filepath: 'produtos/prod1/originals',
      filename: 'HASH.jpeg',
      contentType: 'image/jpeg',
      resizeState: 'pending',
      uploadState: 'pending',
      externalIds: [EXT],
    });

    // one upload, tagged with the owning doc id + a download token
    expect(bucket.saved).toHaveLength(1);
    expect(bucket.saved[0]!.path).toBe(PATH);
    const meta = (bucket.saved[0]!.opts.metadata as { metadata: Record<string, string> }).metadata;
    expect(meta.arquivoId).toBe(DOC);
    expect(typeof meta.firebaseStorageDownloadTokens).toBe('string');

    // the doc.url carries the SAME token that tagged the object
    expect(typeof doc.url).toBe('string');
    expect(doc.url).toContain('demo-erp.appspot.com');
    expect(doc.url).toContain(encodeURIComponent(PATH));
    expect(doc.url).toContain(`token=${meta.firebaseStorageDownloadTokens}`);
  });
});

describe('putArquivoAdmin — content-addressed dedup', () => {
  it('existing doc → no re-upload; arrayUnions the new externalIds', async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();
    db.seed('arquivos', DOC, {
      filetype: 'image',
      filename: 'HASH.jpeg',
      externalIds: [{ externalId: 'OLD', integracaoPath: 'documents/integracao/other' }],
    });
    const r = await putArquivoAdmin({
      db: asDb(db),
      bucket: asBucket(bucket),
      docId: DOC,
      storagePath: PATH,
      bytes: Buffer.from('img'),
      contentType: 'image/jpeg',
      filetype: 'image',
      externalIds: [EXT],
    });
    expect(r).toEqual({ id: DOC, created: false });
    expect(bucket.saved).toHaveLength(0); // never re-upload existing bytes

    const upd = db.updates.find((u) => u.path === `arquivos/${DOC}`);
    expect(upd).toBeDefined();
    expect((upd!.patch.externalIds as FieldValue).isEqual(FieldValue.arrayUnion(EXT))).toBe(true);
  });

  it('existing doc + no new externalIds → no write at all', async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();
    db.seed('arquivos', DOC, { filetype: 'image', filename: 'HASH.jpeg' });
    const r = await putArquivoAdmin({
      db: asDb(db),
      bucket: asBucket(bucket),
      docId: DOC,
      storagePath: PATH,
      bytes: Buffer.from('img'),
      contentType: 'image/jpeg',
      filetype: 'image',
    });
    expect(r.created).toBe(false);
    expect(bucket.saved).toHaveLength(0);
    expect(db.updates).toHaveLength(0);
  });
});
