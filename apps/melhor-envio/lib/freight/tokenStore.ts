/**
 * Firestore-backed `TokenStore` for Melhor Envio OAuth tokens
 * (`int_frete/{intFreteId}/tokenMelEnv`). Single-token semantics: `save`
 * writes a fixed `current` doc and deletes any stray docs in one
 * transaction, so at most one token ever lives (matching the legacy
 * Flutter behavior, which the still-running app reads by
 * `orderBy(expirationDate desc).first()` — a fixed id stays compatible).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { tokenMelEnvCollection } from '@delfrance/data/admin/collections';
import type { StoredToken, TokenStore } from '@delfrance/integrations-freight-br';

/** Fixed doc id — there is always at most one token per account. */
const TOKEN_DOC_ID = 'current';

export function createFirestoreTokenStore(db: Firestore, intFreteId: string): TokenStore {
  const ctx = { intFreteId };

  return {
    async load(): Promise<StoredToken | null> {
      const snap = await tokenMelEnvCollection
        .ref(db, ctx)
        .orderBy('expirationDate', 'desc')
        .limit(1)
        .get();
      const doc = snap.docs[0];
      if (!doc) return null;
      const parsed = tokenMelEnvCollection.parseRead(
        doc.data(),
        tokenMelEnvCollection.docPath(ctx, doc.id),
      );
      return {
        access_token: parsed.access_token,
        refresh_token: parsed.refresh_token,
        expirationDate: parsed.expirationDate,
      };
    },

    async save(token: StoredToken): Promise<StoredToken> {
      const collRef = tokenMelEnvCollection.ref(db, ctx);
      const currentRef = tokenMelEnvCollection.docRef(db, ctx, TOKEN_DOC_ID);
      const data = tokenMelEnvCollection.parse(token);
      await db.runTransaction(async (tx) => {
        // Reads before writes (transaction contract).
        const existing = await tx.get(collRef);
        tx.set(currentRef, data);
        for (const d of existing.docs) {
          if (d.id !== TOKEN_DOC_ID) tx.delete(d.ref);
        }
      });
      return token;
    },
  };
}
