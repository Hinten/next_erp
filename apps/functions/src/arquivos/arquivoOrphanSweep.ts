import {
  FieldPath,
  Filter,
  type DocumentReference,
  type Firestore,
  type Query,
  type Transaction,
} from 'firebase-admin/firestore';
import type { Storage } from 'firebase-admin/storage';
import { getStorage } from 'firebase-admin/storage';
import { logger } from 'firebase-functions';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import {
  arquivoCollection,
  arquivoOrphanSweepStateCollection,
  mensagemCollection,
  produtoCollection,
  tabelaDeMedidasCollection,
} from '@delfrance/data/admin/collections';
import { coerceToMicros } from '@delfrance/core/datetime';
import {
  ARQUIVO_ORPHAN_SWEEP_STATE_DOC_ID,
  ARQUIVOS_COLLECTION,
  MENSAGEM_ARQUIVO_REF_FIELDS,
  type MediaOwnerCollection,
  mensagemArquivoRefValues,
  nowMicros,
  parseMensagemMediaDir,
  parseOwnedMediaDir,
} from '@delfrance/schemas';

import { getAdminApp, getDb } from '../lib/admin';
import { isGrpcLikeError } from '../lib/grpcErrors';

type Bucket = ReturnType<Storage['bucket']>;

// Bound each pass so neither can blow the function budget; the every-48h schedule
// drains a backlog over several runs.
const BATCH_LIMIT = 100;
const MENSAGEM_REFERENCE_CONCURRENCY = 8;

// Admin handles keyed by media-owner collection — the sweep/reaper read a
// candidate's owner doc to see which arquivos it still references.
const OWNER_HANDLES = {
  produtos: produtoCollection,
  tabMedi: tabelaDeMedidasCollection,
} as const;

/**
 * Grace window in **microseconds** below which a doc is still considered "in
 * flight" — create-first writes the doc, THEN uploads, AND an arquivo is
 * unreferenced until its owner or mensagem is saved — so a young doc may not yet
 * have its object / reference. Read per call (not at module load) so the emulator
 * suite can drop it to 0. 48h by default; non-numeric/negative falls back to 48h.
 */
function orphanGraceMicros(): number {
  const raw = Number(process.env.ARQUIVO_ORPHAN_GRACE_HOURS ?? '48');
  const hours = Number.isFinite(raw) && raw >= 0 ? raw : 48;
  return hours * 3_600_000 * 1000;
}

/**
 * Grace window in **microseconds** for a MARKED arquivo (`markedForDeletionAt`,
 * set by an eager owner/mensagem trigger). The mark is a deliberate signal — a
 * trigger saw a ref removed — so this is **short** by default (1h, a
 * brief buffer for a quick undo/re-add) versus the 48h orphan grace. Read per
 * call so the emulator suite can drop it to 0. `ARQUIVO_MARKED_GRACE_HOURS`
 * overrides; non-numeric/negative falls back to 1h.
 */
function markedGraceMicros(): number {
  const raw = Number(process.env.ARQUIVO_MARKED_GRACE_HOURS ?? '1');
  const hours = Number.isFinite(raw) && raw >= 0 ? raw : 1;
  return hours * 3_600_000 * 1000;
}

/**
 * Phantom-doc sweep: an `arquivos` doc stuck `uploadState: 'pending'` past the
 * grace window whose Storage object never arrived — a create-first upload the
 * client abandoned. Deletes the doc. If the object IS present (the trigger
 * missed/lagged the finalize), self-heals the marker to `'finalized'` instead.
 *
 * The pending + grace + oldest-first selection is all in the QUERY (equality +
 * range + orderBy), so it needs the composite index `arquivos(uploadState ASC,
 * criadoEm ASC)` — this Firestore Enterprise edition creates no index
 * automatically. Exported for the emulator suite.
 */
