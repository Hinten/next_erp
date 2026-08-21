/* eslint-disable no-console, no-restricted-syntax, no-restricted-imports -- standalone staging CLI: mirrors THE query verbatim; defineAdminCollection handles have no pipeline surface and the app's admin singleton needs Next env */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import * as pipelines from '@google-cloud/firestore/pipelines';

// ⚠️ BLOCKING pre-merge gate for Step 10 PR C — run MANUALLY against staging
// (agents never run firebase; index deploy is a coordinated human step).
//
// Live proof that `fetchStockFamilies` AND the ledger pre-pass
// (`fetchMovimentosDaJanela`) in lib/marketplace/bulkEstoquePlan.ts ride the declared
// indexes instead of silently full-scanning: this Firestore Enterprise
// edition auto-creates NO indexes, an unindexed subquery scans its collection
// ONCE PER OUTER ROW, and Enterprise bills data scanned. Pipelines have no
// `.explain()`; their explain rides `execute({ explainOptions: { mode:
// 'analyze', outputFormat: 'text' } })` → `snapshot.explainStats.text`
// (firestore-pipelines skill §6).
//
// ⚠️ COST, honestly: `analyze` EXECUTES the query and Enterprise bills DATA
// SCANNED, which the limits here do NOT bound — CHECK_PAGE_LIMIT (default 5)
// caps OUTPUT ROWS, and rows are
// discarded only AFTER the scan that produced them. The widened retries make
// this worse on purpose: they LOWER the cutoff (changedSinceMs = -1,
// desdeMs = 0) so that more rows survive, which means more data scanned, not
// less. Concretely, the ledger run is bounded by its window ONLY once an index
// actually serves `timestamp` as a range; while `timestamp` is residual (see
// 3.) the run reads EVERY historicoEstoque row in the database — and an
// aggregate scans before it groups, so there is no output cap to hide behind.
// Run this against staging, and expect the first run — before the new indexes
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
//     firestore.indexes.json): reports the form the anchors scan rode.
//     Verdict ASC (#705) — the CONTAINS twin was dropped; the gate still
//     prints the form so a planner regression is visible.
//  3. The LEDGER pre-pass (the fetchMovimentosDaJanela shape). The sales
//     signal moved OUT of THE query (owner-approved) and then out of `pedidos`
//     entirely (ADR 0014). Two facts drove that. First, the per-anchor
//     correlated pedidos probe could never ride the itensIds indexes — its
//     membership list is a per-row VARIABLE (anchor + childIds), and the
//     planner binds variable candidate lists only as residual Filters
//     (staging-proven, gate run 2). Second, "did something sell" was the wrong
//     question: the sweep needs "did the PUBLISHED number change", which the
//     summable v2 ledger answers exactly and without the old 10 000-id cap.
//     It is now ONE uncorrelated `historicoEstoque` collection-group aggregate
//     per (window, depósito) per tick: `where timestamp >= desde AND depósito`,
//     grouped `sum(movimento)` / `sum(movimentoReservada)` plus the
//     `countIf(not(exists('movimento')))` fail-open counter, `groups:
//     ['parentId', 'depositoOuterRef']`. Explain-analyze asserts `timestamp` is
//     BOUND on an index-identified access node — the NEW
//     `historicoEstoque(timestamp, parentId, depositoOuterRef)`
//     COLLECTION_GROUP entry. A residual `timestamp` is a FAIL, not an accepted
//     cost: an aggregate scans before it groups, so an unbounded window reads
//     the whole ledger at Enterprise's per-byte price. The run additionally
//     NOTES whether `depositoOuterRef` came back as a residual Filter — served
//     but not covered, i.e. the aggregate is reading documents rather than
//     index entries. Until the new entry deploys this check FAILS
//     PENDING-DEPLOY by design.
//  5. SPIKE: anchor-predicate A/B (#431). THE question this spike exists to
//     answer is whether the stock sweep can stop reading the DEPRECATED
//     `integracoesComProduto` array. Shape A (shipped) puts the conta term IN
//     THE INDEX RANGE — a pre-filter. Shape B drops it, moves the link join
//     UP into an `addFields` and filters on `links.length() > 0` — a
//     post-filter, which on Enterprise does NOT reduce data scanned. B is not
//     an EXTRA probe: the same array is the gate AND the payload, so S6 reuses
//     it. The extra cost is therefore exactly "one partition-bounded link
//     probe per published parent that is NOT on this conta, per tick", and
//     the multiplier is the printed ratio. B is viable ONLY if the
//     `links.length() > 0` filter prunes BEFORE the three estoque
//     `addFields` — stages may be reordered, and this run is how we find out.
//     Reuses page 1's already-captured plan for A, so it costs ONE extra
//     analyze execution. Purely INFORMATIONAL: it never fails the gate.
//     ⚠️ That one execution can be the expensive one — B's index range is
//     EVERY published parent, which is precisely the number being measured.
//     Set CHECK_ANCHOR_AB=0 to skip it.
//
//     ---- RESULT (staging run 2026-08-07, owner decision: KEEP shape A) ----
//     | metric              | A (shipped) | B (post-filter) |
//     |---------------------|-------------|-----------------|
//     | data bytes read     | 6.41 KiB    | 48.27 KiB  ×7.5 |
//     | entity rows scanned | 10          | 15         +5   |
//     | index rows scanned  | 16          | 16         —    |
//     | estoque probe nodes | 8 × 1 rec   | 8 × 1 rec  —    |
//     Sample ratio was 6 published parents : 1 on the conta.
//
//     What it PROVED: the `links.length() > 0` post-filter DOES prune before
//     the three estoque rollups — the per-node counters are identical, so the
//     expensive subqueries never fanned out. B's overhead is therefore exactly
//     the predicted one and nothing more: the anchor scan + one link probe per
//     published parent that is NOT on the conta. The `+5 entity rows` is
//     literally the 5 non-conta parents. Cost model confirmed:
//         B/A  ≈  published parents ÷ conta-linked anchors
//     (observed 7.5× against a 6.0 ratio — slightly above, because B also
//     materializes the link array for parents it then discards).
//
//     What it did NOT settle: the MAGNITUDE for produção. The run self-seeded
//     (discovery found no real linked anchor) on a 6-produto staging project;
//     produção is ~19k produtos. Plug the real ratio into the formula above.
//
//     ⚠️ Trap the run exposed: B rode `/produtos (paiId ASC, publicado ASC,
//     __key__ ASC)` — an index the #779 audit DELETED from
//     firestore.indexes.json, still present on staging as a leftover. B only
//     looked healthy BECAUSE of that stale index. Anyone reviving shape B must
//     re-declare it first, or B full-scans wherever the leftover is absent.
//
//     Decision: A stays. `integracoesComProduto` is kept as the pre-filter, and
//     the cluster is retired instead by moving its MAINTENANCE into a trigger
//     (#920) so `marketplace` + `marketplaceIds` + the stamping can still die
//     at the Flutter decommission. See #431 for the three locks.
//
//     ✅ DONE. #920 shipped: `onProdutoMercadoLivreLinkChanged` and
//     `onVariacaoMercadoLivreLinkChanged` are the array's sole writers, deriving
//     it from the link subcollections, so lock 2 (the `marketplace` coupling) is
//     broken and only the decommission date remains. The A/B section below is
//     kept as the RECORD of why shape A is permanent — re-run it if the
//     published-parents : conta-linked ratio ever shifts by an order of
//     magnitude, but do not treat the array as removable debt.
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
// two seeded `historicoEstoque` rows are the ledger correctness probe (the v2
// one must SUM, the legacy v1-shaped one must be COUNTED as unknown rather
// than silently ignored). EVERY seeded doc is deleted in a
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
// — to the seeded family. CHECK_ANCHOR_AB=0 skips the anchor-predicate A/B spike (5. above).
// Targets the named `default` database (Enterprise — never `(default)`),
// overridable via FIREBASE_DATABASE_ID.
//
// ⚠️ KEEP IN SYNC with `fetchStockFamilies` AND `fetchMovimentosDaJanela` in
// apps/mercado-livre/lib/marketplace/bulkEstoquePlan.ts — this script mirrors
// both in plain JS (the TS module is not importable from a .mjs script); a
// shape change there must be reflected here or the proof goes stale.
// ⚠️ The window filter deliberately has NO component arm (ADR 0014): a kit sale
// stamps the kit's own estoque doc, so `maxComp` was removed rather than being
// forgotten here. The sales signal is likewise gone — the `pedidos` sold-ids
// pass was replaced by the uncorrelated historicoEstoque ledger aggregate.

