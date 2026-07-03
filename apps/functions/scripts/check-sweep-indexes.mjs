import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Live diagnostic: prove the orphan-sweep queries are index-backed (NOT a
// collection scan). This Firestore Enterprise edition creates NO indexes
// automatically, so both queries rely on declared entries in
// firestore.indexes.json: the phantom sweep on `arquivos(uploadState, criadoEm)`,
// the unreferenced candidate scan on `arquivos(criadoEm)`, and the marked sweep on
// `arquivos(markedForDeletionAt)`. (The real candidate scan is a regex pipeline on
// top of that `criadoEm` index; this script explains the equivalent classic range
// query to confirm the index is used.)
// This script confirms `indexesUsed` is non-empty and the reads are bounded.
//
// Query Explain needs a real Firestore (Enterprise) — the emulator does not
// implement `explain({ analyze: true })` — so run it against a live project:
//
//   GOOGLE_APPLICATION_CREDENTIALS=<sa.json> \
//   FIREBASE_PROJECT_ID=veste-france-debug \
//   node apps/functions/scripts/check-sweep-indexes.mjs
//
// `analyze: true` EXECUTES each query (billed as a normal read) — that is what
// produces real index + read statistics. Targets the named `default` database
// (Firestore Enterprise; see deploy gotcha #8), overridable via
// FIREBASE_DATABASE_ID.

const projectId = process.env.FIREBASE_PROJECT_ID ?? 'veste-france-debug';
const databaseId = process.env.FIREBASE_DATABASE_ID ?? 'default';
// Mirror the production sweep's guard: non-numeric/negative falls back to 48h
// (else NaN would poison the cutoff and fail the query).
const graceRaw = Number(process.env.ARQUIVO_ORPHAN_GRACE_HOURS ?? '48');
const graceHours = Number.isFinite(graceRaw) && graceRaw >= 0 ? graceRaw : 48;

const app = initializeApp({ projectId });
const db = getFirestore(app, databaseId);

// Matches sweepUnreferencedArquivos: cutoff = now - grace, in microseconds.
const nowMicros = Date.now() * 1000;
const cutoff = nowMicros - graceHours * 3_600_000 * 1000;

let semIndice = 0;

async function explain(label, query) {
  const { metrics } = await query.explain({ analyze: true });
  const indexesUsed = metrics.planSummary?.indexesUsed ?? [];
  const stats = metrics.executionStats ?? {};
  console.log(`\n=== ${label} ===`);
  console.log('indexesUsed:', JSON.stringify(indexesUsed, null, 2));
  console.log('resultsReturned:', stats.resultsReturned);
  console.log('readOperations:', stats.readOperations);
  console.log('executionDuration:', stats.executionDuration);
  if (indexesUsed.length === 0) {
    semIndice += 1;
    console.warn('  ⚠️  no index reported — query is scanning the collection');
  }
}

await explain(
  'phantom scan — arquivos where uploadState=="pending" AND criadoEm<cutoff orderBy criadoEm limit 100',
  db
    .collection('arquivos')
    .where('uploadState', '==', 'pending')
    .where('criadoEm', '<', cutoff)
    .orderBy('criadoEm', 'asc')
    .limit(100),
);
await explain(
  'candidate criadoEm index — arquivos where criadoEm<cutoff orderBy criadoEm limit 100 (the index the regex pipeline rides)',
  db.collection('arquivos').where('criadoEm', '<', cutoff).orderBy('criadoEm', 'asc').limit(100),
);
await explain(
  'marked sweep — arquivos where markedForDeletionAt<cutoff orderBy markedForDeletionAt limit 100',
  db
    .collection('arquivos')
    .where('markedForDeletionAt', '<', cutoff)
    .orderBy('markedForDeletionAt', 'asc')
    .limit(100),
);

// Verification gate, not a log: a scan must fail the run (same contract as
// check-estoque-indexes.mjs).
if (semIndice > 0) {
  console.error(
    `\n❌ ${semIndice} query(ies) ran without an index — deploy firestore.indexes.json`,
  );
  process.exit(1);
}
console.log('\n✅ all queries index-backed');
process.exit(0);
