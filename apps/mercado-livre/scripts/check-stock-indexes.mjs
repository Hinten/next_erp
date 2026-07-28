/* eslint-disable no-console, no-restricted-syntax, no-restricted-imports -- standalone staging CLI: mirrors THE query verbatim; defineAdminCollection handles have no pipeline surface and the app's admin singleton needs Next env */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import * as pipelines from '@google-cloud/firestore/pipelines';

// ⚠️ BLOCKING pre-merge gate for Step 10 PR C — run MANUALLY against staging
// (agents never run firebase; index deploy is a coordinated human step).
//
// Live proof that `fetchStockFamilies` AND the sold-ids pre-pass
// (`fetchSoldProdutoIds`) in lib/marketplace/estoquePlan.ts ride the declared
// indexes instead of silently full-scanning: this Firestore Enterprise
// edition auto-creates NO indexes, an unindexed subquery scans its collection
// ONCE PER OUTER ROW, and Enterprise bills data scanned. Pipelines have no
// `.explain()`; their explain rides `execute({ explainOptions: { mode:
// 'analyze', outputFormat: 'text' } })` → `snapshot.explainStats.text`
// (firestore-pipelines skill §6).
//
// ⚠️ COST, honestly: `analyze` EXECUTES the query and Enterprise bills DATA
// SCANNED, which the limits here do NOT bound — CHECK_PAGE_LIMIT (default 5)
// and CHECK_SOLD_IDS_LIMIT (default 1000) cap OUTPUT ROWS, and rows are
// discarded only AFTER the scan that produced them. The widened retries make
// this worse on purpose: they LOWER the cutoff (changedSinceMs = -1,
// cutoffUs = 0) so that more rows survive, which means more data scanned, not
// less. Concretely, the sold-ids run is bounded by the 30d window ONLY once
// an index actually serves `timestamp` as a range; while `timestamp` is
// residual (see 3.) the run reads EVERY saída pedido in the collection. Run
// this against staging, and expect the first run — before the new indexes
// deploy — to be the expensive one.
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
//     [Spike (c) — `define` accepting a correlated-subquery expression — was
//     PROVEN on staging 2026-07-28 (gate run 2) and then RETIRED together
//     with the `childIds` define it existed for: the sales signal no longer
//     lives inside THE query (see 3), so nothing consumes such a variable.]
//  2. The full incremental page-1 query (the fetchStockFamilies shape — the
//     per-anchor pedidos probe is GONE, see 3) under explain-analyze, judged
//     by the ACCESS-NODE heuristics below: the produtos anchors scan, the
//     estoques `parentId` equalAny join, and the two subcollection probes —
//     ownEstoque (`depositoOuterRef`) and the conta link join
//     (`contaOuterRef`) — which must ride the NEW COLLECTION-scope
//     `estoques(depositoOuterRef)` / `produtoMercadoLivre(contaOuterRef)`
//     indexes (subcollection() probes compile to CG-index scans with the
//     parent as a RESIDUAL filter when no COLLECTION-scope entry exists —
//     staging-proven, gate run 2). Until `firebase deploy --only
//     firestore:indexes` ships those two entries, both checks FAIL with a
//     clearly labeled PENDING-DEPLOY message — the FIRST run after this
//     rework is EXPECTED to fail exactly those two. Spike (b), retargeted to
//     `integracoesComProduto` only (the itensIds twins are gone from
//     firestore.indexes.json): reports which declared twin (CONTAINS vs ASC)
//     the anchors scan rode — keep the winner, drop the loser in a follow-up.
//  3. The sold-ids pre-pass (the fetchSoldProdutoIds shape). The sales signal
//     moved OUT of THE query (owner-approved): the per-anchor correlated
//     pedidos probe could never ride the itensIds indexes — its membership
//     list is a per-row VARIABLE (anchor + childIds), and the planner binds
//     variable candidate lists only as residual Filters (staging-proven,
//     gate run 2). It is now ONE uncorrelated pedidos pass per conta per
//     incremental sweep: `where ehSaida == true AND estado equalAny AND
//     timestamp >= cutoff`, `unnest(itensIds as pid)`, `distinct('pid')`,
//     `limit`. Explain-analyze asserts `ehSaida` AND `timestamp` are BOUND on
//     an index-identified access node — the NEW `pedidos(ehSaida ASC, estado
//     ASC, timestamp DESC)` entry, where all three predicates bind. A residual
//     `timestamp` is a FAIL, not an accepted cost: in run 2, with `pedidos
//     (ehSaida, timestamp DESC)` and `pedidos(ehSaida, estado, numero)` both
//     deployed, the planner took the `estado` index and left `timestamp` in a
//     residual Filter — unbounded over ALL time. Until the new entry deploys
//     this check FAILS PENDING-DEPLOY by design. When the run seeds, the
//     seeded paid saída pedido doubles as the correctness probe: its
//     `itensIds` anchor id MUST appear in the distinct output.
//  4. A daily-mode PAGE-2 call with the SHIPPED daily predicate
//     (`changedSinceMs = now − dailyWindowHours − overlap`, `afterAnchorId`
//     keyset) and prints its plan — the keyset-over-computed-filter cost
//     regime the docblock warns about. A second, clearly labeled run repeats
//     it with the worst-case force-all `changedSinceMs = -1` (every anchor
//     survives S4): same bounded page, so it is cheap, and it shows the plan
//     when the computed filter selects nothing away.
//
// ---- ACCESS-NODE heuristics (calibrated on the REAL staging plan text of
// gate run 2, 2026-07-28 — the explain format is not machine-stable, so the
// printed plans remain the actual gate: READ them before merging PR C). The
// plan is parsed into access-node blocks: a SequentialScan / SeekingScan /
// IndexSeek / TableScan / EntityScan / CollectionScan bullet — in fact ANY
// `• <Name>Scan` — plus its body up to the next `•` node bullet. Recognizing
// the identifier-LESS node names matters most: those are the scans that
// carry no `index:` line at all, and a parser that skips them cannot see the
// very failure it exists to catch.
//
// In THIS dialect the node NAME is NOT the verdict: a SequentialScan WITH an
// `index: /<name>@[id=…]` identifier AND a bounded `ranges:`/`constraints:`
// block IS an index range scan; IndexSeek / SeekingScan are seeks. A target
// check PASSES when an access node riding the expected index carries a real
// BOUND for the target predicate — judged by the field's own constraint line
// showing a value or range (`[null]`, `[true]`, `["depositos/…"]`, a numeric
// range like `[1,782,…L..+∞)`), an `equal_any` push-down on the node's
// `filter:` line, or a non-root `partition:` (partition-bounded subcollection
// access). The bare unbounded `(-∞..+∞)` line and the bare `ranges:` header do
// NOT count.
//
// ⚠️ `Filter` NODE vs node-local `filter:` line — the distinction the residual
// test turns on. A RESIDUAL filter is its own node (`• Filter` followed by an
// `expression:` line): rows were read, THEN discarded. A `filter:` line INSIDE
// an access node's body is a PUSH-DOWN into that scan and is healthy — it is
// how `equal_any($parentId, …)` rides the CG index. Only the former counts as
// "served residually".
//
// A check FAILS when the target predicate appears ONLY in residual `Filter`
// nodes, when the matching access node is identifier-less, or when every
// predicate field is completely unbounded. Negative-first spirit kept: an
// identifier-less access node ANYWHERE in a checked plan fails the gate
// outright — EXCEPT when it is partition-bounded (a non-root `partition:`),
// which is what a `subcollection()` probe with no `where` legitimately
// compiles to (the `variacaoMercadoLivre` varLinks probe: one child's
// subcollection, nothing to index). Those are printed as a NOTE instead.
// (These replace run 2's ±3-line window + scan-marker heuristics, which
// mis-read identifier-carrying range scans as failures.)
//
// SELF-SEEDED probe family: staging currently has NO produto with any
// `integracoesComProduto` linkage, so THE query's S1 predicate matches zero
// rows for every conta — and a zero-result execution carries NO explainStats
// (v8.6.0, probe-verified), so nothing above could ever print a plan. The
// gate therefore SELF-SEEDS a minimal namespaced probe family (depósito +
// component produto + linked anchor + kit variation child + ML link +
// variação link + paid saída pedido — every doc id prefixed
// `checkstock-<Date.now()>-`) whenever the discovery sampling finds no REAL
// linked anchor, or always under CHECK_SEED=1. The seeded child is a KIT
// whose `componentesKitKeys` (the component id) differ from the anchor's
// (null) — the exact configuration that makes spike (a)'s per-row binding
// visible in the printed values — every seeded estoque's `ultimaModificacao`
// is `now` so the explain runs return rows >= 1 under the SHIPPED windows
// (the widened-retry + honest zero-rows messages stay as fallbacks), and the
// seeded pedido is the sold-ids correctness probe (its `itensIds` anchor
// must surface in the distinct output). EVERY seeded doc is deleted in a
// `finally` (reverse creation order) even when checks fail or throw;
// anything left behind is logged AND fails the gate.
//
// Exits non-zero on any FAIL.
//
// Run (staging), AFTER `firebase deploy --only firestore:indexes` — note the
// two COLLECTION-scope entries (estoques(depositoOuterRef),
// produtoMercadoLivre(contaOuterRef)) and the sales-pass entry
// pedidos(ehSaida ASC, estado ASC, timestamp DESC) were JUST added to
// firestore.indexes.json; before they deploy, those three checks fail
// PENDING-DEPLOY by design. (A `variacaoMercadoLivre` entry was declared and
// then DROPPED: that probe has no `where`, and run 2 shows it already
// partition-bounded — an index there would serve no predicate.)
//
//   GOOGLE_APPLICATION_CREDENTIALS=<sa.json> \
//   FIREBASE_PROJECT_ID=veste-france-debug \
//   node apps/mercado-livre/scripts/check-stock-indexes.mjs
//
// Probe ids are auto-discovered with bounded reads; override with
// CHECK_INTEGRACAO_ID / CHECK_DEPOSITO_ID / CHECK_SPIKE_ANCHOR_ID (the
// spike-(a) family, see 1. above). CHECK_SEED=1 FORCES the self-seeded
// probe family even when discovery finds real linked anchors; seeding
// always relocates the depósito probe — and, unless overridden, spike (a)
// — to the seeded family. CHECK_SOLD_IDS_LIMIT bounds the sold-ids page.
// Targets the named `default` database (Enterprise — never `(default)`),
// overridable via FIREBASE_DATABASE_ID.
//
// ⚠️ KEEP IN SYNC with `fetchStockFamilies` AND `fetchSoldProdutoIds` in
// apps/mercado-livre/lib/marketplace/estoquePlan.ts — this script mirrors
// both in plain JS (the TS module is not importable from a .mjs script); a
// shape change there must be reflected here or the proof goes stale. (The
// mirror follows the owner-approved rework spec: no childIds define, no
// vendaProbe, no temVenda30d in THE query; the sales signal is the
// uncorrelated sold-ids pre-pass.)

