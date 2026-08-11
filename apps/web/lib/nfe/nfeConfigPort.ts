'use client';

import { runTransaction, type Firestore } from 'firebase/firestore';
import { nowMillis } from '@delfrance/core/datetime';
import type { NFeConfig } from '@delfrance/schemas';

import { NFE_CONFIG_DOC_ID, nfeConfigCollection } from '@/lib/data/nfeConfigCollection';
import type { NfeConfigSavePort } from './saveNfeConfig';

/**
 * The Firestore half of {@link NfeConfigSavePort} — the only place the
 * Contingência panel touches the SDK, so every save decision stays
 * unit-testable.
 *
 * A transaction, not a `merge()`, because the guard has to compare against a doc
 * read in the same atomic step: three writers touch this document (this panel,
 * `apps/nfe`'s numeração allocation, and the emission's counter advance) and the
 * browser SDK has no `lastUpdateTime` precondition to lean on
 * (`apps/web/CLAUDE.md` rule 3).
 */
export function createNfeConfigPort(db: Firestore, filialId: string): NfeConfigSavePort {
  const ref = nfeConfigCollection.docRef(db, { filialId }, NFE_CONFIG_DOC_ID);
  return {
    now: () => nowMillis(),
    async update(nextFor) {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const current = snap.exists() ? snap.data() : null;
        // `nextFor` throws to abort — a missing doc or a detected conflict.
        const next: NFeConfig = nextFor(current);
        tx.set(ref, next);
      });
    },
  };
}
