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
// What this DOES measure, and what actually changed: the walk now issues KINDED,
// key-bounded, keys-only queries instead of one kindless all-descendants scan per
// document. Compare the printed counts against the same parent's Query Insights
// row.
//
// ⚠️ Read the summary carefully: `listCollections()` runs once per document
// REACHED, not once per parent — a leaf still costs one round-trip to learn it is
// a leaf. So the cost of deleting a subtree is roughly
// `~5 read units × (1 + descendant count)`, NOT a flat ~5 per parent. That is
// still far below the old path, which paid ~6,184 documents scanned FLAT per
// document deleted whether the subtree held anything or not — the win is largest
// exactly where the old path was most absurd (a produto with no subcollections).
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
// The queries ARE executed and billed as normal reads, and the walk is faithful,
// so it touches every descendant of every parent it is given. That is cheap for
// the fixture-sized subtrees this exists to measure; `CHECK_DELETE_MAX_DOCS`
// (default 2000) stops it becoming a crawl on a pathological one, and says so.
// Targets the named `default` database (Firestore Enterprise; see deploy gotcha
// #8), overridable via FIREBASE_DATABASE_ID.
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

/**
 * Documents sampled per root when no explicit parent is given.
 *
 * Sanitised the way `check-sweep-indexes.mjs` sanitises its grace window: a
 * non-numeric or non-positive value would reach `.limit()` as NaN/0 and either
 * throw from inside the SDK or sample nothing, surfacing as a baffling "nothing
 * was measured" instead of "your env var is wrong".
 */
const sampleRaw = Number(process.env.CHECK_DELETE_SAMPLE ?? '5');
const SAMPLE_PER_ROOT = Number.isFinite(sampleRaw) && sampleRaw >= 1 ? Math.floor(sampleRaw) : 5;

/**
 * Ceiling on documents visited across the whole run. The walk below is faithful,
 * which means it touches EVERY descendant — a pedido with thousands of itens
 * would otherwise turn a diagnostic into a long, billed crawl. Hitting it is
 * always reported, and makes every printed figure a LOWER BOUND.
 */
const maxDocsRaw = Number(process.env.CHECK_DELETE_MAX_DOCS ?? '2000');
const MAX_DOCS = Number.isFinite(maxDocsRaw) && maxDocsRaw >= 1 ? Math.floor(maxDocsRaw) : 2000;

/** Roots worth sampling: the only two with a depth-3 chain in the registry. */
const SAMPLE_ROOTS = ['produtos', 'pedidos'];

const app = initializeApp({ projectId });
const db = getFirestore(app, databaseId);

let queries = 0;
let listCalls = 0;
let documents = 0;
let truncated = false;

/**
 * Every document in `col`, paged with a cursor exactly as `deleteCollection`
 * does, recursing into EVERY document rather than a representative one.
 *
 * The fidelity matters more than it looks. `deleteDocumentSubtree` calls
 * `listCollections()` on every document it reaches — including each
 * `historicoDeModificacoes` row, which has no children — so the real cost is
 * roughly `~5 read units × (1 + descendant count)`, not `~5 per parent`. An
 * earlier version of this script read one page and descended into `docs[0]`,
 * which undercounted a 34-document produto subtree by about 9×. If the number
 * printed here is going to be compared against Query Insights, it has to be the
 * number the helper actually generates.
 *
 * `.select()` with no arguments is the keys-only projection (the SDK pushes
 * `FieldPath.documentId()` itself), and each page is bounded by `limit` — the
 * two properties that make this kinded query cheap where the kindless one could
 * not be made cheap at all.
 */
async function measureCollection(col, depth) {
  let cursor;

  for (;;) {
    if (documents >= MAX_DOCS) {
      truncated = true;
      return;
    }
    queries += 1;
    const started = Date.now();
    const base = col.select().limit(PAGE_SIZE);
    const snap = await (cursor ? base.startAfter(cursor) : base).get();
    documents += snap.size;
    console.log(
      `${'  '.repeat(depth)}  ${col.path} — select() limit ${PAGE_SIZE} → ` +
        `${snap.size} doc(s) in ${Date.now() - started}ms`,
    );
    if (snap.empty) return;

    for (const doc of snap.docs) {
      await probe(doc.ref, depth + 1);
      if (truncated) return;
    }

    if (snap.size < PAGE_SIZE) return;
    cursor = snap.docs[snap.size - 1];
  }
}

/**
 * Walk a document exactly the way `deleteDocumentSubtree` does — one
 * `listCollections()` per document reached, then a fully paged keys-only walk of
 * each child collection, so the `estoques/*\/historicoEstoque` and
 * `nfev4/*\/cartacorrecao` grandchild levels are covered too.
 */
async function probe(docRef, depth = 0) {
  if (documents >= MAX_DOCS) {
    truncated = true;
    return;
  }
  listCalls += 1;
  const children = await docRef.listCollections();
  if (children.length === 0) {
    // Not free, and the reason the per-produto figure scales with subtree size:
    // this leaf still cost one ListCollectionIds round-trip to learn it is a leaf.
    if (depth === 0) console.log(`· ${docRef.path}: no subcollections`);
    return;
  }
  console.log(`${'  '.repeat(depth)}· ${docRef.path}: ${children.length} subcollection(s)`);
  for (const col of children) {
    await measureCollection(col, depth);
    if (truncated) return;
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
    `query(ies), ${documents} document(s) reached.` +
    (truncated
      ? ` ⚠️ TRUNCATED at CHECK_DELETE_MAX_DOCS=${MAX_DOCS} — figures are a LOWER BOUND.`
      : ''),
);
console.log(
  `   listCollections runs once per document REACHED, not once per parent — a leaf\n` +
    `   still costs one round-trip to learn it is a leaf. So a subtree's cost scales\n` +
    `   with its size (~5 read units each), where the old path was ~6,184 documents\n` +
    `   scanned FLAT per document deleted, subtree empty or not (#728).`,
);
process.exit(0);
