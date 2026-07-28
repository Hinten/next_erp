import { z } from 'zod';
import { microsSinceEpoch } from './shared/datetime';
import type { CollectionMetadata } from './types';

/**
 * `arquivoOrphanSweepState` (TOP-LEVEL, ONE fixed doc — id
 * {@link ARQUIVO_ORPHAN_SWEEP_STATE_DOC_ID}) — the persisted round-robin cursor
 * for `sweepUnreferencedArquivos` (#234). The unreferenced-arquivo backstop used
 * to page `arquivos` oldest-`criadoEm`-first, which meant a catalog with more
 * than one batch (`BATCH_LIMIT`, 100) of long-lived REFERENCED photos older than
 * a given orphan would starve that orphan out of the scan window forever — a
 * liveness gap, not a correctness bug (nothing wrong ever got deleted).
 *
 * The fix pages by **document key** (`FieldPath.documentId()`, Firestore's
 * always-available native ordering — no index needed) instead, and persists how
 * far the last tick got so the NEXT tick continues from there rather than
 * re-reading the same head of the collection. When a page comes back shorter
 * than `BATCH_LIMIT` the sweep has reached the end of the collection in key
 * order, so it wraps `lastKey` back to `null` — this guarantees every arquivo is
 * examined within `ceil(total / BATCH_LIMIT)` ticks regardless of orphan
 * density, at the cost of the old "only scan documents old enough to matter"
 * shortcut (age + ownership scoping now happen on the fetched page, in code,
 * same as the owner-reference re-check already did).
 *
 * Admin-only / default-deny: bare `{ schema, meta }` (perms `0n`), NOT
 * registered in `ALL_DOMAINS` (mirrors `backfillPedidosMercadoLivre` /
 * `notificacoesWhatsapp` — only `reconcileArquivoOrphans` — Admin SDK — ever
 * touches this collection), so clients can't read it, the rules generator emits
 * no match block, and no rules regen is needed.
 */

/** Fixed doc id — one process-wide cursor, not per-conta/per-entity. */
export const ARQUIVO_ORPHAN_SWEEP_STATE_DOC_ID = 'cursor';

export const arquivoOrphanSweepStateSchema = z.object({
  /**
   * The document id (within `arquivos`, key-ordered) the last tick finished
   * reading through — the next tick's page starts right after it via
   * `startAfter`. `null` means "start (or restart) from the beginning".
   */
  lastKey: z.string().nullable().default(null),
  /** When the cursor last advanced (µs) — observability only, not read by the sweep. */
  updatedAt: microsSinceEpoch().nullable().default(null),
});
export type ArquivoOrphanSweepState = z.infer<typeof arquivoOrphanSweepStateSchema>;

export const arquivoOrphanSweepStateMeta: CollectionMetadata = {
  collectionPath: 'arquivoOrphanSweepState',
  // No client domain grants these bits — placeholder values. Deliberately NOT
  // registered in `ALL_DOMAINS`, so the rules generator emits no match block
  // and Firestore default-denies every client read/write. Only the Admin SDK
  // (apps/functions `reconcileArquivoOrphans`) reaches it.
  permissions: {
    read: 0n,
    write: 0n,
    delete: 0n,
  },
};

// NOTE: intentionally exported as two BARE constants (`...Schema` + `...Meta`),
// not a single `{ schema, meta }` DomainSchema object, and NOT added to
// `ALL_DOMAINS` — `registry.test.ts`'s `isDomainSchema()` only flags a single
// export carrying both a `.schema` and a `.meta` property, so this shape never
// gets swept in by accident (mirrors `backfillPedidosMercadoLivreSchema` /
// `notificacoesWhatsappSchema`). The admin collection handle
// (`arquivoOrphanSweepStateCollection`) consumes
// `arquivoOrphanSweepStateMeta.collectionPath` directly.
