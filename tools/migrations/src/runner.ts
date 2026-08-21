import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  DocumentReference,
  FieldPath,
  Firestore,
  Timestamp,
  WriteBatch,
} from 'firebase-admin/firestore';
import { migrationDb } from './admin';

/* -------------------------------------------------------------------------- */
/*                              Entrypoint guard                              */
/* -------------------------------------------------------------------------- */

/**
 * True when this module is the process entrypoint (`tsx src/…/migrate.ts`),
 * false when a test imports it. Every script in this package ends with
 * `if (isMainModule(import.meta.url)) …`, and a new one must too — it is the
 * only guard shape here, deliberately, so there is nothing to choose between.
 *
 * ⚠️ **Use this, never a `` `file://${process.argv[1]}` `` template.** On Windows
 * `import.meta.url` is `file:///C:/…` — three slashes, because the drive letter
 * follows an empty authority — while that template produces `file://C:/…`. The
 * comparison then silently fails, `runMigration` is never called, and the script
 * **exits 0 having done nothing**.
 *
 * A migration that reports success without touching a document is the worst
 * failure this package can have, and it reproduces only off Linux: CI is green,
 * the maintainer's own machine is a no-op. `pathToFileURL` builds the URL the
 * same way the loader does, on every platform.
 *
 * ⚠️ Nor a `process.argv[1].endsWith('migrate.ts')` test, which four scripts
 * here used to carry. It is Windows-safe but identity-blind: **every** module in
 * this package is named `migrate.ts`, so it answers "is the entrypoint called
 * migrate.ts", not "is the entrypoint me". Nothing imports one migration from
 * another today — that is the only reason it worked, and it is not a property
 * anyone would think to preserve.
 */
export function isMainModule(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (entry == null || entry === '') return false;
  return importMetaUrl === pathToFileURL(entry).href;
}

/* -------------------------------------------------------------------------- */
/*                              CLI argument parsing                          */
/* -------------------------------------------------------------------------- */

export interface MigrationArgs {
  /** Target Firebase project — REQUIRED, never inferred. */
  projectId: string;
  /** Write changes. Default false (dry-run). */
  apply: boolean;
  /**
   * Classify and COUNT what is stored, without writing and without listing
   * per-document changes. The pre-flight pass you read before trusting a
   * dry-run: it answers "what shapes are actually in this corpus?" — which is
   * the question a change log cannot, because it only shows what the transform
   * already knows how to handle.
   */
  reportOnly: boolean;
  /** Optional explicit service-account file (else env). */
  serviceAccountPath?: string;
  /**
   * Comma-separated selector for migrations that can touch more than one
   * collection/field and want them enabled one group at a time. Empty when the
   * flag was not passed; a migration that does not use it ignores this.
   *
   * Parsed here rather than per-migration so `parseArgs` can keep REJECTING
   * genuinely unknown flags — that guard is what stops `--project --apply` from
   * silently running against a project literally named "--apply".
   */
  targets: string[];
}

export class MigrationArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationArgError';
  }
}

/**
 * Read the value token after a `--flag <value>` argument, rejecting a missing
 * value or another flag — so `--project --apply` errors out instead of treating
 * `--apply` as the project id and running against an invalid target.
 */
function requireValue(next: string | undefined, flag: string): string {
  if (next === undefined || next.startsWith('--')) {
    throw new MigrationArgError(`${flag} requires a value.`);
  }
  return next;
}

/**
 * Parse the migration CLI contract (see `tools/migrations/README.md`):
 *   --project <id>   REQUIRED — never defaults, so prod is never touched by accident
 *   --apply          write changes (omit for a dry-run that only logs)
 *   --report-only    classify + count stored shapes, write nothing
 *   --service-account <path>   optional credential override
 *   --target <a,b>   optional migration-specific selector (see MigrationArgs)
 * Throws `MigrationArgError` on a missing/unknown flag.
 */
