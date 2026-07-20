/**
 * Firestore-backed single-token credential store for Mercado Pago OAuth tokens
 * over the admin-only `metodo_pgto/{metodoId}/credenciais` subcollection.
 * Single-token semantics: `save` writes a fixed `current` doc and deletes any
 * stray docs in one transaction, so at most one live credential ever exists per
 * account (the OAuth token never reaches the browser — this collection is
 * default-deny; only the Admin SDK reaches it). Mirrors
 * apps/melhor-envio/lib/freight/tokenStore.ts.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { credenciaisMetodoPgtoCollection } from '@delfrance/data/admin/collections';
import type { CredenciaisMetodoPgto } from '@delfrance/schemas';
import type { TokenResponse } from '@delfrance/integrations-mercado-pago';

/** Fixed doc id — there is always at most one credential per account. */
const CREDENTIAL_DOC_ID = 'current';

/** Small guard subtracted from the computed expiry (mirrors the ML store's −5s). */
const EXPIRY_GUARD_MS = 5_000;

/**
 * Build a credential doc from a fresh MP `/oauth/token` response captured at
 * `nowMs`. `expires_in` (seconds) becomes an **absolute** ms-since-epoch expiry
 * (`now + expires_in*1000 − 5s`); MP rotates the `refresh_token` on every call,
 * so the returned one is persisted verbatim.
 */
export function credentialFromResponse(resp: TokenResponse, nowMs: number): CredenciaisMetodoPgto {
  return {
    access_token: resp.access_token,
    refresh_token: resp.refresh_token,
    expirationDate: nowMs + resp.expires_in * 1000 - EXPIRY_GUARD_MS,
  };
}

export interface CredentialStore {
  /** The `current` credential doc, or `null` if the account was never connected. */
  load(): Promise<CredenciaisMetodoPgto | null>;
  /**
   * Persist `cred` at the fixed `current` doc and delete every other doc in the
   * same transaction (single-token — at most one lives). Returns the saved value.
   */
  save(cred: CredenciaisMetodoPgto): Promise<CredenciaisMetodoPgto>;
}

export function createCredentialStore(db: Firestore, metodoId: string): CredentialStore {
  const ctx = { metodoId };

  return {
    async load(): Promise<CredenciaisMetodoPgto | null> {
      // Read the fixed `current` doc — the single-token invariant `save()`
      // enforces. Picking "newest by expirationDate" instead could resurrect a
      // stray doc (interrupted cleanup / manual edit) whose rotated refresh
      // token MP has already invalidated.
      const snap = await credenciaisMetodoPgtoCollection.docRef(db, ctx, CREDENTIAL_DOC_ID).get();
      if (!snap.exists) return null;
      return credenciaisMetodoPgtoCollection.parseRead(
        snap.data(),
        credenciaisMetodoPgtoCollection.docPath(ctx, CREDENTIAL_DOC_ID),
      );
    },

    async save(cred: CredenciaisMetodoPgto): Promise<CredenciaisMetodoPgto> {
      const collRef = credenciaisMetodoPgtoCollection.ref(db, ctx);
      const currentRef = credenciaisMetodoPgtoCollection.docRef(db, ctx, CREDENTIAL_DOC_ID);
      const data = credenciaisMetodoPgtoCollection.parse(cred);
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
