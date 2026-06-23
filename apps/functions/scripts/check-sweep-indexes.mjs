import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Live diagnostic: prove the orphan-sweep queries are index-backed (NOT a
// collection scan). Both queries are single-field, so Firestore serves them from
// AUTOMATIC single-field indexes — there is no composite index to add. This
// script confirms `indexesUsed` is non-empty and the reads are bounded.
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
    console.warn('  ⚠️  no index reported — query may be scanning the collection');
  }
}

await explain(
  'candidate scan — arquivos where criadoEm < cutoff limit 100',
  db.collection('arquivos').where('criadoEm', '<', cutoff).limit(100),
);
await explain(
  'phantom scan — arquivos where uploadState == "pending" limit 100',
  db.collection('arquivos').where('uploadState', '==', 'pending').limit(100),
);

process.exit(0);
