import { createHash } from 'node:crypto';

import { rebindReferences } from './convert';
import { type CredentialPolicy, isCredentialPath, withoutCredentialFields } from './credentials';
import { type Observation, type Stamp, decide, parseWatermark } from './watermark';

export { compareStamps, type Stamp } from './watermark';
export {
  type CredentialPolicy,
  InvalidCredentialPolicyError,
  credentialCollectionIds,
  credentialFieldsOf,
  isCredentialPath,
  parseCredentialPolicy,
} from './credentials';

/**
 * The legacy Flutter project's database. It is Firestore STANDARD and literally
 * the `(default)` database — the opposite of this repo's convention, where the
 * Enterprise database is NAMED `default`. Both ids are facts about those two
 * databases, not configuration, so they are constants (shared with the replay
 * script in tools/migrations).
 */
export const SOURCE_DATABASE_ID = '(default)';

/** The new Enterprise project's database (root CLAUDE.md, Critical rule 1). */
export const TARGET_DATABASE_ID = 'default';

/**
 * The collection, in the TARGET database, holding one watermark per mirrored path.
 * Migration-only: delete it after the cutover (functions/DEPLOY.md). Enterprise
 * creates no automatic index, so each watermark write costs one write unit.
 */
export const WATERMARKS_COLLECTION = '_mirrorWatermarks';

/** The minimal read surface of the SOURCE database the mirror needs. */
export interface SourceSnapshot {
  readonly exists: boolean;
  readonly updateTime?: Stamp;
  readonly readTime: Stamp;
  data(): Record<string, unknown> | undefined;
}
export interface SourceDb {
  doc(path: string): { get(): Promise<SourceSnapshot> };
}

/** The minimal write surface of the TARGET database. `R` is its reference type. */
export interface TargetTransaction<R> {
  get(ref: R): Promise<{ data(): unknown }>;
  set(ref: R, data: Record<string, unknown>): unknown;
  delete(ref: R): unknown;
}
export interface TargetDb<R> {
  doc(path: string): R;
  runTransaction<T>(fn: (tx: TargetTransaction<R>) => Promise<T>): Promise<T>;
}

/** `denied`: a credential path under the `deny` policy (credentials.ts). */
export type MirrorOutcome = 'applied' | 'skipped' | 'denied';

/** Thrown for a path that is not a document path. */
export class InvalidDocumentPathError extends Error {
  constructor(path: string) {
    super(`legacy-mirror: '${path}' is not a document path.`);
    this.name = 'InvalidDocumentPathError';
  }
}

/**
 * The relative document path of a trigger event. firebase-functions exposes it as
 * `event.document` (`pedidos/p1/nfev4/n1`); a fully-qualified resource name is
 * accepted too, so a change in that field's shape fails loudly instead of
 * mirroring into a wrong path.
 */
export function relativeDocumentPath(document: string): string {
  const marker = '/documents/';
  const at = document.indexOf(marker);
  const path =
    document.startsWith('projects/') && at >= 0 ? document.slice(at + marker.length) : document;
  const segments = path.split('/');
  if (path === '' || segments.length % 2 !== 0 || segments.some((s) => s === '')) {
    throw new InvalidDocumentPathError(document);
  }
  return path;
}

/** A fixed-length, Firestore-safe id for a path of any depth. */
export function watermarkId(path: string): string {
  return createHash('sha256').update(path).digest('hex');
}

/**
 * Copy the CURRENT state of one source document into the target, unless the
 * target already holds a newer observation of it.
 *
 * The event payload is deliberately ignored: re-reading the source is what makes
 * out-of-order delivery, duplicates and retries harmless (see watermark.ts). It
 * costs one Standard read per event.
 *
 * Race class B (firestore-transaction-inventory): the observation and the data are
 * read OUTSIDE the transaction, from the source; the guard is the watermark,
 * re-read with `tx.get` and compared inside it (ADR 0011 tier 2), and advanced on
 * every write that wins.
 */
export async function mirrorPath<R>(
  rawPath: string,
  source: SourceDb,
  target: TargetDb<R>,
  options: { credentials: CredentialPolicy },
): Promise<MirrorOutcome> {
  const path = relativeDocumentPath(rawPath);
  const documentRef = target.doc(path);

  // `deny` (a test project): a credential document is never written, and any copy
  // already there — from the seed import — is deleted. The source is not even
  // read. No watermark: nothing about it is applied, so nothing needs ordering,
  // and a delete of an absent document is a no-op.
  if (options.credentials === 'deny' && isCredentialPath(path)) {
    await target.runTransaction((tx) => {
      tx.delete(documentRef);
      return Promise.resolve();
    });
    return 'denied';
  }

  const snap = await source.doc(path).get();
  const observed: Observation =
    snap.exists && snap.updateTime
      ? { exists: true, stamp: snap.updateTime }
      : { exists: false, stamp: snap.readTime };
  let data = observed.exists
    ? (rebindReferences(snap.data() ?? {}, (p) => target.doc(p)) as Record<string, unknown>)
    : null;
  if (data && options.credentials === 'deny') data = withoutCredentialFields(path, data);

  const watermarkRef = target.doc(`${WATERMARKS_COLLECTION}/${watermarkId(path)}`);

  return target.runTransaction(async (tx) => {
    const applied = parseWatermark(path, (await tx.get(watermarkRef)).data());
    if (decide(observed, applied) === 'skip') return 'skipped';
    if (data) tx.set(documentRef, data);
    else tx.delete(documentRef);
    tx.set(watermarkRef, { path, exists: observed.exists, stamp: observed.stamp });
    return 'applied';
  });
}
