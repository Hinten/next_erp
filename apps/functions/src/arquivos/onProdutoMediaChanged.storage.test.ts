import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import {
  mediaPath,
  nowMicros,
  productAnexoPath,
  productArquivoId,
  productOriginalPath,
  productVideoPath,
} from '@delfrance/schemas';

import { reconcileMediaMarks } from './mediaMarks';

// Integration test — requires the firestore emulator. Drives the trigger CORE
// (reconcileMediaMarks) directly, not the onDocumentUpdated trigger.
const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const projectId = process.env.GCLOUD_PROJECT ?? 'demo-erp';
const bucketName = `${projectId}.appspot.com`;
const DAY_MICROS = 24 * 3600 * 1_000_000;

function getDb() {
  const app = getApps()[0] ?? initializeApp({ projectId, storageBucket: bucketName });
  return getFirestore(app, process.env.FIREBASE_DATABASE_ID ?? 'default');
}

const id = () => randomUUID().replace(/-/g, '');

describe.skipIf(!EMULATED)('onProdutoMediaChanged — reconcileMediaMarks (emulator)', () => {
  /** Seed a finalized arquivo doc; `marked` stamps an existing past mark. */
  const seedArquivo = async (
    db: ReturnType<typeof getDb>,
    storagePath: string,
    docId: string,
    filetype: 'image' | 'video' | 'document',
    marked = false,
  ) => {
    const slash = storagePath.lastIndexOf('/');
    await db
      .collection('arquivos')
      .doc(docId)
      .set({
        filetype,
        filepath: storagePath.slice(0, slash),
        filename: storagePath.slice(slash + 1),
        contentType:
          filetype === 'video'
            ? 'video/mp4'
            : filetype === 'document'
              ? 'application/pdf'
              : 'image/png',
        url: null,
        externalIds: [],
        uploadState: 'finalized',
        criadoEm: nowMicros(),
        markedForDeletionAt: marked ? nowMicros() - DAY_MICROS : null,
      });
  };

  it('marks a removed photo and leaves a kept video untouched', async () => {
    const db = getDb();
    const produtoId = `p${id()}`;
    const fotoHash = id();
    const vidHash = id();
    const fotoId = productArquivoId(produtoId, fotoHash);
    const vidId = productArquivoId(produtoId, vidHash);
    await seedArquivo(db, productOriginalPath(produtoId, fotoHash, 'png'), fotoId, 'image');
    await seedArquivo(db, productVideoPath(produtoId, vidHash, 'mp4'), vidId, 'video');

    const before = {
      fotos: [{ arquivoOuterRef: `arquivos/${fotoId}` }],
      videos: [{ arquivoOuterRef: `arquivos/${vidId}` }],
    };
    const after = { fotos: [], videos: [{ arquivoOuterRef: `arquivos/${vidId}` }] };

    const res = await reconcileMediaMarks(db, before, after);
    expect(res).toEqual({ marked: 1, unmarked: 0 });

    expect(
      typeof (await db.collection('arquivos').doc(fotoId).get()).data()?.markedForDeletionAt,
    ).toBe('number');
    expect(
      (await db.collection('arquivos').doc(vidId).get()).data()?.markedForDeletionAt,
    ).toBeNull();
  });

  it('marks a removed anexo (product-scoped) just like a photo/video', async () => {
    const db = getDb();
    const produtoId = `p${id()}`;
    const anxHash = id();
    const anxId = productArquivoId(produtoId, anxHash);
    await seedArquivo(db, productAnexoPath(produtoId, anxHash, 'pdf'), anxId, 'document');

    const before = { anexos: [{ arquivoOuterRef: `arquivos/${anxId}` }] };
    const after = { anexos: [] };

    const res = await reconcileMediaMarks(db, before, after);
    expect(res).toEqual({ marked: 1, unmarked: 0 });
    expect(
      typeof (await db.collection('arquivos').doc(anxId).get()).data()?.markedForDeletionAt,
    ).toBe('number');
  });

  it('clears the mark when a previously-removed photo is re-added', async () => {
    const db = getDb();
    const produtoId = `p${id()}`;
    const fotoHash = id();
    const fotoId = productArquivoId(produtoId, fotoHash);
    await seedArquivo(db, productOriginalPath(produtoId, fotoHash, 'png'), fotoId, 'image', true);

    const before = { fotos: [], videos: [] };
    const after = { fotos: [{ arquivoOuterRef: `arquivos/${fotoId}` }], videos: [] };

    const res = await reconcileMediaMarks(db, before, after);
    expect(res).toEqual({ marked: 0, unmarked: 1 });
    expect(
      (await db.collection('arquivos').doc(fotoId).get()).data()?.markedForDeletionAt,
    ).toBeNull();
  });

  it('is a no-op when the media set is unchanged', async () => {
    const db = getDb();
    const same = { fotos: [{ arquivoOuterRef: `arquivos/${id()}` }], videos: [] };
    expect(await reconcileMediaMarks(db, same, same)).toEqual({ marked: 0, unmarked: 0 });
  });

  it('tolerates a removed ref whose arquivo doc no longer exists', async () => {
    const db = getDb();
    const missing = productArquivoId(`p${id()}`, id());
    const before = { fotos: [{ arquivoOuterRef: `arquivos/${missing}` }], videos: [] };
    const after = { fotos: [], videos: [] };
    // Doc never existed → nothing to mark, no NOT_FOUND, no resurrected phantom.
    expect(await reconcileMediaMarks(db, before, after)).toEqual({ marked: 0, unmarked: 0 });
    expect((await db.collection('arquivos').doc(missing).get()).exists).toBe(false);
  });

  it('does NOT mark a fotos ref that points at a non-product-media arquivo', async () => {
    const db = getDb();
    // A `fotos` entry whose arquivo lives in generic `media/` (not under
    // produtos/<id>/originals|videos) — the sweep can't owner-verify it, so the
    // trigger must not mark it.
    const docId = `media-${id()}`;
    await seedArquivo(db, mediaPath(id(), 'png'), docId, 'image');
    const before = { fotos: [{ arquivoOuterRef: `arquivos/${docId}` }], videos: [] };
    const after = { fotos: [], videos: [] };

    expect(await reconcileMediaMarks(db, before, after)).toEqual({ marked: 0, unmarked: 0 });
    expect(
      (await db.collection('arquivos').doc(docId).get()).data()?.markedForDeletionAt,
    ).toBeNull();
  });

  it('does not write a no-op unmark when a brand-new photo is added', async () => {
    const db = getDb();
    const produtoId = `p${id()}`;
    const fotoHash = id();
    const fotoId = productArquivoId(produtoId, fotoHash);
    await seedArquivo(db, productOriginalPath(produtoId, fotoHash, 'png'), fotoId, 'image'); // unmarked

    const before = { fotos: [], videos: [] };
    const after = { fotos: [{ arquivoOuterRef: `arquivos/${fotoId}` }], videos: [] };

    // Already null → no write, counts stay 0 (not an inflated unmarked: 1).
    expect(await reconcileMediaMarks(db, before, after)).toEqual({ marked: 0, unmarked: 0 });
  });
});
