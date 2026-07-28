/* eslint-disable no-console, no-restricted-syntax, no-restricted-imports -- standalone staging CLI: mirrors THE query verbatim; defineAdminCollection handles have no pipeline surface and the app's admin singleton needs Next env */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import * as pipelines from '@google-cloud/firestore/pipelines';

// ⚠️ BLOCKING pre-merge gate for Step 10 PR C — run MANUALLY against staging
// (agents never run firebase; index deploy is a coordinated human step).
//
// Live proof that `fetchStockFamilies` (lib/marketplace/estoquePlan.ts) rides
// the five declared indexes instead of silently full-scanning: this Firestore
// Enterprise edition auto-creates NO indexes, an unindexed correlated subquery
// scans its collection ONCE PER OUTER ROW, and Enterprise bills data scanned —
// the pedidos sales probe is the one catastrophic failure mode. Pipelines have
// no `.explain()`; their explain rides `execute({ explainOptions: { mode:
// 'analyze', outputFormat: 'text' } })` → `snapshot.explainStats.text`
// (firestore-pipelines skill §6). `analyze` EXECUTES the query (billed), so
// every run here is bounded by CHECK_PAGE_LIMIT (default 5) anchors.
//
// What it does, in order:
//  1. Spike (a): nested `define` inside a correlated subquery, at BOTH
//     sibling sites with DIFFERENT variable names (`maxChildKitKeys` in the
//     maxChildren rollup, `childKitKeys` in the children join). Every returned
//     row is PRINTED (`JSON.stringify(row.data())`): a shape that executes but
//     binds the nested define to the OUTER row is only visible in the values,
//     so the spike auto-picks an anchor whose CHILDREN have kit keys the
//     anchor itself does not (it looks for a produto with `ehKit: true` and a
//     `paiId`). Override with CHECK_SPIKE_ANCHOR_ID. If no such family exists
//     in staging the spike still runs but prints a NOTE that a mis-binding
//     would be indistinguishable — seed one before trusting a PASS.
//  2. Spike (c): does `define` accept a correlated-subquery expression
//     (the `childIds` array the pedidos probe consumes as a variable)? Its
//     rows are printed too (`numChildren` must match reality).
//  3. The full incremental page-1 query (the fetchStockFamilies shape) under
//     explain-analyze, asserting index evidence for the three seek targets:
//     the produtos anchors scan, the estoques `parentId` join, the pedidos
//     sales probe. Spike (b) reads the same plan for BOTH array predicates:
//     which entry the pedidos probe rode (`itensIds CONTAINS` vs `itensIds
//     ASC`) and which one the produtos anchor scan rode
//     (`integracoesComProduto CONTAINS` vs `ASC`). Both twins are declared in
//     firestore.indexes.json for each field — after this run, KEEP the form
//     the plan shows and DROP the loser in a follow-up (four entries, two
//     survivors).
//  4. A daily-mode PAGE-2 call with the SHIPPED daily predicate
//     (`changedSinceMs = now − dailyWindowHours − overlap`, probe skipped,
//     `afterAnchorId` keyset) and prints its plan — the
//     keyset-over-computed-filter cost regime the docblock warns about. A
//     second, clearly labeled run repeats it with the worst-case force-all
//     `changedSinceMs = -1` (every anchor survives S4): same bounded page, so
//     it is cheap, and it shows the plan when the computed filter selects
//     nothing away.
//
// The index checks are TEXT HEURISTICS over the plan (the explain format is
// not machine-stable) and are NEGATIVE-FIRST: any scan marker in the window
// FAILS outright, and a PASS additionally requires a real seek/index-usage
// marker (the bare word "index" is not enough — it appears in prose). The
// printed plan is still the actual gate — READ IT before merging PR C.
// Exits non-zero on any FAIL.
//
// Run (staging), AFTER `firebase deploy --only firestore:indexes`:
//
//   GOOGLE_APPLICATION_CREDENTIALS=<sa.json> \
//   FIREBASE_PROJECT_ID=veste-france-debug \
//   node apps/mercado-livre/scripts/check-stock-indexes.mjs
//
// Probe ids are auto-discovered with bounded reads; override with
// CHECK_INTEGRACAO_ID / CHECK_DEPOSITO_ID / CHECK_SPIKE_ANCHOR_ID (the
// spike-(a) family, see 1. above). Targets the named `default`
// database (Enterprise — never `(default)`), overridable via
// FIREBASE_DATABASE_ID.
//
// ⚠️ KEEP IN SYNC with `fetchStockFamilies` in
// apps/mercado-livre/lib/marketplace/estoquePlan.ts — this script mirrors THE
// query in plain JS (the TS module is not importable from a .mjs script); a
// shape change there must be reflected here or the proof goes stale.

