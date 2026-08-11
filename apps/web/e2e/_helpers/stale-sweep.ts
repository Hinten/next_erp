/**
 * Cross-run reclaim of e2e fixtures orphaned in the staging project (#712).
 *
 * Every spec cleans up in `test.afterAll`, which does **not** run when a job is
 * cancelled — and every e2e workflow sets `cancel-in-progress: true` grouped by
 * `github.ref`, so each push to a PR kills that PR's in-flight run mid-suite.
 * Nothing else reclaims another run's leftovers: the per-spec sweeps are scoped
 * to the current prefix, `globalTeardown` scopes itself to `e2e-<thisRunId>-`,
 * and `runTeardown()` clears only `e2e_<thisRunId>_*`.
 *
 * The leak is not cosmetic. Every list is bounded at 50 rows (all 16
 * `defaultQuery` declarations carry `limit: 50`, and TableView falls back to 50
 * without one), fixture names embed the monotonically increasing GitHub run id,
 * and most lists sort `nome asc` — so **older orphans sort first** and eventually
 * push the row a test just created off page 1. That is exactly how
 * `logistica.vendas.e2e.spec.ts` started failing deterministically.
 *
 * Two passes, because an age gate alone cannot fix it:
 *
 *  - **Pass A, predecessor reclaim.** The dominant orphan producer is a run
 *    cancelled *minutes* ago, so any cutoff long enough to be safe also skips
 *    exactly the orphans that matter. Instead we record which run owns each
 *    concurrency group; seeing a different run id there means that run is dead
 *    (`cancel-in-progress` is the only way we are running at all), so its
 *    prefix is swept with NO age gate. Exact, and cheap — the narrow
 *    `e2e-<runId>-` prefix keeps both queries in a tight key range.
 *  - **Pass B, long-tail reclaim.** Broad `e2e-` prefix, age-gated. Catches
 *    local runs, force-killed runners, history predating the marker, and the
 *    `E2E-` pedidos the UI mints (which carry no run id at all, so the age gate
 *    is their only isolation from a concurrent lane).
 *
 * Pass A never reads a timestamp, so the fix for the reported bug keeps working
 * even if `createTime` is ever unavailable.
 *
 * ⚠️ Deleting a fixture is NOT free, and used to be ruinous (#729). Each swept
 * doc went through `database.recursiveDelete`, which issues one kindless
 * all-descendants query — unindexable on Firestore Enterprise, ~5,123 read units
 * per produto whether or not it had a single subcollection doc. With
 * `MAX_DELETES_PER_COLLECTION` docs across the collections that could own
 * children, times two passes, one saturated sweep cost ~46M read units; this
 * runs at `globalSetup` AND `globalTeardown`, on both lanes, per push. It is now
 * `deleteDocumentSubtree` (`@delfrance/data/admin`), which asks
 * `listCollections()` and then runs kinded, key-bounded queries. Do not
 * reintroduce `recursiveDelete` here — `stale-sweep.test.ts` fails if you do.
 */
