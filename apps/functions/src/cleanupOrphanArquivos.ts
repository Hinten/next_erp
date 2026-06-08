import { logger } from 'firebase-functions';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import {
  arquivoCollection,
  produtoCollection,
} from '@delfrance/data/admin/collections';

import { getDb } from './admin';
import { isOlderThanGrace, referencedArquivoIds } from './orphans';

const REGION = 'us-east1';
/** Files newer than this are never reaped (may not be linked yet). */
const GRACE_MS = 24 * 60 * 60 * 1000;
/** Cap deletions per run so a sweep can't run away. */
const BATCH = 200;

/**
 * Periodic orphan sweep: delete `Arquivo` docs that no produto references and
 * that are older than the grace period. Deleting the doc cascades to
 * `onArquivoDeleted`, which removes the Storage object.
 *
 * Pipeline-free: a plain scan of `produtos` builds the referenced-id set, and a
 * plain `where('criadoEm','<', cutoff)` range query lists candidates — so this
 * runs against the emulator. Complements (does not duplicate) the inherited
 * Flutter `manutencaoFotosProduto`, which only reacts to `produto` writes.
 *
 * Note: scans all `produtos` per run — fine for a daily job; paginate if the
 * catalog grows large.
 */
export const cleanupOrphanArquivos = onSchedule(
  { region: REGION, schedule: 'every 24 hours' },
  async () => {
    const db = getDb();

    const referenced = new Set<string>();
    const produtos = await produtoCollection.ref(db, {}).get();
    for (const doc of produtos.docs) {
      for (const id of referencedArquivoIds(doc.data())) referenced.add(id);
    }

    const now = Date.now();
    const cutoff = new Date(now - GRACE_MS).toISOString();
    const candidates = await arquivoCollection
      .ref(db, {})
      .where('criadoEm', '<', cutoff)
      .limit(BATCH)
      .get();

    let deleted = 0;
    for (const doc of candidates.docs) {
      const criadoEm = doc.get('criadoEm') as string | undefined;
      if (!isOlderThanGrace(criadoEm, now, GRACE_MS)) continue;
      if (referenced.has(doc.id)) continue;
      await doc.ref.delete();
      deleted += 1;
    }

    logger.info(
      `cleanupOrphanArquivos: scanned ${candidates.size} candidate(s), deleted ${deleted}`,
    );
  },
);