const projectId = process.env.FIREBASE_PROJECT_ID ?? 'veste-france-debug';
const databaseId = process.env.FIREBASE_DATABASE_ID ?? 'default';
const pageLimitRaw = Number(process.env.CHECK_PAGE_LIMIT ?? '5');
const pageLimit = Number.isInteger(pageLimitRaw) && pageLimitRaw > 0 ? pageLimitRaw : 5;

// Mirrors the shipped daily window: `dailyWindowHours()` (24) minus
// `windowOverlapSec()` (20) — estoquePlan.ts defaults, janelaDoSweep('daily').
const DAILY_WINDOW_MS = 24 * 3_600_000;
const WINDOW_OVERLAP_MS = 20_000;

// Mirrors ESTADOS_VENDA + INTEGRACAO_TIPO.mercadoLivre (packages/schemas).
const ESTADOS_VENDA = [
  'emAnalise',
  'emProcessamento',
  'pago',
  'finalizado',
  'estornadoParcialmente',
];
const INTEGRACAO_TIPO_MERCADO_LIVRE = 1;

const app = initializeApp({ projectId });
const db = getFirestore(app, databaseId);

const failures = [];
function fail(msg) {
  failures.push(msg);
  console.error(`FAIL  ${msg}`);
}

// Expected spike-failure family: a server rejection of an unsupported pipeline
// shape surfaces as an Error carrying a numeric gRPC status code (1-16, e.g.
// 3 INVALID_ARGUMENT) — same discriminant as orderBackfill's containment.
// Anything else is a coding bug in this script and rethrows.
function isGrpcCodedError(err) {
  if (!(err instanceof Error)) return false;
  const code = err.code;
  return typeof code === 'number' && Number.isInteger(code) && code >= 1 && code <= 16;
}

/* --------------------------- probe discovery -------------------------------- */

let integracaoId = process.env.CHECK_INTEGRACAO_ID ?? null;
if (!integracaoId) {
  const snap = await db
    .collection('integracao')
    .where('tipo', '==', INTEGRACAO_TIPO_MERCADO_LIVRE)
    .where('ativo', '==', true)
    .limit(1)
    .get();
  integracaoId = snap.docs[0]?.id ?? null;
}
let depositoId = process.env.CHECK_DEPOSITO_ID ?? null;
if (!depositoId) {
  const snap = await db.collection('depositos').limit(1).get();
  depositoId = snap.docs[0]?.id ?? null;
}
if (!integracaoId || !depositoId) {
  console.error(
    'no active ML integracao and/or deposito found — seed staging or pass ' +
      'CHECK_INTEGRACAO_ID / CHECK_DEPOSITO_ID explicitly',
  );
  process.exit(1);
}
console.log(`probes: integracao/${integracaoId}, depositos/${depositoId}, pageLimit ${pageLimit}`);

/* ---- THE query, mirrored from estoquePlan.ts (keep-in-sync note above) ----- */

const depMatch = () =>
  pipelines.or(
    pipelines.equal(pipelines.field('depositoOuterRef'), `documents/depositos/${depositoId}`),
    pipelines.equal(pipelines.field('depositoOuterRef'), `depositos/${depositoId}`),
  );

const ownEstoque = () =>
  pipelines
    .subcollection('estoques')
    .where(depMatch())
    .limit(1)
    .select('quantidade', 'quantidadeReservada', 'ultimaModificacao')
    .toScalarExpression();

const ownEstoqueMax = () =>
  pipelines
    .subcollection('estoques')
    .where(depMatch())
    .aggregate(pipelines.maximum('ultimaModificacao').as('max'))
    .toScalarExpression();

