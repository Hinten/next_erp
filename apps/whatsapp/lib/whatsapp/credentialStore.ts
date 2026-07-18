/**
 * Firestore-backed single-token credential store for the WhatsApp permanent
 * token over the admin-only `integracao/{integracaoId}/credenciaisWhatsapp`
 * subcollection. Single-token semantics: `save` writes a fixed `current` doc and
 * deletes any stray docs in one transaction, so at most one live credential ever
 * exists per account (the permanent token never reaches the browser — this
 * collection is default-deny; only the Admin SDK reaches it). Mirrors
 * apps/mercado-pago/lib/payments/credentialStore.ts. Unlike the marketplace
 * OAuth stores there is no refresh flow — the WhatsApp Cloud API token is a
 * long-lived Meta Graph token entered by the operator, so there is no
 * `credentialFromResponse` mapping here.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { credenciaisWhatsappCollection } from '@delfrance/data/admin/collections';
import type { CredenciaisWhatsapp } from '@delfrance/schemas';

/** Fixed doc id — there is always at most one credential per account. */
const CREDENTIAL_DOC_ID = 'current';

export interface CredentialStore {
  /** The `current` credential doc, or `null` if no token was ever stored. */
  load(): Promise<CredenciaisWhatsapp | null>;
  /**
   * Persist `cred` at the fixed `current` doc and delete every other doc in the
   * same transaction (single-token — at most one lives). Returns the saved
   * value. When `cred` carries no `pin`, a previously-stored pin is carried
   * forward (see the implementation) — so a bare token replacement never wipes
   * the two-step registration PIN.
   */
  save(cred: CredenciaisWhatsapp): Promise<CredenciaisWhatsapp>;
  /** Delete every credential doc for this account (revoke / disconnect). */
  revoke(): Promise<void>;
}

export function createCredentialStore(db: Firestore, integracaoId: string): CredentialStore {
  const ctx = { integracaoId };

  return {
    async load(): Promise<CredenciaisWhatsapp | null> {
      // Read the fixed `current` doc — the single-token invariant `save()`
      // enforces. Picking "newest" instead could resurrect a stray doc
      // (interrupted cleanup / manual edit) carrying a token the operator has
      // already replaced.
      const snap = await credenciaisWhatsappCollection.docRef(db, ctx, CREDENTIAL_DOC_ID).get();
      if (!snap.exists) return null;
      return credenciaisWhatsappCollection.parseRead(
        snap.data(),
        credenciaisWhatsappCollection.docPath(ctx, CREDENTIAL_DOC_ID),
      );
    },

    async save(cred: CredenciaisWhatsapp): Promise<CredenciaisWhatsapp> {
      const collRef = credenciaisWhatsappCollection.ref(db, ctx);
      const currentRef = credenciaisWhatsappCollection.docRef(db, ctx, CREDENTIAL_DOC_ID);
      // Firestore retries the transaction closure on contention, so it must be
      // RE-ENTRANT: derive `effective` from the immutable `cred` inside each
      // attempt (never mutate captured state across attempts) and hoist only
      // the committed value out.
      let committed: CredenciaisWhatsapp = cred;
      await db.runTransaction(async (tx) => {
        // Reads before writes (transaction contract).
        const existing = await tx.get(collRef);
        // `save` replaces the WHOLE `current` doc, so a plain token replacement
        // (POST /api/whatsapp/token, which never carries a pin) would otherwise
        // drop the two-step registration PIN the re-register flow needs. Carry
        // the stored pin forward when this write doesn't set one; an explicit
        // pin on `cred` always wins (the registro route passes it).
        let effective = cred;
        if (effective.pin == null) {
          const current = existing.docs.find((d) => d.id === CREDENTIAL_DOC_ID);
          const prevPin = (current?.data?.() as { pin?: unknown } | undefined)?.pin;
          // Only carry forward a pin that satisfies the schema's 6-digit
          // constraint — an invalid stored pin (legacy/corrupt/manually-edited
          // data) is dropped rather than propagated, so a token save never
          // fails on it.
          if (typeof prevPin === 'string' && /^\d{6}$/.test(prevPin)) {
            effective = { ...effective, pin: prevPin };
          }
        }
        const data = credenciaisWhatsappCollection.parse(effective);
        tx.set(currentRef, data);
        for (const d of existing.docs) {
          if (d.id !== CREDENTIAL_DOC_ID) tx.delete(d.ref);
        }
        committed = effective;
      });
      return committed;
    },

    async revoke(): Promise<void> {
      const collRef = credenciaisWhatsappCollection.ref(db, ctx);
      await db.runTransaction(async (tx) => {
        const existing = await tx.get(collRef);
        for (const d of existing.docs) {
          tx.delete(d.ref);
        }
      });
    },
  };
}
