/**
 * Firestore-backed `TokenStore` for Melhor Envio OAuth tokens
 * (`int_frete/{intFreteId}/tokenMelEnv`). Single-token semantics: `save`
 * writes a fixed `current` doc and deletes any stray docs in one
 * transaction, so at most one token ever lives. The legacy corpus stores its
 * tokens under arbitrary ids (the old app picked one with
 * `orderBy(expirationDate desc).first()`), so a fixed id plus the stray-delete
 * converges whatever the migration brings in onto the single `current` doc.
 *
 * ## The write is guarded — ADR 0011 tier 2, update-if-newer (#966)
 *
 * `save` used to be last-write-wins: two concurrent refreshes both `tx.set` the
 * same fixed id, Firestore imposes no ordering between them, and an OCC retry
 * re-applies the callback's captured `data` verbatim — so the later writer
 * silently overwrote a credential that may have been *newer* than its own.
 *
 * The guard is a freshness comparison on `expirationDate` (ms since epoch,
 * required by the schema), re-derived from the callback's own `tx.get` so a
 * retry re-decides instead of replaying a stale closure. A write that is not
 * strictly newer than what is stored is dropped, and the STORED token is
 * returned — which is why `save` returns a token at all: the loser of a write
 * race walks away with the winner's credential rather than an error.
 *
 * ⚠️ The comparison looks at the `current` doc **only**, never the strays. A
 * legacy doc carrying a bogus far-future `expirationDate` would otherwise make
 * the guard reject every write forever — ADR 0011's "wrong-way default", the
 * failure mode that made the legacy ML shipment guard reject everything. Strays
 * are deleted in both branches regardless.
 *
 * ⚠️ Tier 2 rather than tier 1 (`lastUpdateTime`): the guard has to live behind
 * the `TokenStore` port in `@delfrance/integrations-freight-br`, which is
 * deliberately `firebase-admin`-free, so a version token cannot cross it without
 * either leaking a `Timestamp` type or inventing an opaque wrapper plus a
 * conflict error class. Tier 2 rides the transaction that already exists here
 * and needs nothing on the other side of the port. The clock is only used to
 * order two credentials that are both valid for ~30 days, so sub-ms instance
 * skew cannot pick a harmful winner.
 *
 * `options.force` bypasses the guard for the authorization-code flow: a human
 * who just re-consented always wins.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { tokenMelEnvCollection } from '@delfrance/data/admin/collections';
import type { SaveTokenOptions, StoredToken, TokenStore } from '@delfrance/integrations-freight-br';

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

    async save(token: StoredToken, options?: SaveTokenOptions): Promise<StoredToken> {
      const collRef = tokenMelEnvCollection.ref(db, ctx);
      const currentRef = tokenMelEnvCollection.docRef(db, ctx, TOKEN_DOC_ID);
      const data = tokenMelEnvCollection.parse(token);
      // Firestore retries the callback on contention, so it must be RE-ENTRANT:
      // the verdict is derived from THIS attempt's `tx.get` and only the
      // committed value is hoisted out.
      let committed: StoredToken = token;
      await db.runTransaction(async (tx) => {
        // Reads before writes (transaction contract).
        const existing = await tx.get(collRef);
        committed = token;

        const stored = existing.docs.find((d) => d.id === TOKEN_DOC_ID);
        if (!options?.force && stored) {
          const parsed = tokenMelEnvCollection.parseRead(
            stored.data(),
            tokenMelEnvCollection.docPath(ctx, stored.id),
          );
          // ⚠️ `parseRead` is SOFT — it logs and returns the raw document on a
          // schema mismatch (migration tolerance), so `expirationDate` is not
          // guaranteed to be a number here. Only a finite one may block a write:
          // a legacy or hand-edited doc must not be able to freeze this account's
          // token forever, and a comparison against `undefined`/`NaN` silently
          // answers `false` for reasons that have nothing to do with freshness.
          const storedExpiry = parsed.expirationDate;
          const comparable = typeof storedExpiry === 'number' && Number.isFinite(storedExpiry);
          // `>=`, not `>`: a tie is two equally-fresh credentials, and keeping
          // the stored one means a replayed save writes nothing (idempotent).
          if (comparable && storedExpiry >= token.expirationDate) {
            committed = {
              access_token: parsed.access_token,
              refresh_token: parsed.refresh_token,
              expirationDate: parsed.expirationDate,
            };
          } else {
            tx.set(currentRef, data);
          }
        } else {
          tx.set(currentRef, data);
        }

        // The single-token invariant holds either way — a dropped write is
        // still an opportunity to collapse the legacy lineage.
        for (const d of existing.docs) {
          if (d.id !== TOKEN_DOC_ID) tx.delete(d.ref);
        }
      });
      return committed;
    },
  };
}