export async function sweepPhantomDocs(db: Firestore, bucket: Bucket): Promise<number> {
  const cutoff = nowMicros() - orphanGraceMicros();
  const pending = await arquivoCollection
    .ref(db, {})
    .where('uploadState', '==', 'pending')
    .where('criadoEm', '<', cutoff)
    .orderBy('criadoEm', 'asc')
    .limit(BATCH_LIMIT)
    .get();

  let deleted = 0;
  let healed = 0;
  let kept = 0;
  let failed = 0;
  for (const doc of pending.docs) {
    try {
      const data = doc.data();
      const filepath = data.filepath as string | null | undefined;
      const filename = data.filename as string | undefined;
      if (!filename) {
        // A 'pending' doc with no filename can't be resolved to an object — it
        // can't happen via create-first (filename is schema-required), so warn
        // rather than skip silently (mirrors reconcileProductImages).
        kept += 1;
        logger.warn(`sweepPhantomDocs: ${doc.id} is 'pending' with no filename — skipping`);
        continue;
      }
      const objectName = filepath ? `${filepath}/${filename}` : filename;
      const [exists] = await bucket.file(objectName).exists();
      if (exists) {
        await doc.ref.update({ uploadState: 'finalized' });
        healed += 1;
        continue;
      }
      await doc.ref.delete();
      deleted += 1;
    } catch (err) {
      if (!isGrpcLikeError(err)) throw err;
      failed += 1;
      logger.error(`sweepPhantomDocs: ${doc.id} failed`, err);
    }
  }
  logger.info(
    `sweepPhantomDocs: ${deleted} deleted, ${healed} healed, ${kept} kept, ${failed} failed`,
  );
  return deleted;
}

/**
 * Collect every `arquivos/<id>` ref the given OWNER docs (`produtos` or
 * `tabMedi`) currently use — across their embedded `fotos` / `videos` / `anexos`
 * arrays. Reads **only** the named owner docs (one batched `getAll`, projected to
 * the three media arrays), NOT the whole collection: an owner arquivo encodes its
 * owner id in its storage path, so the sweep already knows which doc to ask about
 * (tabMedi has only `fotos`; the other masks return nothing — harmless).
 *
 * An owner that doesn't exist contributes nothing — its arquivos are orphans.
 * Plain admin SDK reads (no pipeline), so this is fully emulator-testable.
 */
export async function resolveReferencedRefs(
  db: Firestore,
  ownerCollection: MediaOwnerCollection,
  ownerIds: string[],
): Promise<Set<string>> {
  const refs = new Set<string>();
  // De-dup — callers may pass repeats; one getAll per DISTINCT owner (avoids
  // redundant reads + keeps the getAll arg list bounded).
  const uniqueIds = [...new Set(ownerIds)];
  if (uniqueIds.length === 0) return refs;

  // The admin handle's docRef returns a RAW ref (no converter — see
  // defineAdminCollection), so the field-masked partial read below is safe; the
  // handle just sources the collection path from schemas.
  const handle = OWNER_HANDLES[ownerCollection];
  const docRefs = uniqueIds.map((id) => handle.docRef(db, {}, id));
  // Field mask → transfer only the three media arrays, still one read per owner.
  const snaps = await db.getAll(...docRefs, { fieldMask: ['fotos', 'videos', 'anexos'] });
  for (const snap of snaps) {
    if (!snap.exists) continue; // owner deleted → leave its arquivos orphaned
    const data = (snap.data() ?? {}) as Record<string, unknown>;
    for (const key of ['fotos', 'videos', 'anexos'] as const) {
      const arr = data[key];
      if (!Array.isArray(arr)) continue;
      for (const el of arr) {
        const ref = (el as { arquivoOuterRef?: unknown } | null)?.arquivoOuterRef;
        if (typeof ref === 'string' && ref) refs.add(ref);
      }
    }
  }
  return refs;
}

/** Produto-only view of {@link resolveReferencedRefs}, kept for its callers + test. */
export function resolveReferencedArquivoRefs(
  db: Firestore,
  produtoIds: string[],
): Promise<Set<string>> {
  return resolveReferencedRefs(db, 'produtos', produtoIds);
}

/**
 * The indexed collection-group query used for mensagem-owned media refcounts.
 * Each field accepts both ref encodings carried by the imported corpus.
 */
export function buildMensagemArquivoReferenceQuery(db: Firestore, arquivoId: string): Query {
  const values = [...mensagemArquivoRefValues(arquivoId)];
  const filters = MENSAGEM_ARQUIVO_REF_FIELDS.map((field) => Filter.where(field, 'in', values));
  return mensagemCollection
    .groupQuery(db)
    .where(Filter.or(...filters))
    .select(...MENSAGEM_ARQUIVO_REF_FIELDS)
    .limit(1);
}

async function mensagemArquivoIsReferenced(
  db: Firestore,
  arquivoId: string,
  tx?: Transaction,
): Promise<boolean> {
  const query = buildMensagemArquivoReferenceQuery(db, arquivoId);
  const snapshot = tx ? await tx.get(query) : await query.get();
  return !snapshot.empty;
}