import { FieldPath, type Firestore, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { deleteDocumentSubtree } from '@delfrance/data/admin';
import { db } from '@delfrance/test-fixtures';
import { requiresAuthEnv } from '../helpers/env';
import { getRunId } from './run-id';

/** The prefix every run-scoped fixture name and seeded doc id starts with. */
export const E2E_PREFIX = 'e2e-';

/**
 * A pedido created through the UI does not get an `e2e-…` numero: the counter
 * mints `<OPERACAO_PREFIX>-<seq>` and `operacaoNumeroPrefix` uppercases the
 * operação's first three letters (`packages/data/src/pedido/numero.ts`), so a
 * fixture operação named `e2e-<runId>-…` yields `E2E-000042`. Uppercase sorts
 * outside the `e2e-` range, which is why those pedidos have leaked on every run,
 * green or cancelled. Renaming is not an option — the operação name is itself
 * the thing the per-spec sweep matches on.
 */
const UI_PEDIDO_PREFIX = 'E2E-';

/** Fixtures older than this are considered leaked, mirroring `STALE_E2E_USER_AGE_MS`. */
export const STALE_E2E_FIXTURE_AGE_MS = 3 * 60 * 60 * 1000;

/** Docs read per query page. Bounded so a huge backlog cannot blow up memory. */
const PAGE_SIZE = 300;

/** Per-collection delete ceiling for one sweep. Truncation is always logged. */
const MAX_DELETES_PER_COLLECTION = 500;

/** Wall-clock budget. This runs before the suite, inside a 30-minute job. */
const SWEEP_BUDGET_MS = 60_000;

/** Marker docs keyed by CI concurrency group. `e2e_`-prefixed, so it is never a real collection. */
const RUN_MARKERS_COLLECTION = 'e2e_runMarkers';

/**
 * One live collection the suite seeds into, and where the `e2e-` prefix lands.
 *
 * Doc ids are matched for every target regardless of `fields` — every *seeded*
 * doc is written at `col.doc(\`${prefix}-NNN\`)`, and the key index always
 * exists, so that query is both free and covers most of the volume. `fields`
 * exists for the rows created through the UI during a test, which get Firestore
 * auto-ids and carry the prefix only in their data.
 */
export interface E2EFixtureTarget {
  readonly collection: string;
  /** Fields whose value starts with the prefix. Omit for id-only targets. */
  readonly fields?: readonly string[];
  /** Prefixes to match in addition to `e2e-`. */
  readonly extraPrefixes?: readonly string[];
}

/**
 * Every live collection the e2e suite writes to, with the field carrying the
 * prefix. Derived from the per-spec cleanups; `stale-sweep.test.ts` fails the
 * build if the two ever drift apart.
 *
 * Note `filiais` carries the prefix on **`razaoSocial`** — it has no `nome` at
 * all, so a `nome` sweep there silently matches nothing.
 */
export const E2E_FIXTURE_TARGETS: readonly E2EFixtureTarget[] = [
  // Prefix lives only in the doc id (`${prefix}-arq-001`); the fields carry it
  // as part of a filename, not as a value prefix.
  { collection: 'arquivos' },
  { collection: 'balanco', fields: ['nome'] },
  { collection: 'bandeirasCartao', fields: ['nome'] },
  { collection: 'cargos', fields: ['nome'] },
  { collection: 'categorias', fields: ['nome'] },
  { collection: 'chat', fields: ['nome'] },
  { collection: 'clientes', fields: ['nome'] },
  { collection: 'depositos', fields: ['nome'] },
  { collection: 'filiais', fields: ['razaoSocial'] },
  { collection: 'grupoDeVariacoes', fields: ['nome'] },
  { collection: 'int_frete', fields: ['nome'] },
  { collection: 'integracao', fields: ['nome'] },
  { collection: 'listaDePrecos', fields: ['nome'] },
  { collection: 'metodo_pgto', fields: ['nome'] },
  { collection: 'motivosincidentes', fields: ['nome'] },
  { collection: 'operacao', fields: ['nome'] },
  {
    collection: 'pedidos',
    fields: ['numero', 'observacoesInternas'],
    extraPrefixes: [UI_PEDIDO_PREFIX],
  },
  { collection: 'produtos', fields: ['nome'] },
  { collection: 'tabMedi', fields: ['nome'] },
  { collection: 'usuarios', fields: ['nome'] },
];

/**
 * True for an Admin-SDK failure carrying a `code` — Firestore reports numeric
 * gRPC codes, Auth reports `auth/*` strings. Mirrors `isGrpcLikeError` in
 * `apps/functions/src/lib/grpcErrors.ts`, which is not importable from here.
 * Anything without a code (a TypeError, a programming bug) is rethrown.
 *
 * ⚠️ Note what this does NOT cover: the SDK's own **client-side validation**
 * errors are bare `Error`s with no `code` — `startAfter` on a snapshot missing an
 * order key throws one. So this predicate treats them as programming bugs and
 * rethrows, which is right for `global-teardown.ts` (its lane is
 * `continue-on-error`) but was fatal in `globalSetup`. That is why
 * {@link sweepOrphanedE2EFixturesSafely} no longer uses it — see #960.
 */
export function isAdminSdkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'number' || typeof code === 'string';
}

