import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import type { z } from 'zod';
import { diffDocumentFields, type ExpandSpec } from '@delfrance/core';
import { millisToMicros, nowMicros } from '@delfrance/core/datetime';
import type { AdminCollectionHandle } from '@delfrance/data/admin';

import { getDb } from './admin';

/**
 * Generic modification-history recorder — one entry per CloudEvent under the
 * OWNING ROOT document.
 *
 * The root is INJECTED ({@link ModificationHistoryRoot}), so one implementation
 * serves `produtos/{produtoId}/historicoDeModificacoes` and
 * `pedidos/{pedidoId}/historicoDeModificacoes`; a source's `resolve()` decides
 * WHICH root document a given event belongs to, and whether the event came from
 * the root document itself or one of its covered subcollections.
 *
 * The concrete roots live in `./historyRoots`, not here — the same split as
 * `cascadeCaroGenerico.ts` (generic) vs `../cascades/caroGenericoTriggers.ts`
 * (the three instantiations). This module therefore imports no domain
 * collection and cannot grow a per-root branch.
 */

/** One `historicoDeModificacoes` entry — the shape the schema validates. */
export interface ModificationEntry {
  path: string;
  subcolecao: string | null;
  docId: string;
  kind: 'create' | 'update' | 'delete';
  campos: string[];
  changes: Record<string, { old: unknown; new: unknown }>;
  timestamp: number;
  eventId: string;
}

/**
 * The two collection handles + the wildcard name that bind a history trigger to
 * ONE root document collection.
 *
 * `parentIdParam` is the `{wildcard}` BOTH handles resolve the root id under
 * (`produtoId`, `pedidoId`). It is passed explicitly rather than parsed out of
 * the history collection's path because it is ALSO the key the trigger reads off
 * `event.params` — keeping the two as one value is what makes a mismatch
 * impossible.
 */
export interface ModificationHistoryRoot {
  /** Handle for the ROOT document collection (`produtos`, `pedidos`). */
  parentCollection: AdminCollectionHandle<z.ZodTypeAny>;
  /** Handle for that root's `historicoDeModificacoes` subcollection. */
  historyCollection: AdminCollectionHandle<z.ZodTypeAny>;
  /** Wildcard name both handles (and `event.params`) key the root id under. */
  parentIdParam: string;
}

/**
 * Diff `before`/`after` into a {@link ModificationEntry}, or `null` when
 * nothing outside `ignore` changed (mirrors {@link diffDocumentFields}'s
 * empty-diff `null`). Pure — no I/O — so the trigger's guard logic and the
 * entry shape are unit-testable without a live db.
 */
export function buildModificationEntry(input: {
  before: DocumentData | undefined;
  after: DocumentData | undefined;
  ignore: ReadonlyArray<string>;
  path: string;
  subcolecao: string | null;
  docId: string;
  eventId: string;
  /** Event time as MICROSECONDS since epoch (`microsSinceEpoch` convention). */
  eventTimeMicros: number;
  /** Per-field descent; see {@link ModificationHistorySource.expand}. */
  expand?: Readonly<Record<string, ExpandSpec>>;
}): ModificationEntry | null {
  const diff = diffDocumentFields(input.before, input.after, {
    ignore: input.ignore,
    expand: input.expand,
  });
  if (diff === null) return null;
  return {
    path: input.path,
    subcolecao: input.subcolecao,
    docId: input.docId,
    kind: diff.kind,
    campos: diff.campos,
    changes: diff.changes,
    timestamp: input.eventTimeMicros,
    eventId: input.eventId,
  };
}

