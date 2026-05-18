import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { onDocumentDeletedWithAuthContext } from 'firebase-functions/v2/firestore';
import { buildLixeiraEntry } from './buildLixeiraEntry.js';

// The project runs Firestore on a named database — the trigger and the Admin
// SDK must both target it. Defaults to the unnamed default database.
const DATABASE_ID = process.env.FIREBASE_DATABASE_ID ?? '(default)';

initializeApp();

/**
 * Capture deletions of `categorias` documents into the top-level `lixeira`
 * collection so they can be recovered from the "Itens excluídos" view.
 *
 * Pilot scope: categorias only. To cover another collection, add a sibling
 * trigger on `<collection>/{docId}`.
 *
 * Uses `onDocumentDeletedWithAuthContext` so `event.authId` (the deleting
 * user's uid) can be recorded; it is null for service-account or otherwise
 * unattributed deletes (scripts, the Firebase console).
 */
export const captureCategoriaDelete = onDocumentDeletedWithAuthContext(
  { document: 'categorias/{docId}', database: DATABASE_ID },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;

    const entry = buildLixeiraEntry({
      collectionPath: 'categorias',
      docId: event.params.docId,
      data: snapshot.data() ?? {},
      deletedBy: event.authId ?? null,
    });

    await getFirestore(DATABASE_ID).collection('lixeira').add(entry);
  },
);
