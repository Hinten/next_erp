import { logger } from 'firebase-functions';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { avisoCollection } from '@delfrance/data/admin/collections';

import { getDb } from '../lib/admin';

/**
 * Retention for the operator notification inbox: delete RESOLVED avisos once
 * they are old enough that nobody is going to look them up.
 *
 * ## Why a sweep and not a TTL policy
 *
 * A TTL would have to key on a field, and the only always-present candidate is
 * `criadoEm` — which would silently expire a still-OPEN aviso, exactly the ones
 * that matter (an authorization warning legitimately stands for 200 days before
 * its window arrives). Deleting on `resolvidoEm` is the correct predicate and a
 * TTL cannot express "only if this other field is set".
 *
 * Three more reasons, all cheap to state and expensive to rediscover:
 *   - `firestore.indexes.json` has 142 indexes and ZERO `fieldOverrides`; a TTL
 *     would be its first, and the Firebase CLI does NOT remove a TTL policy when
 *     you delete the block — it warns and leaves production auto-deleting.
 *     Turning one off needs an explicit `ttl: false`.
 *   - TTL deletes bill as Managed Delete Units with no free grant.
 *   - The repo's house pattern for bounded-lifetime data is deliberately not TTL
 *     (`oauthState` uses a fixed doc id so a new attempt overwrites the old,
 *     explicitly justified as "no TTL policy and no sweep to deploy").
 *
 * ## Why retention is not optional
 *
 * Everything here is machine-written and durable by construction, so rows only
 * accumulate. Unbounded, the bell's cold sync drags the whole collection: at
 * 50/day for three years that is ~55k documents, and on Enterprise a query that
 * scans them raises no error and offers no index link — it just bills the scan
 * and gets slow. Latency breaks before the invoice does.
 */

/** Resolved avisos older than this are deleted. Long enough to answer "what happened last quarter". */
const RETENCAO_DIAS = 90;
const DIA_US = 24 * 60 * 60 * 1_000_000;

/**
 * Bounded per run so a large backlog cannot blow the time budget; the daily
 * schedule drains it over several runs. Firestore caps a batch at 500 writes.
 */
const LOTE_MAXIMO = 400;

export const sweepAvisosResolvidos = onSchedule(
  { schedule: 'every 24 hours', timeoutSeconds: 300 },
  async () => {
    const db = getDb();
    const corteUs = Date.now() * 1000 - RETENCAO_DIAS * DIA_US;

    // Served by the DEDICATED single-field `avisos(resolvidoEm ASC)` entry, not
    // by the bell's `(resolvidoEm ASC, criadoEm DESC)` composite.
    //
    // ⚠️ Declared rather than reasoned about. A composite looks like it should
    // serve this as a field prefix, but Firestore appends an implicit `__name__`
    // to a query's ordering while an Enterprise composite carries none (root
    // `CLAUDE.md` rule 1 — the same asymmetry that makes Standard-edition index
    // JSON wrong here), and on Enterprise there is no auto-created single-field
    // index to fall back on. Being wrong is silent: no `FAILED_PRECONDITION`, no
    // index link, just a full scan billed by data scanned, with `limit()`
    // shrinking the result rather than the scan. `sweepMarkedForDeletion` has the
    // identical shape and declares its own `arquivos(markedForDeletionAt ASC)`
    // for exactly this reason; one JSON entry is cheaper than the planner
    // question.
    //
    // The `< cutoff` range filter also excludes `null`, which is what keeps every
    // UNRESOLVED aviso out of the sweep — the same behaviour `sweepMarkedForDeletion`
    // relies on, and it is emulator-tested there.
    const vencidos = await avisoCollection
      .ref(db, {})
      .where('resolvidoEm', '<', corteUs)
      .orderBy('resolvidoEm', 'asc')
      .limit(LOTE_MAXIMO)
      .get();

    if (vencidos.empty) {
      logger.info('[avisos] retention sweep: nothing to delete', { corteUs });
      return;
    }

    const lote = db.batch();
    for (const doc of vencidos.docs) lote.delete(doc.ref);
    await lote.commit();

    logger.info('[avisos] retention sweep', {
      excluidos: vencidos.size,
      corteUs,
      // A full batch means there is more behind it; the next run continues.
      restaProvavelmente: vencidos.size === LOTE_MAXIMO,
    });
  },
);
