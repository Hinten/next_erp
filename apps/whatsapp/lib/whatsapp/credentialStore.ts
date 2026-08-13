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
import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import { credenciaisWhatsappCollection } from '@delfrance/data/admin/collections';
import type { CredenciaisWhatsapp } from '@delfrance/schemas';

/** Fixed doc id — there is always at most one credential per account. */
const CREDENTIAL_DOC_ID = 'current';

/**
 * A credential plus the version token needed to write it back safely — the
 * ADR 0011 **tier 1** pair. `version` is the `current` doc's Firestore
 * `updateTime` at read time; handing it to {@link CredentialStore.save} turns a
 * lost update into a `FAILED_PRECONDITION` the caller can see.
 */
export interface StoredCredential {
  readonly cred: CredenciaisWhatsapp;
  readonly version: Timestamp;
}

/** Options for {@link CredentialStore.save}. */
export interface SaveCredentialOptions {
  /**
   * The `version` from {@link CredentialStore.loadForUpdate}. When present the
   * write is conditional: it commits only if nobody touched the `current` doc
   * since that read, and fails `FAILED_PRECONDITION` (gRPC 9) otherwise.
   *
   * Pass it whenever the value being written was derived from a document read
   * **before an `await`** — the registro route reads the credential, then blocks
   * on a Meta Graph round-trip, then writes it back.
   */
  readonly expectedVersion?: Timestamp;
}

export interface CredentialStore {
  /** The `current` credential doc, or `null` if no token was ever stored. */
  load(): Promise<CredenciaisWhatsapp | null>;
  /**
   * {@link load} plus the version token for a conditional write-back. Use this
   * — not `load()` — whenever the credential will be saved again after an
   * `await`; see {@link SaveCredentialOptions.expectedVersion}.
   */
  loadForUpdate(): Promise<StoredCredential | null>;
  /**
   * Persist `cred` at the fixed `current` doc and delete every other doc in the
   * same transaction (single-token — at most one lives). Returns the saved
   * value. When `cred` carries no `pin`, a previously-stored pin is carried
   * forward (see the implementation) — so a bare token replacement never wipes
   * the two-step registration PIN.
   *
   * ⚠️ Without `options.expectedVersion` this is **last-write-wins**: the doc is
   * replaced wholesale from the caller's `cred`, so any field a concurrent
   * writer changed meanwhile is reverted. That is correct only when `cred` was
   * built from values the caller owns outright (the token route's own input).
   */
  save(cred: CredenciaisWhatsapp, options?: SaveCredentialOptions): Promise<CredenciaisWhatsapp>;
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

    async loadForUpdate(): Promise<StoredCredential | null> {
      const snap = await credenciaisWhatsappCollection.docRef(db, ctx, CREDENTIAL_DOC_ID).get();
      // `updateTime` is present on every existing document; the optional type is
      // for the not-found case, which `exists` has already ruled out.
      if (!snap.exists || !snap.updateTime) return null;
      return {
        cred: credenciaisWhatsappCollection.parseRead(
          snap.data(),
          credenciaisWhatsappCollection.docPath(ctx, CREDENTIAL_DOC_ID),
        ),
        version: snap.updateTime,
      };
    },

    async save(
      cred: CredenciaisWhatsapp,
      options?: SaveCredentialOptions,
    ): Promise<CredenciaisWhatsapp> {
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
        if (options?.expectedVersion) {
          // ADR 0011 tier 1. The transaction's own OCC covers what the CALLBACK
          // read; it cannot cover a value the CALLER read before an `await`,
          // which is exactly the registro route's shape. The precondition does:
          // a concurrent write to `current` fails this commit with
          // FAILED_PRECONDITION instead of silently reverting it.
          //
          // `update` rather than `set` — the doc provably exists (the caller
          // holds its `updateTime`), and `update` on a vanished doc is a
          // NOT_FOUND worth surfacing rather than a resurrection.
          tx.update(currentRef, data, { lastUpdateTime: options.expectedVersion });
        } else {
          tx.set(currentRef, data);
        }
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