/**
 * Exclusive upper bound of a prefix range: the prefix with its last character
 * incremented. For `e2e-` that is `e2e.` (`-` is 0x2D, `.` is 0x2E).
 *
 * Deliberately not `prefix + '￿'`: that works for a field value, but a
 * documentId bound is serialized into a resource name, and U+FFFF is a Unicode
 * noncharacter. The successor is exact either way.
 */
export function prefixEnd(prefix: string): string {
  const last = prefix.charCodeAt(prefix.length - 1);
  return `${prefix.slice(0, -1)}${String.fromCharCode(last + 1)}`;
}

/** Every prefix a target should be matched on. */
function prefixesFor(target: E2EFixtureTarget, basePrefixes: readonly string[]): string[] {
  return [...basePrefixes, ...(target.extraPrefixes ?? [])];
}

export interface SweepReport {
  deleted: number;
  /** Matched the prefix but is younger than the cutoff — left alone on purpose. */
  keptFresh: number;
  /** Matched but had no readable creation time. Never deleted; see `docAgeMs`. */
  keptUnknownAge: number;
  /** Candidates left behind because a cap or the wall-clock budget was hit. */
  remaining: number;
  byCollection: Record<string, number>;
}

function emptyReport(): SweepReport {
  return { deleted: 0, keptFresh: 0, keptUnknownAge: 0, remaining: 0, byCollection: {} };
}

function mergeReports(a: SweepReport, b: SweepReport): SweepReport {
  const byCollection = { ...a.byCollection };
  for (const [collection, count] of Object.entries(b.byCollection)) {
    byCollection[collection] = (byCollection[collection] ?? 0) + count;
  }
  return {
    deleted: a.deleted + b.deleted,
    keptFresh: a.keptFresh + b.keptFresh,
    keptUnknownAge: a.keptUnknownAge + b.keptUnknownAge,
    remaining: a.remaining + b.remaining,
    byCollection,
  };
}

interface SweepOptions {
  /** Prefixes to reclaim. */
  prefixes: readonly string[];
  /** Keep anything younger than this. `null` disables the gate entirely. */
  maxAgeMs: number | null;
  /** Report what would be deleted without deleting it. Issues NO writes at all. */
  dryRun?: boolean;
  /** Absolute wall-clock deadline shared across the whole sweep. */
  deadline?: number;
  /** Firestore instance. Defaults to the shared Admin SDK singleton; a test injects a fake. */
  database?: Firestore;
}

/**
 * Age of a document, or `null` when it cannot be established.
 *
 * `createTime` is part of the document envelope rather than an index feature, so
 * it needs no schema field and nothing has to be stamped at seed time. It is
 * also the only honest source here: `ultimaModificacao` would be refreshed on
 * orphans by `recalcular-precos.cadastros.e2e.spec.ts`, which rewrites every
 * parent produto in the shared catalog — they would look fresh forever.
 *
 * An unknown age is **never** deleted. The count is reported so a silent
 * regression shows up as "kept N, age unknown" instead of a quiet no-op.
 */
function docAgeMs(snap: QueryDocumentSnapshot, now: number): number | null {
  const created = snap.createTime?.toMillis();
  return typeof created === 'number' ? now - created : null;
}

