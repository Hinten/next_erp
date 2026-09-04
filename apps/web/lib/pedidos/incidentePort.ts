'use client';

import { runTransaction, type Firestore } from 'firebase/firestore';
import type { Incidente } from '@delfrance/schemas';
import { nowMicros } from '@delfrance/core/datetime';

import { incidenteCollection } from '@/lib/data/incidenteCollection';
import type { IncidenteSavePort } from './saveIncidenteEdit';

/**
 * The Firestore half of {@link IncidenteSavePort} — the only place in the
 * Incidentes editor that touches the SDK, so every save decision stays
 * unit-testable.
 *
 * A transaction, not a `merge()`, because the conflict guard has to compare
 * against a doc read in the same atomic step. Several writers touch these
 * documents: the Mercado Livre claims webhook (`claimImport`, which merges
 * `resolucao` / `claimStatus` / `claimStage` / `entregue`), the ML order
 * import, the `pedidoTravado` sweep, the `liberarBloqueioIncidente` callable,
 * the troca/devolução flows in `@delfrance/data`, and a second operator's tab.
 * The browser SDK has no `lastUpdateTime` precondition to lean on
 * (`apps/web/CLAUDE.md` rule 3), so the re-read IS the precondition.
 *
 * ⚠️ `tx.update` deliberately bypasses the collection converter — the same
 * reasoning as the pedido and listing ports. `set(..., { merge: true })` on a
 * converted ref would full-parse the patch, fill schema defaults for keys the
 * operator never touched, and the merge mask would then write those defaults
 * over stored values. `update` writes exactly the keys given, which is also
 * what keeps `overrideBloqueio` out of `affectedKeys()` — the generated rules
 * deny any client write that names it.
 *
 * The READ still runs through the converter, so `patchFor` gets the parsed wire
 * shape (`parseSoftRead`, tolerant of legacy rows) rather than raw Firestore
 * data — the same contract the baseline the caller compares against was read
 * under.
 */
export function createClientIncidentePort(
  db: Firestore,
  pedidoId: string,
  incidenteId: string,
): IncidenteSavePort {
  const ref = incidenteCollection.docRef(db, { pedidoId }, incidenteId);
  return {
    now: nowMicros,
    async update(patchFor) {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const current = snap.exists() ? (snap.data() as Incidente) : null;
        const patch = patchFor(current);
        if (Object.keys(patch).length === 0) return;
        tx.update(ref, patch as never);
      });
    },
  };
}
