import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Live diagnostic for the estoque-domain indexes (#407) — sibling of
// check-sweep-indexes.mjs. This Firestore Enterprise edition creates NO indexes
// automatically, so the two hot reads below rely on declared entries in
// firestore.indexes.json:
//
//   1. movement history (EstoqueMovimentacaoModal):
//      historicoEstoque orderBy timestamp desc limit 50
//      → requires `historicoEstoque(timestamp DESC)` (queryScope COLLECTION);
//   2. variation-children lookup (EstoqueManager):
//      produtos where paiId == <id> limit 500
//      → served by the EXISTING composite `produtos(paiId ASC, nome ASC)`
//        via index-prefix equality — this script PROVES that instead of
//        assuming it.
//
// Query Explain needs a real Firestore (the emulator does not implement
// `explain({ analyze: true })`), so run it against a live project AFTER
// `firebase deploy --only firestore:indexes`:
//
//   GOOGLE_APPLICATION_CREDENTIALS=<sa.json> \
//   FIREBASE_PROJECT_ID=<project-id> \
//   node apps/functions/scripts/check-estoque-indexes.mjs
//
// Exits NON-ZERO if any query reports no index (a scan) — the script is a
// verification gate, not a log. `analyze: true` EXECUTES each query (billed as
// a normal read). Targets the named `default` database (deploy gotcha #8),
// overridable via FIREBASE_DATABASE_ID. Probe documents are auto-discovered
// with bounded reads; override with CHECK_PRODUTO_ID / CHECK_ESTOQUE_ID to
// point at a specific estoque.

const projectId = process.env.FIREBASE_PROJECT_ID ?? 'veste-france-debug';
const databaseId = process.env.FIREBASE_DATABASE_ID ?? 'default';

const app = initializeApp({ projectId });
const db = getFirestore(app, databaseId);

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

// --- Probe discovery (bounded) ---------------------------------------------
// The history query is subcollection-scoped, so it needs a REAL
// produtos/<id>/estoques/<id> path. Discovery must itself be cheap on a big
// database: a bare collection-group probe could scan arbitrarily far on this
// Enterprise edition (no group index), so instead walk up to PROBE_PRODUTOS
// produtos (a bare limit query — no predicate/sort, bounded by definition) and
// peek at each one's `estoques` subcollection (limit 1). Worst case:
// PROBE_PRODUTOS + PROBE_PRODUTOS reads.
const PROBE_PRODUTOS = 25;

let produtoId = process.env.CHECK_PRODUTO_ID ?? null;
let estoqueId = process.env.CHECK_ESTOQUE_ID ?? null;
if (!produtoId || !estoqueId) {
  const produtos = await db.collection('produtos').limit(PROBE_PRODUTOS).get();
  for (const produtoDoc of produtos.docs) {
    const estoques = await produtoDoc.ref.collection('estoques').limit(1).get();
    if (!estoques.empty) {
      produtoId = produtoDoc.id;
      estoqueId = estoques.docs[0].id;
      break;
    }
  }
  if (!produtoId || !estoqueId) {
    console.error(
      `no estoque found under the first ${PROBE_PRODUTOS} produtos — ` +
        'pass CHECK_PRODUTO_ID/CHECK_ESTOQUE_ID to point at one explicitly',
    );
    process.exit(1);
  }
}
console.log(`probe estoque: produtos/${produtoId}/estoques/${estoqueId}`);

await explain(
  'movement history — historicoEstoque orderBy timestamp desc limit 50',
  db
    .collection('produtos')
    .doc(produtoId)
    .collection('estoques')
    .doc(estoqueId)
    .collection('historicoEstoque')
    .orderBy('timestamp', 'desc')
    .limit(50),
);

await explain(
  'variation children — produtos where paiId == <probe id> limit 500 (must ride produtos(paiId, nome))',
  db.collection('produtos').where('paiId', '==', produtoId).limit(500),
);

if (semIndice > 0) {
  console.error(
    `\n❌ ${semIndice} query(ies) ran without an index — deploy firestore.indexes.json`,
  );
  process.exit(1);
}
console.log('\n✅ all queries index-backed');
process.exit(0);