export function parseArgs(argv: readonly string[]): MigrationArgs {
  let projectId: string | undefined;
  let apply = false;
  let reportOnly = false;
  let serviceAccountPath: string | undefined;
  let targetsRaw: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--apply') {
      apply = true;
    } else if (arg === '--report-only') {
      reportOnly = true;
    } else if (arg === '--project') {
      projectId = requireValue(argv[i + 1], '--project');
      i += 1;
    } else if (arg.startsWith('--project=')) {
      projectId = arg.slice('--project='.length);
    } else if (arg === '--service-account') {
      serviceAccountPath = requireValue(argv[i + 1], '--service-account');
      i += 1;
    } else if (arg.startsWith('--service-account=')) {
      serviceAccountPath = arg.slice('--service-account='.length);
    } else if (arg === '--target') {
      targetsRaw = requireValue(argv[i + 1], '--target');
      i += 1;
    } else if (arg.startsWith('--target=')) {
      targetsRaw = arg.slice('--target='.length);
    } else {
      throw new MigrationArgError(`Unknown argument: ${arg}`);
    }
  }

  if (!projectId || projectId.trim().length === 0) {
    throw new MigrationArgError(
      '--project <id> is required. The migration refuses to guess the target project.',
    );
  }
  if (apply && reportOnly) {
    throw new MigrationArgError('--report-only cannot be combined with --apply.');
  }
  const targets = (targetsRaw ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');

  return { projectId: projectId.trim(), apply, reportOnly, serviceAccountPath, targets };
}

/* -------------------------------------------------------------------------- */
/*                          Change log + batched writes                       */
/* -------------------------------------------------------------------------- */

/** Records every intended field change / skip to a timestamped `out/` log. */
export class ChangeSink {
  changes = 0;
  skips = 0;

  constructor(private readonly stream: WriteStream) {}

  change(path: string, field: string, from: unknown, to: unknown): void {
    this.changes += 1;
    this.stream.write(`${JSON.stringify({ kind: 'change', path, field, from, to })}\n`);
  }

  skip(path: string, field: string, value: unknown, reason: string): void {
    this.skips += 1;
    this.stream.write(`${JSON.stringify({ kind: 'skip', path, field, value, reason })}\n`);
  }
}

/** gRPC FAILED_PRECONDITION (code 9) — a `lastUpdateTime` guard that did not hold. */
function isFailedPrecondition(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 9;
}

/**
 * Accumulates `update()`s and commits them in batches of `maxOps` (Firestore
 * caps a batch at 500). A no-op in dry-run mode. Call `flush()` at the end.
 *
 * {@link BatchWriter.updateGuarded} is the tier-1 alternative for a patch
 * derived from a document you read.
 */
export class BatchWriter {
  private batch: WriteBatch | null = null;
  private ops = 0;
  committed = 0;

  constructor(
    private readonly db: Firestore,
    private readonly apply: boolean,
    private readonly maxOps = 400,
  ) {}

  async update(ref: DocumentReference, data: Record<string, unknown>): Promise<void> {
    if (!this.apply) return;
    this.batch ??= this.db.batch();
    this.batch.update(ref, data);
    this.ops += 1;
    if (this.ops >= this.maxOps) await this.flush();
  }

  /**
   * A LOST-UPDATE-GUARDED single-document update —
   * `ref.update(patch, { lastUpdateTime })`, root `CLAUDE.md` rule 7 **tier 1**.
   * Resolves `false` when the document changed since the snapshot the patch was
   * derived from, so the caller can report it instead of clobbering.
   *
   * ⚠️ Deliberately NOT batched, and that is the whole point. A `WriteBatch`
   * commits ATOMICALLY, so a single stale document would fail the other 399
   * with it and the pass could never make progress past one conflict. One RPC
   * per document is the price of a per-document verdict.
   *
   * Use it whenever the patch is DERIVED from a document you read — a blind
   * `update()` there silently overwrites whatever landed in between, which for
   * a backfill racing a live writer is exactly the failure mode the migration
   * exists to avoid.
   */
  async updateGuarded(
    ref: DocumentReference,
    data: Record<string, unknown>,
    lastUpdateTime: Timestamp,
  ): Promise<boolean> {
    if (!this.apply) return true;
    try {
      await ref.update(data, { lastUpdateTime });
      this.committed += 1;
      return true;
    } catch (err) {
      if (isFailedPrecondition(err)) return false;
      throw err;
    }
  }

