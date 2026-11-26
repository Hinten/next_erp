/* eslint-disable no-console -- CLI script: stdout is the interface */
import { createWriteStream, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';

import {
  SOURCE_DATABASE_ID,
  TARGET_DATABASE_ID,
  WATERMARKS_COLLECTION,
  mirrorPath,
} from '@delfrance/legacy-mirror/mirror';
import { projectBoundDb } from '../admin';
import { isMainModule } from '../runner';
import { type ReplayArgs, compareCounts, isAfter, parseReplayArgs } from './transform';

/**
 * Re-apply every mirrored path changed after the export's T0 — see transform.ts
 * and `legacy-mirror-replay.README.md`. Reads the LEGACY project, writes the NEW
 * one, through the mirror's own `mirrorPath` (same watermark guard, so running it
 * while the mirror is live is safe, and running it twice is a no-op the second
 * time).
 *
 * Cost: one unindexed scan of `_mirrorWatermarks` (bounded by the paths changed
 * since the mirror was deployed — Enterprise bills it as data scanned, a few
 * read units per thousand watermarks), then one Standard read plus the usual
 * mirror write per replayed path.
 */

const PARALLEL = 16;

function openLog(name: string, dryRun: boolean) {
  const outDir = resolve(process.cwd(), 'out');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = resolve(outDir, `${stamp}-${name}${dryRun ? '-dryrun' : ''}.jsonl`);
  return { path, stream: createWriteStream(path, { flags: 'a' }) };
}

function handles(args: ReplayArgs): { source: Firestore; target: Firestore } {
  return {
    source: projectBoundDb({
      projectId: args.sourceProjectId,
      serviceAccountPath: args.sourceServiceAccountPath,
      appName: 'legacy-mirror-replay-source',
      databaseId: SOURCE_DATABASE_ID,
    }),
    target: projectBoundDb({
      projectId: args.projectId,
      serviceAccountPath: args.serviceAccountPath,
      appName: 'legacy-mirror-replay-target',
      databaseId: TARGET_DATABASE_ID,
    }),
  };
}

async function replay(args: ReplayArgs, source: Firestore, target: Firestore): Promise<void> {
  const credentials = args.credentials;
  if (credentials === null) throw new Error('unreachable: parseReplayArgs requires --credentials');
  const log = openLog('legacy-mirror-replay', !args.apply);
  const since = new Timestamp(args.since.seconds, args.since.nanoseconds);
  // Unindexed on purpose: a migration-only collection gets no index, and the
  // filter is re-checked in code below, so a planner that ignores it costs a
  // scan, never a wrong answer.
  const snap = await target.collection(WATERMARKS_COLLECTION).where('stamp', '>', since).get();
  const paths = snap.docs
    .map((d) => d.data() as { path?: unknown; stamp?: Timestamp })
    .filter(
      (w): w is { path: string; stamp: Timestamp } =>
        typeof w.path === 'string' && !!w.stamp && isAfter(w.stamp, args.since),
    )
    .map((w) => w.path);

  console.log(`${paths.length} path(s) changed after T0 (${since.toDate().toISOString()}).`);
  let applied = 0;
  let skipped = 0;
  let denied = 0;
  for (let i = 0; i < paths.length; i += PARALLEL) {
    const slice = paths.slice(i, i + PARALLEL);
    if (!args.apply) {
      for (const path of slice)
        log.stream.write(`${JSON.stringify({ kind: 'would-replay', path })}\n`);
      continue;
    }
    const outcomes = await Promise.all(
      slice.map((path) => mirrorPath(path, source, target, { credentials })),
    );
    outcomes.forEach((outcome, k) => {
      if (outcome === 'applied') applied += 1;
      else if (outcome === 'denied') denied += 1;
      else skipped += 1;
      log.stream.write(`${JSON.stringify({ kind: outcome, path: slice[k] })}\n`);
    });
  }
  log.stream.end();
  console.log(
    args.apply
      ? `replayed: ${applied} applied, ${skipped} skipped (a newer version was already there), ` +
          `${denied} credential path(s) denied.`
      : `dry-run: nothing written. Re-run with --apply.`,
  );
  console.log(`log: ${log.path}`);
}

async function counts(db: Firestore, groups: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const col of await db.listCollections()) {
    out.set(col.id, (await col.count().get()).data().count);
  }
  for (const group of groups) {
    out.set(`group:${group}`, (await db.collectionGroup(group).count().get()).data().count);
  }
  return out;
}

async function verify(args: ReplayArgs, source: Firestore, target: Firestore): Promise<number> {
  const [legacy, novo] = await Promise.all([
    counts(source, args.groups),
    counts(target, args.groups),
  ]);
  const rows = compareCounts(legacy, novo, new Set([WATERMARKS_COLLECTION]));
  console.table(rows);
  const differ = rows.filter((r) => r.status !== 'igual');
  console.log(
    differ.length === 0 ? 'every count matches.' : `${differ.length} collection(s) differ.`,
  );
  return differ.length === 0 ? 0 : 1;
}

async function main(): Promise<void> {
  const args = parseReplayArgs(process.argv.slice(2));
  const { source, target } = handles(args);
  if (args.verify) {
    process.exitCode = await verify(args, source, target);
    return;
  }
  await replay(args, source, target);
}

if (isMainModule(import.meta.url)) {
  await main();
}