const projectId = process.env.FIREBASE_PROJECT_ID ?? 'veste-france-debug';
const databaseId = process.env.FIREBASE_DATABASE_ID ?? 'default';
const pageLimitRaw = Number(process.env.CHECK_PAGE_LIMIT ?? '5');
const pageLimit = Number.isInteger(pageLimitRaw) && pageLimitRaw > 0 ? pageLimitRaw : 5;
const soldIdsLimitRaw = Number(process.env.CHECK_SOLD_IDS_LIMIT ?? '1000');
const soldIdsLimit =
  Number.isInteger(soldIdsLimitRaw) && soldIdsLimitRaw > 0 ? soldIdsLimitRaw : 1000;

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

// ⚠️ v8.6.0 SDK behavior (probe-verified): a pipeline execution that returns
// ZERO rows comes back with `explainStats` UNDEFINED even in analyze mode — a
// plan the explain runs below can never print. The discovery therefore picks
// an integracao that REAL anchors reference (and that anchor's depósito), so
// the explain executions return rows; a bare first-active-integracao pick can
// land on an e2e seed doc with no linked produtos and prove nothing.
let integracaoId = process.env.CHECK_INTEGRACAO_ID ?? null;
let depositoId = process.env.CHECK_DEPOSITO_ID ?? null;
// Whether the sampling loop below actually ran and found a REAL linked
// anchor — falling through to the last-resort fallbacks means the S1
// predicate matches nothing and the self-seed (next section) must kick in.
let discoveryRan = false;
let foundRealLinkedAnchor = false;
if (!integracaoId || !depositoId) {
  discoveryRan = true;
  const ativas = await db
    .collection('integracao')
    .where('tipo', '==', INTEGRACAO_TIPO_MERCADO_LIVRE)
    .where('ativo', '==', true)
    .limit(10)
    .get();
  const ativaIds = new Set(ativas.docs.map((d) => d.id));
  // Bounded sample of real anchors: find one whose integracoesComProduto hits
  // an active ML conta — that pair guarantees the S1 predicate matches rows.
  const anchors = await db
    .collection('produtos')
    .where('paiId', '==', null)
    .where('publicado', '==', true)
    .limit(25)
    .get();
  for (const doc of anchors.docs) {
    const integracoes = Array.isArray(doc.data().integracoesComProduto)
      ? doc.data().integracoesComProduto
      : [];
    const hit = integracoes.find((id) => ativaIds.has(id));
    if (!hit) continue;
    foundRealLinkedAnchor = true;
    integracaoId = integracaoId ?? hit;
    if (!depositoId) {
      const est = await doc.ref.collection('estoques').limit(1).get();
      const ref = est.docs[0]?.data()?.depositoOuterRef;
      if (typeof ref === 'string' && ref !== '') depositoId = ref.split('/').pop();
    }
    if (integracaoId && depositoId) break;
  }
  // Last-resort fallbacks (may hit seed docs — the zero-rows note above applies).
  if (!integracaoId) integracaoId = ativas.docs[0]?.id ?? null;
  if (!depositoId) {
    const snap = await db.collection('depositos').limit(1).get();
    depositoId = snap.docs[0]?.id ?? null;
  }
}
/* ------------------------ self-seeded probe family -------------------------- */

