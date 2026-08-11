/**
 * Optimistic-concurrency transaction engine for FakeDbs — the ONE piece every
 * transaction test double in this monorepo shares, because it is the piece that
 * must not drift: several subtly different OCC models would be worse than none
 * (ADR 0011 — "hand-writing that ~25 times produced five distinct failure
 * modes"). Each FakeDb still owns its own collections, queries, `opLog` and
 * `lastPatch` surface, which is what those files' "own copy" comments are
 * actually about.
 *
 * ⚠️ **SDK-agnostic on purpose.** It imports nothing — not `firebase`, not
 * `firebase-admin` — and knows a ref only by its `path`. That is what lets the
 * Admin-SDK shape (`db.runTransaction(cb)`) and the browser shape
 * (`runTransaction(db, cb)`) share it: the caller writes a five-line adapter,
 * never a second engine. It lives in `packages/data` rather than in an app so
 * `packages/ui`, `apps/web`, `apps/whatsapp` and `apps/mercado-livre` can all
 * reach it; it was lifted out of `apps/mercado-livre` for #824.
 *
 * Models the three Admin SDK properties the previous non-isolated fakes did
 * not, and that issue #791 is entirely about:
 *
 *  1. **Snapshot reads.** `tx.get` records the version of what it read. Because
 *     writes are buffered until commit, a read never observes this
 *     transaction's own pending writes — matching the real Admin SDK.
 *  2. **Buffered writes + a commit-time version check.** Writes land at commit,
 *     in call order. If anything this attempt read was committed by another
 *     transaction meanwhile, the attempt throws and is retried.
 *  3. **Retry re-runs the CALLBACK ONLY.** Everything computed *before*
 *     `db.runTransaction` — `mappedFrete`, the outer `pedido` read, `isStale`,
 *     `fullConference` — is re-applied verbatim on the retry. That is the
 *     stale-closure shape ADR 0011 names, and the reason a plain interleaving
 *     harness cannot catch it: with no retry there is no closure
 *     re-application, so the bug is invisible to the harness meant to find it.
 *
 * ## Two timing choices, both deliberate
 *
 * - **Writes are logged to `opLog` at CALL time**, not at commit. `opLog` is a
 *   log of what the transaction body *did*; logging at commit would make the ML
 *   import tests' `expect(ops.map(o => o.op)).toEqual(['get','update'])`
 *   assertions vacuous, and would hide the staged-then-aborted write that the
 *   race tests assert on. Reads are NOT logged here — each FakeDb's own
 *   `ref.get()` already logs them, and double-logging would break the same
 *   assertions.
 * - **Patches are recorded for `lastPatch` at COMMIT time.** `lastPatch` means
 *   "the patch that is actually stored", so an aborted attempt's patch must not
 *   linger. For a transaction that never retries the two are identical, which
 *   is why every existing test is unaffected.
 *
 * ## Interleaving
 *
 * `beforeCommit` is the only interleaving primitive: an await point between
 * "the callback returned" and "the buffered writes commit". Two runs started
 * together plus this hook give a deterministic commit order with no timers, no
 * fake clock, and no instrumentation inside production code.
 *
 * Identify a run from `ctx.writes` (what it is about to write), never from
 * `ctx.label` — labels follow transaction-open order, which is an artefact of
 * whichever `await` chain got there first, not of the test's intent.
 */

export type OccWriteKind = 'set' | 'create' | 'update' | 'delete';
export type OccOpKind = 'get' | OccWriteKind;

/** Anything `tx.get` accepts: a fake doc ref, or a fake collection ref. */
export interface OccReadable<T> {
  /** Firestore path. Segment parity decides doc (EVEN) vs collection (ODD). */
  readonly path: string;
  get: () => Promise<T>;
}

/** Anything `tx.set` / `create` / `update` accepts — the engine needs the path. */
export interface OccRef {
  readonly path: string;
}

/**
 * An ADR 0011 **tier 1** precondition on a single write, as
 * `Transaction.update(ref, data, { lastUpdateTime })` takes it.
 *
 * The engine only CARRIES this to {@link OccHost.applyWrite}; enforcing it is
 * the host's job, because the host owns what a "version" is (the engine knows a
 * document only by its path). A host that ignores the field silently makes
 * every tier-1 test vacuous — so enforce it, the way
 * `apps/mercado-livre`'s `publish.test.ts` / `import.test.ts` fakes do for the
 * non-transactional spelling.
 */