const compEstoques = (keysVar) =>
  pipelines.conditional(
    pipelines.variable(keysVar).length().greaterThan(0),
    db
      .pipeline()
      .collectionGroup('estoques')
      .where(
        pipelines.and(
          pipelines.field('parentId').equalAny(pipelines.variable(keysVar)),
          depMatch(),
        ),
      )
      .select('parentId', 'quantidade', 'quantidadeReservada', 'ultimaModificacao')
      .toArrayExpression(),
    pipelines.array([]),
  );

const compEstoquesMax = (keysVar) =>
  pipelines.conditional(
    pipelines.variable(keysVar).length().greaterThan(0),
    db
      .pipeline()
      .collectionGroup('estoques')
      .where(
        pipelines.and(
          pipelines.field('parentId').equalAny(pipelines.variable(keysVar)),
          depMatch(),
        ),
      )
      .aggregate(pipelines.maximum('ultimaModificacao').as('max'))
      .toScalarExpression(),
    pipelines.constant(null),
  );

const kitKeysDefine = (name) =>
  pipelines.coalesce(pipelines.field('componentesKitKeys'), pipelines.array([])).as(name);

const childIds = () =>
  db
    .pipeline()
    .collection('produtos')
    .where(pipelines.equal(pipelines.field('paiId'), pipelines.variable('anchorId')))
    .select(pipelines.documentId(pipelines.field('__name__')).as('childId'))
    .toArrayExpression();

const maxChildren = () =>
  db
    .pipeline()
    .collection('produtos')
    .where(pipelines.equal(pipelines.field('paiId'), pipelines.variable('anchorId')))
    .define(kitKeysDefine('maxChildKitKeys'))
    .select(pipelines.logicalMaximum(ownEstoqueMax(), compEstoquesMax('maxChildKitKeys')).as('m'))
    .aggregate(pipelines.maximum('m').as('max'))
    .toScalarExpression();

const linkJoin = () =>
  pipelines
    .subcollection('produtoMercadoLivre')
    .where(
      pipelines.or(
        pipelines.equal(pipelines.field('contaOuterRef'), `documents/integracao/${integracaoId}`),
        pipelines.equal(pipelines.field('contaOuterRef'), `integracao/${integracaoId}`),
      ),
    )
    .select(
      'id',
      'estado',
      'status',
      'sub_status',
      'isUserProductModel',
      pipelines.documentId(pipelines.field('__name__')).as('linkDocId'),
    )
    .toArrayExpression();

const childrenJoin = () =>
  db
    .pipeline()
    .collection('produtos')
    .where(pipelines.equal(pipelines.field('paiId'), pipelines.variable('anchorId')))
    .define(kitKeysDefine('childKitKeys'))
    .select(
      pipelines.documentId(pipelines.field('__name__')).as('childId'),
      'ehKit',
      'ehKitVirtual',
      'publicado',
      'componentesKit',
      'timestamp',
      ownEstoque().as('estoque'),
      compEstoques('childKitKeys').as('componentEstoques'),
      pipelines
        .subcollection('variacaoMercadoLivre')
        .select('itemId', 'id', 'produtoMercadoLivreOuterRef')
        .toArrayExpression()
        .as('varLinks'),
    )
    .toArrayExpression();

const vendaProbe = (cutoffUs) =>
  db
    .pipeline()
    .collection('pedidos')
    .where(
      pipelines.and(
        pipelines
          .field('itensIds')
          .arrayContainsAny(
            pipelines.arrayConcat(
              pipelines.array([pipelines.variable('anchorId')]),
              pipelines.variable('childIds'),
            ),
          ),
        pipelines.equal(pipelines.field('ehSaida'), true),
        pipelines.field('timestamp').greaterThanOrEqual(cutoffUs),
        pipelines.field('estado').equalAny([...ESTADOS_VENDA]),
      ),
    )
    .limit(1)
    .select('estado')
    .toArrayExpression()
    .length()
    .greaterThan(0);

function anchorPredicate(afterAnchorId) {
  const paiTerm = pipelines.equal(pipelines.field('paiId'), null);
  const publicadoTerm = pipelines.equal(pipelines.field('publicado'), true);
  const contaTerm = pipelines.field('integracoesComProduto').arrayContains(integracaoId);
  if (afterAnchorId == null) return pipelines.and(paiTerm, publicadoTerm, contaTerm);
  return pipelines.and(
    paiTerm,
    publicadoTerm,
    contaTerm,
    pipelines.greaterThan(
      pipelines.field('__name__'),
      pipelines.constant(db.collection('produtos').doc(afterAnchorId)),
    ),
  );
}