  /**
   * `update()` addressed by explicit {@link FieldPath}s instead of an object of
   * dotted string keys — the ONLY way to touch a field whose name contains a
   * character the dotted-string form forbids.
   *
   * The Admin SDK runs `validateFieldPath` over every string key of the object
   * form and rejects any matching `/[*~/[\]]/` outright ("Paths can't be empty
   * and must not contain \"*~/[]\""). It never reaches the splitter, so a key
   * like `precos.listaDePrecos/L1` throws rather than addressing the map entry
   * `listaDePrecos/L1`. A `FieldPath` carries its segments already separated,
   * so the SDK skips that validation and backtick-quotes each segment when it
   * serializes — `new FieldPath('precos', 'listaDePrecos/L1')` becomes
   * ``precos.`listaDePrecos/L1` ``. Segments containing `.` are fine too, for
   * the same reason: nothing is ever split.
   *
   * Takes the same alternating `field, value, field, value…` varargs the SDK
   * does, and counts as ONE op regardless of how many fields it carries.
   */
  async updateFields(
    ref: DocumentReference,
    field: FieldPath,
    value: unknown,
    ...more: unknown[]
  ): Promise<void> {
    if (!this.apply) return;
    this.batch ??= this.db.batch();
    this.batch.update(ref, field, value, ...more);
    this.ops += 1;
    if (this.ops >= this.maxOps) await this.flush();
  }

  async flush(): Promise<void> {
    if (!this.batch || this.ops === 0) return;
    await this.batch.commit();
    this.committed += this.ops;
    this.batch = null;
    this.ops = 0;
  }
}

export interface MigrationContext {
  db: Firestore;
  apply: boolean;
  /** See {@link MigrationArgs.reportOnly}. Never true together with `apply`. */
  reportOnly: boolean;
  sink: ChangeSink;
  writer: BatchWriter;
  /** The parsed CLI arguments, so a migration body can read `--target`. */
  args: MigrationArgs;
}

export interface MigrationSummary {
  docsScanned: number;
  docsChanged: number;
}

function log(message: string): void {
  // eslint-disable-next-line no-console
  console.log(message);
}

/**
 * Set up the admin connection + a timestamped `out/` log, run the migration
 * body, flush pending writes, and print a summary. Dry-run unless `--apply`.
 * The body receives a `MigrationContext` and returns how many docs it scanned
 * / changed.
 */
export async function runMigration(
  name: string,
  body: (ctx: MigrationContext) => Promise<MigrationSummary>,
): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = migrationDb(args.projectId, args.serviceAccountPath);

  const outDir = resolve(process.cwd(), 'out');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = resolve(outDir, `${stamp}-${name}${args.apply ? '' : '-dryrun'}.jsonl`);
  const stream = createWriteStream(logPath, { flags: 'a' });

  const sink = new ChangeSink(stream);
  const writer = new BatchWriter(db, args.apply);

  const mode = args.apply ? 'APPLY' : args.reportOnly ? 'REPORT-ONLY' : 'DRY-RUN';
  log(`[${name}] project=${args.projectId} mode=${mode} → ${logPath}`);

  const summary = await body({
    db,
    apply: args.apply,
    reportOnly: args.reportOnly,
    sink,
    writer,
    args,
  });
  await writer.flush();
  await new Promise<void>((res) => stream.end(res));

  log(
    `[${name}] done: scanned ${summary.docsScanned} docs, ${summary.docsChanged} with changes ` +
      `(${sink.changes} field changes, ${sink.skips} skipped, ${writer.committed} writes). ` +
      `${args.apply ? 'APPLIED.' : 'DRY-RUN — no writes performed.'}`,
  );
}