/**
 * Resolve which candidate ids have at least one live mensagem reference.
 * Queries are independent but bounded so one 100-row sweep page never fans out
 * 100 simultaneous collection-group reads.
 */
export async function resolveMensagemArquivoReferences(
  db: Firestore,
  arquivoIds: string[],
): Promise<Set<string>> {
  const ids = [...new Set(arquivoIds)];
  const referenced = new Set<string>();
  let cursor = 0;
  const worker = async () => {
    while (cursor < ids.length) {
      const index = cursor;
      cursor += 1;
      const id = ids[index]!;
      if (await mensagemArquivoIsReferenced(db, id)) referenced.add(id);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MENSAGEM_REFERENCE_CONCURRENCY, ids.length) }, worker),
  );
  return referenced;
}

export type MensagemArquivoReconcileOutcome = 'deleted' | 'referenced' | 'missing' | 'out-of-scope';

/**
 * Final, race-safe deletion decision for one mensagem-owned arquivo.
 *
 * Class A transaction: the candidate doc and the global mensagem refcount query
 * are both read inside the callback. Message writers read this same anchor in
 * their own transaction before creating refs. Firestore OCC/serializable
 * retries therefore prevent either interleaving from committing a dangling ref.
 */
export function reconcileMensagemArquivoCandidate(
  db: Firestore,
  ref: DocumentReference,
): Promise<MensagemArquivoReconcileOutcome> {
  return db.runTransaction(async (tx) => {
    const arquivo = await tx.get(ref);
    if (!arquivo.exists) return 'missing';
    const data = arquivo.data() ?? {};
    if (!parseMensagemMediaDir(data.filepath as string | null | undefined)) {
      if (data.markedForDeletionAt != null) tx.update(ref, { markedForDeletionAt: null });
      return 'out-of-scope';
    }
    if (await mensagemArquivoIsReferenced(db, ref.id, tx)) {
      if (data.markedForDeletionAt != null) tx.update(ref, { markedForDeletionAt: null });
      return 'referenced';
    }
    tx.delete(ref);
    return 'deleted';
  });
}

/** One raw `arquivos` doc read during a round-robin page scan (pre age/scope filter). */
interface ArquivoPageRow {
  ref: DocumentReference;
  id: string;
  filepath: string | null;
  criadoEm: number | null;
}

/**
 * Fetches the next `BATCH_LIMIT`-sized page of `arquivos`, ordered by document
 * key, starting right after `lastKey` (`null` → from the beginning).
 */
type FetchArquivoPage = (db: Firestore, lastKey: string | null) => Promise<ArquivoPageRow[]>;

/** Resolves the `arquivos/<id>` refs a set of owner docs currently uses. */
type ResolveReferenced = (
  ownerCollection: MediaOwnerCollection,
  ownerIds: string[],
) => Promise<ReadonlySet<string>>;

/** Resolves which mensagem-media Arquivo ids currently have a live reference. */
type ResolveMensagemReferenced = (arquivoIds: string[]) => Promise<ReadonlySet<string>>;

/**
 * Default page fetch: a plain **classic** query ordered by
 * `FieldPath.documentId()` — Firestore's always-available native ordering, no
 * declared index needed — paginated with `startAfter(lastKey)`. Unlike the old
 * `criadoEm`-oldest-first scan, this is **not** scoped server-side to owner
 * media or the grace window: {@link sweepUnreferencedArquivos} applies both
 * filters to the fetched page, in code, the same way it already re-verifies
 * owner references. No pipeline involved, so this runs in the emulator too.
 *
 * `criadoEm` is read raw (no `arquivoCollection.parseRead`, which would
 * validate the WHOLE doc for a field the sweep only needs to compare) but
 * still runs through the schema's own tolerant `coerceToMicros` — the same
 * coercion `microsSinceEpoch()` applies on a normal read — so a legacy ms
 * number / ISO string / `Date` still resolves to a real µs value instead of
 * being permanently treated as "unknown age, never sweep".
 */