export interface OccPrecondition {
  /** Commit only while the target is still at this version; else gRPC 9. */
  readonly lastUpdateTime?: unknown;
}

export interface OccTransaction {
  get: <T>(target: OccReadable<T>) => Promise<T>;
  set: (ref: OccRef, data: Record<string, unknown>) => void;
  create: (ref: OccRef, data: Record<string, unknown>) => void;
  update: (ref: OccRef, patch: Record<string, unknown>, precondition?: OccPrecondition) => void;
  delete: (ref: OccRef, precondition?: OccPrecondition) => void;
}

export interface OccBufferedWrite {
  kind: OccWriteKind;
  path: string;
  data: Record<string, unknown>;
  /** Only ever set by `tx.update`; see {@link OccPrecondition}. */
  precondition?: OccPrecondition;
}

/** What the owning FakeDb must supply. Deliberately tiny. */
export interface OccHost {
  /**
   * Apply ONE buffered write to the backing store, at commit, in call order.
   * Must throw the way the Admin SDK does: gRPC 6 on `create` over an existing
   * document, gRPC 5 on `update` of an absent one, and gRPC 9 when
   * `precondition.lastUpdateTime` no longer matches the stored version. Must
   * NOT touch `opLog` — the engine already logged this write at call time.
   */
  applyWrite: (
    kind: OccWriteKind,
    path: string,
    data: Record<string, unknown>,
    precondition?: OccPrecondition,
  ) => void;
  /**
   * Apply ONE buffered `tx.delete`. Routed here rather than through
   * {@link applyWrite} so a host whose code under test never deletes needs no
   * `kind === 'delete'` branch — and so one that DOES delete cannot silently
   * fall through a `set`/`update` chain and store an empty document instead.
   * Staging a delete without supplying this throws.
   */
  applyDelete?: (path: string, precondition?: OccPrecondition) => void;
  /** Append a WRITE to the FakeDb's own `opLog`, at call time. */
  logWrite?: (op: OccWriteKind, path: string) => void;
  /** Record a raw patch for the FakeDb's `lastPatch()`, at commit time. */
  recordPatch?: (path: string, patch: Record<string, unknown>) => void;
}

/** gRPC `ABORTED` (10) — the status the Admin SDK retries a transaction on. */
export class OccAbortedError extends Error {
  readonly code = 10;
  constructor(readonly conflictPath: string) {
    super(`ABORTED: "${conflictPath}" was committed by another transaction after this one read it`);
    this.name = 'OccAbortedError';
  }
}

export interface OccAttemptLogEntry {
  label: string;
  attempt: number;
  phase: 'begin' | 'commit' | 'abort';
  /** The path that lost the version check — only on `abort`. */
  conflictPath?: string;
}

export interface OccBeforeCommitCtx {
  label: string;
  attempt: number;
  /** What this attempt is ABOUT to commit — the reliable way to identify a run. */
  writes: readonly OccBufferedWrite[];
}

export interface OccEngineOptions {
  /** Exhausting this is a live-lock in the code under test, not a flaky test. */
  maxAttempts?: number;
}

/** A collection path has an ODD segment count; a document path an EVEN one. */
function isCollectionPath(path: string): boolean {
  return path.split('/').filter(Boolean).length % 2 === 1;
}

function parentCollection(docPath: string): string {
  return docPath.slice(0, docPath.lastIndexOf('/'));
}

export class OccEngine {
  /** One entry per attempt — `begin` / `commit` / `abort`. Assert retries on it. */
  readonly txLog: OccAttemptLogEntry[] = [];

  /**
   * Await point between "the callback returned" and "the buffered writes
   * commit". Assign in a test to hold one of two concurrent runs. Fires on
   * every attempt, including retries.
   */
  beforeCommit: ((ctx: OccBeforeCommitCtx) => Promise<void> | void) | null = null;

