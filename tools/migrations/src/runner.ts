import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { resolve } from 'node:path';
import type { DocumentReference, Firestore, WriteBatch } from 'firebase-admin/firestore';
import { migrationDb } from './admin';

/* -------------------------------------------------------------------------- */
/*                              CLI argument parsing                          */
/* -------------------------------------------------------------------------- */

export interface MigrationArgs {
  /** Target Firebase project — REQUIRED, never inferred. */
  projectId: string;
  /** Write changes. Default false (dry-run). */
  apply: boolean;
  /** Optional explicit service-account file (else env). */
  serviceAccountPath?: string;
}

export class MigrationArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationArgError';
  }
}

/**
 * Parse the migration CLI contract (see `tools/migrations/README.md`):
 *   --project <id>   REQUIRED — never defaults, so prod is never touched by accident
 *   --apply          write changes (omit for a dry-run that only logs)
 *   --service-account <path>   optional credential override
 * Throws `MigrationArgError` on a missing/unknown flag.
 */
export function parseArgs(argv: readonly string[]): MigrationArgs {
  let projectId: string | undefined;
  let apply = false;
  let serviceAccountPath: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--apply') {
      apply = true;
    } else if (arg === '--project') {
      projectId = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--project=')) {
      projectId = arg.slice('--project='.length);
    } else if (arg === '--service-account') {
      serviceAccountPath = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--service-account=')) {
      serviceAccountPath = arg.slice('--service-account='.length);
    } else {
      throw new MigrationArgError(`Unknown argument: ${arg}`);
    }
  }

  if (!projectId || projectId.trim().length === 0) {
    throw new MigrationArgError(
      '--project <id> is required. The migration refuses to guess the target project.',
    );
  }
  return { projectId: projectId.trim(), apply, serviceAccountPath };
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

/**
 * Accumulates `update()`s and commits them in batches of `maxOps` (Firestore
 * caps a batch at 500). A no-op in dry-run mode. Call `flush()` at the end.
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
  sink: ChangeSink;
  writer: BatchWriter;
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

  log(`[${name}] project=${args.projectId} mode=${args.apply ? 'APPLY' : 'DRY-RUN'} → ${logPath}`);

  const summary = await body({ db, apply: args.apply, sink, writer });
  await writer.flush();
  await new Promise<void>((res) => stream.end(res));

  log(
    `[${name}] done: scanned ${summary.docsScanned} docs, ${summary.docsChanged} with changes ` +
      `(${sink.changes} field changes, ${sink.skips} skipped, ${writer.committed} writes). ` +
      `${args.apply ? 'APPLIED.' : 'DRY-RUN — no writes performed.'}`,
  );
}