async function fetchArquivoPage(db: Firestore, lastKey: string | null): Promise<ArquivoPageRow[]> {
  let query = arquivoCollection.ref(db, {}).orderBy(FieldPath.documentId()).limit(BATCH_LIMIT);
  if (lastKey !== null) query = query.startAfter(lastKey);
  const snap = await query.get();
  return snap.docs.map((doc) => {
    const data = doc.data();
    const filepath = data.filepath as string | null | undefined;
    return {
      ref: doc.ref,
      id: doc.id,
      filepath: typeof filepath === 'string' ? filepath : null,
      criadoEm: coerceToMicros(data.criadoEm),
    };
  });
}

/**
 * Unreferenced-arquivo sweep: delete owner media (photos / videos / anexos) and
 * mensagem media (`whatsapp/` / `chat/`) older than the grace window when no
 * live owner/mensagem references them. Deleting the doc lets `onArquivoDeleted`
 * free the object + cascade any derivatives.
 *
 * **Round-robin paging (#234).** The old oldest-`criadoEm`-first scan always
 * re-read the same head of the collection, so once the catalog accumulated more
 * than `BATCH_LIMIT` long-lived REFERENCED photos older than a given orphan,
 * that orphan never entered the scan window again — a liveness gap. This now
 * pages `arquivos` by **document key** via {@link fetchArquivoPage} (no
 * server-side age/ownership filter) and persists how far it got in
 * `arquivoOrphanSweepStateCollection` (doc {@link ARQUIVO_ORPHAN_SWEEP_STATE_DOC_ID}):
 * the next tick's page starts right after it. A page shorter than
 * `BATCH_LIMIT` means the scan reached the end of the collection in key order,
 * so the cursor wraps back to `null` — guaranteeing every arquivo is examined
 * within `ceil(total / BATCH_LIMIT)` ticks regardless of orphan density. Age
 * (grace window) and ownership (`parseOwnedMediaDir`) scoping now happen on
 * the fetched page, in code — same treatment the owner-reference re-check
 * already got. Each owning produto/tabMedi is then read directly (see {@link
 * resolveReferencedArquivoRefs}) — no full-collection scan there either. Both
 * seams (`fetchPage`, `resolveReferenced`) default to the real
 * implementations; the emulator suite can override either, though neither
 * needs a pipeline anymore.
 */