function buildFamiliesPipeline({ changedSinceMs, vendaCutoffUs, afterAnchorId }) {
  return db
    .pipeline()
    .collection('produtos')
    .where(anchorPredicate(afterAnchorId ?? null))
    .define(
      pipelines.documentId(pipelines.field('__name__')).as('anchorId'),
      kitKeysDefine('anchorKitKeys'),
    )
    .addFields(
      ownEstoqueMax().as('maxOwn'),
      compEstoquesMax('anchorKitKeys').as('maxComp'),
      maxChildren().as('maxChildren'),
    )
    .where(
      pipelines.greaterThan(
        pipelines.coalesce(
          pipelines.logicalMaximum(
            pipelines.field('maxOwn'),
            pipelines.field('maxComp'),
            pipelines.field('maxChildren'),
          ),
          0,
        ),
        changedSinceMs,
      ),
    )
    .define(childIds().as('childIds'))
    .sort(pipelines.ascending(pipelines.field('__name__')))
    .limit(pageLimit)
    .select(
      pipelines.variable('anchorId').as('anchorId'),
      'ehKit',
      'ehKitVirtual',
      'publicado',
      'componentesKit',
      'integracoesComProduto',
      'timestamp',
      ownEstoque().as('estoque'),
      compEstoques('anchorKitKeys').as('componentEstoques'),
      linkJoin().as('links'),
      childrenJoin().as('children'),
      ...(vendaCutoffUs == null ? [] : [vendaProbe(vendaCutoffUs).as('temVenda30d')]),
    );
}

/* ------------------------------- spikes a + c ------------------------------- */

// The spikes are bounded to <= 3 rows each and PRINT every returned row: a
// nested `define` that silently binds to the OUTER row still executes, so only
// the VALUES expose it.
async function runSpike(label, build) {
  try {
    const snap = await build().execute();
    console.log(`PASS  spike ${label} (${snap.results.length} row(s))`);
    for (const row of snap.results) console.log(`      ${JSON.stringify(row.data())}`);
    return true;
  } catch (err) {
    if (!isGrpcCodedError(err)) throw err;
    fail(`spike ${label}: ${err.message}`);
    return false;
  }
}

// Spike (a) is only conclusive on a family whose CHILDREN carry kit keys the
// anchor does not — otherwise both bindings produce identical output. Find a
// produto that is itself a kit AND a variation child; its `paiId` is such an
// anchor. Bounded read (10 docs), overridable via CHECK_SPIKE_ANCHOR_ID.
let spikeAnchorId = process.env.CHECK_SPIKE_ANCHOR_ID ?? null;
if (!spikeAnchorId) {
  const kitSnap = await db.collection('produtos').where('ehKit', '==', true).limit(10).get();
  for (const doc of kitSnap.docs) {
    const pai = doc.data().paiId;
    if (typeof pai === 'string' && pai !== '') {
      spikeAnchorId = pai;
      break;
    }
  }
}

// Pin spike (a) to that anchor when one was found; otherwise fall back to the
// normal anchor predicate and say so loudly.
const spikePredicate = () =>
  spikeAnchorId == null
    ? anchorPredicate(null)
    : pipelines.equal(
        pipelines.field('__name__'),
        pipelines.constant(db.collection('produtos').doc(spikeAnchorId)),
      );

console.log('\n=== spike (a): nested define at BOTH sibling subquery sites ===');
if (spikeAnchorId == null) {
  console.log(
    'NOTE  no produto with `ehKit: true` AND a `paiId` found — this run cannot ' +
      'distinguish a correct per-subquery-row binding from a binding to the outer ' +
      'anchor (the kit keys would be identical either way). Seed a kit variation ' +
      'child, or pass CHECK_SPIKE_ANCHOR_ID, before treating a PASS as proof.',
  );
} else {
  console.log(
    `      anchor ${spikeAnchorId} (has a kit child — its childKitKeys differ from the anchor's)`,
  );
}
await runSpike('a — maxChildren(maxChildKitKeys) + childrenJoin(childKitKeys)', () =>
  db
    .pipeline()
    .collection('produtos')
    .where(spikePredicate())
    .define(
      pipelines.documentId(pipelines.field('__name__')).as('anchorId'),
      kitKeysDefine('anchorKitKeys'),
    )
    .sort(pipelines.ascending(pipelines.field('__name__')))
    .limit(2)
    .select(
      pipelines.variable('anchorId').as('anchorId'),
      // Printed alongside the children so the two key sets can be compared.
      pipelines.variable('anchorKitKeys').as('anchorKitKeys'),
      maxChildren().as('maxChildren'),
      childrenJoin().as('children'),
    ),
);

