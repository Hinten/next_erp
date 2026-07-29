/* eslint-disable no-console -- CLI script: stdout is the interface */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Live MEASUREMENT for #728/#729: how many queries a delete-cascade walk costs.
//
// ⚠️ This is a report, NOT a pass/fail index gate, and it cannot be one.
// `query.explain({ analyze: true })` — the mechanism every other `check-*.mjs`
// in this repo uses — is REJECTED by Firestore Enterprise:
//
//     3 INVALID_ARGUMENT: Explain options are not supported in RunQuery API for
//     Enterprise edition. Please use the ExecutePipeline API instead.
//
// Do not "fix" that by explaining a pipeline instead. The delete path runs
// CLASSIC queries (`col.select().limit(n)`); a pipeline's plan says nothing
// about a classic query's plan, so such a gate would assert something it never
// measured. Index usage on this database is verified in **Query Insights**
// (console) or `firestore.googleapis.com/api/billable_read_units` in Cloud
// Monitoring — which is where #728's "~6,184 documents scanned per call" came
// from in the first place.
//
// What this DOES measure, and what actually changed: the walk now issues a
// BOUNDED number of kinded queries (one page per non-empty subcollection)
// instead of one kindless all-descendants scan per document. Compare the
// printed query/document counts against the same parent's Query Insights row.
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
// actually exists. This script walks a parent exactly the way that helper does
// and reports what it cost.
//
// Needs a real Firestore (the emulator has neither the data nor the shape):
//
//   GOOGLE_APPLICATION_CREDENTIALS=<sa.json> \
//   FIREBASE_PROJECT_ID=veste-france-debug \
//   node apps/functions/scripts/check-delete-cost.mjs
//
// The queries ARE executed and billed as normal reads. They are keys-only
// `limit(300)` pages over one parent's subcollection, so the bill is negligible
// — that is the whole point being measured. Targets the named `default`
// database (Firestore Enterprise; see deploy gotcha #8), overridable via
// FIREBASE_DATABASE_ID.
//
// Pass a concrete parent to measure real data:
//   node apps/functions/scripts/check-delete-cost.mjs produtos/<id> pedidos/<id>
//
// With no arguments it SAMPLES real documents from the two deep-subtree roots
// (`produtos`, `pedidos`) and walks those. It deliberately does not fall back to
// a synthetic id: a document that does not exist has no subcollections, so the
// walk would issue ZERO queries and still print a cheerful summary — a vacuous
// pass, which is worse than no measurement at all. A run that measured nothing
// exits NON-ZERO (see the bottom of the file).
//
// (The first version probed `produtos/__probe__`. Firestore reserves every id
// matching `__…__`, so it died with `INVALID_ARGUMENT: Resource id "__probe__"
// is invalid because it is reserved` before reaching the vacuous-pass problem.)

const projectId = process.env.FIREBASE_PROJECT_ID ?? 'veste-france-debug';
const databaseId = process.env.FIREBASE_DATABASE_ID ?? 'default';
const PAGE_SIZE = 300;

/** Documents sampled per root when no explicit parent is given. */
const SAMPLE_PER_ROOT = Number(process.env.CHECK_DELETE_SAMPLE ?? '5');

/** Roots worth sampling: the only two with a depth-3 chain in the registry. */
const SAMPLE_ROOTS = ['produtos', 'pedidos'];

const app = initializeApp({ projectId });
const db = getFirestore(app, databaseId);

let queries = 0;
let listCalls = 0;
let documents = 0;

/**
 * Run one page of the real delete query and report what it returned.
 *
 * `.select()` with no arguments is the keys-only projection (the SDK pushes
 * `FieldPath.documentId()` itself), and the page is bounded by `limit` — the two
 * properties that make this kinded query cheap where the kindless one could not
 * be made cheap at all.
 */
async function measurePage(col, depth) {
  queries += 1;
  const started = Date.now();
  const snap = await col.select().limit(PAGE_SIZE).get();
  documents += snap.size;
  console.log(
    `${'  '.repeat(depth)}  ${col.path} — select() limit ${PAGE_SIZE} → ` +
      `${snap.size} doc(s) in ${Date.now() - started}ms`,
  );
  return snap;
}

/**
 * Walk a document exactly the way `deleteDocumentSubtree` does — ask
 * `listCollections()`, then one keys-only page per child — and recurse, so the
 * `estoques/*\/historicoEstoque` and `nfev4/*\/cartacorrecao` grandchild levels
 * are covered too.
 */
async function probe(docRef, depth = 0) {
  listCalls += 1;
  const children = await docRef.listCollections();
  if (children.length === 0) {
    console.log(`${'  '.repeat(depth)}· ${docRef.path}: no subcollections (0 queries)`);
    return;
  }
  console.log(`${'  '.repeat(depth)}· ${docRef.path}: ${children.length} subcollection(s)`);
  for (const col of children) {
    const snap = await measurePage(col, depth);
    // One representative child is enough to reach the next level: every doc in a
    // collection has the same possible shape below it.
    if (!snap.empty) await probe(snap.docs[0].ref, depth + 1);
  }
}

/**
 * Real parent documents to walk. Explicit arguments win; otherwise sample each
 * deep-subtree root. Keys-only and tiny, so the discovery itself is negligible
 * next to what it is measuring.
 */
async function resolveTargets() {
  const explicit = process.argv.slice(2);
  if (explicit.length > 0) return explicit.map((path) => db.doc(path));

  const refs = [];
  for (const root of SAMPLE_ROOTS) {
    const snap = await db.collection(root).select().limit(SAMPLE_PER_ROOT).get();
    console.log(`[sample] ${root}: ${snap.size} document(s)`);
    for (const doc of snap.docs) refs.push(doc.ref);
  }
  return refs;
}

const targets = await resolveTargets();

for (const ref of targets) {
  console.log(`\n──────── ${ref.path} ────────`);
  await probe(ref);
}

// A cheerful summary over zero measurements is the failure mode this exists to
// avoid: every sampled parent being childless reads exactly like a clean result.
if (queries === 0) {
  console.error(
    `\n❌ walked ${targets.length} document(s) and none had a subcollection — ` +
      'nothing was measured. Pass a parent that owns subcollections explicitly, ' +
      'e.g. `node apps/functions/scripts/check-delete-cost.mjs produtos/<id>`, ' +
      `or raise CHECK_DELETE_SAMPLE (currently ${SAMPLE_PER_ROOT}).`,
  );
  process.exit(1);
}

console.log(
  `\n📊 ${targets.length} parent(s): ${listCalls} listCollections + ${queries} kinded ` +
    `query(ies), ${documents} document(s) returned.`,
);
console.log(
  `   Compare against Query Insights: the old path issued ONE kindless ` +
    `COLLECTION_GROUP * SELECT __name__ scan per document, ~6,184 docs scanned each,\n` +
    `   regardless of whether the subtree held anything (#728).`,
);
process.exit(0);
