/**
 * Mercado Livre **stock-sync compute core** (Step 10 PR A, produtos-first
 * rework) — the building blocks behind the 15-minute + 2AM stock sweeps
 * (PR C) and the `sendMercadoLivreStock` task handler (PR B). No scheduling,
 * no task enqueue and no ML API call lives here: this module DISCOVERS the
 * produto FAMILIES with stock movement (`fetchStockFamilies` — THE query),
 * fetches the sold produto ids once per conta per incremental sweep
 * (`fetchSoldProdutoIds` — the uncorrelated sales pre-pass), computes every
 * family member's send quantity at sweep time (`quantidadesDaFamilia`),
 * applies the incremental activity filter (`deveEnviarIncremental`) and turns
 * one family row into ready-to-enqueue send-task drafts (`buildSendTasks`).
 *
 * ---- Produtos-first joined discovery (the owner-approved redesign of the
 * first #678 cut, which ran two pipeline executions and re-read everything at
 * send time). The sweep template is the legacy BigQuery SQL
 * `.old/packages/canal_de_vendas/big_query/changed_estoque_big_query.sql`
 * (live copy inlined in `estoques.dart:394-529`): drive FROM the family
 * anchors (`paiId == null`), join estoques + ALL of the conta's
 * `produtoMercadoLivre` links (a produto can hold SEVERAL live listings on
 * ONE conta — the legacy sender loops every one, functions.dart:275-282, and
 * `buildSendTasks` emits tasks per listing) + the variation children
 * server-side in ONE pipeline execution per conta per sweep page, with a
 * minimal `select`, and hand the sender a payload it NEVER re-reads
 * produtos/estoques for.
 *
 * Owner decisions locked 2026-07-27:
 *  1. Sale estados = the `ESTADOS_VENDA` allow-list (emAnalise /
 *     emProcessamento / pago / finalizado / estornadoParcialmente).
 *  2. Standalone produtos (no children): the legacy query EXCLUDED the
 *     anchor's own estoque as a change trigger — deliberately FIXED here: the
 *     anchor's own estoque is a first-class trigger (`maxOwn` in S3/S4).
 *     Expect a one-time correction burst on the first post-deploy sweep.
 *  3. Retry staleness: tasks are sent VERBATIM (legacy parity, zero extra
 *     reads at send time). Quantities are computed once, at sweep time, and
 *     carried in the task payload; the send handler logs
 *     `ageMs = now − sweepComputedAtMs` on every send and the next sweep
 *     converges any staleness.
 *
 * Timestamp units: produto/estoque timestamps are MS since epoch; pedido
 * `timestamp` is µS (hence the sold-ids pass's `vendaCutoffUs`). Residual
 * risk: pre-µs-migration
 * pedidos still holding ms at rest silently miss the sales window — accepted,
 * bounded by the pedido µs migration having run. Residual risk 2: component
 * quantities depend on the `estoques.parentId` denorm (legal null at rest per
 * the schema) — all known writers set it (legacy Flutter models.dart:4301 +
 * aplicarEstoque / sincronizarEstoquePedido / usecases), but a null-parentId
 * estoque yields no join row and that component scores 0 (#238); staging
 * spot-check before the flag flips.
 *
 * ---- Index ledger (PR C declares the entries; Enterprise auto-creates NONE
 * — an unindexed predicate silently full-scans, billed by data scanned):
 *  - anchors (S1): rides BOTH declared twins for the array term —
 *    `produtos(paiId ASC, publicado ASC, integracoesComProduto ASC,
 *    __name__ ASC)` and `produtos(paiId ASC, publicado ASC,
 *    integracoesComProduto CONTAINS, __name__ ASC)`. Which of the two forms an
 *    `arrayContains` predicate actually seeks is spike (b)'s question: the
 *    staging gate PRINTS the ridden index, and the LOSER is dropped in a
 *    follow-up (they are declared together only so the gate can adjudicate).
 *    The bare `produtos(paiId ASC, publicado ASC, __name__ ASC)` prefix that
 *    used to sit alongside them was dropped by the #779 audit: every S1 call
 *    site also filters `integracoesComProduto`, so it was dead weight —
 *    either twin's leading two fields already serve it as a prefix;
 *  - estoque joins: `estoques(parentId ASC, depositoOuterRef ASC,
 *    ultimaModificacao ASC)` COLLECTION_GROUP — `parentId` carries the
 *    `equalAny` seek, `ultimaModificacao` covers the MAX branch;
 *  - subcollection() probes: two COLLECTION-scope entries —
 *    `estoques(depositoOuterRef ASC, ultimaModificacao ASC)` and
 *    `produtoMercadoLivre(contaOuterRef)`. The estoques entry widened past
 *    the bare `depositoOuterRef` PR C shipped (still fine for `ownEstoque`'s
 *    `select`) once the #779 audit found `ownEstoqueMax`'s
 *    `aggregate(maximum('ultimaModificacao'))` needed it too — same reason
 *    the COLLECTION_GROUP sibling above carries that trailing field.
 *    Staging explain evidence (gate run 2, 2026-07-28): with no
 *    COLLECTION-scope index a `subcollection()` probe carrying a WHERE
 *    compiles to a COLLECTION-GROUP index scan with the PARENT as a RESIDUAL
 *    filter (every family's subcollection docs scanned per row); with these
 *    entries the access is partition-bounded;
 *  - the `variacaoMercadoLivre` probe gets NO entry: it has no `where` at all,
 *    and the same run 2 plans show it already compiling to a partition-bounded
 *    `TableScan` over the one child's subcollection — an index would have no
 *    predicate to serve (a declared entry was dropped for exactly that reason);
 *  - children: the `paiId` equality rides the existing `produtos(paiId,
 *    nome)` index as a prefix;
 *  - sales pass (`fetchSoldProdutoIds` — NOT part of THE query): rides the NEW
 *    `pedidos(ehSaida ASC, estado ASC, timestamp DESC)` entry, where ALL
 *    THREE predicates bind. Do not assume a two-field index suffices: in run 2,
 *    with `pedidos(ehSaida, timestamp DESC)` AND `pedidos(ehSaida, estado,
 *    numero)` both deployed, the planner picked the `estado` one and left
 *    `timestamp` as a RESIDUAL filter — i.e. unbounded over ALL time, the
 *    opposite of the 30d window the pass is supposed to cost. The former
 *    per-anchor correlated pedidos probe (and its `itensIds` index twins) is
 *    GONE — see the fetchSoldProdutoIds docblock for why.
 * ⚠️ Explain-dialect note (the staging gate's plans, 2026-07-28): a node
 * named `SequentialScan` that carries an `index: /<name>@[id=…]` identifier
 * AND bounded `ranges:`/`constraints:` IS an index range scan — healthy
 * (IndexSeek/SeekingScan are seeks). A `TableScan` carries no index
 * identifier at all and is healthy only when `partition:` is non-root. Only
 * unbounded/identifier-less scans over the root partition, or target
 * predicates served ONLY by residual `Filter` NODES (`• Filter` +
 * `expression:` — a node-local `filter:` line is a push-down INTO the access
 * node, which is the good case), indicate a missing index.
 * The 128 MiB materialization ceiling spans the WHOLE query including every
 * joined document — hence every subquery `select`s a minimal field set.
 *
 * Two API spikes stay open until PR C finalizes the query shape (TODO
 * markers at the call sites): (a) nested `define` inside BOTH the maxChildren
 * rollup and the S6 childrenJoin subqueries (and the same-name question — the
 * two sites deliberately bind different variable names); (b) whether
 * pipelines seek CONTAINS or ASCENDING index entries for the
 * `integracoesComProduto` array predicate. Spike (c) — "does `define` accept
 * a correlated-subquery expression?" — is RETIRED: proven live on staging
 * 2026-07-28 (a subquery-valued `define` executes fine), then made moot the
 * same day when the per-anchor sales probe (the `childIds` variable's only
 * consumer) moved out of THE query into the uncorrelated
 * `fetchSoldProdutoIds` pre-pass; nothing defines a subquery anymore.
 *
 * ---- Legacy parity anchors (`.old/packages/canais_de_venda`, verified
 * 2026-07-24):
 *  - Kit quantity = **component-min only** (`GetEstoquesResponse.disponivel`,
 *    estoques.dart:94-131): min over components with `limitarEstoque` of
 *    `disponivel / quantidade`, skip `limitarEstoque == false`, clamp >= 0,
 *    floor. This module WRAPS `kitEstoqueDisponivel` (#238 semantics: a
 *    component with no resolvable estoque counts as 0, never silently skipped;
 *    null = no component constrains → own stock stands alone) — it never
 *    reimplements the min. Own-stock inclusion exists only as an opt-in hook
 *    (`MERCADO_LIVRE_STOCK_KIT_INCLUI_PROPRIO`, default OFF — Lucas's call).
 *  - The `available_quantity` clamp 0..99999 was centralized in the legacy API
 *    layer (api.dart:1182-1203) → `quantidadeParaEnvio` floors then clamps
 *    `ESTOQUE_MIN..MERCADO_LIVRE_STOCK_MAX`.
 *  - `ehKitVirtual` produtos NEVER get stock sent (functions.dart:286-289) →
 *    `quantidadeParaEnvio` returns null and `buildSendTasks` skips
 *    `'kit-virtual'`.
 *  - vendido30dias = a LEFT JOIN against a 30d order-items aggregate ON the
 *    SOLD produto id (kit sales attribute to the KIT, matching the legacy
 *    `produtoIdNoItem`) → here ONE UNCORRELATED pedidos pre-pass per conta
 *    per incremental sweep (`fetchSoldProdutoIds`) whose Set of sold produto
 *    ids feeds `deveEnviarIncremental` (a family "sold" when the ANCHOR or
 *    ANY child id is in the Set — legacy hasSales = own or any child), never
 *    a `historicoEstoque` probe (kit sales only move COMPONENT estoques —
 *    the probe on the produto's own history never flagged kits, the
 *    #678-review bug).
 *
 * Listing-status whitelist (developers.mercadolivre.com.br, read 2026-07-24 —
 * replaces the dropped legacy `statusProdMarketplace.podeEnviarEstoque` gate):
 * documented statuses are active · paused(out_of_stock | paused_by_seller |
 * picture_downloading_pending) · under_review(warning | waiting_for_patch |
 * held | pending_documentation | forbidden) · closed(expired | deleted |
 * suspended | freezed) · inactive · payment_required. ML auto-pauses a listing
 * to `paused/out_of_stock` at qty=0 and auto-reactivates it when stock
 * returns, so stock is sent iff `status === 'active'` OR (`'paused'` AND
 * `sub_status` includes `'out_of_stock'`). Anything outside the documented set
 * is `desconhecido` — never sent, loudly logged (status tracking, per Lucas).
 *
 * ---- Legacy-authored links (#780): `status`/`sub_status` arrived with the
 * `items` status-sync (#440); the Flutter app authoring the same docs during
 * dual-run never wrote them, so EVERY pre-cutover link has `status == null`.
 * Gating those out would make the flag flip a total, silent stock outage — a
 * listing that never changes never fires `items`, so it never self-heals. They
 * are therefore sent OPTIMISTICALLY, because the send is its own backfill: a
 * successful `PUT /items` returns the listing and `estoqueSend` merges the
 * fresh `estado`/`status`/`sub_status` back onto the link, so each legacy
 * listing resolves to real data in ONE send at ZERO extra API cost — cheaper
 * than any `GET`-based pre-flip pass, which would pay one call per listing for
 * exactly the majority that needed none, and would need to be ordered against
 * the flag flip. The rejected minority is trimmed by `ESTADOS_TERMINAIS_LEGADO`
 * (below), which is what makes the convergence terminate.
 *
 * ---- Config: business tunables read `process.env` LAZILY (at call time,
 * never at module load — mirrors `orderBackfill`'s flag check) so functions
 * cold starts and the unit tests both see current values; pure mechanics stay
 * code constants.
 */
