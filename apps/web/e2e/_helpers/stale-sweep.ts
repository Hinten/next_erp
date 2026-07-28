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
 */
import { FieldPath, type Firestore, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { ALL_DOMAINS } from '@delfrance/schemas';
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

/** Firestore batches cap at 500 ops; stay under it. */
const BATCH_CAP = 400;

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
 * Root collections owning at least one subcollection, derived from the schema
 * registry rather than hardcoded — a new subcollection is covered the moment it
 * is registered in `ALL_DOMAINS`. Firestore never cascades, and every
 * subcollection cleanup in the suite needs the parent id in memory, which a
 * cancelled run has lost forever; these are the docs that must be deleted
 * recursively or their children become unreachable (#257).
 */
export const PARENTS_WITH_SUBCOLLECTIONS: ReadonlySet<string> = new Set(
  ALL_DOMAINS.map((d) => d.meta.collectionPath)
    .filter((path) => path.includes('/'))
    .map((path) => path.slice(0, path.indexOf('/'))),
);

/**
 * True for an Admin-SDK failure carrying a `code` — Firestore reports numeric
 * gRPC codes, Auth reports `auth/*` strings. Mirrors `isGrpcLikeError` in
 * `apps/functions/src/lib/grpcErrors.ts`, which is not importable from here.
 * Anything without a code (a TypeError, a programming bug) is rethrown.
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
        col.where(FieldPath.documentId(), '>=', prefix).where(FieldPath.documentId(), '<', end),
        found,
        deadline,
      )) || truncated;

    for (const field of target.fields ?? []) {
      truncated =
        (await collectPage(
          col.where(field, '>=', prefix).where(field, '<', end),
          found,
          deadline,
        )) || truncated;
    }
  }

  return { docs: [...found.values()], truncated };
}

/**
 * Delete `docs`, recursively for anything that can own subcollections and in
 * plain batches for leaves.
 *
 * `recursiveDelete` issues an all-descendants query per document, so using it on
 * a leaf collection costs one query per doc where a batch costs one commit. The
 * BulkWriter is created once and passed in explicitly: without that the SDK
 * shares a single lazily-created writer and every call awaits *everyone's*
 * pending operations.
 */
async function deleteDocs(
  database: Firestore,
  docs: readonly QueryDocumentSnapshot[],
): Promise<number> {
  const recursive = docs.filter((d) => PARENTS_WITH_SUBCOLLECTIONS.has(d.ref.parent.id));
  const leaves = docs.filter((d) => !PARENTS_WITH_SUBCOLLECTIONS.has(d.ref.parent.id));
  let deleted = 0;

  for (let i = 0; i < leaves.length; i += BATCH_CAP) {
    const batch = database.batch();
    for (const doc of leaves.slice(i, i + BATCH_CAP)) batch.delete(doc.ref);
    await batch.commit();
    deleted += Math.min(BATCH_CAP, leaves.length - i);
  }

  if (recursive.length > 0) {
    const writer = database.bulkWriter();
    try {
      for (const doc of recursive) {
        try {
          await database.recursiveDelete(doc.ref, writer);
          deleted += 1;
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
  }

  return deleted;
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

    const deleted = options.dryRun ? capped.length : await deleteDocs(database, capped);
    report.deleted += deleted;
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
  options: { dryRun?: boolean; database?: Firestore } = {},
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
  options: { maxAgeMs?: number; dryRun?: boolean; database?: Firestore } = {},
): Promise<SweepReport> {
  return sweep({
    prefixes: [E2E_PREFIX],
    maxAgeMs: options.maxAgeMs ?? STALE_E2E_FIXTURE_AGE_MS,
    dryRun: options.dryRun,
    database: options.database,
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
): Promise<SweepReport> {
  // Both passes take the same flags. Forwarding to only one of them is what made
  // `sweep:e2e` delete while reporting "would delete".
  const options = { dryRun, database };
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
 * accumulates nothing. A janitor failure is logged and swallowed — it must never
 * be the reason a suite does not run.
 */
export async function sweepOrphanedE2EFixturesSafely(): Promise<void> {
  if (process.env.FIRESTORE_EMULATOR_HOST) return;
  if (!requiresAuthEnv()) {
    console.warn('[sweep] skipping — Admin SDK env incomplete.');
    return;
  }
  try {
    await sweepOrphanedE2EFixtures();
  } catch (err) {
    if (!isAdminSdkError(err)) throw err;
    console.warn(`[sweep] failed (continuing): ${String(err)}`);
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
