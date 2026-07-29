/* eslint-disable no-console -- CLI script: stdout is the interface */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Live gate for #728/#729: prove the delete-cascade walk is index-backed.
//
// `db.recursiveDelete(ref)` issued ONE kindless all-descendants query per call
// — `COLLECTION_GROUP * SELECT __name__ LIMIT 5000`. On this Firestore
// Enterprise edition that query rides no index and CANNOT be given one:
// Enterprise auto-creates nothing, has no wildcard index, and a kindless
// descendant scan carries no field predicate to seek on (Query Insights' "create
// index" button opens a blank form). It silently full-scanned and Enterprise
// bills DATA SCANNED — measured at ~6,184 documents per call, 9,234 calls in 7
// days, 93% of this project's read volume.
//
// `deleteDocumentSubtree` (`@delfrance/data/admin`) replaced it with
// `listCollections()` + one KINDED, key-bounded query per subcollection that
// actually exists. This script explains that second shape and fails if any of
// them scans.
//
// ⚠️ It can only prove the AFTER. The kindless query is built from the SDK's
// internal `QueryOptions.forKindlessAllDescendants` and cannot be reconstructed
// through the public API, so there is nothing to hand `explain()`. The before
// numbers are the measured ones recorded in #728 (~6,184 docs/call) and #729
// (~5,123 read units/produto).
//
// Query Explain needs a real Firestore — the emulator does not implement
// `explain({ analyze: true })` — so run it against a live project:
//
//   GOOGLE_APPLICATION_CREDENTIALS=<sa.json> \
//   FIREBASE_PROJECT_ID=veste-france-debug \
//   node apps/functions/scripts/check-delete-cost.mjs
//
// `analyze: true` EXECUTES each query (billed as a normal read) — that is what
// produces real index + read statistics. These are keys-only `limit(300)`
// queries over one parent's subcollection, so the bill is negligible; that is
// the whole point being verified. Targets the named `default` database
// (Firestore Enterprise; see deploy gotcha #8), overridable via
// FIREBASE_DATABASE_ID.
//
// Pass a concrete parent to probe real data:
//   node apps/functions/scripts/check-delete-cost.mjs produtos/<id> pedidos/<id>
// With no arguments it probes a NON-EXISTENT parent in each of the two
// deep-subtree roots. That still exercises the real query planner — an empty
// key range is the case the sweep hits most, and it is exactly where
// `recursiveDelete` charged full price for finding nothing.

const projectId = process.env.FIREBASE_PROJECT_ID ?? 'veste-france-debug';
const databaseId = process.env.FIREBASE_DATABASE_ID ?? 'default';
const PAGE_SIZE = 300;

const app = initializeApp({ projectId });
const db = getFirestore(app, databaseId);

const parents = process.argv.slice(2);
const targets = parents.length > 0 ? parents : ['produtos/__probe__', 'pedidos/__probe__'];

let semIndice = 0;
let queries = 0;

async function explain(label, query) {
  queries += 1;
  const { metrics } = await query.explain({ analyze: true });
  const indexesUsed = metrics.planSummary?.indexesUsed ?? [];
  const stats = metrics.executionStats ?? {};
  console.log(`\n=== ${label} ===`);
  console.log('indexesUsed:', JSON.stringify(indexesUsed));
  console.log('resultsReturned:', stats.resultsReturned);
  console.log('readOperations:', stats.readOperations);
  console.log('executionDuration:', stats.executionDuration);
  if (indexesUsed.length === 0) {
    semIndice += 1;
    console.warn('  ⚠️  no index reported — this query is scanning');
  }
}

/**
 * Walk a document exactly the way `deleteDocumentSubtree` does — ask
 * `listCollections()`, then explain one keys-only page per child — and recurse,
 * so the `estoques/*\/historicoEstoque` and `nfev4/*\/cartacorrecao` grandchild
 * levels are covered too.
 */
async function probe(docRef, depth = 0) {
  const children = await docRef.listCollections();
  if (children.length === 0) {
    console.log(`${'  '.repeat(depth)}· ${docRef.path}: no subcollections (0 queries)`);
    return;
  }
  for (const col of children) {
    await explain(`${col.path} — select() limit ${PAGE_SIZE}`, col.select().limit(PAGE_SIZE));
    const snap = await col.select().limit(1).get();
    // One representative child is enough to reach the next level: every doc in a
    // collection has the same possible shape below it.
    if (!snap.empty) await probe(snap.docs[0].ref, depth + 1);
  }
}

for (const target of targets) {
  console.log(`\n──────── ${target} ────────`);
  await probe(db.doc(target));
}

if (semIndice > 0) {
  console.error(`\n❌ ${semIndice} of ${queries} subtree query(ies) ran without an index`);
  process.exit(1);
}
console.log(`\n✅ ${queries} subtree query(ies), all index-backed`);
process.exit(0);