// Namespace prefix of every doc the seed creates — unique per run, grep-able.
const SEED_PREFIX = 'checkstock-' + Date.now();

// Spike-(a) anchor: env override first; the seed (below) pins it to the
// seeded anchor when active; otherwise the bounded kit-search before the
// spike section fills it.
let spikeAnchorId = process.env.CHECK_SPIKE_ANCHOR_ID ?? null;

// Seed when FORCED (CHECK_SEED=1) or when the discovery sampling ran and
// found NO real linked anchor (fell through to the last-resort fallbacks):
// then the S1 predicate matches zero rows for every conta, and zero-result
// executions carry no explainStats (header) — the gate would prove nothing.
const shouldSeed = process.env.CHECK_SEED === '1' || (discoveryRan && !foundRealLinkedAnchor);
if (shouldSeed) {
  // No integracao doc is ever joined — THE query only string-compares the
  // seeded docs' contaOuterRef / integracoesComProduto — so a synthetic id
  // still works when staging has no active ML integracao at all.
  if (integracaoId == null) integracaoId = `${SEED_PREFIX}-conta`;
  // The probe family's estoques live at the seeded depósito — always override.
  depositoId = `${SEED_PREFIX}-dep`;
  if (spikeAnchorId == null) spikeAnchorId = `${SEED_PREFIX}-anchor`;
  console.log(
    `SEEDING namespaced probe family (staging has no linked produtos) — docs ` +
      `prefixed ${SEED_PREFIX}, cleaned up at exit` +
      (process.env.CHECK_SEED === '1' ? ' [forced via CHECK_SEED=1]' : ''),
  );
}

if (!integracaoId || !depositoId) {
  console.error(
    'no active ML integracao and/or deposito found — seed staging or pass ' +
      'CHECK_INTEGRACAO_ID / CHECK_DEPOSITO_ID explicitly',
  );
  process.exit(1);
}
console.log(`probes: integracao/${integracaoId}, depositos/${depositoId}, pageLimit ${pageLimit}`);

// Every doc ref seedProbeData creates, in CREATION order — cleanupProbeData
// (called from the outer `finally`) deletes them in reverse.
const seedRefs = [];

/**
 * Create the minimal probe family every join of THE query hits (doc ids all
 * prefixed `${SEED_PREFIX}-`): a depósito, a non-anchor COMPONENT produto
 * (`paiId: null, publicado: false`), an ANCHOR produto linked to the conta,
 * a variation CHILD that is a KIT over the component — its
 * `componentesKitKeys` differ from the anchor's (null), the configuration
 * that makes spike (a)'s per-row binding visible — the anchor's
 * `produtoMercadoLivre` link, the child's `variacaoMercadoLivre` link, and a
 * paid saída pedido on the anchor (`timestamp` in µS, the pedido wire unit)
 * — the sold-ids pass correctness probe: its `itensIds` anchor id must
 * appear in the distinct output. Estoques sit at the deterministic
 * `est-<produtoId>-<depositoId>` ids (makeEstoqueUid) with
 * `ultimaModificacao = now`, so the SHIPPED windows match them. Refs are
 * pushed BEFORE each write: a failed set still gets a delete attempt
 * (deleting a nonexistent doc is a no-op).
 */