console.log('\n=== spike (c): define accepts a correlated-subquery expression ===');
await runSpike('c — define(childIds subquery) consumed as a variable', () =>
  db
    .pipeline()
    .collection('produtos')
    .where(anchorPredicate(null))
    .define(pipelines.documentId(pipelines.field('__name__')).as('anchorId'))
    .define(childIds().as('childIds'))
    .sort(pipelines.ascending(pipelines.field('__name__')))
    .limit(1)
    .select(
      pipelines.variable('anchorId').as('anchorId'),
      pipelines.variable('childIds').length().as('numChildren'),
    ),
);

/* ------------------- plan-text heuristics (see header) ---------------------- */

// NEGATIVE-first matching. Any of these anywhere in the evidence window is an
// outright FAIL — a scan marker beats any amount of positive-looking prose.
const SCAN_MARKER_RE =
  /no[\s_]?index|unindexed|collection[\s_-]?scan|scan[\s_-]?all|full[\s_-]?scan|table[\s_-]?scan|seq(?:uential)?[\s_-]?scan/i;
// A PASS needs a REAL seek/index-usage marker. The bare word "index" does not
// count: it shows up in prose ("index recommended", field names, …).
const INDEX_USE_RE = /seek|index(?:es)?[\s_-]?used|index[\s_-]?range/i;

// Windowed evidence check: gather ±3 lines around every line matching
// `fieldRe`; FAIL on any scan marker in those windows, then require a positive
// seek/index-used marker. The printed windows are the real gate.
function checkTarget(label, plan, fieldRe) {
  const lines = plan.split('\n');
  const windows = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!fieldRe.test(lines[i])) continue;
    windows.push(lines.slice(Math.max(0, i - 3), i + 4).join('\n'));
  }
  console.log(`\n--- ${label} (${fieldRe}) ---`);
  if (windows.length === 0) {
    fail(`${label}: plan text never mentions ${fieldRe} — no index evidence`);
    return;
  }
  for (const w of windows) console.log(w, '\n   ···');
  const joined = windows.join('\n');
  const scan = joined.match(SCAN_MARKER_RE);
  if (scan != null) {
    fail(`${label}: scan marker "${scan[0]}" near ${fieldRe} — NOT riding an index`);
    return;
  }
  if (!INDEX_USE_RE.test(joined)) {
    fail(`${label}: no seek / index-used / index-range marker near ${fieldRe} — likely scanning`);
    return;
  }
  console.log(`PASS  ${label}: index evidence present`);
}

/** Which declared twin did an array predicate ride? Reads the field's lines. */
function reportArrayIndexForm(label, plan, fieldRe) {
  const fieldLines = plan
    .split('\n')
    .filter((l) => fieldRe.test(l))
    .join('\n');
  const form = /contains/i.test(fieldLines)
    ? 'CONTAINS'
    : /asc/i.test(fieldLines)
      ? 'ASC'
      : 'UNKNOWN (read the plan lines above)';
  console.log(`spike (b): ${label} index form used → ${form}`);
}

/* --------------- main gate: incremental page 1, explain-analyze ------------- */

console.log('\n=== fetchStockFamilies page 1 (incremental) — explain analyze ===');
const nowMs = Date.now();
const incrementalSnap = await buildFamiliesPipeline({
  changedSinceMs: nowMs - 24 * 3_600_000,
  vendaCutoffUs: (nowMs - 30 * 24 * 3_600_000) * 1000,
  afterAnchorId: null,
}).execute({ explainOptions: { mode: 'analyze', outputFormat: 'text' } });

