import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { diffDocumentFields } from '@delfrance/core';
import { millisToMicros, nowMicros } from '@delfrance/core/datetime';
import {
  historicoModificacaoCollection,
  produtoCollection,
} from '@delfrance/data/admin/collections';

import { getDb } from './admin';

/**
 * Generic modification-history recorder — one entry per CloudEvent under the
 * OWNING produto; reusable for other collection roots later (`resolve()`
 * decides the history parent). `onProdutoChanged` (`../produtos/onProdutoChanged`)
 * is the first, produto-rooted caller; a future subcollection trigger (e.g.
 * `estoques`) would supply its own `ModificationHistorySource` instead of a
 * new copy of this plumbing.
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
}): ModificationEntry | null {
  const diff = diffDocumentFields(input.before, input.after, { ignore: input.ignore });
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
 * Write one entry at a deterministic id (`entry.eventId`) — a redelivery of
 * the same CloudEvent rewrites a content-identical doc, never a duplicate.
 *
 * `opts.requireParentExists` guards writes racing (or delivered after)
 * `onProdutoDeleted`'s subtree walk: the cascade fires DELETE events for
 * every swept subcollection doc, and a user's create/update event can also be
 * delivered late, once the owning produto is already gone (a subcollection
 * event carries no parent-liveness guarantee). Recording an entry under a
 * deleted (or mid-delete) produto would either be swept a moment later or
 * orphaned outright, so EVERY entry kind re-checks the parent and skips
 * (returning `false`) when it is missing — one extra read per guarded write.
 */
export async function recordModification(
  db: Firestore,
  produtoId: string,
  entry: ModificationEntry,
  opts?: { requireParentExists?: boolean },
): Promise<boolean> {
  if (opts?.requireParentExists) {
    const produtoSnap = await produtoCollection.docRef(db, {}, produtoId).get();
    if (!produtoSnap.exists) return false;
  }

  const ref = historicoModificacaoCollection.docRef(db, { produtoId }, entry.eventId);
  await ref.set(historicoModificacaoCollection.parse(entry));
  return true;
}

/** Wires a `ModificationHistorySource` into a full history-recording trigger. */
export interface ModificationHistorySource {
  /** `null` when the document IS the produto (no subcollection hop). */
  subcolecao: string | null;
  ignoreFields: ReadonlyArray<string>;
  /** Maps the trigger's `event.params` to the produto owning the history
   *  subcollection, the id of the changed doc, and its `historicoDeModificacoes`
   *  `path` field. */
  resolve(params: Record<string, string>): { produtoId: string; docId: string; path: string };
  /** Extra fields to ignore for THIS write, computed from the revisions
   *  themselves (e.g. a variation child's propagated `precos`). */
  extraIgnores?(
    before: DocumentData | undefined,
    after: DocumentData | undefined,
  ): ReadonlyArray<string>;
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
      const { produtoId, docId, path } = source.resolve(params);
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
      });
      if (entry === null) return;

      await recordModification(getDb(), produtoId, entry, {
        requireParentExists: source.requireParentExists,
      });
    },
  );
}
