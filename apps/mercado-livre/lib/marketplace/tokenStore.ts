/**
 * Firestore-backed credential store for Mercado Livre OAuth tokens, over the
 * admin-only `integracao/{integracaoId}/credenciais` collection (#287).
 * Single-token semantics: `save` writes a fixed `current` doc and deletes any
 * stray docs in one transaction, so at most one credential doc ever lives
 * (mirrors apps/melhor-envio/lib/freight/tokenStore.ts).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { credenciaisIntegracaoCollection } from '@delfrance/data/admin/collections';

/** Fixed doc id — there is always at most one credential per account. */
const CREDENTIAL_DOC_ID = 'current';

export interface StoredCredential {
  access_token: string;
  refresh_token: string;
  /** ms since epoch (`now + expires_in`). */
  expirationDate: number;
}

export interface CredentialStore {
  load(): Promise<StoredCredential | null>;
  save(cred: StoredCredential): Promise<StoredCredential>;
}

export function createCredentialStore(db: Firestore, integracaoId: string): CredentialStore {
  const ctx = { integracaoId };

  return {
    async load(): Promise<StoredCredential | null> {
      const snap = await credenciaisIntegracaoCollection
        .ref(db, ctx)
        .orderBy('expirationDate', 'desc')
        .limit(1)
        .get();
      const doc = snap.docs[0];
      if (!doc) return null;
      const parsed = credenciaisIntegracaoCollection.parseRead(
        doc.data(),
        credenciaisIntegracaoCollection.docPath(ctx, doc.id),
      );
      return {
        access_token: parsed.access_token,
        refresh_token: parsed.refresh_token,
        expirationDate: parsed.expirationDate,
      };
    },

    async save(cred: StoredCredential): Promise<StoredCredential> {
      const collRef = credenciaisIntegracaoCollection.ref(db, ctx);
      const currentRef = credenciaisIntegracaoCollection.docRef(db, ctx, CREDENTIAL_DOC_ID);
      const data = credenciaisIntegracaoCollection.parse(cred);
      await db.runTransaction(async (tx) => {
        // Reads before writes (transaction contract).
        const existing = await tx.get(collRef);
        tx.set(currentRef, data);
        for (const d of existing.docs) {
          if (d.id !== CREDENTIAL_DOC_ID) tx.delete(d.ref);
        }
      });
      return cred;
    },
  };
}