/** Page a query into `out`, keyed by ref path so the id and field ranges can overlap. */
async function collectPage(
  query: FirebaseFirestore.Query,
  out: Map<string, QueryDocumentSnapshot>,
  deadline: number,
): Promise<boolean> {
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    if (Date.now() > deadline) return true;
    const page = cursor ? query.startAfter(cursor).limit(PAGE_SIZE) : query.limit(PAGE_SIZE);
    const snap = await page.get();
    for (const doc of snap.docs) out.set(doc.ref.path, doc);
    if (snap.size < PAGE_SIZE) return false;
    cursor = snap.docs[snap.size - 1];
  }
}

/**
 * Every doc in `target` matching any of `prefixes`, by doc id and by declared
 * field. Returns whether collection was truncated by the budget.
 *
 * A `documentId()` range is served by the always-present key index. The field
 * ranges are served by the single-field indexes already declared for most of
 * these collections; note an implicit field `orderBy` drops docs missing that
 * field, which is why `pedidos` declares both `numero` and `observacoesInternas`
 * rather than relying on either alone.
 *
 * Both queries are projected as narrowly as their CURSOR allows: the sweep reads
 * nothing off a candidate but its `ref` and its `createTime`, and `createTime`
 * rides the snapshot envelope rather than the field mask. Enterprise bills data
 * scanned, so pulling produto and pedido bodies here was pure waste.
 *
 * ⚠️ That is why the two differ, and they must stay different (#960):
 *  - the **id range** is keys-only (`.select()`). Its only order key is
 *    `__name__`, which `Query._extractFieldValues` takes from `snapshot.ref` —
 *    that survives an empty projection. Same shape as `deleteDocumentSubtree`.
 *  - the **field range** MUST project `field`. An inequality forces an implicit
 *    `orderBy(field)` ahead of `__name__`, and `collectPage` pages with a
 *    SNAPSHOT cursor, so the SDK reads the snapshot's value for that order key.
 *    Under `.select()` the value is absent and `startAfter` throws
 *    `Field "<field>" is missing in the provided DocumentSnapshot` — killing the
 *    sweep, and with it globalSetup, on the SECOND page of any field range.
 *    The projected value is never read by this module; it exists only so the
 *    cursor can be built.
 */
async function collectCandidates(
  database: Firestore,
  target: E2EFixtureTarget,
  prefixes: readonly string[],
  deadline: number,
): Promise<{ docs: QueryDocumentSnapshot[]; truncated: boolean }> {
  const col = database.collection(target.collection);
  const found = new Map<string, QueryDocumentSnapshot>();
  let truncated = false;

  for (const prefix of prefixes) {
    const end = prefixEnd(prefix);
    truncated =
      (await collectPage(
        col
          .where(FieldPath.documentId(), '>=', prefix)
          .where(FieldPath.documentId(), '<', end)
          .select(),
        found,
        deadline,
      )) || truncated;

    for (const field of target.fields ?? []) {
      truncated =
        (await collectPage(
          // `.select(field)`, not `.select()` — the cursor needs the order key.
          // See the ⚠️ note above; this is #960.
          col.where(field, '>=', prefix).where(field, '<', end).select(field),
          found,
          deadline,
        )) || truncated;
    }
  }

  return { docs: [...found.values()], truncated };
}

/**
 * Delete `docs` and everything below each of them.
 *
 * Every doc goes through `deleteDocumentSubtree` — there is deliberately no
 * "leaves take a cheap batch, parents take a subtree walk" split any more (#729).
 * That split was driven by a set derived from `ALL_DOMAINS`, and the registry is
 * not a complete picture of what is actually under a document: `metodo_pgto` is
 * swept here but its `credenciais` meta is outside `ALL_DOMAINS`, so every sweep
 * batch-deleted the parent and orphaned the subcollection. `listCollections()`
 * asks Firestore instead of asking the registry, which removes the whole class
 * of drift — at the cost of one ~5-read-unit call per leaf doc (worst case
 * ~25k units per sweep, against the 46.1M this change removes).
 *
 * The BulkWriter is created once and passed in explicitly: without that the SDK
 * shares a single lazily-created writer and every call awaits *everyone's*
 * pending operations.
 */