async function seedProbeData() {
  const now = Date.now();
  const depId = `${SEED_PREFIX}-dep`;
  const compId = `${SEED_PREFIX}-comp`;
  const anchorId = `${SEED_PREFIX}-anchor`;
  const childId = `${SEED_PREFIX}-child`;
  const linkId = `${SEED_PREFIX}-link`;
  const produtos = db.collection('produtos');
  const estoqueDoc = (produtoId, quantidade) => [
    produtos.doc(produtoId).collection('estoques').doc(`est-${produtoId}-${depId}`),
    {
      parentId: produtoId,
      depositoOuterRef: `documents/depositos/${depId}`,
      quantidade,
      quantidadeReservada: 2,
      ultimaModificacao: now,
    },
  ];
  const docs = [
    [db.collection('depositos').doc(depId), { nome: 'checkstock probe' }],
    [produtos.doc(compId), { paiId: null, publicado: false, nome: 'checkstock probe component' }],
    estoqueDoc(compId, 10),
    [
      produtos.doc(anchorId),
      {
        paiId: null,
        publicado: true,
        ehKit: false,
        ehKitVirtual: false,
        integracoesComProduto: [integracaoId],
        componentesKitKeys: null,
        componentesKit: null,
        nome: 'checkstock anchor',
        timestamp: now,
      },
    ],
    estoqueDoc(anchorId, 7),
    [
      produtos.doc(childId),
      {
        paiId: anchorId,
        publicado: true,
        ehKit: true,
        ehKitVirtual: false,
        componentesKit: { [compId]: { quantidade: 2, limitarEstoque: true, timestamp: now } },
        componentesKitKeys: [compId],
        nome: 'checkstock child kit',
        timestamp: now,
      },
    ],
    estoqueDoc(childId, 4),
    [
      produtos.doc(anchorId).collection('produtoMercadoLivre').doc(linkId),
      {
        id: 'MLB000CHECK',
        contaOuterRef: `documents/integracao/${integracaoId}`,
        estado: 'p',
        status: 'active',
        sub_status: [],
        isUserProductModel: false,
      },
    ],
    [
      produtos.doc(childId).collection('variacaoMercadoLivre').doc(`${SEED_PREFIX}-vlink`),
      {
        itemId: 'MLB000CHECKV',
        id: 12345,
        produtoMercadoLivreOuterRef: `documents/produtos/${anchorId}/produtoMercadoLivre/${linkId}`,
      },
    ],
    [
      db.collection('pedidos').doc(`${SEED_PREFIX}-ped`),
      // Pedido `timestamp` is µS at rest (estoquePlan.ts module doc).
      { ehSaida: true, estado: 'pago', itensIds: [anchorId], timestamp: now * 1000, itens: {} },
    ],
  ];
  for (const [ref, data] of docs) {
    seedRefs.push(ref); // BEFORE the write — a failed set still gets a delete attempt
    await ref.set(data);
  }
  console.log(`seeded ${seedRefs.length} probe doc(s) (prefix ${SEED_PREFIX})`);
}

/** Delete every seeded doc in REVERSE creation order — leftovers FAIL the gate. */
async function cleanupProbeData() {
  if (seedRefs.length === 0) return;
  let deleted = 0;
  const leftovers = [];
  for (const ref of [...seedRefs].reverse()) {
    try {
      await ref.delete();
      deleted += 1;
    } catch (err) {
      if (!isGrpcCodedError(err)) throw err;
      leftovers.push(`${ref.path} — ${err.message}`);
    }
  }
  console.log(`\ncleanup: deleted ${deleted}/${seedRefs.length} seeded probe doc(s)`);
  for (const left of leftovers) console.error(`cleanup: LEFT BEHIND ${left}`);
  if (leftovers.length > 0) {
    fail(
      `cleanup left ${leftovers.length} seeded doc(s) behind — delete them ` +
        `manually (prefix ${SEED_PREFIX})`,
    );
  }
}

/* ---- THE query, mirrored from estoquePlan.ts (keep-in-sync note above) ----- */
/* No childIds define, no vendaProbe, no temVenda30d — the sales signal is the
   uncorrelated sold-ids pre-pass (mirrored after this section).              */

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

function buildFamiliesPipeline({ changedSinceMs, afterAnchorId }) {
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
    );
}

/* ------ the sold-ids pre-pass, mirrored from fetchSoldProdutoIds ----------- */

// ONE uncorrelated pedidos pass per conta per incremental sweep (header 3.):
// where ehSaida + estado equalAny + timestamp >= cutoff, unnest itensIds,
// distinct pid, limit. No per-anchor correlation — nothing here is a variable.
const buildSoldIdsPipeline = (cutoffUs) =>
  db
    .pipeline()
    .collection('pedidos')
    .where(
      pipelines.and(
        pipelines.equal(pipelines.field('ehSaida'), true),
        pipelines.field('estado').equalAny([...ESTADOS_VENDA]),
        pipelines.field('timestamp').greaterThanOrEqual(cutoffUs),
      ),
    )
    .unnest(pipelines.field('itensIds').as('pid'))
    .distinct('pid')
    .limit(soldIdsLimit);

/* -- everything below runs under try/finally so the seed ALWAYS cleans up ---- */