export async function sweepUnreferencedArquivos(
  db: Firestore,
  bucket: Bucket,
  // `bucket` is unused (object cleanup is onArquivoDeleted's job) but kept for
  // signature parity with sweepPhantomDocs and the reconcile call site.
  fetchPage: FetchArquivoPage = fetchArquivoPage,
  resolveReferenced: ResolveReferenced = (coll, ids) => resolveReferencedRefs(db, coll, ids),
  resolveMensagemReferenced: ResolveMensagemReferenced = (ids) =>
    resolveMensagemArquivoReferences(db, ids),
): Promise<number> {
  const cutoff = nowMicros() - orphanGraceMicros();
  const cursorSnap = await arquivoOrphanSweepStateCollection
    .docRef(db, {}, ARQUIVO_ORPHAN_SWEEP_STATE_DOC_ID)
    .get();
  const lastKey = cursorSnap.exists
    ? ((cursorSnap.data()?.lastKey as string | null | undefined) ?? null)
    : null;

  const page = await fetchPage(db, lastKey);
  const reachedEnd = page.length < BATCH_LIMIT;

  // Derive each candidate's owner from its filepath; group distinct ids per
  // owner collection for one batched lookup each.
  const ownerItems: { ref: DocumentReference; refPath: string }[] = [];
  const mensagemItems: { ref: DocumentReference; id: string }[] = [];
  const idsByOwner = new Map<MediaOwnerCollection, Set<string>>();
  for (const row of page) {
    if (row.criadoEm === null || row.criadoEm >= cutoff) continue; // too young (or unknown age) — never sweep
    const parsed = parseOwnedMediaDir(row.filepath);
    if (!parsed) {
      if (parseMensagemMediaDir(row.filepath)) mensagemItems.push({ ref: row.ref, id: row.id });
      continue; // derivative, generic media/, or unknown root
    }
    ownerItems.push({ ref: row.ref, refPath: `${ARQUIVOS_COLLECTION}/${row.id}` });
    let set = idsByOwner.get(parsed.ownerCollection);
    if (!set) {
      set = new Set();
      idsByOwner.set(parsed.ownerCollection, set);
    }
    set.add(parsed.ownerId);
  }

  const referencedRefs = new Set<string>();
  for (const [coll, ids] of idsByOwner) {
    for (const r of await resolveReferenced(coll, [...ids])) referencedRefs.add(r);
  }
  const referencedMensagemIds = await resolveMensagemReferenced(mensagemItems.map((i) => i.id));

  let ownerDeleted = 0;
  let ownerReferenced = 0;
  let ownerFailed = 0;
  let mensagemDeleted = 0;
  let mensagemReferenced = 0;
  let mensagemMissing = 0;
  let mensagemOutOfScope = 0;
  let mensagemFailed = 0;
  for (const { ref, refPath } of ownerItems) {
    try {
      if (referencedRefs.has(refPath)) {
        ownerReferenced += 1;
        continue;
      }
      // Unreferenced + past grace → delete the doc; onArquivoDeleted frees the
      // object and cascades derivatives.
      await ref.delete();
      ownerDeleted += 1;
    } catch (err) {
      if (!isGrpcLikeError(err)) throw err;
      ownerFailed += 1;
      logger.error(`sweepUnreferencedArquivos: ${ref.id} failed`, err);
    }
  }

  for (const { ref, id } of mensagemItems) {
    try {
      if (referencedMensagemIds.has(id)) {
        mensagemReferenced += 1;
        continue;
      }
      // The outside query is only a cheap pre-filter. The delete verdict is
      // always recomputed transactionally to close the query→delete race.
      const outcome = await reconcileMensagemArquivoCandidate(db, ref);
      if (outcome === 'deleted') mensagemDeleted += 1;
      else if (outcome === 'missing') mensagemMissing += 1;
      else if (outcome === 'referenced') mensagemReferenced += 1;
      else mensagemOutOfScope += 1;
    } catch (err) {
      if (!isGrpcLikeError(err)) throw err;
      mensagemFailed += 1;
      logger.error(`sweepUnreferencedArquivos: mensagem arquivo ${ref.id} failed`, err);
    }
  }

  const nextKey = reachedEnd ? null : (page[page.length - 1]?.id ?? null);
  await arquivoOrphanSweepStateCollection.merge(db, {}, ARQUIVO_ORPHAN_SWEEP_STATE_DOC_ID, {
    lastKey: nextKey,
    updatedAt: nowMicros(),
  });

  logger.info(
    `sweepUnreferencedArquivos: ${page.length} scanned; owner candidates=${ownerItems.length} referenced=${ownerReferenced} deleted=${ownerDeleted} failed=${ownerFailed}; mensagem candidates=${mensagemItems.length} referenced=${mensagemReferenced} deleted=${mensagemDeleted} missing=${mensagemMissing} outOfScope=${mensagemOutOfScope} failed=${mensagemFailed}; cursor ${lastKey ?? '(start)'} -> ${nextKey ?? '(wrapped)'}`,
  );
  return ownerDeleted + mensagemDeleted + mensagemMissing;
}

/**
 * Marked-for-deletion sweep: delete `arquivos` docs stamped by the eager owner
 * or mensagem triggers once they're past the short grace window — but only
 * after re-verifying the owner or the global mensagem references. Deleting the
 * doc lets `onArquivoDeleted` free the object; a still-referenced doc has its
 * mark cleared instead.
 *
 * This is the **eager** cleanup path's back half — the trigger captures the
 * removal cheaply at edit time, so this sweep is a plain admin range query
 * (`where markedForDeletionAt < cutoff orderBy markedForDeletionAt asc`, **no**
 * pipeline → emulator-runnable) over the single-field index
 * `arquivos(markedForDeletionAt ASC)`. Unmarked docs (`null`) are excluded by the
 * range predicate. The owner re-check reuses {@link resolveReferencedArquivoRefs}
 * (one batched `getAll`). Bounded by `BATCH_LIMIT`; isolates per-doc failures.
 */