const plan = incrementalSnap.explainStats?.text ?? '';
console.log(`rows returned: ${incrementalSnap.results.length}`);
console.log('\n----- FULL PLAN (page 1, incremental) -----\n');
console.log(plan);
if (plan.trim() === '') {
  fail('incremental page-1 explainStats.text is empty — nothing proven');
} else {
  const planScan = plan.match(SCAN_MARKER_RE);
  if (planScan != null) {
    fail(`plan text reports "${planScan[0]}" somewhere — inspect the plan above`);
  }
  checkTarget('anchors scan (produtos)', plan, /paiId|integracoesComProduto/);
  checkTarget('estoques parentId join', plan, /parentId|depositoOuterRef/);
  checkTarget('pedidos sales probe', plan, /itensIds/);

  // Spike (b), BOTH array predicates: each has a CONTAINS twin and an ASC twin
  // declared in firestore.indexes.json. Keep the form reported here and drop
  // the loser in a follow-up.
  console.log('');
  reportArrayIndexForm('pedidos itensIds (sales probe)', plan, /itensIds/);
  reportArrayIndexForm(
    'produtos integracoesComProduto (anchor scan)',
    plan,
    /integracoesComProduto/,
  );
}

/* ------------- daily-mode PAGE 2: keyset over computed filter --------------- */

let afterAnchorId =
  incrementalSnap.results.length > 0
    ? incrementalSnap.results[incrementalSnap.results.length - 1].data().anchorId
    : null;
if (typeof afterAnchorId !== 'string' || afterAnchorId === '') {
  // No survivor on page 1 — any anchor id works as a keyset cursor: the plan
  // shape, not the row contents, is what this call proves.
  const snap = await db.collection('produtos').where('paiId', '==', null).limit(1).get();
  afterAnchorId = snap.docs[0]?.id ?? null;
}

/** One page-2 (keyset) run in daily mode under explain-analyze. */
async function explainDailyPage2(label, changedSinceMs) {
  const snap = await buildFamiliesPipeline({
    changedSinceMs,
    vendaCutoffUs: null, // daily sweep skips the pedidos probe entirely
    afterAnchorId,
  }).execute({ explainOptions: { mode: 'analyze', outputFormat: 'text' } });
  const dailyPlan = snap.explainStats?.text ?? '';
  console.log(`rows returned: ${snap.results.length} (after ${afterAnchorId})`);
  console.log(`\n----- FULL PLAN (page 2, daily — ${label}) -----\n`);
  console.log(dailyPlan);
  if (dailyPlan.trim() === '') {
    fail(`daily page-2 (${label}) explainStats.text is empty — nothing proven`);
  }
}

if (afterAnchorId == null) {
  fail('no produto anchor found to build the page-2 keyset cursor — seed staging');
} else {
  // (1) The SHIPPED daily predicate — janelaDoSweep('daily'): a flat 24h
  // lookback minus the 20s overlap. This is the plan that actually runs at
  // 02:07, in the keyset-over-computed-filter cost regime the docblock warns
  // about.
  console.log(
    '\n=== fetchStockFamilies page 2 (daily, SHIPPED window = now − 24h − 20s) — explain analyze ===',
  );
  await explainDailyPage2(
    'shipped 24h window, keyset-over-computed-filter regime',
    nowMs - DAILY_WINDOW_MS - WINDOW_OVERLAP_MS,
  );

  // (2) Worst case, clearly labeled: force-all (`changedSinceMs = -1`) makes
  // EVERY anchor survive the S4 computed filter. NOT a shipped predicate — it
  // just shows the plan when the filter selects nothing away. Same bounded
  // page (CHECK_PAGE_LIMIT anchors), so the extra analyze run is cheap.
  console.log(
    '\n=== fetchStockFamilies page 2 (daily, WORST CASE changedSinceMs = -1 — not shipped) ===',
  );
  await explainDailyPage2('worst case: force-all, every anchor survives S4', -1);
}

/* --------------------------------- verdict ---------------------------------- */

if (failures.length > 0) {
  console.error(`\n❌ ${failures.length} check(s) FAILED:`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    'deploy firestore.indexes.json, re-run, and READ the printed plans before merging PR C',
  );
  process.exit(1);
}
console.log('\n✅ all checks passed — now READ the plans above before merging PR C');
process.exit(0);