  private readonly docVersions = new Map<string, number>();
  private readonly colVersions = new Map<string, number>();
  private txN = 0;

  constructor(
    private readonly host: OccHost,
    private readonly options: OccEngineOptions = {},
  ) {}

  /**
   * Version of a path. A never-written document reads 0, so a competitor
   * CREATING it after this transaction observed "it does not exist" is a
   * conflict too.
   *
   * A collection's version is bumped by ANY write inside it — a conservative
   * over-approximation of Firestore's real query-result version check. It can
   * only ever produce MORE retries, never fewer, which is the safe direction
   * for a test double: a spurious retry is visible, a missing one hides a bug.
   */
  private version(path: string): number {
    return isCollectionPath(path)
      ? (this.colVersions.get(path) ?? 0)
      : (this.docVersions.get(path) ?? 0);
  }

  async runTransaction<T>(fn: (tx: OccTransaction) => Promise<T>): Promise<T> {
    const label = `tx${(this.txN += 1)}`;
    const maxAttempts = this.options.maxAttempts ?? 5;
    let lastConflict = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.txLog.push({ label, attempt, phase: 'begin' });

      const readVersions = new Map<string, number>();
      const buffered: OccBufferedWrite[] = [];
      let wroteAlready = false;

      const stage = (
        kind: OccWriteKind,
        ref: OccRef,
        data: Record<string, unknown>,
        precondition?: OccPrecondition,
      ): void => {
        assertPath(ref, kind);
        this.host.logWrite?.(kind, ref.path);
        buffered.push({ kind, path: ref.path, data, precondition });
        wroteAlready = true;
      };

      const tx: OccTransaction = {
        get: async (target) => {
          assertPath(target, 'get');
          // Admin SDK invariant, enforced at CALL time — buffering writes must
          // not make this folder's reads-before-writes assertions vacuous.
          if (wroteAlready) {
            throw new Error('read after write in transaction (Admin SDK invariant)');
          }
          readVersions.set(target.path, this.version(target.path));
          return target.get();
        },
        set: (ref, data) => stage('set', ref, data),
        create: (ref, data) => stage('create', ref, data),
        update: (ref, patch, precondition) => stage('update', ref, patch, precondition),
        delete: (ref, precondition) => stage('delete', ref, {}, precondition),
      };

      // A throw from the callback propagates: the real SDK only retries its own
      // ABORTED, and a bug in the code under test must not be swallowed.
      const result = await fn(tx);

      await this.beforeCommit?.({ label, attempt, writes: buffered });

      const conflict = [...readVersions].find(([path, seen]) => this.version(path) !== seen);
      if (conflict) {
        lastConflict = conflict[0];
        this.txLog.push({ label, attempt, phase: 'abort', conflictPath: lastConflict });
        continue; // re-run the CALLBACK ONLY — its closure is re-applied verbatim
      }

      for (const w of buffered) {
        if (w.kind === 'delete') {
          if (!this.host.applyDelete) {
            throw new Error(
              `OccEngine: the code under test called tx.delete("${w.path}") but this host ` +
                'supplies no `applyDelete`. Add one — silently ignoring the delete would ' +
                'make the test assert against a document Firestore would have removed.',
            );
          }
          this.host.applyDelete(w.path, w.precondition);
        } else {
          this.host.applyWrite(w.kind, w.path, w.data, w.precondition);
        }
        this.host.recordPatch?.(w.path, w.data);
        this.docVersions.set(w.path, (this.docVersions.get(w.path) ?? 0) + 1);
        const col = parentCollection(w.path);
        this.colVersions.set(col, (this.colVersions.get(col) ?? 0) + 1);
      }
      this.txLog.push({ label, attempt, phase: 'commit' });
      return result;
    }

    throw new OccAbortedError(lastConflict);
  }
}

function assertPath(target: { path?: unknown }, op: string): asserts target is { path: string } {
  if (typeof target.path !== 'string' || target.path.length === 0) {
    throw new Error(
      `OccEngine: tx.${op}() received a ref with no \`path\`. Every fake doc/collection ` +
        'ref must carry its Firestore path so the engine can version-check it.',
    );
  }
}

/* -------------------------- interleaving helper --------------------------- */

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
