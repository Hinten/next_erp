import { logger } from 'firebase-functions';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { avisoCollection } from '@delfrance/data/admin/collections';

import { getDb } from '../lib/admin';

/**
 * Retention for the operator notification inbox: delete RESOLVED avisos once
 * they are old enough that nobody is going to look them up.
 *
 * ## Why a sweep and not a TTL policy — a cost call, not a capability gap
 *
 * A TTL policy COULD express this. A TTL only deletes documents that carry its
 * field, so `resolverAviso` could stamp an `expiraEm` (`ttlExpiry()` in
 * `@delfrance/schemas`) 90 days after `resolvidoEm` and a reopen could clear it
 * — `criadoEm` stays wrong as the key, since it would expire still-OPEN avisos
 * (an authorization warning legitimately stands for 200 days). The repo now does
 * exactly that for four collection groups (`TTL_POLICIES`, #651).
 *
 * This sweep stays because it already works and the swap would cost more than it
 * saves: a schema field, a stamp on resolve, a clear on reopen, their tests —
 * against one small indexed query a day. Revisit if the volume changes. Two facts
 * for whoever does:
 *   - TTL deletes bill as Managed Delete Units with no free grant — the same
 *     deletes this sweep already pays for, minus its scan.
 *   - Removing a policy's block from `firestore.indexes.json` does NOT remove the
 *     policy: without `--force` the CLI only warns (or asks), and the database
 *     keeps auto-deleting. Turn one off with an explicit `"ttl": false` first.
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