async function deleteDocs(
  database: Firestore,
  docs: readonly QueryDocumentSnapshot[],
  deadline: number,
): Promise<{ deleted: number; remaining: number }> {
  if (docs.length === 0) return { deleted: 0, remaining: 0 };

  const writer = database.bulkWriter();
  let deleted = 0;
  let index = 0;
  try {
    for (; index < docs.length; index += 1) {
      const doc = docs[index]!;
      // The delete phase used to ignore the budget entirely, so a saturated
      // sweep ran all 500 deletes per collection however long it took.
      //
      // The check sits BETWEEN documents, and the walk below is deliberately
      // given NO deadline: once a fixture is started it must finish. The walk
      // deletes the parent first, so a subtree abandoned half-way leaves
      // children under a doc that no longer exists — and this sweep finds
      // candidates by querying the ROOT collection, so nothing would ever
      // rediscover them. A fixture subtree is a handful of docs; finishing one
      // is cheap, and being unable to reclaim it is not.
      if (Date.now() > deadline) {
        console.warn(
          `[sweep] wall-clock budget reached mid-delete — ` +
            `${docs.length - index} left for the next run`,
        );
        break;
      }
      try {
        const report = await deleteDocumentSubtree(database, doc.ref, { writer });
        deleted += 1;
        if (report.failedDeletes > 0) {
          console.warn(
            `[sweep] ${doc.ref.path}: ${report.failedDeletes} delete(s) failed — ` +
              `${String(report.firstError)}`,
          );
        }
      } catch (err) {
        // One stale ref racing to NOT_FOUND, or a transient UNAVAILABLE, must
        // not abandon the rest of the backlog.
        if (!isAdminSdkError(err)) throw err;
        console.warn(`[sweep] ${doc.ref.path} failed to delete: ${String(err)}`);
      }
    }
  } finally {
    await writer.close();
  }

  // Anything the budget cut off is a candidate LEFT BEHIND, and the report says
  // so — "deleted 12" with `remaining: 0` reads as "nothing left" when there
  // may be hundreds.
  return { deleted, remaining: docs.length - index };
}

/** One pass over every target. */
async function sweep(options: SweepOptions): Promise<SweepReport> {
  const database = options.database ?? db();
  const deadline = options.deadline ?? Date.now() + SWEEP_BUDGET_MS;
  const report = emptyReport();

  for (const target of E2E_FIXTURE_TARGETS) {
    if (Date.now() > deadline) {
      report.remaining += 1;
      continue;
    }

    const { docs, truncated } = await collectCandidates(
      database,
      target,
      prefixesFor(target, options.prefixes),
      deadline,
    );

    const now = Date.now();
    const doomed: QueryDocumentSnapshot[] = [];
    for (const doc of docs) {
      if (options.maxAgeMs === null) {
        doomed.push(doc);
        continue;
      }
      const age = docAgeMs(doc, now);
      if (age === null) report.keptUnknownAge += 1;
      else if (age < options.maxAgeMs) report.keptFresh += 1;
      else doomed.push(doc);
    }

    // Truncation is never silent: a sweep that stopped early must say so, or
    // "swept 12" reads as "nothing left" when there are hundreds more.
    const capped = doomed.slice(0, MAX_DELETES_PER_COLLECTION);
    const overCap = doomed.length - capped.length;
    if (overCap > 0 || truncated) {
      report.remaining += overCap;
      console.warn(
        `[sweep] ${target.collection}: ` +
          (overCap > 0
            ? `${overCap} candidate(s) over the per-collection cap`
            : 'wall-clock budget reached mid-query') +
          ' — left for the next run',
      );
    }
    if (capped.length === 0) continue;

    const { deleted, remaining } = options.dryRun
      ? { deleted: capped.length, remaining: 0 }
      : await deleteDocs(database, capped, deadline);
    report.deleted += deleted;
    report.remaining += remaining;
    report.byCollection[target.collection] =
      (report.byCollection[target.collection] ?? 0) + deleted;
  }

  return report;
}