import type { Firestore } from 'firebase-admin/firestore';
// Pipeline expression builders live in the `/pipelines` subpath (admin
// `@google-cloud/firestore` v8). Namespace import — the module is `export =`d.
import * as pipelines from '@google-cloud/firestore/pipelines';
import {
  type ComponentesKit,
  ESTADO_PUBLICACAO_ML,
  estoqueDisponivel,
  kitEstoqueDisponivel,
  toOuterRef,
} from '@delfrance/schemas';
import {
  produtoCollection,
  produtoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';

/* ------------------------------ configuration ----------------------------- */

/** The env flag gating the whole stock sync — ON only when it is exactly `'1'`. */
export const STOCK_SYNC_FLAG_ENV = 'MERCADO_LIVRE_STOCK_SYNC_ENABLED';

/** Cloud Tasks queue name for the stock send tasks (PR B's `onTaskDispatched`). */
export const MERCADO_LIVRE_STOCK_SEND_QUEUE = 'sendMercadoLivreStock';

/**
 * In-task retry cap — the Cloud Tasks `retryConfig.maxAttempts` (kept in sync;
 * `sendStock.ts` reads THIS constant, and `estoqueSend.stockSendMaxAttempts.test.ts`
 * pins the two together). Mirrors `MASS_IMPORT_MAX_ATTEMPTS` /
 * `PRICE_SYNC_MAX_ATTEMPTS`: the 4xx branch only writes its terminal state on
 * the LAST attempt, so the handler must know the cap the queue was deployed with.
 */
export const STOCK_SEND_MAX_ATTEMPTS = 3;

/** Lower clamp of every quantity sent to ML (legacy clamp >= 0). */
export const ESTOQUE_MIN = 0;

/**
 * Pedido `estado` values that count as "had sales" for the incremental
 * sweep's 30-day activity filter — the owner-locked ALLOW-LIST (2026-07-27).
 * The sweep passes it into `fetchSoldProdutoIds` (kept as an arg so tests pin
 * the exact list wired into the pedidos pre-pass).
 */
export const ESTADOS_VENDA = [
  'emAnalise',
  'emProcessamento',
  'pago',
  'finalizado',
  'estornadoParcialmente',
] as const;

/** Max jitter (seconds) added when a paused conta's task re-enqueues itself (PR B). */
export const PAUSE_REENQUEUE_JITTER_MAX_S = 30;

/**
 * Read a non-negative integer tunable from `process.env` — LAZILY, at call
 * time, so tests can mutate the env and a value change needs only a redeploy,
 * never a code edit. Unset/blank/non-integer/negative → `fallback`.
 */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** Read a boolean env flag — true only when the value is exactly `'1'`. */
export function envFlag(name: string): boolean {
  return process.env[name] === '1';
}

/** Master flag — the sweeps and the send handler are no-ops while OFF. */
export function isStockSyncEnabled(): boolean {
  return envFlag(STOCK_SYNC_FLAG_ENV);
}

/** Incremental sweep fallback window (minutes) when a conta has no cursor yet. */
export function incrementalWindowMin(): number {
  return envInt('MERCADO_LIVRE_STOCK_INCREMENTAL_WINDOW_MIN', 15);
}

/** Slack (seconds) re-covered behind every window start (legacy `interval+20s`). */
export function windowOverlapSec(): number {
  return envInt('MERCADO_LIVRE_STOCK_WINDOW_OVERLAP_SEC', 20);
}

/** Cap (hours) on how far back a stale cursor may pull the incremental window. */
export function cursorMaxLookbackHours(): number {
  return envInt('MERCADO_LIVRE_STOCK_CURSOR_MAX_LOOKBACK_H', 24);
}

/** The 2AM daily sweep's full window (hours). */
export function dailyWindowHours(): number {
  return envInt('MERCADO_LIVRE_STOCK_DAILY_WINDOW_H', 24);
}

/** Sales/created activity-filter lookback (days) for the incremental sweep. */
export function atividadeLookbackDays(): number {
  return envInt('MERCADO_LIVRE_STOCK_ATIVIDADE_LOOKBACK_D', 30);
}

/**
 * Cap on the `fetchSoldProdutoIds` distinct-ids result. Hitting it means some
 * sold ids are MISSING from the Set (see the truncation note on that
 * function) — the pass warns loudly and the daily sweep corrects.
 */
export function soldIdsLimit(): number {
  return envInt('MERCADO_LIVRE_STOCK_SOLD_IDS_LIMIT', 10_000);
}

/**
 * Low-stock override threshold: a changed produto with available stock below
 * this is sent even without recent sales/creation (legacy `disponivel < 5`).
 */
export function limiarEstoqueBaixo(): number {
  return envInt('MERCADO_LIVRE_STOCK_LIMIAR', 5);
}

/** Upper clamp of every quantity sent to ML (`available_quantity` ceiling). */
export function estoqueMax(): number {
  return envInt('MERCADO_LIVRE_STOCK_MAX', 99999);
}

/** Kit own-stock inclusion hook — default OFF (component-min only, per Lucas). */
export function kitIncluiEstoqueProprio(): boolean {
  return envFlag('MERCADO_LIVRE_STOCK_KIT_INCLUI_PROPRIO');
}

/** Anchor-page size of THE query — family rows are heavy, keep pages small. */
export function anchorPageLimit(): number {
  return envInt('MERCADO_LIVRE_STOCK_ANCHOR_PAGE_LIMIT', 250);
}

/** Truncation guard: max send tasks one sweep may enqueue. */
export function maxTasksPerSweep(): number {
  return envInt('MERCADO_LIVRE_STOCK_MAX_TASKS_PER_SWEEP', 2000);
}

/** 429 pause duration (minutes) when ML sends no `Retry-After`. */
export function ratePauseMin(): number {
  return envInt('MERCADO_LIVRE_STOCK_RATE_PAUSE_MIN', 5);
}

/** Cap on how often a paused task re-enqueues itself before dropping (PR B). */
export function maxPauseReenqueues(): number {
  return envInt('MERCADO_LIVRE_STOCK_MAX_PAUSE_REENQUEUES', 10);
}

/** Queue rate limit (deploy-time only — feeds `onTaskDispatched.rateLimits`). */
export function dispatchesPerSecond(): number {
  return envInt('MERCADO_LIVRE_STOCK_DISPATCHES_PER_SECOND', 2);
}

/** Queue concurrency (deploy-time only — feeds `onTaskDispatched.rateLimits`). */
export function concurrentDispatches(): number {
  return envInt('MERCADO_LIVRE_STOCK_CONCURRENT_DISPATCHES', 2);
}

/* -------------------- THE query: joined stock families --------------------- */

/**
 * One raw estoque row joined server-side — unvalidated, read defensively like
 * a `doc.data()` record. Component rows (`componentEstoques`) carry the
 * `parentId` produto-id denorm the join keys on; the member's own estoque row
 * omits it (the owner is the member itself).
 */
export interface RawEstoqueRow {
  parentId?: unknown;
  quantidade?: unknown;
  quantidadeReservada?: unknown;
  ultimaModificacao?: unknown;
  [key: string]: unknown;
}

/**
 * One raw `produtoMercadoLivre` link row — ONE of the conta's listings on the
 * family (the join returns every listing) — read defensively.
 */
export interface RawStockLinkRow {
  id?: unknown;
  estado?: unknown;
  status?: unknown;
  sub_status?: unknown;
  isUserProductModel?: unknown;
  linkDocId?: unknown;
  [key: string]: unknown;
}

/** Raw variação link row joined per child — read defensively. */
export interface RawVarLinkRow {
  itemId?: unknown;
  id?: unknown;
  produtoMercadoLivreOuterRef?: unknown;
  [key: string]: unknown;
}

/**
 * One family member (the anchor, or a variation child) with everything the
 * sweep-time quantity computation needs. Booleans are coerced (`=== true`);
 * `componentesKit` stays raw (the kit-min helper tolerates junk).
 */
export interface FamilyMember {
  produtoId: string;
  ehKit: boolean;
  ehKitVirtual: boolean;
  publicado: boolean;
  componentesKit: ComponentesKit | null;
  /** Produto `timestamp` (ms since epoch) — the created-recently activity arm. */
  timestampMs: number | null;
  /** The member's own estoque at the swept depósito; null when absent. */
  estoque: RawEstoqueRow | null;
  /** Component estoques at the same depósito, keyed by their `parentId` denorm. */
  componentEstoques: RawEstoqueRow[];
}

/** A variation child: a member plus its `variacaoMercadoLivre` link rows. */
export interface FamilyChild extends FamilyMember {
  varLinks: RawVarLinkRow[];
}

/** One THE-query row: a family anchor with every server-side join attached. */
export interface StockFamilyRow {
  anchorId: string;
  anchor: FamilyMember;
  /** The anchor's `integracoesComProduto` (conta gate), strings only. */
  integracoesComProduto: string[];
  /**
   * ALL of this conta's `produtoMercadoLivre` links on the family — one row
   * per listing (anúncio), empty when the conta has none. A produto can hold
   * several live listings on ONE conta and the legacy sender loops every one
   * (functions.dart:275-282), so `buildSendTasks` emits per listing.
   */
  links: RawStockLinkRow[];
  /** Variation children, sorted by produtoId (output determinism only). */
  children: FamilyChild[];
}

export interface FetchStockFamiliesArgs {
  /** Conta being swept — drives the link join + the anchor conta filter. */
  integracaoId: string;
  /** Depósito doc id — both accepted `depositoOuterRef` forms are derived. */
  depositoId: string;
  /** Exclusive window start (ms since epoch); `-1` = force-all (daily sweep). */
  changedSinceMs: number;
  /** Page size override — defaults to `anchorPageLimit()`. */
  pageLimit?: number;
  /** Resume after this anchor id (keyset) — page 1 of a fresh sweep omits it. */
  afterAnchorId?: string | null;
}

/** One page of THE query — the result of exactly ONE pipeline execution. */
export interface StockFamilyPage {
  rows: StockFamilyRow[];
  /**
   * Keyset cursor: the last row's `anchorId` when the page came back FULL
   * (`rows.length === pageLimit`), null when the backlog is drained. The PR-C
   * sweep loops pages (feeding this back as `afterAnchorId`), enqueues per
   * page, bounds pages per tick and advances its durable cursor between
   * ticks — the `orderBackfill` pattern.
   */
  nextAfterAnchorId: string | null;
}

/** The single seam the sweeps consume — injectable so tests stub it. */
export type FetchStockFamilies = (
  db: Firestore,
  args: FetchStockFamiliesArgs,
) => Promise<StockFamilyPage>;

/**
 * THE query (module doc): exactly ONE pipeline execution per CALL — the
 * fetcher is page-aware and never drains internally. The PR-C sweep loops
 * pages (feeding `nextAfterAnchorId` back as `afterAnchorId`), enqueues per
 * page, bounds pages per tick and advances its durable cursor per the
 * `orderBackfill` pattern. Stages, in order:
 *  - S1 anchor predicate (server-side): `paiId == null`, `publicado == true`,
 *    `integracoesComProduto` arrayContains the conta; a resumed page adds
 *    `__name__ > <afterAnchorId ref>` (the ref is rebuilt via
 *    `produtoCollection.docRef` — `select` drops refs).
 *  - S2 define: `anchorId` + `anchorKitKeys` (`coalesce(componentesKitKeys,
 *    [])` — NOT ifNull, an ABSENT field passes through ifNull) — PLAIN
 *    expressions only; `define` is documented for those.
 *  - S3 addFields (the DOCUMENTED subquery-embed site): `maxOwn`, `maxComp`,
 *    `maxChildren` — indexed MAX-aggregate seeks per anchor.
 *  - S4 window filter, SERVER-SIDE, over the added FIELDS (the documented
 *    HAVING-style where-after-addFields pattern):
 *    `coalesce(logicalMaximum(maxOwn, maxComp, maxChildren), 0) >
 *    changedSinceMs`. The heavy S6 projection then runs only for surviving
 *    anchors; `coalesce(..., 0)` keeps no-estoque families out for positive
 *    windows and gives `changedSinceMs = -1` force-all free.
 *  - S5 `sort(__name__)` + `limit(pageLimit)` — `__name__` is unique, the
 *    keyset needs no tuple.
 *  - S6 the projection (minimal fields — the 128 MiB ceiling spans joins):
 *    anchor gate fields + own/component estoques + the conta's link ARRAY
 *    (every listing this conta holds on the family — the legacy sender loops
 *    them all, functions.dart:275-282, one stock send per listing) + the
 *    children array (each with its own estoques + variação links).
 * The SALES signal is deliberately NOT part of THE query: the per-anchor
 * pedidos probe needed a per-row VARIABLE membership list, which the planner
 * can only bind as a residual Filter (never an array-index seek) — it lives
 * in the separate uncorrelated `fetchSoldProdutoIds` pre-pass instead.
 * Returns ONE page: `rows` plus `nextAfterAnchorId` (the last row's
 * `anchorId` when the page came back full, else null — backlog drained).
 *
 * NOT emulator-runnable (pipelines never are) — tested through the seam;
 * live-validated by PR C's `check-stock-indexes.mjs`.
 */
export const fetchStockFamilies: FetchStockFamilies = async (db, args) => {
  const pageLimit = args.pageLimit ?? anchorPageLimit();

  // Both accepted *OuterRef forms (outerRef.ts invariant: readers tolerate
  // the bare form) — every builder call mints fresh expression objects.
  const depMatch = () =>
    pipelines.or(
      pipelines.equal(
        pipelines.field('depositoOuterRef'),
        `documents/depositos/${args.depositoId}`,
      ),
      pipelines.equal(pipelines.field('depositoOuterRef'), `depositos/${args.depositoId}`),
    );

  // The current row's own estoque at the depósito — subcollection() binds to
  // the row being processed, so this works for the anchor AND inside the
  // children subquery alike.
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

  // The SQL UNNEST-join: component estoques of the row's kit keys, riding the
  // estoque `parentId` produto-id denorm. Empty-IN semantics for `equalAny`
  // are undocumented, so the `conditional` short-circuits non-kits (the
  // dominant path: empty key list) entirely instead of relying on them.
  const compEstoques = (keysVar: string) =>
    pipelines.conditional(
      pipelines.variable(keysVar).length().greaterThan(0),
      // eslint-disable-next-line no-restricted-syntax -- correlated-subquery SOURCE stage, not a raw ref; defineAdminCollection handles have no pipeline surface
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

  const compEstoquesMax = (keysVar: string) =>
    pipelines.conditional(
      pipelines.variable(keysVar).length().greaterThan(0),
      // eslint-disable-next-line no-restricted-syntax -- correlated-subquery SOURCE stage (see chain-start note above)
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
      // NULL folds correctly into the downstream logicalMaximum + coalesce.
      pipelines.constant(null),
    );

  const kitKeysDefine = (name: string) =>
    pipelines.coalesce(pipelines.field('componentesKitKeys'), pipelines.array([])).as(name);

  // TODO(pre-PR-C spike a): confirm a nested `define` inside a correlated
  // subquery binds per SUBQUERY row — at BOTH nested-define sites: this
  // maxChildren rollup (`maxChildKitKeys`) AND the S6 childrenJoin
  // (`childKitKeys`). The two sites deliberately bind DIFFERENT names:
  // variables are pipeline-global, and whether two sibling subqueries may
  // rebind ONE global name is an extra unverified assumption we don't take.
  // (The skill says variables reach nested subqueries; every published
  // example defines top-level.) Fallback: drop the child-level component
  // join and warn when a variation child has ehKit.
  const maxChildren = () =>
    // eslint-disable-next-line no-restricted-syntax -- correlated-subquery SOURCE stage (see chain-start note above)
    db
      .pipeline()
      .collection('produtos')
      .where(pipelines.equal(pipelines.field('paiId'), pipelines.variable('anchorId')))
      .define(kitKeysDefine('maxChildKitKeys'))
      .select(pipelines.logicalMaximum(ownEstoqueMax(), compEstoquesMax('maxChildKitKeys')).as('m'))
      .aggregate(pipelines.maximum('m').as('max'))
      .toScalarExpression();

  // ALL of this conta's links — the legacy sender loops EVERY listing the
  // conta holds on the produto (functions.dart:275-282:
  // `allMarketplaceTarget(contaId)` → one per-listing status gate + stock
  // send each), so no limit(1): a produto can carry several live anúncios on
  // ONE conta and each must receive stock. The per-conta filter still scopes
  // the array to THIS conta's listings. Both accepted contaOuterRef forms,
  // mirroring refMatchesIntegracao (linkRefs.ts).
  const linkJoin = () =>
    pipelines
      .subcollection('produtoMercadoLivre')
      .where(
        pipelines.or(
          pipelines.equal(
            pipelines.field('contaOuterRef'),
            `documents/integracao/${args.integracaoId}`,
          ),
          pipelines.equal(pipelines.field('contaOuterRef'), `integracao/${args.integracaoId}`),
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

  // Variation children with their own estoques + variação links (each nested
  // row is a CHILD, so subcollection() joins on the child's __name__).
  const childrenJoin = () =>
    // eslint-disable-next-line no-restricted-syntax -- correlated-subquery SOURCE stage (see chain-start note above)
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

  const paiTerm = pipelines.equal(pipelines.field('paiId'), null);
  const publicadoTerm = pipelines.equal(pipelines.field('publicado'), true);
  const contaTerm = pipelines.field('integracoesComProduto').arrayContains(args.integracaoId);
  const afterAnchorId = args.afterAnchorId ?? null;
  const anchorPredicate =
    afterAnchorId == null
      ? pipelines.and(paiTerm, publicadoTerm, contaTerm)
      : pipelines.and(
          paiTerm,
          publicadoTerm,
          contaTerm,
          // constant() accepts a DocumentReference — the keyset cursor.
          pipelines.greaterThan(
            pipelines.field('__name__'),
            pipelines.constant(produtoCollection.docRef(db, {}, afterAnchorId)),
          ),
        );

  // eslint-disable-next-line no-restricted-syntax -- pipeline SOURCE stage, not a raw ref; defineAdminCollection handles have no pipeline surface
  const snap = await db
    .pipeline()
    .collection('produtos')
    .where(anchorPredicate)
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
        args.changedSinceMs,
      ),
    )
    .sort(pipelines.ascending(pipelines.field('__name__')))
    .limit(pageLimit)
    .select(
      // Variables are omitted from output unless re-selected — anchorId is
      // both the row identity and the keyset cursor.
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
    )
    .execute();

  const rows: StockFamilyRow[] = [];
  for (const result of snap.results) {
    const data = result.data() as Record<string, unknown>;
    const anchorId =
      typeof data.anchorId === 'string' && data.anchorId !== '' ? data.anchorId : null;
    if (anchorId == null) continue; // projected server-side; purely defensive
    rows.push(mapFamilyRow(anchorId, data));
  }

  const lastRow = rows.length === pageLimit ? rows[rows.length - 1] : undefined;
  return { rows, nextAfterAnchorId: lastRow?.anchorId ?? null };
};

/** Coerce one projected row into the family shape — junk-tolerant. */
function mapFamilyRow(anchorId: string, data: Record<string, unknown>): StockFamilyRow {
  const children: FamilyChild[] = [];
  for (const rawChild of Array.isArray(data.children) ? data.children : []) {
    if (rawChild == null || typeof rawChild !== 'object') continue;
    const child = rawChild as Record<string, unknown>;
    if (typeof child.childId !== 'string' || child.childId === '') continue;
    children.push({
      ...coerceMember(child.childId, child),
      varLinks: Array.isArray(child.varLinks)
        ? child.varLinks.filter(
            (v): v is RawVarLinkRow => v != null && typeof v === 'object' && !Array.isArray(v),
          )
        : [],
    });
  }
  // The children array subquery has no sort (unstable order) — sort by id
  // purely for output determinism.
  children.sort((a, b) => (a.produtoId < b.produtoId ? -1 : a.produtoId > b.produtoId ? 1 : 0));

  return {
    anchorId,
    anchor: coerceMember(anchorId, data),
    integracoesComProduto: Array.isArray(data.integracoesComProduto)
      ? data.integracoesComProduto.filter((x): x is string => typeof x === 'string')
      : [],
    links: Array.isArray(data.links)
      ? data.links.filter((l): l is RawStockLinkRow => l != null && typeof l === 'object')
      : [],
    children,
  };
}

function coerceMember(produtoId: string, raw: Record<string, unknown>): FamilyMember {
  return {
    produtoId,
    ehKit: raw.ehKit === true,
    ehKitVirtual: raw.ehKitVirtual === true,
    publicado: raw.publicado === true,
    componentesKit: (raw.componentesKit ?? null) as ComponentesKit | null,
    timestampMs: finiteNumber(raw.timestamp),
    estoque:
      raw.estoque != null && typeof raw.estoque === 'object' && !Array.isArray(raw.estoque)
        ? (raw.estoque as RawEstoqueRow)
        : null,
    componentEstoques: Array.isArray(raw.componentEstoques)
      ? raw.componentEstoques.filter(
          (e): e is RawEstoqueRow => e != null && typeof e === 'object' && !Array.isArray(e),
        )
      : [],
  };
}

/* --------------------------- sold-ids pre-pass ----------------------------- */

export interface FetchSoldProdutoIdsArgs {
  /** Inclusive lower bound (µs since epoch) of the pedidos sales window. */
  vendaCutoffUs: number;
  /** Pedido estados counting as a sale — the sweep passes `ESTADOS_VENDA`. */
  estadosVenda: readonly string[];
  /** Distinct-ids cap override — defaults to `soldIdsLimit()`. */
  limit?: number;
}

/** The sold-ids seam the sweeps consume — injectable so tests stub it. */
export type FetchSoldProdutoIds = (
  db: Firestore,
  args: FetchSoldProdutoIdsArgs,
) => Promise<Set<string>>;

/**
 * The UNCORRELATED sales pre-pass: ONE pipeline execution per conta per
 * incremental sweep returning the DISTINCT produto ids sold (any
 * `estadosVenda` pedido) since `vendaCutoffUs` —
 * `pedidos.where(...).unnest(itensIds → pid).distinct(pid).limit(cap)`.
 * The sweep runs it once BEFORE the page loop and `deveEnviarIncremental`
 * checks family membership (anchor OR any child) against the Set.
 *
 * Why the correlated per-anchor probe was RETIRED (staging explain evidence,
 * gate run 2, 2026-07-28): the probe's `itensIds` membership list was a
 * per-row VARIABLE (anchor + childIds), and the planner binds variable
 * candidate lists only as RESIDUAL Filters — the plan scanned the OLD
 * `pedidos(ehSaida, estado, numero)` index with `itensIds` + `timestamp` as
 * residuals, once per anchor, never seeking the declared `itensIds` array
 * indexes (since removed). Owner decision: the sales signal moved out of THE
 * query into this single pre-pass.
 *
 * Index: rides the NEW `pedidos(ehSaida ASC, estado ASC, timestamp DESC)`
 * entry — all three predicates bind (equality, equalAny, range). It is NOT
 * enough for the individual fields to be indexed somewhere: gate run 2
 * (2026-07-28) had both `pedidos(ehSaida, timestamp DESC)` and
 * `pedidos(ehSaida, estado, numero)` deployed and the planner chose the
 * `estado` one, leaving `timestamp` in a residual Filter — the pass would then
 * scan every saída pedido ever written instead of the 30d window. The staging
 * gate FAILS on exactly that shape (a residual `timestamp`).
 *
 * Truncation: hitting the cap (`limit`, default `soldIdsLimit()`) means some
 * sold produto ids are MISSING from the Set — the incremental sweep then
 * UNDER-sends (a sold-but-otherwise-quiet family is skipped); the daily
 * force-all sweep corrects within 24h. The pass warns LOUDLY when the result
 * size equals the cap so the operator can raise
 * `MERCADO_LIVRE_STOCK_SOLD_IDS_LIMIT`.
 *
 * NOT emulator-runnable (pipelines never are) — tested through the seam.
 */
export const fetchSoldProdutoIds: FetchSoldProdutoIds = async (db, args) => {
  const limit = args.limit ?? soldIdsLimit();

  // eslint-disable-next-line no-restricted-syntax -- pipeline SOURCE stage, not a raw ref; defineAdminCollection handles have no pipeline surface
  const snap = await db
    .pipeline()
    .collection('pedidos')
    .where(
      pipelines.and(
        pipelines.equal(pipelines.field('ehSaida'), true),
        pipelines.field('estado').equalAny([...args.estadosVenda]),
        pipelines.field('timestamp').greaterThanOrEqual(args.vendaCutoffUs),
      ),
    )
    // unnest(selectable, indexField?): one row per itensIds element, aliased
    // `pid`; distinct(group,...) then dedupes (a MERGING stage — only `pid`
    // survives it, which is all the mapping below reads).
    .unnest(pipelines.field('itensIds').as('pid'))
    .distinct('pid')
    .limit(limit)
    .execute();

  const soldIds = new Set<string>();
  for (const result of snap.results) {
    const pid = (result.data() as Record<string, unknown>).pid;
    if (typeof pid === 'string' && pid !== '') soldIds.add(pid);
  }
  if (snap.results.length === limit) {
    console.warn(
      '[mercado-livre] stock-sync: sold-ids TRUNCADO no limite — ids vendidos faltando; ' +
        'o sweep incremental sub-envia e o daily corrige; aumente ' +
        'MERCADO_LIVRE_STOCK_SOLD_IDS_LIMIT',
      { limit, distinctIds: soldIds.size },
    );
  }
  return soldIds;
};

/* ------------------------------- status gate ------------------------------- */

/** The documented ML listing statuses (developers.mercadolivre.com.br, 2026-07-24). */
const DOCUMENTED_ML_STATUSES = new Set([
  'active',
  'paused',
  'under_review',
  'closed',
  'inactive',
  'payment_required',
]);

/**
 * The `estado` codes that make a LEGACY-authored link (`status == null`)
 * non-sendable — the only trim on the optimistic arm (module doc, #780).
 * `estado` is the derived short code the Flutter app DOES write, so it is the
 * one signal available before the first send:
 *
 *  - `c` (cancelado) — the listing is already closed. `PUT /items` answers 4xx
 *    and teaches nothing, so the call is pure waste.
 *  - `E` (erro) — the PREVIOUS send's own deterministic rejection, stamped by
 *    `estoqueSend`'s 4xx handler. **This rung is what terminates the loop**: a
 *    legacy listing ML refuses gets exactly ONE send, is stamped `E`, and is
 *    skipped from the next sweep on. Without it the sweep would rebuild and
 *    re-send the identical rejected payload every tick, forever (#781, which
 *    fixes the same loop for links that already carry a real `status`).
 *
 * Deliberately NOT trimmed: `pa` (pausado). A paused listing is the case the
 * whitelist admits when `sub_status` is `out_of_stock`, and `estado` cannot
 * express sub-status — trimming `pa` would leave every legacy paused listing
 * `status: null` and unsent FOREVER (non-convergent), which is the very outage
 * this fix exists to close. A seller-paused listing instead absorbs the update
 * and stays paused, and the writeback then resolves it correctly.
 */
const ESTADOS_TERMINAIS_LEGADO: ReadonlySet<string> = new Set([
  ESTADO_PUBLICACAO_ML.cancelado,
  ESTADO_PUBLICACAO_ML.erro,
]);

export interface StatusGate {
  /** May this listing receive an `available_quantity` update? */
  enviar: boolean;
  /** Status outside the documented set (null/undefined included) — caller logs. */
  desconhecido: boolean;
}

/**
 * The listing-status whitelist (module doc): send iff `status === 'active'` OR
 * (`'paused'` AND `sub_status` includes `'out_of_stock'` — ML auto-reactivates
 * on qty>0). An undocumented status is `desconhecido` and never `enviar`.
 *
 * A NULL status takes the legacy arm (#780): the link predates `status`, so it
 * is sent optimistically — the send's own writeback backfills the real values —
 * unless `estado` is terminal (`ESTADOS_TERMINAIS_LEGADO`). It stays
 * `desconhecido` either way: the flag reports "this decision was made without
 * real ML data", which is true of both arms and is what the caller logs.
 */
export function podeEnviarEstoque(
  status: string | null | undefined,
  subStatus: string[] | null | undefined,
  /** The link's legacy `estado` code — only consulted when `status` is null. */
  estado?: string | null,
): StatusGate {
  const desconhecido = status == null || !DOCUMENTED_ML_STATUSES.has(status);
  if (status == null) {
    return { enviar: !ESTADOS_TERMINAIS_LEGADO.has(estado ?? ''), desconhecido };
  }
  const enviar =
    status === 'active' || (status === 'paused' && (subStatus ?? []).includes('out_of_stock'));
  return { enviar, desconhecido };
}

/* ----------------------------- quantity compute ---------------------------- */

export interface QuantidadeParaEnvioArgs {
  ehKit: boolean;
  ehKitVirtual: boolean;
  componentesKit: ComponentesKit | null | undefined;
  /** The produto's own `disponivel` (quantidade − reservada) at the depósito. */
  ownDisponivel: number;
  /** Component produto id → its `disponivel` at the same depósito. */
  disponivelByProdutoId: Record<string, number | null | undefined>;
  /** Override for the kit own-stock hook — defaults to `kitIncluiEstoqueProprio()`. */
  incluirEstoqueProprioDoKit?: boolean;
}

/**
 * The quantity to publish for one produto at one depósito, or `null` for
 * "never send" (`ehKitVirtual`, functions.dart:286-289). Kits wrap
 * `kitEstoqueDisponivel` (component-min, estoques.dart:94-131 — unrounded,
 * missing component = 0); a `null` min (no component constrains) falls back to
 * the produto's own stock. The opt-in own-stock hook ADDS `ownDisponivel` to a
 * constrained kit min. Result is floored, then clamped
 * `ESTOQUE_MIN..estoqueMax()` (api.dart:1182-1203).
 */
export function quantidadeParaEnvio(args: QuantidadeParaEnvioArgs): number | null {
  if (args.ehKitVirtual) return null;

  let disponivel: number;
  if (args.ehKit) {
    const kitMin = kitEstoqueDisponivel(args.componentesKit, args.disponivelByProdutoId);
    if (kitMin == null) {
      disponivel = args.ownDisponivel; // unconstrained kit → own stock stands alone
    } else {
      const incluirProprio = args.incluirEstoqueProprioDoKit ?? kitIncluiEstoqueProprio();
      disponivel = kitMin + (incluirProprio ? args.ownDisponivel : 0);
    }
  } else {
    disponivel = args.ownDisponivel;
  }

  return Math.min(Math.max(Math.floor(disponivel), ESTOQUE_MIN), estoqueMax());
}

/* ------------------------- quantities at sweep time ------------------------ */

/**
 * Component `disponivel` map from the joined estoque rows, keyed by the
 * `parentId` produto-id denorm. Junk rows (no string parentId) are skipped;
 * non-finite quantities read as 0 (legacy tolerance).
 */
export function disponivelByProdutoIdFrom(rows: RawEstoqueRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    if (typeof row.parentId !== 'string' || row.parentId === '') continue;
    out[row.parentId] = estoqueDisponivel({
      quantidade: finiteNumber(row.quantidade) ?? 0,
      quantidadeReservada: finiteNumber(row.quantidadeReservada) ?? 0,
    });
  }
  return out;
}

/**
 * One member's send quantity from its OWN joined rows — no I/O, computed at
 * sweep time (owner decision 3: the task carries this verbatim to the send
 * handler). Missing own estoque reads as 0; a missing component estoque
 * counts as 0 through the kit min (#238); `ehKitVirtual` → null (never send).
 */
export function quantidadeDoMembro(member: FamilyMember): number | null {
  const ownDisponivel =
    member.estoque == null
      ? 0
      : estoqueDisponivel({
          quantidade: finiteNumber(member.estoque.quantidade) ?? 0,
          quantidadeReservada: finiteNumber(member.estoque.quantidadeReservada) ?? 0,
        });
  return quantidadeParaEnvio({
    ehKit: member.ehKit,
    ehKitVirtual: member.ehKitVirtual,
    componentesKit: member.componentesKit,
    ownDisponivel,
    disponivelByProdutoId: disponivelByProdutoIdFrom(member.componentEstoques),
  });
}

/**
 * Every family member's send quantity (anchor + children), keyed by produto
 * id. Members whose quantity is `null` (`ehKitVirtual`) are OMITTED — the
 * task builder treats a missing entry as "never send".
 */
export function quantidadesDaFamilia(row: StockFamilyRow): Map<string, number> {
  const out = new Map<string, number>();
  for (const member of [row.anchor, ...row.children]) {
    const quantidade = quantidadeDoMembro(member);
    if (quantidade != null) out.set(member.produtoId, quantidade);
  }
  return out;
}

/**
 * Incremental-sweep activity filter (the daily sweep sends ALL families):
 * send when the family sold in the lookback window (the ANCHOR id or ANY
 * child id is in `soldIds`, the `fetchSoldProdutoIds` Set — legacy hasSales =
 * own or any child), OR any member was created recently (`timestamp` within
 * `atividadeLookbackDays()`), OR any member's quantity is below
 * `limiarEstoqueBaixo()` (legacy `disponivel < 5` override).
 */
export function deveEnviarIncremental(
  row: StockFamilyRow,
  quantidades: ReadonlyMap<string, number>,
  nowMs: number,
  soldIds: ReadonlySet<string>,
): boolean {
  if (soldIds.has(row.anchorId) || row.children.some((c) => soldIds.has(c.produtoId))) return true;
  const criadoCutoffMs = nowMs - atividadeLookbackDays() * 24 * 60 * 60 * 1000;
  const members = [row.anchor, ...row.children];
  if (members.some((m) => m.timestampMs != null && m.timestampMs >= criadoCutoffMs)) return true;
  const limiar = limiarEstoqueBaixo();
  for (const quantidade of quantidades.values()) {
    if (quantidade < limiar) return true;
  }
  return false;
}

/* -------------------------------- send tasks ------------------------------- */

export type SendUnitKind = 'item' | 'variationItem';

/**
 * Hard cap on one old-model bulk task's `variations` array. Cloud Tasks
 * rejects payloads over ~100 KB at ENQUEUE time — and a rejected enqueue means
 * the sweep re-attempts the same unsendable family forever. One serialized
 * entry (`{"id":<~13-digit ML id>,"available_quantity":<=99999},`) is ~40 B,
 * so 2000 entries ≈ 80 KB — comfortably under the limit with headroom for the
 * task envelope. Above the cap NO task is built: the listing skips
 * `'variations-excede-limite'` + `console.error`.
 */
export const MAX_VARIATIONS_PER_TASK = 2000;

export type SendSkipReason =
  | 'sem-link'
  | 'sem-item-id'
  | 'aguardando-migracao'
  | 'anuncio-em-erro'
  | 'status-nao-enviavel'
  | 'kit-virtual'
  | 'nao-publicado'
  | 'conta-fora-do-produto'
  | 'variations-excede-limite';

export interface SendSkip {
  /** The produto the reason applies to — the family anchor, or the UP child. */
  produtoId: string;
  reason: SendSkipReason;
}

/** One `variations` entry of an old-model bulk `PUT items/{id}`. */
export interface StockVariationEntry {
  /** Numeric ML variation id (the variação link's `id` field). */
  id: number;
  available_quantity: number;
}

/**
 * One ready-to-enqueue send task — the `mlStockSendTaskSchema` wire shape
 * (the zod schema lives on the stacked send-queue branch; this local type
 * mirrors it). Exactly ONE of `quantidade` / `variations` is non-null. The
 * payload is sent VERBATIM by the handler (owner decision 3 — legacy parity,
 * zero reads at send time; the handler logs `ageMs = now −
 * sweepComputedAtMs` and the next sweep converges staleness). `linkDocId` is
 * the status-writeback target — never re-resolved.
 */
export interface StockSendTaskDraft {
  integracaoId: string;
  /** The family ANCHOR produto — quantities were computed for this family. */
  produtoId: string;
  /** UP model: the variation child behind `itemId`; null on `kind: 'item'`. */
  variacaoProdutoId: string | null;
  kind: SendUnitKind;
  /** The ML item id the call targets (family MLB for `'item'`, per-variation for UP). */
  itemId: string;
  /** The conta's `produtoMercadoLivre` link doc id (writeback target). */
  linkDocId: string;
  quantidade: number | null;
  variations: StockVariationEntry[] | null;
  sweepId: string;
  /** When the sweep computed the quantities (ms since epoch). */
  sweepComputedAtMs: number;
  reenqueues: number;
}

export interface BuildSendTasksResult {
  tasks: StockSendTaskDraft[];
  skips: SendSkip[];
}

export interface BuildSendTasksOpts {
  integracaoId: string;
  sweepId: string;
  sweepComputedAtMs: number;
}

function skipOnly(produtoId: string, reason: SendSkipReason): BuildSendTasksResult {
  return { tasks: [], skips: [{ produtoId, reason }] };
}

/**
 * Pure assembly: resolve one family row + its sweep-time quantities into
 * send-task drafts, reproducing the legacy PER-LISTING loop
 * (functions.dart:275-282: `allMarketplaceTarget(contaId)` yields EVERY
 * listing this conta holds on the produto, and each gets its OWN status gate
 * and its OWN stock send — a skipped listing never blocks its siblings).
 *
 * Anchor-level rungs run ONCE, before the loop, in order: `'sem-link'` (the
 * conta has NO listings on this family), `'kit-virtual'`
 * (functions.dart:286-289), then the defensive `'nao-publicado'` /
 * `'conta-fora-do-produto'`.
 *
 * Per-listing rungs (legacy `continue` semantics — the skip is pushed and the
 * OTHER listings still send): `'sem-link'` (listing without a doc id,
 * defensive — server-projected), `'sem-item-id'` (never published),
 * `'aguardando-migracao'` (`estado 'am'`, mid-UP-migration, Flutter-driven),
 * `'anuncio-em-erro'` (`estado 'E'` — the send handler verified with ML that the
 * anúncio is healthy and it was our PAYLOAD that was refused, so re-sending it
 * unchanged only re-earns the rejection, #781), `'status-nao-enviavel'`
 * (whitelist gate PER listing; `desconhecido` statuses additionally warn with
 * that listing's itemId — status tracking per Lucas).
 *
 * Per surviving listing — every task carries THAT listing's `linkDocId`
 * (writeback per listing): old model (`isUserProductModel !== true`) with
 * children → ONE `'item'` task carrying the whole family as bulk `variations`
 * (1 task = 1 ML call) — children matched by `produtoMercadoLivreOuterRef ===
 * toOuterRef(<THIS listing's docPath>)` (exact string match is safe: both
 * apps write the canonical `documents/...` form, see importVariations.ts),
 * each entry's `id` the NUMERIC variação-link id. Unmatched / id-less /
 * quantity-less children are skip-logged and excluded; ALL children excluded
 * → NO task for that listing (skips only); a `variations` array past
 * `MAX_VARIATIONS_PER_TASK` also builds NO task (the enqueue would blow the
 * ~100 KB Cloud Tasks payload limit and the sweep would retry forever) —
 * skip `'variations-excede-limite'` + `console.error`, with the existing
 * >1000 warn kept as the early warning below the cap. Old model childless → one `'item'`
 * task with the anchor quantity. User Products: one `'variationItem'` task
 * per child (each variation is its own ML item); a childless UP listing
 * degenerates to a single `'item'` task with the anchor quantity.
 *
 * Cycle-wide dedup (the legacy `processedUpFamilies` /
 * `processedUpVariationItems` sets): ONE `emittedItemIds` set spans the whole
 * family loop — a task whose ML item id (`'item'` → the listing's MLB id,
 * `'variationItem'` → the variation item id) was already emitted is dropped
 * silently (legacy printed only a debug line — no warn spam).
 *
 * A member missing from `quantidades` means `quantidadeDoMembro` returned
 * null — only `ehKitVirtual` does that, so the skip reason is
 * `'kit-virtual'`.
 */
export function buildSendTasks(
  row: StockFamilyRow,
  quantidades: ReadonlyMap<string, number>,
  opts: BuildSendTasksOpts,
): BuildSendTasksResult {
  const { anchorId } = row;

  if (row.links.length === 0) return skipOnly(anchorId, 'sem-link');
  if (row.anchor.ehKitVirtual) return skipOnly(anchorId, 'kit-virtual');
  // DEFENSIVE-ONLY rung: S1 already filters `publicado` server-side (keep the S1 term).
  if (!row.anchor.publicado) return skipOnly(anchorId, 'nao-publicado');
  // DEFENSIVE-ONLY rung: S1 already filters the conta server-side (keep the S1 term).
  if (!row.integracoesComProduto.includes(opts.integracaoId)) {
    return skipOnly(anchorId, 'conta-fora-do-produto');
  }

  const tasks: StockSendTaskDraft[] = [];
  const skips: SendSkip[] = [];
  // Cycle-wide dedup across ALL of the family's listings (legacy
  // processedUpFamilies / processedUpVariationItems): each ML item id is sent
  // at most once per cycle; a duplicate drops silently (legacy debug print).
  const emittedItemIds = new Set<string>();

  // The legacy per-listing loop (functions.dart:275-282) — each of the
  // conta's listings gets its own gates and its own send; `continue` skips
  // ONE listing, never the family.
  for (const link of row.links) {
    const linkDocId =
      typeof link.linkDocId === 'string' && link.linkDocId !== '' ? link.linkDocId : null;
    if (linkDocId == null) {
      skips.push({ produtoId: anchorId, reason: 'sem-link' }); // defensive — server-projected
      continue;
    }

    const itemId = typeof link.id === 'string' && link.id !== '' ? link.id : null;
    if (itemId == null) {
      skips.push({ produtoId: anchorId, reason: 'sem-item-id' });
      continue;
    }
    if (link.estado === 'am') {
      skips.push({ produtoId: anchorId, reason: 'aguardando-migracao' });
      continue;
    }
    // #781: the send handler's terminal branch stamps `'E'` when ML confirmed the
    // anúncio is healthy and it was therefore OUR payload it refused — rebuilding
    // the identical payload next tick just re-earns the same rejection. Every
    // other terminal case records the listing's real ML status instead, and the
    // whitelist below skips those. Cleared by an `items` webhook or the produto
    // tab's "Reverificar anúncio" action.
    if (link.estado === ESTADO_PUBLICACAO_ML.erro) {
      skips.push({ produtoId: anchorId, reason: 'anuncio-em-erro' });
      continue;
    }

    const statusGate = podeEnviarEstoque(
      typeof link.status === 'string' ? link.status : null,
      Array.isArray(link.sub_status)
        ? link.sub_status.filter((s): s is string => typeof s === 'string')
        : null,
      typeof link.estado === 'string' ? link.estado : null,
    );
    // Both arms of the gate are `desconhecido`, but only ONE is an anomaly. A
    // status that is PRESENT and undocumented is a real ML-side surprise and
    // stays loud (status tracking, per Lucas). A MISSING status is the expected
    // legacy shape (#780) — every pre-cutover link has it — so it is not logged
    // here at all: at one line per listing per tick it would bury the tick
    // summary on the first sweeps after the flag flip, and the event worth
    // seeing is the send itself, which `estoqueSend` already logs (one `info`
    // per successful send) and the sweep already counts.
    if (statusGate.desconhecido && link.status != null) {
      console.warn('[mercado-livre] stock-sync: status de anúncio fora do conjunto documentado', {
        integracaoId: opts.integracaoId,
        produtoId: anchorId,
        itemId,
        status: link.status,
      });
    }
    if (!statusGate.enviar) {
      skips.push({ produtoId: anchorId, reason: 'status-nao-enviavel' });
      continue;
    }

    const base = {
      integracaoId: opts.integracaoId,
      produtoId: anchorId,
      linkDocId, // THIS listing's link doc — status writeback per listing
      sweepId: opts.sweepId,
      sweepComputedAtMs: opts.sweepComputedAtMs,
      reenqueues: 0,
    };

    if (row.children.length === 0) {
      if (emittedItemIds.has(itemId)) continue; // cycle-wide dedup — silent (set above)
      // Childless family (old model or UP alike) → one item task with the
      // anchor's own quantity. A missing entry is only possible for virtuals —
      // unreachable after the kit-virtual rung, guarded defensively.
      const quantidade = quantidades.get(anchorId) ?? null;
      if (quantidade == null) {
        skips.push({ produtoId: anchorId, reason: 'kit-virtual' });
        continue;
      }
      emittedItemIds.add(itemId);
      tasks.push({
        ...base,
        kind: 'item',
        itemId,
        variacaoProdutoId: null,
        quantidade,
        variations: null,
      });
      continue;
    }

    // Exact string match is safe here — both apps write the canonical
    // `documents/...` form for this field (see importVariations.ts).
    const parentLinkOuterRef = toOuterRef(
      produtoMercadoLivreLinkCollection.docPath({ produtoId: anchorId }, linkDocId),
    );

    if (link.isUserProductModel !== true) {
      // Old model bulk: the whole family in ONE `PUT items/{id}` with a
      // `variations` array — still 1 task = 1 ML call per listing. Dedup
      // BEFORE the per-child work: a duplicate MLB id re-logs no child skips.
      if (emittedItemIds.has(itemId)) continue; // cycle-wide dedup — silent (set above)
      const variations: StockVariationEntry[] = [];
      for (const child of row.children) {
        const varLink = child.varLinks.find(
          (v) => v.produtoMercadoLivreOuterRef === parentLinkOuterRef,
        );
        if (varLink == null) {
          skips.push({ produtoId: child.produtoId, reason: 'sem-link' });
          continue;
        }
        const varId =
          typeof varLink.id === 'number' && Number.isFinite(varLink.id) ? varLink.id : null;
        if (varId == null) {
          skips.push({ produtoId: child.produtoId, reason: 'sem-item-id' });
          continue;
        }
        const quantidade = quantidades.get(child.produtoId) ?? null;
        if (quantidade == null) {
          skips.push({ produtoId: child.produtoId, reason: 'kit-virtual' });
          continue;
        }
        variations.push({ id: varId, available_quantity: quantidade });
      }
      if (variations.length === 0) continue; // nothing sendable on this listing
      if (variations.length > MAX_VARIATIONS_PER_TASK) {
        // Hard cap (see MAX_VARIATIONS_PER_TASK): past it the Cloud Tasks
        // enqueue itself would reject the ~100 KB+ payload and the sweep
        // would re-attempt the same unsendable family forever — build NO task.
        console.error(
          '[mercado-livre] stock-sync: família excede o limite de variations por task',
          {
            integracaoId: opts.integracaoId,
            produtoId: anchorId,
            itemId,
            variations: variations.length,
            max: MAX_VARIATIONS_PER_TASK,
          },
        );
        skips.push({ produtoId: anchorId, reason: 'variations-excede-limite' });
        continue;
      }
      if (variations.length > 1000) {
        // Early warning below the MAX_VARIATIONS_PER_TASK cap (~40 B/entry
        // against the 100 KB Cloud Tasks payload limit) — families this large
        // deserve a look before they grow into the hard limit.
        console.warn('[mercado-livre] stock-sync: família com variations acima de 1000 entradas', {
          integracaoId: opts.integracaoId,
          produtoId: anchorId,
          itemId,
          variations: variations.length,
        });
      }
      emittedItemIds.add(itemId);
      tasks.push({
        ...base,
        kind: 'item',
        itemId,
        variacaoProdutoId: null,
        quantidade: null,
        variations,
      });
      continue;
    }

    // User Products: one task per variation child — each variation is its own
    // ML item; the cycle-wide set keeps one task per ML item across listings.
    for (const child of row.children) {
      const varLink = child.varLinks.find(
        (v) => v.produtoMercadoLivreOuterRef === parentLinkOuterRef,
      );
      if (varLink == null) {
        skips.push({ produtoId: child.produtoId, reason: 'sem-link' });
        continue;
      }
      const varItemId =
        typeof varLink.itemId === 'string' && varLink.itemId !== '' ? varLink.itemId : null;
      if (varItemId == null) {
        skips.push({ produtoId: child.produtoId, reason: 'sem-item-id' });
        continue;
      }
      if (emittedItemIds.has(varItemId)) continue; // cycle-wide dedup — silent (set above)
      const quantidade = quantidades.get(child.produtoId) ?? null;
      if (quantidade == null) {
        skips.push({ produtoId: child.produtoId, reason: 'kit-virtual' });
        continue;
      }
      emittedItemIds.add(varItemId);
      tasks.push({
        ...base,
        kind: 'variationItem',
        itemId: varItemId,
        variacaoProdutoId: child.produtoId,
        quantidade,
        variations: null,
      });
    }
  }

  return { tasks, skips };
}

/* --------------------------------- helpers --------------------------------- */

/** Narrow a raw doc field to a finite number (tolerates legacy/missing data). */
function finiteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