const projectId = process.env.FIREBASE_PROJECT_ID ?? 'veste-france-debug';
const databaseId = process.env.FIREBASE_DATABASE_ID ?? 'default';
const pageLimitRaw = Number(process.env.CHECK_PAGE_LIMIT ?? '5');
const pageLimit = Number.isInteger(pageLimitRaw) && pageLimitRaw > 0 ? pageLimitRaw : 5;
// The A/B spike (header 5.) runs by default; '0' opts out of its one extra
// analyze execution — the one whose cost IS the measurement.
const runAnchorAb = (process.env.CHECK_ANCHOR_AB ?? '1') !== '0';

// Mirrors the shipped daily window: `dailyWindowHours()` (24) minus
// `windowOverlapSec()` (20) — bulkEstoquePlan.ts defaults, janelaDoSweep('daily').
const DAILY_WINDOW_MS = 24 * 3_600_000;
const WINDOW_OVERLAP_MS = 20_000;

// Mirrors INTEGRACAO_TIPO.mercadoLivre (packages/schemas).
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
 * `produtoMercadoLivre` link, the child's `variacaoMercadoLivre` link, and
 * TWO `historicoEstoque` rows under the anchor's estoque (`timestamp` in mS,
 * the ledger wire unit) — the pre-pass correctness probe: one v2 row that
 * must SUM, one legacy v1-shaped row that must land in `nDesconhecido`.
 * Estoques sit at the deterministic
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
  const historicoDocs = (produtoId, ts) => {
    const hist = produtos
      .doc(produtoId)
      .collection('estoques')
      .doc(`est-${produtoId}-${depId}`)
      .collection('historicoEstoque');
    const chaves = { parentId: produtoId, depositoOuterRef: `documents/depositos/${depId}` };
    return [
      // v2: summable — contributes -3 / -1 to the group.
      [
        hist.doc(`${SEED_PREFIX}-hist-v2`),
        { ...chaves, timestamp: ts, movimento: -3, movimentoReservada: -1, saldo: 7 },
      ],
      // v1 (legacy Flutter shape): NO `movimento` key — must land in
      // `nDesconhecido`, never be read as "moved nothing".
      [
        hist.doc(`${SEED_PREFIX}-hist-v1`),
        { ...chaves, timestamp: ts, quantidade: -2, ehBalanco: false },
      ],
    ];
  };
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
        userProductId: 'MLBU000CHECK',
      },
    ],
    [
      produtos.doc(childId).collection('variacaoMercadoLivre').doc(`${SEED_PREFIX}-vlink`),
      {
        itemId: 'MLB000CHECKV',
        id: 12345,
        userProductId: 'MLBU000CHECKV',
        produtoMercadoLivreOuterRef: `documents/produtos/${anchorId}/produtoMercadoLivre/${linkId}`,
      },
    ],
    // Two ledger rows under the ANCHOR's estoque — the pre-pass correctness
    // probe. `historicoEstoque.timestamp` is MILLIseconds (schema v2), unlike
    // the pedido/estado trails. The second row is deliberately shaped like a
    // legacy Flutter v1 write (no `movimento` key at all): it is the only way
    // to prove, live, that `countIf(not(exists('movimento')))` is accepted by
    // the backend and actually counts — pipelines never run in the emulator,
    // so this gate is the sole coverage for the fail-open accumulator.
    ...historicoDocs(anchorId, now),
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

