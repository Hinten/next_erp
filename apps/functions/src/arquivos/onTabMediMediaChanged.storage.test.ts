import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { nowMicros, tabMediArquivoId, tabMediOriginalPath } from '@delfrance/schemas';

import { reconcileMediaMarks } from './mediaMarks';

// Integration test — requires the firestore emulator. Drives the shared
// reconcileMediaMarks (the onTabMediMediaChanged core) with tabMedi paths, not
// the onDocumentWritten trigger.
const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const projectId = process.env.GCLOUD_PROJECT ?? 'demo-erp';

function getDb() {
  const app =
    getApps()[0] ?? initializeApp({ projectId, storageBucket: `${projectId}.appspot.com` });
  return getFirestore(app, process.env.FIREBASE_DATABASE_ID ?? 'default');
}

const id = () => randomUUID().replace(/-/g, '');

describe.skipIf(!EMULATED)(
  'onTabMediMediaChanged — reconcileMediaMarks (tabMedi, emulator)',
  () => {
    const seedFoto = async (db: ReturnType<typeof getDb>, tabMediId: string, hash: string) => {
      const docId = tabMediArquivoId(tabMediId, hash);
      const storagePath = tabMediOriginalPath(tabMediId, hash, 'png');
      const slash = storagePath.lastIndexOf('/');
      await db
        .collection('arquivos')
        .doc(docId)
        .set({
          filetype: 'image',
          filepath: storagePath.slice(0, slash),
          filename: storagePath.slice(slash + 1),
          contentType: 'image/png',
          url: null,
          externalIds: [],
          uploadState: 'finalized',
          criadoEm: nowMicros(),
          markedForDeletionAt: null,
        });
      return docId;
    };

    it('marks a tabMedi photo removed in an edit', async () => {
      const db = getDb();
      const tabMediId = `tm${id()}`;
      const fotoId = await seedFoto(db, tabMediId, id());

      const before = { fotos: [{ arquivoOuterRef: `arquivos/${fotoId}` }] };
      const after = { fotos: [] };

      expect(await reconcileMediaMarks(db, before, after)).toEqual({ marked: 1, unmarked: 0 });
      expect(
        typeof (await db.collection('arquivos').doc(fotoId).get()).data()?.markedForDeletionAt,
      ).toBe('number');
    });

    it('marks every photo when the whole tabela is deleted (after is empty)', async () => {
      const db = getDb();
      const tabMediId = `tm${id()}`;
      const fotoId1 = await seedFoto(db, tabMediId, id());
      const fotoId2 = await seedFoto(db, tabMediId, id());

      const before = {
        fotos: [
          { arquivoOuterRef: `arquivos/${fotoId1}` },
          { arquivoOuterRef: `arquivos/${fotoId2}` },
        ],
      };
      // Delete event: `after` is undefined → every before-ref is marked.
      expect(await reconcileMediaMarks(db, before, undefined)).toEqual({ marked: 2, unmarked: 0 });
      for (const fotoId of [fotoId1, fotoId2]) {
        expect(
          typeof (await db.collection('arquivos').doc(fotoId).get()).data()?.markedForDeletionAt,
        ).toBe('number');
      }
    });
  },
);
