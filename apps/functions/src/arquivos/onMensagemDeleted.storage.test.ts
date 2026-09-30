import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { chatMediaPath, mediaPath, nowMicros, whatsappMediaPath } from '@delfrance/schemas';

import { markDeletedMensagemArquivos } from './onMensagemDeleted';

const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const projectId = process.env.GCLOUD_PROJECT ?? 'demo-erp';
const bucketName = `${projectId}.appspot.com`;

function getDb() {
  const app = getApps()[0] ?? initializeApp({ projectId, storageBucket: bucketName });
  return getFirestore(app, process.env.FIREBASE_DATABASE_ID ?? 'default');
}

const id = () => randomUUID().replace(/-/g, '');

async function seedArquivo(
  db: ReturnType<typeof getDb>,
  docId: string,
  storagePath: string,
): Promise<void> {
  const slash = storagePath.lastIndexOf('/');
  await db
    .collection('arquivos')
    .doc(docId)
    .set({
      filetype: 'image',
      filepath: storagePath.slice(0, slash),
      filename: storagePath.slice(slash + 1),
      contentType: 'image/jpeg',
      url: 'https://example.invalid/file',
      externalIds: [],
      uploadState: 'finalized',
      criadoEm: nowMicros(),
      markedForDeletionAt: null,
    });
}

describe.skipIf(!EMULATED)('onMensagemDeleted — eager mensagem media marks', () => {
  it('marks distinct inbound/outbound refs once, including a dual-write', async () => {
    const db = getDb();
    const inboundId = `wa_${id()}`;
    const outboundId = `chat_${id()}`;
    await seedArquivo(db, inboundId, whatsappMediaPath('conta-1', id()));
    await seedArquivo(db, outboundId, chatMediaPath(id(), 'jpg'));

    const marked = await markDeletedMensagemArquivos(db, {
      anexoStorage: `documents/arquivos/${outboundId}`,
      image: { image: `arquivos/${outboundId}` },
      audio: { audio: `documents/arquivos/${inboundId}` },
    });

    expect(marked).toBe(2);
    expect(
      typeof (await db.collection('arquivos').doc(inboundId).get()).data()?.markedForDeletionAt,
    ).toBe('number');
    expect(
      typeof (await db.collection('arquivos').doc(outboundId).get()).data()?.markedForDeletionAt,
    ).toBe('number');
    await Promise.all([
      db.collection('arquivos').doc(inboundId).delete(),
      db.collection('arquivos').doc(outboundId).delete(),
    ]);
  });

  it('does not mark generic media or resurrect a missing arquivo', async () => {
    const db = getDb();
    const genericId = `generic-${id()}`;
    const missingId = `missing-${id()}`;
    await seedArquivo(db, genericId, mediaPath(id(), 'jpg'));

    expect(
      await markDeletedMensagemArquivos(db, {
        image: { image: `arquivos/${genericId}` },
        video: { video: `arquivos/${missingId}` },
      }),
    ).toBe(0);
    expect(
      (await db.collection('arquivos').doc(genericId).get()).data()?.markedForDeletionAt,
    ).toBeNull();
    expect((await db.collection('arquivos').doc(missingId).get()).exists).toBe(false);
    await db.collection('arquivos').doc(genericId).delete();
  });
});