/* ---- THE query, mirrored from bulkEstoquePlan.ts (keep-in-sync note above) ----- */
/* No childIds define, no vendaProbe, no temVenda30d — the change signal is the
   uncorrelated historicoEstoque ledger aggregate (mirrored after this
   section), and no component rollup: sibling kits are a monthly concern
   (ADR 0014).                                                               */

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

const kitKeysDefine = (name) =>
  pipelines.coalesce(pipelines.field('componentesKitKeys'), pipelines.array([])).as(name);

// Children's OWN estoques only — the component arm is gone (ADR 0014), which
// also removes this subquery's nested `define`.
const maxChildren = () =>
  db
    .pipeline()
    .collection('produtos')
    .where(pipelines.equal(pipelines.field('paiId'), pipelines.variable('anchorId')))
    .select(ownEstoqueMax().as('m'))
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
      'userProductId',
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
        .select(
          'itemId',
          'id',
          'produtoMercadoLivreOuterRef',
          'status',
          'sub_status',
          'userProductId',
          pipelines.documentId(pipelines.field('__name__')).as('varLinkDocId'),
        )
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
    .addFields(ownEstoqueMax().as('maxOwn'), maxChildren().as('maxChildren'))
    .where(
      pipelines.greaterThan(
        pipelines.coalesce(
          pipelines.logicalMaximum(pipelines.field('maxOwn'), pipelines.field('maxChildren')),
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

/* ---- SPIKE shape B: the same query with the conta term moved OUT of the
   index range (#431, header 5.). NOT shipped — this exists only to be
   explained. Two deliberate differences from `buildFamiliesPipeline`:

     1. S1 loses `arrayContains(integracoesComProduto, conta)`, so the index
        range widens from "anchors on this conta" to EVERY published parent;
     2. `linkJoin()` moves from S6 up into an `addFields`, and
        `where(links.length() > 0)` becomes the conta filter. The SAME array
        is then re-`select`ed in S6 — B pays ONE link probe per row, not two,
        which is why this is a post-filter swap and not an added join.

   Everything else — the define, the three MAX rollups, the window HAVING, the
   sort/limit and the projection — is byte-identical to the shipped shape, so
   the plans are comparable line for line.                                    */

function anchorPredicateNoConta(afterAnchorId) {
  const paiTerm = pipelines.equal(pipelines.field('paiId'), null);
  const publicadoTerm = pipelines.equal(pipelines.field('publicado'), true);
  if (afterAnchorId == null) return pipelines.and(paiTerm, publicadoTerm);
  return pipelines.and(
    paiTerm,
    publicadoTerm,
    pipelines.greaterThan(
      pipelines.field('__name__'),
      pipelines.constant(db.collection('produtos').doc(afterAnchorId)),
    ),
  );
}

function buildFamiliesPipelineLinkFirst({ changedSinceMs, afterAnchorId }) {
  return (
    db
      .pipeline()
      .collection('produtos')
      .where(anchorPredicateNoConta(afterAnchorId ?? null))
      .define(
        pipelines.documentId(pipelines.field('__name__')).as('anchorId'),
        kitKeysDefine('anchorKitKeys'),
      )
      // The conta gate, computed ONCE and reused by S6 below.
      .addFields(linkJoin().as('links'))
      .where(pipelines.greaterThan(pipelines.field('links').length(), 0))
      .addFields(ownEstoqueMax().as('maxOwn'), maxChildren().as('maxChildren'))
      .where(
        pipelines.greaterThan(
          pipelines.coalesce(
            pipelines.logicalMaximum(pipelines.field('maxOwn'), pipelines.field('maxChildren')),
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
        'timestamp',
        ownEstoque().as('estoque'),
        compEstoques('anchorKitKeys').as('componentEstoques'),
        // Already materialized by the addFields above — no second probe, and
        // `integracoesComProduto` is deliberately NOT projected: shape B must
        // prove it can build the whole payload without ever reading it.
        'links',
        childrenJoin().as('children'),
      )
  );
}

/* --- the ledger pre-pass, mirrored from fetchMovimentosDaJanela ------------ */

// ONE uncorrelated historicoEstoque aggregate per (window, depósito) per tick
// (header 3.): where timestamp >= desde AND depósito, grouped sum of the signed
// movements. No per-anchor correlation — nothing here is a variable.
//
// ⚠️ This one must be COVERED, not merely served: an aggregate without a
// covering index buffers every group in the 128 MiB budget and can
// RESOURCE_EXHAUSTED. The declared entry is
// `historicoEstoque(timestamp, parentId, depositoOuterRef)`, COLLECTION_GROUP.
const buildMovimentosPipeline = (desdeMs) =>
  db
    .pipeline()
    .collectionGroup('historicoEstoque')
    .where(pipelines.and(pipelines.field('timestamp').greaterThanOrEqual(desdeMs), depMatch()))
    .aggregate({
      accumulators: [
        pipelines.sum('movimento').as('dq'),
        pipelines.sum('movimentoReservada').as('dr'),
        pipelines.countIf(pipelines.not(pipelines.exists('movimento'))).as('nDesconhecido'),
      ],
      groups: ['parentId', 'depositoOuterRef'],
    });

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
      // Per-node `Execution:` stats. The A/B spike (header 5.) turns on these:
      // whether the `links.length() > 0` post-filter prunes BEFORE the estoque
      // rollups is not decidable from the printed TREE (it is a shape, not an
      // order) — but the estoque nodes' own execution counts say it outright.
      const execIdx = block.findIndex((l) => /\bExecution:/.test(l));
      const execution =
        execIdx === -1
          ? []
          : block
              .slice(execIdx)
              .map((l) => l.replace(/^[|\s]+/, '').trim())
              .filter((l) => l !== '');
      nodes.push({
        type: m[1],
        // Bullet position in the printed plan — 1-BASED, because that is how a
        // human counts lines in the plan text dumped above. `i` is a 0-based
        // array index; printing it raw is off by one (review catch on #890).
        line: i + 1,
        identifier,
        kind,
        partition,
        filter,
        boundLines,
        boundedLines: boundLines.filter((l) => !UNBOUNDED_RE.test(l)),
        execution,
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

  /**
   * Spike (b) report (verdict ASC, #705 — CONTAINS twin removed). Still
   * prints the ridden form so a planner regression back to residual-only or
   * a reintroduced CONTAINS index is visible in the gate log.
   */
  function reportIntegracoesIndexForm(nodes) {
    const anchor = nodes.find(
      (n) => n.identifier != null && /^\/produtos \(paiId ASC, publicado/.test(n.identifier),
    );
    if (anchor == null) {
      console.log('spike (b): anchors access node not found — form UNKNOWN (read the plan)');
      return;
    }
    const m = anchor.identifier.match(/integracoesComProduto\s+([A-Z_]+)/);
    if (m == null) {
      console.log(
        'spike (b): produtos integracoesComProduto index form used → ' +
          'NOT IN THE RIDDEN INDEX (arrayContains served residually — read the plan above)',
      );
      return;
    }
    const form = m[1];
    // ASCENDING from explain text; ASC is the documented short form.
    const ok = form === 'ASCENDING' || form === 'ASC';
    console.log(
      `spike (b): produtos integracoesComProduto index form used → ${form}` +
        (ok
          ? ' — ASC confirmed (#705, CONTAINS twin dropped)'
          : ' — UNEXPECTED (expected ASCENDING or ASC; re-check firestore.indexes.json / plan)'),
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
  /** Shape A's parsed nodes, reused by the A/B spike (header 5.). */
  let pageOneNodes = null;
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
    // Hoisted: the A/B spike (header 5.) reuses shape A's already-captured
    // plan, so it costs one extra execution instead of two.
    pageOneNodes = parseAccessNodes(plan);
    const nodes = pageOneNodes;
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

  /* ---- SPIKE: anchor-predicate A/B — can the sweep drop the array? (#431) ---- */

  // Informational ONLY: this section never calls fail(). It measures the one
  // thing that decides whether #431's stock half is unblockable, and prints a
  // verdict the reader can act on. See header 5.
  if (!runAnchorAb) {
    console.log('\n=== SPIKE: anchor predicate A/B (#431) — SKIPPED (CHECK_ANCHOR_AB=0) ===');
  } else if (pageOneNodes == null) {
    console.log(
      '\n=== SPIKE: anchor predicate A/B (#431) — SKIPPED ===\n' +
        'shape A produced no plan above, so there is nothing to compare against.',
    );
  } else {
    console.log('\n=== SPIKE: anchor predicate A/B (#431) — explain analyze ===');

    /* -- (i) the ratio. THIS is the multiplier B pays, and it is the whole
       cost question in one number. Both counts ride the existing
       produtos(paiId, publicado, integracoesComProduto, __name__) composite —
       the second as the full prefix, the first as its leading two fields. -- */
    let publishedParents = null;
    let contaAnchors = null;
    try {
      const base = db
        .collection('produtos')
        .where('paiId', '==', null)
        .where('publicado', '==', true);
      publishedParents = (await base.count().get()).data().count;
      contaAnchors = (
        await base.where('integracoesComProduto', 'array-contains', integracaoId).count().get()
      ).data().count;
    } catch (err) {
      if (!isGrpcCodedError(err)) throw err;
      console.log(`NOTE  ratio counts unavailable: ${err.message}`);
    }
    if (publishedParents != null && contaAnchors != null) {
      const ratio = contaAnchors === 0 ? null : publishedParents / contaAnchors;
      console.log(
        `\n--- the ratio (shape B's extra link probes per tick) ---\n` +
          `  published parents (B's index range):        ${publishedParents}\n` +
          `  of those, on conta ${integracaoId} (A's range): ${contaAnchors}\n` +
          `  B pays a link probe for the difference:     ${publishedParents - contaAnchors}` +
          // toPrecision, not toFixed: this is a ratio, not money — and the
          // repo's no-ad-hoc-money-rounding rule bans `.toFixed(2)` outright.
          (ratio == null ? '' : `  (×${ratio.toPrecision(3)} the rows A materializes)`),
      );
      console.log(
        '  ⚠️ `contaAnchors` counts the DENORM array, which is exactly the field under\n' +
          '     suspicion: an anchor with a live link but a stale array entry is missing\n' +
          '     from it (and is invisible to the shipped sweep today). Treat it as a\n' +
          '     LOWER bound on the truly-linked set, i.e. the ratio as an UPPER bound.',
      );
    }

    /* -- (ii) shape B under explain-analyze. One execution; same widened-retry
       fallback as page 1, because zero rows still carry no explainStats. -- */
    let abSnap = await buildFamiliesPipelineLinkFirst({
      changedSinceMs: nowMs - 24 * 3_600_000,
      afterAnchorId: null,
    }).execute({ explainOptions: { mode: 'analyze', outputFormat: 'text' } });
    let abLabel = 'shipped 24h window';
    if (abSnap.results.length === 0 && abSnap.explainStats === undefined) {
      abLabel = 'widened window (-1) — 0 rows in the shipped one';
      abSnap = await buildFamiliesPipelineLinkFirst({
        changedSinceMs: -1,
        afterAnchorId: null,
      }).execute({ explainOptions: { mode: 'analyze', outputFormat: 'text' } });
    }
    const abPlan = abSnap.explainStats?.text ?? '';
    console.log(`\nrows returned: ${abSnap.results.length} (${abLabel})`);
    console.log('\n----- FULL PLAN (shape B: link post-filter) -----\n');
    console.log(abPlan);

    if (abPlan.trim() === '') {
      console.log(
        'NOTE  shape B returned no plan (0 rows even force-all) — nothing measured. ' +
          'Point CHECK_INTEGRACAO_ID / CHECK_DEPOSITO_ID at a conta with real linked ' +
          'produtos, or run with CHECK_SEED=1.',
      );
    } else {
      const abNodes = parseAccessNodes(abPlan);

      // Correctness first: B must find the family through the LINK alone. In
      // seeded mode the seeded anchor is the guaranteed match, and the seed
      // gives it BOTH an array entry and a link — so a hit proves the link
      // path works, not that the array was consulted (B never projects it).
      if (shouldSeed) {
        const abIds = abSnap.results.map((r) => r.data()?.anchorId);
        console.log(
          abIds.includes(`${SEED_PREFIX}-anchor`)
            ? `\n  correctness: shape B found the seeded anchor WITHOUT the array term ✔`
            : `\n  correctness: shape B did NOT return the seeded anchor — read the plan ` +
                `(it returned ${JSON.stringify(abIds)})`,
        );
      }

      // The ordering question, answered by counters rather than by the tree.
      // If the post-filter prunes first, B's estoque nodes execute about as
      // often as A's; if the optimizer hoists the rollups, B's counts blow up
      // toward `publishedParents`.
      //
      // ⚠️ NOT `uniqueNodes` here. That dedupes on SHAPE
      // (type|identifier|kind|filter|bounds) and ignores `execution` — so two
      // estoque probes riding the same index with WILDLY different execution
      // counts collapse into one, and the survivor may be the cheap one. That
      // would hide the exact signal this section exists to read. Every node is
      // printed, in plan order. (Review catch on #890.)
      const estoqueNodes = (list) =>
        list.filter((n) => n.identifier != null && /estoques \(/.test(n.identifier));
      const printExec = (label, list) => {
        console.log(`\n  ${label}  (${list.length} node(s), no dedupe)`);
        if (list.length === 0) {
          console.log('    (no estoque access node in this plan)');
          return;
        }
        for (const n of list) {
          console.log(`    • line ${n.line}  ${n.type}  ${n.identifier}`);
          for (const l of n.execution) console.log(`        ${l}`);
          if (n.execution.length === 0) console.log('        (no Execution: stats on this node)');
        }
      };
      console.log('\n--- estoque-probe execution counters: A vs B ---');
      console.log(
        '  Read these side by side. Comparable counts ⇒ the link post-filter pruned\n' +
          '  BEFORE the rollups (B is viable). B much higher ⇒ the optimizer hoisted the\n' +
          '  rollups above the filter, and B pays the three estoque subqueries for every\n' +
          '  published parent — the one outcome that rules B out.',
      );
      printExec('A (shipped, conta term in the index range):', estoqueNodes(pageOneNodes));
      printExec('B (link post-filter):', estoqueNodes(abNodes));

      // Where the filter node actually sits, for the reader who wants the tree.
      const abLines = abPlan.split('\n');
      // `findIndex` is 0-based too — normalized to 1-based below, so both
      // numbers in this block are countable against the printed plan.
      const linksFilterIdx = abLines.findIndex(
        (l, i) =>
          /•\s+Filter\b/.test(l) &&
          abLines
            .slice(i + 1, i + 6)
            .some((b) => /\bexpression:/.test(b) && /links|array_length/i.test(b)),
      );
      const linksFilterLine = linksFilterIdx === -1 ? null : linksFilterIdx + 1;
      const firstEstoqueLine = abNodes
        .filter((n) => n.identifier != null && /estoques \(/.test(n.identifier))
        .map((n) => n.line)
        .sort((a, b) => a - b)[0];
      console.log(
        `\n  plan-text positions (a TREE, not an execution order — corroboration only):\n` +
          `    links post-filter node: ${linksFilterLine == null ? 'not found' : `line ${linksFilterLine}`}\n` +
          `    first estoque probe:    ${firstEstoqueLine == null ? 'not found' : `line ${firstEstoqueLine}`}`,
      );

      // Did B's anchors scan stay indexed at all? Losing the third field must
      // not cost the leading two.
      const abAnchor = uniqueNodes(
        abNodes.filter(
          (n) => n.identifier != null && /^\/produtos \(paiId ASC, publicado/.test(n.identifier),
        ),
      );
      console.log('\n  B anchors scan:');
      if (abAnchor.length === 0) {
        console.log(
          '    NOTE  no /produtos (paiId ASC, publicado …) access node — B did NOT ride the\n' +
            '          composite as a prefix. Read the plan; this alone rules B out.',
        );
      } else {
        for (const n of abAnchor) printNode(n);
      }

      console.log(
        '\n  VERDICT is yours to read off the three blocks above:\n' +
          '    • ratio near 1 AND B-counters ≈ A-counters ⇒ drop the array from BOTH\n' +
          '      planners (#431 stock half unblocked; precoPlan moves with it).\n' +
          '    • otherwise ⇒ keep the array as the pre-filter, and decide separately\n' +
          '      whether to re-point its maintenance to a link trigger so the other two\n' +
          '      arrays can still die at the Flutter decommission.',
      );
    }
  }

  /* ------------ ledger pre-pass (fetchMovimentosDaJanela mirror) ------------- */

  console.log('\n=== ledger pre-pass (fetchMovimentosDaJanela mirror) — explain analyze ===');
  const movDesdeMs = nowMs - 15 * 60_000 - 20_000; // the incremental window
  let movSnap = await buildMovimentosPipeline(movDesdeMs).execute({
    explainOptions: { mode: 'analyze', outputFormat: 'text' },
  });
  let movLabel = 'shipped 15min window';
  if (movSnap.results.length === 0 && movSnap.explainStats === undefined) {
    console.log(
      '0 rows in the 15min window → SDK returns no explainStats; retrying with ' +
        'desdeMs = 0 (same stage shape — index proof unaffected)',
    );
    movLabel = 'widened window (0) — 0 rows in the shipped one';
    movSnap = await buildMovimentosPipeline(0).execute({
      explainOptions: { mode: 'analyze', outputFormat: 'text' },
    });
  }
  const movPlan = movSnap.explainStats?.text ?? '';
  console.log(`groups returned: ${movSnap.results.length} (${movLabel})`);

  // Correctness probe (seeded runs only): the accumulators are the ONE part of
  // this design the emulator can never exercise. Assert the seeded anchor's
  // group both SUMS the v2 row and COUNTS the legacy one — a `nDesconhecido`
  // of 0 here would mean the fail-open counter is silently inert, which reads
  // in production as "nothing moved" on every Flutter-written movement.
  if (shouldSeed) {
    const grupo = movSnap.results
      .map((r) => r.data())
      .find((d) => d.parentId === `${SEED_PREFIX}-anchor`);
    if (!grupo) {
      fail(
        `ledger probe: no aggregate group for the seeded anchor ` +
          `(${SEED_PREFIX}-anchor) — the pre-pass would see its movement as absent`,
      );
    } else {
      console.log(`ledger probe group: ${JSON.stringify(grupo)}`);
      if (Number(grupo.dq) !== -3 || Number(grupo.dr) !== -1) {
        fail(
          `ledger probe: expected dq -3 / dr -1 from the seeded v2 row, got ${JSON.stringify(grupo)}`,
        );
      }
      if (Number(grupo.nDesconhecido) !== 1) {
        fail(
          `ledger probe: expected nDesconhecido 1 from the seeded legacy row, got ` +
            `${JSON.stringify(grupo.nDesconhecido)} — countIf(not(exists('movimento'))) ` +
            `is not counting, so a v1 row would be read as "moved nothing"`,
        );
      }
    }
  }
  console.log('\n----- FULL PLAN (ledger pre-pass) -----\n');
  console.log(movPlan);
  if (movPlan.trim() === '') {
    fail(
      movSnap.results.length === 0 && movSnap.explainStats === undefined
        ? 'ledger pre-pass: 0 rows even with desdeMs 0 → no explainStats (v8.6.0, ' +
            'probe-verified) — nothing proven. Staging has no historicoEstoque rows at ' +
            'this depósito; seed one (CHECK_SEED=1) and re-run'
        : 'ledger pre-pass explainStats.text is empty — nothing proven',
    );
  } else {
    const movNodes = parseAccessNodes(movPlan);
    failIdentifierlessScans('ledger plan', movNodes);
    checkTarget({
      label: 'ledger: historicoEstoque timestamp BOUND (the window actually bounds the scan)',
      nodes: movNodes,
      plan: movPlan,
      indexRe: /^\/historicoEstoque \(timestamp/,
      fallbackRe: /\/historicoEstoque \(/,
      predicateRe: /\$timestamp|\$parentId/,
      pendingDeploy: pendingDeployHint(
        'historicoEstoque(timestamp ASC, parentId ASC, depositoOuterRef ASC) [COLLECTION_GROUP]',
      ),
      boundOf: (n) =>
        n.boundedLines.some((l) => NUMERIC_BOUND_RE.test(l))
          ? `timestamp range bounds on ${n.identifier}`
          : null,
    });
    // ⚠️ The aggregate must be COVERED, not merely served: an uncovered one
    // buffers every group in the 128 MiB budget and can RESOURCE_EXHAUSTED.
    // A residual `depositoOuterRef` means the declared entry was not fully
    // taken, so the group keys are being read off the documents.
    console.log(
      predicateInResidualFilters(movPlan, /\$depositoOuterRef/)
        ? 'NOTE  ledger: `depositoOuterRef` is served by a residual Filter NODE — the ' +
            'planner did not take the full covering entry. The window still bounds the ' +
            'scan if the check above passed, but the aggregate is reading documents; ' +
            'read the plan before trusting it at catalogue scale'
        : 'NOTE  ledger: `depositoOuterRef` is not residual — the covering entry was taken',
    );
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