try {
  if (shouldSeed) await seedProbeData();

  /* --------------------------------- spike a --------------------------------- */

  // The spike is bounded to <= 2 rows and PRINTS every returned row: a nested
  // `define` that silently binds to the OUTER row still executes, so only the
  // VALUES expose it. (Spike (c) ran here until 2026-07-28 — staging-proven,
  // then retired with the childIds probe it existed for; see the header.)
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
  // anchor. Bounded read (10 docs). Skipped when CHECK_SPIKE_ANCHOR_ID was
  // given or the seed already pinned the seeded anchor (which IS such a family).
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

  /* ---------------- access-node heuristics (see header) ----------------------- */

  // The completely-unbounded range line — `(-∞..+∞)` — never counts as a bound;
  // a half-bounded range (`[1,234L..+∞)`, a timestamp cutoff) DOES.
  const UNBOUNDED_RE = /\(-(?:∞|inf)\s*\.\.\s*\+?(?:∞|inf)\)/i;

  // A NUMERIC constraint bound: `[1,782,652,331,060,000L..+∞)`, `[1234L]`,
  // `(-1..500L]`. Anchored at the `|----` marker and shape-matched, never
  // digit-matched: `["depositos/checkstock-1785244325954-dep"]` is full of
  // digits, and the keyset bound `(EntityRef[…]..oid(000…))` ends in a
  // parenthesised number — neither may read as a timestamp range.
  const NUMERIC_BOUND_RE = /^\|-+\s*[[(]\s*-?[\d,]+L?\s*(?:\.\.|[\])])/;

  /**
   * Parse the plan into access-node blocks: a SequentialScan / SeekingScan /
   * IndexSeek / TableScan / EntityScan / CollectionScan bullet — plus ANY
   * other `• <Name>Scan`, so a node type this dialect has not shown us yet is
   * still SEEN rather than silently skipped — with every body line up to the
   * next `•` node bullet. The identifier-less names are the point: a
   * `TableScan` carries no `index:` line at all (staging run 2 emits one for
   * the varLinks probe), and a parser blind to it cannot report a raw scan.
   * Extracted per node: the `index:`/`identifier:` line carrying `@[id = …]`
   * (SequentialScan/SeekingScan spell it `index:`, IndexSeek `identifier:`),
   * the `partition:` value, the `filter:` push-down line, and the constraint
   * VALUE lines (`|----…`) under the `ranges:`/`constraints:` header —
   * `boundedLines` keeps only the ones that are not `(-∞..+∞)`.
   */
  function parseAccessNodes(plan) {
    const lines = plan.split('\n');
    const nodes = [];
    for (let i = 0; i < lines.length; i += 1) {
      const m = lines[i].match(
        /•\s+(SequentialScan|SeekingScan|IndexSeek|TableScan|EntityScan|CollectionScan|\w*Scan)\b/,
      );
      if (m == null) continue;
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (/•\s+\w/.test(lines[j])) {
          end = j;
          break;
        }
      }
      const block = lines.slice(i + 1, end);
      const idLine = block.find((l) => /\b(?:index|identifier):\s*\S.*@\[id\s*=/.test(l)) ?? null;
      const identifier =
        idLine == null ? null : idLine.replace(/^.*?\b(?:index|identifier):\s*/, '').trim();
      const partitionLine = block.find((l) => /\bpartition:\s*\S/.test(l)) ?? null;
      const partition =
        partitionLine == null ? null : partitionLine.replace(/^.*?\bpartition:\s*/, '').trim();
      // TableScan names its target with `kind:` instead of an index — printed
      // so an identifier-less node still says WHAT it scanned.
      const kindLine = block.find((l) => /\bkind:\s*\S/.test(l)) ?? null;
      const kind = kindLine == null ? null : kindLine.replace(/^.*?\bkind:\s*/, '').trim();
      const filterLine = block.find((l) => /\bfilter:\s*\(/.test(l)) ?? null;
      const filter = filterLine == null ? null : filterLine.replace(/^.*?\bfilter:\s*/, '').trim();
      const boundLines = [];
      let inConstraints = false;
      for (const l of block) {
        if (/\b(?:ranges|constraints):/.test(l)) {
          inConstraints = true;
          continue;
        }
        if (!inConstraints) continue;
        if (/Execution:/.test(l) || l.replace(/[|\s]/g, '') === '') {
          inConstraints = false;
          continue;
        }
        if (l.includes('|----')) boundLines.push(l.slice(l.indexOf('|----')));
      }
      nodes.push({
        type: m[1],
        identifier,
        kind,
        partition,
        filter,
        boundLines,
        boundedLines: boundLines.filter((l) => !UNBOUNDED_RE.test(l)),
      });
    }
    return nodes;
  }

  /** Printed-plan honesty: show exactly what each judged node carries. */
  function printNode(n) {
    console.log(`  • ${n.type}`);
    console.log(
      `      index: ${n.identifier ?? `(NO IDENTIFIER${n.kind ? `, kind ${n.kind}` : ''})`}`,
    );
    if (n.partition != null) console.log(`      partition: ${n.partition}`);
    for (const l of n.boundLines) console.log(`      ${l}`);
    if (n.filter != null) console.log(`      filter: ${n.filter}`);
  }

  /** Dedupe identically-shaped nodes for printing (plans repeat subquery nodes). */
  function uniqueNodes(list) {
    const seen = new Set();
    const out = [];
    for (const n of list) {
      const key = `${n.type}|${n.identifier}|${n.kind}|${n.filter}|${n.boundLines.join(';')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(n);
    }
    return out;
  }

  /**
   * Does the target predicate show up in a RESIDUAL `Filter` NODE — rows read
   * and then thrown away? Only `• Filter` blocks count, and only their
   * `expression:` bodies. A node-local `filter:` line is the OPPOSITE finding:
   * it is a push-down INTO an access node (that is how `equal_any($parentId,
   * …)` rides the CG index), so counting it as residual would condemn the
   * healthy plan. Blocks run from the `• Filter` bullet to the next `•` bullet
   * or the node's `Execution:` stats, whichever comes first.
   */
  function predicateInResidualFilters(plan, predicateRe) {
    const lines = plan.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (!/•\s+Filter\b/.test(lines[i])) continue;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (/•\s+\w/.test(lines[j]) || /\bExecution:/.test(lines[j])) break;
        if (/\bexpression:\s/.test(lines[j]) && predicateRe.test(lines[j])) return true;
      }
    }
    return false;
  }

  // Negative-first: an identifier-less access node ANYWHERE is a raw full
  // scan — UNLESS it is partition-bounded. A `subcollection()` probe with no
  // `where` (the varLinks join) compiles to a `TableScan` with a non-root
  // `partition:`: it reads one parent's subcollection and there is no
  // predicate an index could serve, so it is reported, not failed.
  function failIdentifierlessScans(label, nodes) {
    for (const n of uniqueNodes(nodes.filter((x) => x.identifier == null))) {
      printNode(n);
      if (n.partition != null && n.partition !== '/') {
        console.log(
          `NOTE  ${label}: identifier-less ${n.type} is partition-bounded (${n.partition}) — ` +
            `a subcollection probe with no predicate to index; not a full scan`,
        );
        continue;
      }
      fail(`${label}: identifier-less ${n.type} in the plan — a raw full scan`);
    }
  }

  /** The "declared but not deployed yet" diagnosis, shared by every NEW entry. */
  const pendingDeployHint = (entry) =>
    `the ${entry} entry was just added to firestore.indexes.json and is ` +
    `NOT deployed to staging yet — run \`firebase deploy --only firestore:indexes\` and ` +
    `re-run this gate (the FIRST run after this rework is EXPECTED to fail this check)`;

  /**
   * One target check (header heuristics): PASS when an access node whose
   * identifier matches `indexRe` yields a non-null `boundOf(node)` detail.
   * FAIL otherwise, diagnosing: bound-less nodes on the right index →
   * unbounded/residual; no node on the right index → `pendingDeploy` message
   * when given (the NEW entries), else residual-only vs never-mentioned.
   * `fallbackRe` prints what the probe rides TODAY.
   */
  function checkTarget({
    label,
    nodes,
    plan,
    indexRe,
    boundOf,
    predicateRe,
    pendingDeploy,
    fallbackRe,
  }) {
    console.log(`\n--- ${label} ---`);
    const relevant = nodes.filter((n) => n.identifier != null && indexRe.test(n.identifier));
    if (relevant.length === 0 && fallbackRe != null) {
      const riding = uniqueNodes(
        nodes.filter((n) => n.identifier != null && fallbackRe.test(n.identifier)),
      );
      if (riding.length > 0) {
        console.log(`  no access node rides ${indexRe}; the probe currently rides:`);
        for (const n of riding) printNode(n);
      }
    }
    for (const n of uniqueNodes(relevant)) printNode(n);
    const passDetail = relevant.map((n) => boundOf(n)).find((d) => d != null) ?? null;
    if (passDetail != null) {
      console.log(`PASS  ${label}: ${passDetail}`);
      return;
    }
    if (relevant.length > 0) {
      fail(
        `${label}: access node(s) ride ${relevant[0].identifier} but carry NO bound for the ` +
          `target predicate (unbounded / residual-only) — read the node(s) above` +
          (pendingDeploy != null ? `. ${pendingDeploy}` : ''),
      );
      return;
    }
    if (pendingDeploy != null) {
      fail(`${label}: PENDING DEPLOY — ${pendingDeploy}`);
      return;
    }
    if (predicateInResidualFilters(plan, predicateRe)) {
      fail(
        `${label}: target predicate ${predicateRe} served ONLY by residual Filter nodes — ` +
          `NOT riding an index`,
      );
      return;
    }
    fail(
      `${label}: no access node matches ${indexRe} and ${predicateRe} never appears in the ` +
        `plan — nothing proven`,
    );
  }

  /** Spike (b), retargeted: which integracoesComProduto twin did the anchors ride? */
  function reportIntegracoesIndexForm(nodes) {
    const anchor = nodes.find(
      (n) => n.identifier != null && /^\/produtos \(paiId ASC, publicado/.test(n.identifier),
    );
    if (anchor == null) {
      console.log('spike (b): anchors access node not found — form UNKNOWN (read the plan)');
      return;
    }
    const m = anchor.identifier.match(/integracoesComProduto\s+([A-Z_]+)/);
    console.log(
      `spike (b): produtos integracoesComProduto index form used → ` +
        (m != null
          ? `${m[1]} — keep this twin, drop the other in a follow-up`
          : 'NOT IN THE RIDDEN INDEX (arrayContains served residually — read the plan above)'),
    );
  }

  /* --------------- main gate: incremental page 1, explain-analyze ------------- */

  console.log('\n=== fetchStockFamilies page 1 (incremental) — explain analyze ===');
  const nowMs = Date.now();
  let incrementalSnap = await buildFamiliesPipeline({
    changedSinceMs: nowMs - 24 * 3_600_000,
    afterAnchorId: null,
  }).execute({ explainOptions: { mode: 'analyze', outputFormat: 'text' } });

  // ⚠️ v8.6.0: an execution returning ZERO rows carries NO explainStats at all
  // (probe-verified) — a quiet staging window would prove nothing. Retry once
  // with the S4 constant widened to -1: the STAGE SHAPE (and therefore the
  // index proof) is identical; only the window constant differs. Labeled.
  let incrementalLabel = 'shipped 24h window';
  if (incrementalSnap.results.length === 0 && incrementalSnap.explainStats === undefined) {
    console.log(
      '0 rows in the shipped window → SDK returns no explainStats; retrying with ' +
        'changedSinceMs = -1 (same stage shape — index proof unaffected)',
    );
    incrementalLabel = 'widened window (-1) — 0 rows in the shipped one';
    incrementalSnap = await buildFamiliesPipeline({
      changedSinceMs: -1,
      afterAnchorId: null,
    }).execute({ explainOptions: { mode: 'analyze', outputFormat: 'text' } });
  }

  const plan = incrementalSnap.explainStats?.text ?? '';
  console.log(`rows returned: ${incrementalSnap.results.length} (${incrementalLabel})`);
  console.log('\n----- FULL PLAN (page 1, incremental) -----\n');
  console.log(plan);
  if (plan.trim() === '') {
    fail(
      incrementalSnap.results.length === 0 && incrementalSnap.explainStats === undefined
        ? 'incremental page-1: 0 rows even force-all → the v8.6.0 SDK returns NO ' +
            'explainStats on empty results (probe-verified) — nothing proven. The ' +
            'probe conta has no matching anchors at all: point CHECK_INTEGRACAO_ID ' +
            '/ CHECK_DEPOSITO_ID at a conta with real linked produtos, then re-run'
        : 'incremental page-1 explainStats.text is empty — nothing proven',
    );
  } else {
    const nodes = parseAccessNodes(plan);
    failIdentifierlessScans('page-1 plan', nodes);

    checkTarget({
      label: 'anchors scan (produtos paiId + publicado)',
      nodes,
      plan,
      // Require `publicado` in the identifier: the children-join seeks ride
      // `/produtos (paiId ASC, nome ASC)` and would only add noise here.
      indexRe: /^\/produtos \(paiId ASC, publicado/,
      predicateRe: /\$paiId|\$publicado/,
      boundOf: (n) => {
        const hasNull = n.boundedLines.some((l) => l.includes('[null]'));
        const hasTrue = n.boundedLines.some((l) => l.includes('[true]'));
        return hasNull && hasTrue
          ? `paiId [null] + publicado [true] bounds on ${n.identifier}`
          : null;
      },
    });

    checkTarget({
      label: 'estoques parentId equalAny join (compEstoques, CG index)',
      nodes,
      plan,
      indexRe: /^\*\*\/estoques \(parentId/,
      predicateRe: /equal_any\(\$parentId/,
      // The bare `(-∞..+∞)` parentId range is NOT a bound; the equal_any
      // push-down on the node's own filter line IS (header heuristics).
      boundOf: (n) =>
        n.filter != null && /equal_any\(\$parentId/.test(n.filter)
          ? `parentId equal_any push-down on ${n.identifier}`
          : null,
    });

    checkTarget({
      label: 'ownEstoque depositoOuterRef probe (NEW COLLECTION-scope index)',
      nodes,
      plan,
      indexRe: /^\/estoques \(depositoOuterRef/,
      fallbackRe: /\/estoques \(/,
      predicateRe: /\$depositoOuterRef/,
      pendingDeploy: pendingDeployHint('COLLECTION-scope estoques(depositoOuterRef)'),
      boundOf: (n) => {
        const valueBound = n.boundedLines.some((l) => l.includes('depositos/'));
        const filterBound = n.filter != null && /depositoOuterRef/.test(n.filter);
        const partitionBound = n.partition != null && n.partition !== '/';
        if (valueBound) return `depositoOuterRef value bound on ${n.identifier}`;
        if (partitionBound) return `partition-bounded (${n.partition}) on ${n.identifier}`;
        if (filterBound) return `depositoOuterRef push-down on ${n.identifier}`;
        return null;
      },
    });

    checkTarget({
      label: 'produtoMercadoLivre contaOuterRef link probe (NEW COLLECTION-scope index)',
      nodes,
      plan,
      indexRe: /^\/produtoMercadoLivre \(contaOuterRef/,
      fallbackRe: /\/produtoMercadoLivre \(/,
      predicateRe: /\$contaOuterRef/,
      pendingDeploy: pendingDeployHint('COLLECTION-scope produtoMercadoLivre(contaOuterRef)'),
      boundOf: (n) => {
        const valueBound = n.boundedLines.some((l) => l.includes('integracao/'));
        const filterBound = n.filter != null && /contaOuterRef/.test(n.filter);
        const partitionBound = n.partition != null && n.partition !== '/';
        if (valueBound) return `contaOuterRef value bound on ${n.identifier}`;
        if (partitionBound) return `partition-bounded (${n.partition}) on ${n.identifier}`;
        if (filterBound) return `contaOuterRef push-down on ${n.identifier}`;
        return null;
      },
    });

    console.log('');
    reportIntegracoesIndexForm(nodes);
  }

  /* -------------- sold-ids pre-pass (fetchSoldProdutoIds mirror) -------------- */

  console.log('\n=== sold-ids pre-pass (fetchSoldProdutoIds mirror) — explain analyze ===');
  const soldCutoffUs = (nowMs - 30 * 24 * 3_600_000) * 1000; // atividadeLookbackDays() default
  let soldSnap = await buildSoldIdsPipeline(soldCutoffUs).execute({
    explainOptions: { mode: 'analyze', outputFormat: 'text' },
  });
  let soldLabel = 'shipped 30d cutoff';
  if (soldSnap.results.length === 0 && soldSnap.explainStats === undefined) {
    console.log(
      '0 rows in the 30d cutoff → SDK returns no explainStats; retrying with ' +
        'cutoffUs = 0 (same stage shape — index proof unaffected)',
    );
    soldLabel = 'widened cutoff (0) — 0 rows in the shipped one';
    soldSnap = await buildSoldIdsPipeline(0).execute({
      explainOptions: { mode: 'analyze', outputFormat: 'text' },
    });
  }
  const soldPlan = soldSnap.explainStats?.text ?? '';
  console.log(`distinct pids returned: ${soldSnap.results.length} (${soldLabel})`);
  console.log('\n----- FULL PLAN (sold-ids pre-pass) -----\n');
  console.log(soldPlan);
  if (soldPlan.trim() === '') {
    fail(
      soldSnap.results.length === 0 && soldSnap.explainStats === undefined
        ? 'sold-ids pre-pass: 0 rows even with cutoff 0 → no explainStats (v8.6.0, ' +
            'probe-verified) — nothing proven. Staging has no ESTADOS_VENDA saída ' +
            'pedidos at all; seed one (CHECK_SEED=1) and re-run'
        : 'sold-ids pre-pass explainStats.text is empty — nothing proven',
    );
  } else {
    const soldNodes = parseAccessNodes(soldPlan);
    failIdentifierlessScans('sold-ids plan', soldNodes);
    checkTarget({
      label: 'sold-ids: pedidos ehSaida + timestamp BOUND on one index',
      nodes: soldNodes,
      plan: soldPlan,
      // The NEW three-field entry is the target; the two-field
      // pedidos(ehSaida, timestamp DESC) would also bind both predicates and
      // is accepted. What is NOT accepted is pedidos(ehSaida, estado, numero)
      // — run 2's actual pick, which leaves `timestamp` residual. `[^)]*`
      // (not `.*`) keeps the match inside the index's own field list.
      indexRe: /^\/pedidos \((?:ehSaida[^)]*estado[^)]*timestamp|ehSaida[^)]*timestamp)/,
      fallbackRe: /\/pedidos \(/,
      predicateRe: /\$ehSaida|\$timestamp/,
      pendingDeploy: pendingDeployHint('pedidos(ehSaida ASC, estado ASC, timestamp DESC)'),
      boundOf: (n) => {
        const ehSaidaBound = n.boundedLines.some((l) => l.includes('[true]'));
        // The timestamp cutoff shows as a numeric (half-)range constraint —
        // `[1,782,652,331,060,000L..+∞)`. String bounds (`["pago"]`,
        // `["depositos/…-1785…"]`) carry digits too, so match the numeric
        // SHAPE, never a bare digit.
        const timestampBound = n.boundedLines.some((l) => NUMERIC_BOUND_RE.test(l));
        return ehSaidaBound && timestampBound
          ? `ehSaida [true] + timestamp range bounds on ${n.identifier}`
          : null;
      },
    });
    // With the new entry all three predicates bind. A residual `estado` is no
    // longer "accepted by design" — it means the planner did NOT take it.
    console.log(
      predicateInResidualFilters(soldPlan, /\$estado|equal_any\(\$estado/)
        ? 'NOTE  sold-ids: `estado` equalAny is served by a residual Filter NODE — the ' +
            'planner did not take pedidos(ehSaida, estado, timestamp DESC). Harmless ' +
            'ONLY if the check above passed (timestamp bound ⇒ the 30d window still ' +
            'bounds the scan); read the plan either way'
        : 'NOTE  sold-ids: `estado` is not residual — it rides the index, as intended',
    );
  }

  // Seeded-mode correctness probe: the seeded paid saída pedido's itensIds
  // anchor MUST surface in the distinct output (header 3.).
  if (shouldSeed) {
    const seededAnchorId = `${SEED_PREFIX}-anchor`;
    const pids = soldSnap.results.map((r) => r.data()?.pid).filter((p) => typeof p === 'string');
    if (pids.includes(seededAnchorId)) {
      console.log(
        `PASS  sold-ids: seeded pedido's anchor id ${seededAnchorId} present in the ` +
          `distinct output (${pids.length} pid(s) on this page)`,
      );
    } else {
      fail(
        `sold-ids: the seeded paid saída pedido (itensIds [${seededAnchorId}]) did NOT ` +
          `surface in the distinct output — ${pids.length} pid(s) returned; raise ` +
          `CHECK_SOLD_IDS_LIMIT (${soldIdsLimit}) or read the plan above`,
      );
    }
  }

  /* ------------- daily-mode PAGE 2: keyset over computed filter --------------- */

  let afterAnchorId =
    incrementalSnap.results.length > 0
      ? incrementalSnap.results[incrementalSnap.results.length - 1].data().anchorId
      : null;
  if (shouldSeed) {
    // Seeded mode: the seeded family is the only GUARANTEED S1 match, and page
    // 1 already returned it — a cursor at (or after) the seeded anchor would
    // select zero rows, and zero rows carry no explainStats (header). `-0`
    // sorts BELOW `-anchor` ('0' < 'a'), so the keyset predicate still admits
    // the seeded anchor: the page-2 plan SHAPE (keyset over the computed
    // filter) is what these runs prove, not the row contents.
    afterAnchorId = `${SEED_PREFIX}-0`;
    console.log(
      `seeded mode: page-2 keyset cursor pinned to ${afterAnchorId} (sorts below the seeded anchor)`,
    );
  } else if (typeof afterAnchorId !== 'string' || afterAnchorId === '') {
    // No survivor on page 1 — any anchor id works as a keyset cursor: the plan
    // shape, not the row contents, is what this call proves.
    const snap = await db.collection('produtos').where('paiId', '==', null).limit(1).get();
    afterAnchorId = snap.docs[0]?.id ?? null;
  }

  /** One page-2 (keyset) run in daily mode under explain-analyze. */
  async function explainDailyPage2(label, changedSinceMs) {
    const snap = await buildFamiliesPipeline({
      changedSinceMs,
      afterAnchorId,
    }).execute({ explainOptions: { mode: 'analyze', outputFormat: 'text' } });
    const dailyPlan = snap.explainStats?.text ?? '';
    console.log(`rows returned: ${snap.results.length} (after ${afterAnchorId})`);
    console.log(`\n----- FULL PLAN (page 2, daily — ${label}) -----\n`);
    console.log(dailyPlan);
    if (dailyPlan.trim() === '') {
      fail(
        snap.results.length === 0 && snap.explainStats === undefined
          ? `daily page-2 (${label}): 0 rows → the v8.6.0 SDK returns NO explainStats ` +
              'on empty results (probe-verified) — nothing proven. Point ' +
              'CHECK_INTEGRACAO_ID / CHECK_DEPOSITO_ID at a conta with real ' +
              'linked produtos and stock movement, then re-run'
          : `daily page-2 (${label}) explainStats.text is empty — nothing proven`,
      );
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
} finally {
  // The seed must NEVER outlive the run — delete it even when a check failed
  // or a spike threw (the throw propagates after the cleanup completes).
  await cleanupProbeData();
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