/**
 * Identifier of this job's CI concurrency group — the unit `cancel-in-progress`
 * operates on, so the run it names is the one this run superseded. `null` for a
 * local run, which has no such group and therefore no predecessor to reclaim.
 * `/` is illegal in a document id, hence the substitution.
 */
function concurrencyGroupId(): string | null {
  const workflow = process.env.GITHUB_WORKFLOW;
  const ref = process.env.GITHUB_REF;
  if (!workflow || !ref) return null;
  return `${workflow}__${ref}`.replace(/\//g, '_');
}

/**
 * Pass A. Claim this concurrency group, and if the previous claimant was a
 * different run, reclaim its fixtures with no age gate.
 *
 * That run is necessarily finished: either it was cancelled (the only reason a
 * newer run of the same group could be running at all), in which case its
 * `afterAll` never fired, or it completed and swept itself, in which case this
 * is a no-op. Never sweeps the *current* run id — a re-run reuses
 * `GITHUB_RUN_ID`, so attempt 2 shares attempt 1's prefix.
 */
export async function reclaimPredecessorRun(
  options: { dryRun?: boolean; database?: Firestore; deadline?: number } = {},
): Promise<SweepReport> {
  const groupId = concurrencyGroupId();
  if (!groupId) return emptyReport();

  const database = options.database ?? db();
  const runId = getRunId();
  const marker = database.collection(RUN_MARKERS_COLLECTION).doc(groupId);
  const previous = (await marker.get()).get('runId');
  // Claiming the group is a write, so a dry run must not do it — otherwise
  // inspecting the backlog from inside CI would clobber the marker and leave the
  // next real run believing it had already claimed the group.
  if (!options.dryRun) await marker.set({ runId, startedAt: Date.now() });

  if (typeof previous !== 'string' || previous === runId) return emptyReport();

  // eslint-disable-next-line no-console
  console.log(`[sweep] reclaiming fixtures from superseded run ${previous}`);
  return sweep({ prefixes: [`${E2E_PREFIX}${previous}-`], maxAgeMs: null, ...options });
}

/**
 * End-of-run sweep for `globalTeardown` — this run's own fixtures, across every
 * registered collection, with no age gate.
 *
 * Scoping mirrors what `globalTeardown` already did: in CI `GITHUB_RUN_ID` is
 * stable across the runner and its workers, and the two e2e workflows are
 * separate runs with separate ids, so `e2e-<runId>-` matches everything this run
 * seeded and nothing from the sibling lane. Locally `getRunId()` is a per-call
 * timestamp — there is no stable run scope at all — so the broad prefix stays,
 * which is also what clears cruft from earlier local runs.
 */
export async function sweepCurrentRunFixtures(database?: Firestore): Promise<SweepReport> {
  const prefix = process.env.GITHUB_RUN_ID ? `${E2E_PREFIX}${getRunId()}-` : E2E_PREFIX;
  return sweep({ prefixes: [prefix], maxAgeMs: null, database });
}

/**
 * Pass B. Everything still carrying an `e2e-` prefix and older than the cutoff.
 *
 * Options object rather than positional `(maxAgeMs, dryRun)` on purpose: a
 * trailing boolean that defaults to the *unsafe* value is exactly how the caller
 * below silently dropped `dryRun` and made `sweep:e2e` delete during a dry run.
 */
export async function sweepStaleFixtures(
  options: { maxAgeMs?: number; dryRun?: boolean; database?: Firestore; deadline?: number } = {},
): Promise<SweepReport> {
  return sweep({
    prefixes: [E2E_PREFIX],
    maxAgeMs: options.maxAgeMs ?? STALE_E2E_FIXTURE_AGE_MS,
    dryRun: options.dryRun,
    database: options.database,
    deadline: options.deadline,
  });
}

/**
 * Both passes, with a one-line summary. Safe to call concurrently: the two e2e
 * lanes run this at the same time, and deleting an already-deleted doc is a
 * no-op.
 */
export async function sweepOrphanedE2EFixtures(
  dryRun = false,
  database?: Firestore,
  /**
   * Absolute wall-clock deadline for BOTH passes together. Defaulted here rather
   * than inside `sweep()` so the budget is one 60s allowance for the whole
   * janitor — each pass defaulting its own meant a saturated sweep could run for
   * two. A test injects a past deadline to exercise the truncation path.
   */
  deadline: number = Date.now() + SWEEP_BUDGET_MS,
): Promise<SweepReport> {
  // Both passes take the same flags. Forwarding to only one of them is what made
  // `sweep:e2e` delete while reporting "would delete".
  const options = { dryRun, database, deadline };
  const report = mergeReports(
    await reclaimPredecessorRun(options),
    await sweepStaleFixtures(options),
  );
  const summary = Object.entries(report.byCollection)
    .map(([collection, count]) => `${collection}:${count}`)
    .join(' ');
  // eslint-disable-next-line no-console
  console.log(
    `[sweep] ${dryRun ? 'would delete' : 'deleted'} ${report.deleted} orphaned fixture(s)` +
      `${summary ? ` — ${summary}` : ''}; kept ${report.keptFresh} fresh, ` +
      `${report.keptUnknownAge} of unknown age, ${report.remaining} left for the next run`,
  );
  return report;
}

/**
 * `globalSetup` entry point. Skips when the Admin SDK env is incomplete (same
 * rule as `globalTeardown`) and in emulator mode, where a fresh database
 * accumulates nothing.
 *
 * ⚠️ This boundary swallows **everything**, including a programming bug in the
 * sweep itself. That is the whole contract: the sweep is a janitor, nothing about
 * a suite's correctness depends on it, and `_setup/combined.ts` does not catch —
 * so anything escaping here fails `globalSetup` and **no test runs at all**, on
 * every PR, since the emulator lane has no `paths:` filter.
 *
 * It used to narrow on {@link isAdminSdkError}, and #960 is exactly the hole that
 * left: the SDK's cursor validation error is a bare client-side `Error` with no
 * gRPC `code`, so the guard rethrew the one failure it existed to contain. The
 * narrow form is still right for `global-teardown.ts`'s call sites (that lane
 * runs `continue-on-error`, so a rethrow there costs nothing) and for the CLI
 * block below, which should exit non-zero for a human running `pnpm sweep:e2e`.
 *
 * Loud, not silent: `console.error` with the error object, so a broken janitor is
 * obvious in the log even though it no longer blocks anyone.
 */
export async function sweepOrphanedE2EFixturesSafely(): Promise<void> {
  if (process.env.FIRESTORE_EMULATOR_HOST) return;
  if (!requiresAuthEnv()) {
    console.warn('[sweep] skipping — Admin SDK env incomplete.');
    return;
  }
  try {
    await sweepOrphanedE2EFixtures();
    // DELIBERATE catch-all. The rule bans generic catches because silent
    // fallbacks hide bugs; here the catch IS the feature (see the docblock) and
    // it is anything but silent — narrowing is precisely what let #960 take down
    // globalSetup for every PR.
    // eslint-disable-next-line no-restricted-syntax -- justified above
  } catch (err) {
    console.error('[sweep] FAILED — continuing so the suite still runs. Fix this:', err);
  }
}

const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('stale-sweep.ts') ||
  process.argv[1]?.endsWith('stale-sweep.js');

if (isDirectInvocation) {
  // Dry run by default — deleting from a live project is opt-in.
  const apply = process.argv.includes('--apply');
  if (!apply) {
    // eslint-disable-next-line no-console
    console.log('[sweep] DRY RUN — re-run with --apply to delete.');
  }
  sweepOrphanedE2EFixtures(!apply).catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