export async function sweepMarkedForDeletion(db: Firestore): Promise<number> {
  const cutoff = nowMicros() - markedGraceMicros();
  const marked = await arquivoCollection
    .ref(db, {})
    .where('markedForDeletionAt', '<', cutoff)
    .orderBy('markedForDeletionAt', 'asc')
    .limit(BATCH_LIMIT)
    .get();

  if (marked.empty) {
    logger.info('sweepMarkedForDeletion: 0 candidates');
    return 0;
  }

  // Re-verify against the owning docs in one batched lookup per owner collection:
  // derive each candidate's owner from its filepath, resolve the refs those owners
  // still hold, then delete only the genuinely-unreferenced ones.
  const items: {
    ref: DocumentReference;
    refPath: string;
    scope: 'owner' | 'mensagem' | 'unknown';
  }[] = [];
  const idsByOwner = new Map<MediaOwnerCollection, Set<string>>();
  for (const doc of marked.docs) {
    const filepath = (doc.data().filepath as string | null | undefined) ?? null;
    const parsed = parseOwnedMediaDir(filepath);
    const mensagem = parseMensagemMediaDir(filepath);
    if (parsed) {
      let set = idsByOwner.get(parsed.ownerCollection);
      if (!set) {
        set = new Set();
        idsByOwner.set(parsed.ownerCollection, set);
      }
      set.add(parsed.ownerId);
    }
    items.push({
      ref: doc.ref,
      refPath: `${ARQUIVOS_COLLECTION}/${doc.id}`,
      scope: parsed ? 'owner' : mensagem ? 'mensagem' : 'unknown',
    });
  }

  const referencedRefs = new Set<string>();
  for (const [coll, ids] of idsByOwner) {
    for (const r of await resolveReferencedRefs(db, coll, [...ids])) referencedRefs.add(r);
  }

  let ownerDeleted = 0;
  let ownerCleared = 0;
  let mensagemDeleted = 0;
  let mensagemCleared = 0;
  let unknownCleared = 0;
  let failed = 0;
  for (const { ref, refPath, scope } of items) {
    try {
      if (scope === 'mensagem') {
        const outcome = await reconcileMensagemArquivoCandidate(db, ref);
        if (outcome === 'deleted' || outcome === 'missing') mensagemDeleted += 1;
        else {
          mensagemCleared += 1;
          if (outcome === 'out-of-scope') {
            logger.warn(
              `sweepMarkedForDeletion: ${ref.id} changed out of mensagem-media scope — clearing, not deleting`,
            );
          }
        }
        continue;
      }
      // Owner not derivable (filepath isn't `produtos/<id>/…` or `tabMedi/<id>/…`
      // — legacy / console / bad data the trigger's owner-media guard now blocks):
      // we can't re-verify ownership, so NEVER delete it. Clear the mark + warn so it
      // stops re-querying instead of being reaped blind.
      if (scope === 'unknown') {
        await ref.update({ markedForDeletionAt: null });
        unknownCleared += 1;
        logger.warn(
          `sweepMarkedForDeletion: ${ref.id} marked but filepath is outside governed media — clearing, not deleting`,
        );
        continue;
      }
      // Referenced again (a re-add whose unmark was missed) → clear + keep.
      if (referencedRefs.has(refPath)) {
        await ref.update({ markedForDeletionAt: null });
        ownerCleared += 1;
        continue;
      }
      await ref.delete();
      ownerDeleted += 1;
    } catch (err) {
      if (!isGrpcLikeError(err)) throw err;
      failed += 1;
      logger.error(`sweepMarkedForDeletion: ${ref.id} failed`, err);
    }
  }
  logger.info(
    `sweepMarkedForDeletion: ${marked.size} candidates; owner=${items.filter((item) => item.scope === 'owner').length} deleted=${ownerDeleted} unmarked=${ownerCleared}; mensagem=${items.filter((item) => item.scope === 'mensagem').length} deleted=${mensagemDeleted} unmarked=${mensagemCleared}; outsideScope=${items.filter((item) => item.scope === 'unknown').length} unmarked=${unknownCleared}; failed=${failed}`,
  );
  return ownerDeleted + mensagemDeleted;
}

/**
 * Scheduled (every 48h) arquivo orphan reconciliation. Three bounded passes, each
 * isolating per-item failures: the **marked** sweep first (cheapest — an indexed
 * query over what `onProdutoMediaChanged` already flagged), then the phantom-doc
 * sweep, then the unreferenced-arquivo backstop (owner lookups plus indexed,
 * globally shared mensagem refcounts).
 */
export const reconcileArquivoOrphans = onSchedule(
  { schedule: 'every 48 hours', memory: '512MiB' },
  async () => {
    const db = getDb();
    const bucket = getStorage(getAdminApp()).bucket();
    const marked = await sweepMarkedForDeletion(db);
    const phantoms = await sweepPhantomDocs(db, bucket);
    const unreferenced = await sweepUnreferencedArquivos(db, bucket);
    logger.info(
      `reconcileArquivoOrphans: ${marked} marked + ${phantoms} phantom docs + ${unreferenced} unreferenced arquivos cleaned`,
    );
  },
);