/**
 * Write one entry at a deterministic id (`entry.eventId`) under `root` — a
 * redelivery of the same CloudEvent rewrites a content-identical doc, never a
 * duplicate.
 *
 * `opts.requireParentExists` guards writes racing (or delivered after) a
 * parent-delete cascade: the cascade fires DELETE events for every swept
 * subcollection doc, and a user's create/update event can also be delivered
 * late, once the owning root doc is already gone (a subcollection event carries
 * no parent-liveness guarantee). Under a root that HAS a sweeping cascade
 * (`produtos` → `onProdutoDeleted`), recording an entry would either be swept a
 * moment later or orphaned outright, so every entry kind re-checks the parent
 * and skips (returning `false`) when it is missing — one extra read per guarded
 * write.
 *
 * ⚠️ Under a root with NO cascade the flag must be left OFF. `pedidos` declares
 * a cascade and deliberately has no trigger (owner call, 2026-08 — `nfev4` holds
 * emitted fiscal documents), so nothing sweeps a pedido's subtree: there the row
 * is the only surviving record of what happened, and dropping it would silence
 * exactly the event that most needs auditing. See the rationale on each
 * `ModificationHistorySource`.
 */
export async function recordModification(
  db: Firestore,
  root: ModificationHistoryRoot,
  parentId: string,
  entry: ModificationEntry,
  opts?: { requireParentExists?: boolean },
): Promise<boolean> {
  if (opts?.requireParentExists) {
    const parentSnap = await root.parentCollection.docRef(db, {}, parentId).get();
    if (!parentSnap.exists) return false;
  }

  const ref = root.historyCollection.docRef(db, { [root.parentIdParam]: parentId }, entry.eventId);
  await ref.set(root.historyCollection.parse(entry) as DocumentData);
  return true;
}

/** Wires a `ModificationHistorySource` into a full history-recording trigger. */
export interface ModificationHistorySource {
  /** The root document collection this source's documents hang off. */
  root: ModificationHistoryRoot;
  /** `null` when the document IS the root doc (no subcollection hop). */
  subcolecao: string | null;
  ignoreFields: ReadonlyArray<string>;
  /**
   * Maps the trigger's `event.params` to the ROOT document owning the history
   * subcollection, the id of the changed doc, and its `historicoDeModificacoes`
   * `path` field.
   */
  resolve(params: Record<string, string>): { parentId: string; docId: string; path: string };
  /**
   * Extra fields to ignore for THIS write, computed from the revisions
   * themselves (e.g. a variation child's propagated `precos`).
   */
  extraIgnores?(
    before: DocumentData | undefined,
    after: DocumentData | undefined,
  ): ReadonlyArray<string>;
  /**
   * Opt a top-level field into a per-element diff instead of storing both whole
   * values (`pedido.itens`). Absent for every produto source, which is what
   * keeps their entries byte-identical to before the option existed.
   */
  expand?: Readonly<Record<string, ExpandSpec>>;
  requireParentExists?: boolean;
}

/**
 * Build an `onDocumentWritten` trigger that records exactly one
 * {@link ModificationEntry} per write, per {@link ModificationHistorySource}.
 * Targets the repo's NAMED `default` database (gotcha #8) — a trigger that
 * omits `database` binds to `(default)` and never fires.
 */
export function makeModificationHistoryTrigger(
  document: string,
  source: ModificationHistorySource,
) {
  return onDocumentWritten(
    { document, database: process.env.FIREBASE_DATABASE_ID ?? 'default' },
    async (event) => {
      const params = event.params as Record<string, string>;
      const { parentId, docId, path } = source.resolve(params);
      const before = event.data?.before?.data();
      const after = event.data?.after?.data();
      // `event.time` is the CloudEvent occurrence time — stable across
      // redeliveries of the SAME event, so the deterministic entry doc stays
      // content-identical on retries. Stored as MICROSECONDS since epoch
      // (`microsSinceEpoch`, the repo's datetime standard — ms-derived × 1000,
      // same precision model as `nowMicros()`).
      const eventTimeMillis = Date.parse(event.time);

      const entry = buildModificationEntry({
        before,
        after,
        ignore: [...source.ignoreFields, ...(source.extraIgnores?.(before, after) ?? [])],
        path,
        subcolecao: source.subcolecao,
        docId,
        eventId: event.id,
        eventTimeMicros: Number.isNaN(eventTimeMillis)
          ? nowMicros()
          : millisToMicros(eventTimeMillis),
        expand: source.expand,
      });
      if (entry === null) return;

      await recordModification(getDb(), source.root, parentId, entry, {
        requireParentExists: source.requireParentExists,
      });
    },
  );
}
