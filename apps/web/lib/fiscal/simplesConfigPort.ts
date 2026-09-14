'use client';

import { runTransaction, type Firestore } from 'firebase/firestore';

import { nowMillis } from '@delfrance/core/datetime';
import type { SimplesNacionalConfig } from '@delfrance/schemas';

import {
  SIMPLES_CONFIG_DOC_ID,
  simplesNacionalConfigCollection,
} from '@/lib/data/simplesNacionalConfigCollection';
import type { SimplesConfigSavePort } from './saveSimplesConfig';

/**
 * The Firestore half of {@link SimplesConfigSavePort} — the only place this
 * panel touches the SDK, so every save decision stays unit-testable.
 *
 * A transaction rather than a `merge()` because the guard has to compare
 * against a document read in the same atomic step: this document has two
 * writers (this panel and the monthly apuração runner) and the browser SDK has
 * no `lastUpdateTime` precondition to lean on (`apps/web/CLAUDE.md` rule 3).
 */
export function createSimplesConfigPort(db: Firestore, filialId: string): SimplesConfigSavePort {
  const ref = simplesNacionalConfigCollection.docRef(db, { filialId }, SIMPLES_CONFIG_DOC_ID);
  return {
    now: () => nowMillis(),
    async update(nextFor) {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const current = snap.exists() ? snap.data() : null;
        // `nextFor` throws to abort — a detected conflict or a lost create.
        const next: SimplesNacionalConfig = nextFor(current);
        tx.set(ref, next);
      });
    },
  };
}
