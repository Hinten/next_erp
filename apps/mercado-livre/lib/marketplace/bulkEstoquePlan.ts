/**
 * Mercado Livre **stock-sync compute core** (Step 10 PR A, produtos-first
 * rework) — the building blocks behind the 15-minute + 2AM stock sweeps
 * (PR C) and the `sendMercadoLivreStock` task handler (PR B). No scheduling,
 * no task enqueue and no ML API call lives here: this module DISCOVERS the
 * produto FAMILIES with stock movement (`fetchStockFamilies` — THE query),
 * sums the stock ledger once per tick (`fetchMovimentosDaJanela` — the
 * uncorrelated movement pre-pass), computes every family member's send quantity
 * at sweep time (`quantidadesDaFamilia`) and at the WINDOW START
 * (`quantidadesAnteriores`), applies the send policy (`deveEnviarFamilia`) and
 * turns one family row into ready-to-enqueue drafts (`buildSendTasks`).
 *
 * ---- ⚠️ READ **ADR 0014** (`apps/docs`, "Kit stock propagation and the
 * tiered stock sweep") BEFORE changing what this query joins or which families
 * it emits. Three things here look like bugs and are not:
 *  - the window filter does NOT propagate a component movement to the kits
 *    containing it, because ~2000 kits share one blank shirt + one print, so any
 *    per-component fan-out is thousands of writes per sale (built and measured);
 *  - the sweep therefore UNDER-sends by design — a kit whose component moved but
 *    which did not itself sell waits for the monthly full pass;
 *  - the high-stock skip compares `min(anterior, atual)`, never `atual` alone:
 *    gating on the current value would skip 110 → 95, the movement that walks a
 *    listing into the danger zone.
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
 *  1. Standalone produtos (no children): the legacy query EXCLUDED the
 *     anchor's own estoque as a change trigger — deliberately FIXED here: the
 *     anchor's own estoque is a first-class trigger (`maxOwn` in S3/S4).
 *     Expect a one-time correction burst on the first post-deploy sweep.
 *  2. Retry staleness: tasks are sent VERBATIM (legacy parity, zero extra
 *     reads at send time). Quantities are computed once, at sweep time, and
 *     carried in the task payload; the send handler logs
 *     `ageMs = now − sweepComputedAtMs` on every send and the next sweep
 *     converges any staleness.
 *
 * Timestamp units: produto/estoque timestamps AND `historicoEstoque.timestamp`
 * are MS since epoch — the movement pre-pass windows on ms, so nothing here
 * touches µs any more (the retired sales pass was the only µs consumer).
 * Residual risk: component quantities depend on the `estoques.parentId` denorm
 * (legal null at rest per the schema) — all known writers set it (legacy Flutter
 * models.dart:4301 + aplicarEstoque / sincronizarEstoquePedido / usecases), but
 * a null-parentId estoque yields no join row and that component scores 0 (#238).
 * ⚠️ That denorm is load-bearing for the **component join only**. The movement
 * reconstruction keys a member's OWN row by `member.produtoId` instead (#932):
 * the subcollection probe is already bound to that produto, so the projection
 * carries no `parentId` and never needed to. Do not "restore" a `row.parentId`
 * read there — it is absent by construction, and an unkeyable row reads as
 * *unchanged*, which is a silent skip rather than a fail-open send.
 *
 * ---- Index ledger (PR C declares the entries; Enterprise auto-creates NONE
 * — an unindexed predicate silently full-scans, billed by data scanned):
 *  - anchors (S1): the single array-term composite the staging gate (spike
 *    (b), #705) proved `arrayContains` rides —
 *    `produtos(paiId ASC, publicado ASC, integracoesComProduto ASC,
 *    __name__ ASC)`. A CONTAINS twin was declared alongside it only so the
 *    gate could adjudicate which form the planner seeks; ASC won, CONTAINS
 *    was dropped (#705). The bare `produtos(paiId ASC, publicado ASC,
 *    __name__ ASC)` prefix that used to sit alongside them was dropped by the
 *    #779 audit: every S1 call site also filters `integracoesComProduto`, so
 *    it was dead weight — the surviving composite's leading two fields
 *    already serve it as a prefix.
 *    ⚠️ That surviving composite is PERMANENT — do not let a future index
 *    audit read it as legacy-migration debt. The A/B spike (#890, staging
 *    2026-08-07) measured the alternative: dropping the array and gating the
 *    conta with a link post-filter reads ×7.5 the data (48.27 KiB vs 6.41), and
 *    on Enterprise a post-filter cannot reduce data scanned at all. Shape A
 *    stays, so `integracoesComProduto` is no longer a deprecated array — it is
 *    an app-owned denorm whose sole writers are the #920 link triggers;
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
 *  - movement pass (`fetchMovimentosDaJanela` — NOT part of THE query): needs
 *    `historicoEstoque(timestamp ASC, parentId ASC, depositoOuterRef ASC)`,
 *    scope COLLECTION_GROUP. It must COVER the aggregate, not merely serve the
 *    `where`: an uncovered `aggregate` buffers every group in the 128 MiB budget
 *    and can `RESOURCE_EXHAUSTED`. The retired `pedidos(ehSaida, estado,
 *    timestamp DESC)` entry existed only for the sales pass and is dropped with
 *    it (the deployed index still has to be deleted by hand — declaring is not
 *    deleting). Its history is worth keeping in mind for the new entry: in gate
 *    run 2 the planner picked a different `pedidos` index and left `timestamp`
 *    as a RESIDUAL filter, i.e. unbounded over ALL time. Verify the same way.
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
 * Spike (a) — "does a nested `define` inside a correlated subquery bind per
 * SUBQUERY row?" — is now MOOT at the rollup site: `maxChildren` no longer
 * nests a component join, so it defines nothing (ADR 0014 removed the arm). The
 * S6 `childrenJoin` remains the only nested-`define` site, one level deep.
 * Spike (b) —
 * "does `arrayContains` on `integracoesComProduto` seek CONTAINS or
 * ASCENDING?" — is RETIRED: staging gate printed ASC; the CONTAINS twin was
 * dropped (#705). Spike (c) — "does `define` accept a correlated-subquery
 * expression?" — is RETIRED: proven live on staging 2026-07-28 (a
 * subquery-valued `define` executes fine), then made moot the same day when
 * the per-anchor sales probe (the `childIds` variable's only consumer) moved
 * out of THE query into the uncorrelated `fetchSoldProdutoIds` pre-pass;
 * nothing defines a subquery anymore.
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
 *    SOLD produto id (kit sales attribute to the KIT). **Retired** (ADR 0014):
 *    the activity heuristic it fed existed only because change detection was
 *    imprecise. A kit sale now stamps the kit's OWN estoque doc at the pedido
 *    line, so the window filter carries the sales signal, and
 *    `deveEnviarFamilia` answers the sharper question — *did the published
 *    number change* — from the summed ledger.
 *    ⚠️ Historical note worth preserving: a `historicoEstoque` probe **on the
 *    produto's own history** never flagged kits (kit sales only move COMPONENT
 *    estoques) — the #678-review bug. `fetchMovimentosDaJanela` does not repeat
 *    it: it sums the COMPONENTS' rows and runs the result back through the kit
 *    math, rather than looking for movement on the kit itself.
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
 * `items` status-sync (#440); the legacy app that authored the migrated links
 * never wrote them, so EVERY inherited link has `status == null`.
 * Gating those out would make the flag flip a total, silent stock outage — a
 * listing that never changes never fires `items`, so it never self-heals. They
 * are therefore sent OPTIMISTICALLY, on a `buildSendTasks` rung of their own
 * (NOT inside `podeEnviarEstoque`, whose null must stay non-sendable for its
 * live-ML callers). The send is its own backfill and both outcomes record the
 * real status: an accepted `PUT /items` returns the listing and `estoqueSend`
 * writes `status`/`sub_status` straight back, and a rejected one is verified
 * against ML on the last attempt (#781) and writes them back too. Each legacy
 * listing therefore resolves to real data at ZERO extra API cost on the happy
 * path — cheaper than any `GET`-based pre-flip pass, which would pay one call
 * per listing for exactly the majority that needed none, and would have to be
 * ordered against the flag flip.
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
  componentesKitEntries,
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

/**
 * High-stock threshold: on the INCREMENTAL sweep only, a change is not worth a
 * 15-minute send while the quantity stays comfortably above this on **both**
 * sides of the movement. 100 → 99 cannot cause an oversell inside one window —
 * nobody drains 99 units that fast — so it waits for the daily pass.
 *
 * ⚠️ The rule compares `min(anterior, atual)`, never `atual` alone. Gating on
 * the current value would skip `110 → 95`, which is exactly the movement that
 * walks a listing into the danger zone. See {@link deveEnviarFamilia} and ADR
 * 0014; this is the single most likely line here to be "simplified" into a real
 * oversell.
 *
 * Subsumes the old `limiarEstoqueBaixo` (default 5): low stock now always sends,
 * because `min(...) <= LIMIAR_ALTO` holds for it.
 */
export function limiarEstoqueAlto(): number {
  return envInt('MERCADO_LIVRE_STOCK_LIMIAR_ALTO', 100);
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
 *
 * ⚠️ "Omits it" is a fact about the PROJECTION, not a hint to compensate for.
 * Any consumer that needs the owner of an own row must take it from
 * `member.produtoId`; reading `row.parentId` there always yields `undefined`
 * and silently degrades to "no data" (#932). The stored document does carry the
 * field — a kit's own estoque doc is written with it for structural uniformity
 * (ADR 0014 §2) — but nothing projects it, and nothing reads it: a kit can never
 * be a component of another kit (#239), so the one query that matches on
 * `parentId` can never reach a kit's own row.
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

/* ------------------- shared join + projection builders --------------------- */

/**
 * Every join THE query is made of, bound to one conta + depósito.
 *
 * Extracted so the paged sweep fetcher ({@link fetchStockFamilies}) and the
 * by-ids manual fetcher ({@link fetchStockFamiliesByIds}) cannot drift: both
 * destructure from here, so there is exactly ONE definition of each join and —
 * via {@link stockFamilyProjection} — of the S6 projection. A second derivation
 * of the sent quantity is precisely what ADR 0014 and the `applyItemStatusToLink`
 * extraction exist to prevent.
 *
 * Every builder is a THUNK: a Pipeline expression object may not be reused
 * across stages, so each call has to mint a fresh one.
 */
function stockJoinBuilders(db: Firestore, integracaoId: string, depositoId: string) {
  // Both accepted *OuterRef forms (outerRef.ts invariant: readers tolerate
  // the bare form) — every builder call mints fresh expression objects.
  const depMatch = () =>
    pipelines.or(
      pipelines.equal(pipelines.field('depositoOuterRef'), `documents/depositos/${depositoId}`),
      pipelines.equal(pipelines.field('depositoOuterRef'), `depositos/${depositoId}`),
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

  const kitKeysDefine = (name: string) =>
    pipelines.coalesce(pipelines.field('componentesKitKeys'), pipelines.array([])).as(name);

  // Children's OWN estoques only. The component arm that used to nest inside
  // here (and its anchor-level twin `compEstoquesMax`) is GONE — a component
  // movement now reaches the kit through the pedido-line stamp on the kit's own
  // estoque doc (ADR 0014), so the window no longer has to look through the
  // kit's bill of materials to notice it.
  //
  // This also retires the repo's only THIRD-level correlated nesting, whose
  // spike was still open at level two: one `produtos` subquery containing a
  // `subcollection('estoques')` aggregate is a shape the planner is known to
  // handle, and it is all that remains.
  const maxChildren = () =>
    // eslint-disable-next-line no-restricted-syntax -- correlated-subquery SOURCE stage (see chain-start note above)
    db
      .pipeline()
      .collection('produtos')
      .where(pipelines.equal(pipelines.field('paiId'), pipelines.variable('anchorId')))
      .select(ownEstoqueMax().as('m'))
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

  return {
    depMatch,
    ownEstoque,
    ownEstoqueMax,
    compEstoques,
    kitKeysDefine,
    maxChildren,
    linkJoin,
    childrenJoin,
  };
}

/**
 * The S6 projection — the ONE definition both fetchers select with (minimal
 * fields; the 128 MiB ceiling spans joins). Pinned equal across the two by
 * `bulkEstoquePlan.test.ts`, which is the whole anti-drift guarantee: the manual
 * push must consume byte-identical family rows to the sweep, or the quantity an
 * operator sends by hand could differ from the one the sweep sends minutes later.
 */
function stockFamilyProjection(b: ReturnType<typeof stockJoinBuilders>) {
  return [
    // Variables are omitted from output unless re-selected — anchorId is
    // both the row identity and the keyset cursor.
    pipelines.variable('anchorId').as('anchorId'),
    'ehKit',
    'ehKitVirtual',
    'publicado',
    'componentesKit',
    'integracoesComProduto',
    'timestamp',
    b.ownEstoque().as('estoque'),
    b.compEstoques('anchorKitKeys').as('componentEstoques'),
    b.linkJoin().as('links'),
    b.childrenJoin().as('children'),
    // A TUPLE (`as const`), not an array: `select(...)` takes a rest parameter,
    // and TypeScript only lets you spread a tuple into one.
  ] as const;
}

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
 *  - S3 addFields (the DOCUMENTED subquery-embed site): `maxOwn` +
 *    `maxChildren` — indexed MAX-aggregate seeks per anchor. ⚠️ The component
 *    arm (`maxComp`) is deliberately ABSENT: see the window note below.
 *  - S4 window filter, SERVER-SIDE, over the added FIELDS (the documented
 *    HAVING-style where-after-addFields pattern):
 *    `coalesce(logicalMaximum(maxOwn, maxChildren), 0) > changedSinceMs`. The
 *    heavy S6 projection then runs only for surviving anchors;
 *    `coalesce(..., 0)` keeps no-estoque families out for positive windows and
 *    gives `changedSinceMs = -1` force-all free.
 *  - S5 `sort(__name__)` + `limit(pageLimit)` — `__name__` is unique, the
 *    keyset needs no tuple.
 *  - S6 the projection (minimal fields — the 128 MiB ceiling spans joins):
 *    anchor gate fields + own/component estoques + the conta's link ARRAY
 *    (every listing this conta holds on the family — the legacy sender loops
 *    them all, functions.dart:275-282, one stock send per listing) + the
 *    children array (each with its own estoques + variação links).
 * ⚠️ The window does NOT reach through a kit's components, and that is the
 * central cost decision (ADR 0014). ~2000 kits share one blank shirt and one
 * print, so a `maxComp` arm made every one of them a candidate on every sale,
 * 96× a day. A kit sale instead stamps the kit's OWN estoque doc at the pedido
 * line, so `maxOwn` sees it. The deliberate consequence: a kit whose component
 * moved but which did not itself sell is NOT a candidate here — the monthly
 * force-all pass is its corrector, not this query.
 * Returns ONE page: `rows` plus `nextAfterAnchorId` (the last row's
 * `anchorId` when the page came back full, else null — backlog drained).
 *
 * NOT emulator-runnable (pipelines never are) — tested through the seam;
 * live-validated by PR C's `check-stock-indexes.mjs`.
 */
export const fetchStockFamilies: FetchStockFamilies = async (db, args) => {
  const pageLimit = args.pageLimit ?? anchorPageLimit();
  const builders = stockJoinBuilders(db, args.integracaoId, args.depositoId);
  const { ownEstoqueMax, kitKeysDefine, maxChildren } = builders;

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
    .addFields(ownEstoqueMax().as('maxOwn'), maxChildren().as('maxChildren'))
    .where(
      pipelines.greaterThan(
        pipelines.coalesce(
          pipelines.logicalMaximum(pipelines.field('maxOwn'), pipelines.field('maxChildren')),
          0,
        ),
        args.changedSinceMs,
      ),
    )
    .sort(pipelines.ascending(pipelines.field('__name__')))
    .limit(pageLimit)
    .select(...stockFamilyProjection(builders))
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

/* ---------------------- by-ids discovery (manual push) --------------------- */

export interface FetchStockFamiliesByIdsArgs {
  /** Conta being pushed — drives the link join. */
  integracaoId: string;
  /** Depósito doc id — both accepted `depositoOuterRef` forms are derived. */
  depositoId: string;
  /** Family ANCHOR ids, already resolved from any selected variation child. */
  anchorIds: readonly string[];
}

/** The seam the manual push consumes — injectable so tests stub it. */
export type FetchStockFamiliesByIds = (
  db: Firestore,
  args: FetchStockFamiliesByIdsArgs,
) => Promise<StockFamilyRow[]>;

/**
 * THE query, scoped to an explicit set of anchors — the manual "enviar estoque
 * agora" push (#819). Same joins, same projection ({@link stockFamilyProjection}),
 * so the number an operator sends by hand is derived exactly like the one the
 * sweep sends minutes later.
 *
 * Three deliberate differences from {@link fetchStockFamilies}:
 *
 *  1. **`documents([...])` is the SOURCE stage**, not `collection(...)`. That is
 *     a batch KEY read: there is no index to ride and none to miss, so the
 *     Enterprise "unindexed predicate silently full-scans and bills data
 *     scanned" trap (root CLAUDE.md rule 1) is structurally unaskable here. The
 *     `__name__ equalAny` alternative would have to be explain-proven — the
 *     staging gate already found that a *variable* candidate list binds only as
 *     a residual `Filter`, which would scan the conta's whole published
 *     catalogue on every operator click.
 *  2. **No `addFields`/window filter.** A manual push is force-send by
 *     definition — the operator is asserting the published number is wrong — so
 *     it must not run two correlated MAX aggregates per anchor to ask "did it
 *     change". Consequently the caller runs NO ledger pre-pass either: no
 *     `fetchMovimentosDaJanela`, no `quantidadesAnteriores`, no
 *     `deveEnviarFamilia`. That is the answer to "why doesn't this call
 *     deveEnviarFamilia".
 *  3. **No `paiId` / `publicado` / `integracoesComProduto` anchor terms.** Those
 *     exist to bound the SWEEP's scan and buy nothing against ≤50 point reads.
 *     Dropping them is what makes `buildSendTasks`' `'nao-publicado'` and
 *     `'conta-fora-do-produto'` rungs actually fire, turning #804's "three
 *     classes silently drop out, none produces a skip row" into an explicit,
 *     operator-visible row.
 *
 * ⚠️ `documents()` requires a NON-EMPTY, DUPLICATE-FREE list and **silently
 * omits a missing document**. The caller therefore dedupes and short-circuits
 * empty before calling (never let the throw be control flow — the `idIn: []`
 * rule), and reports a requested anchor that comes back with no row itself.
 *
 * NOT emulator-runnable (pipelines never are) — tested through the seam.
 */
export const fetchStockFamiliesByIds: FetchStockFamiliesByIds = async (db, args) => {
  const anchorIds = [...new Set(args.anchorIds)];
  if (anchorIds.length === 0) {
    // Mirrors buildPipeline's `idIn: []` guard: an empty candidate list means
    // "no rows", and falling through to a collection source would full-scan.
    throw new Error('fetchStockFamiliesByIds: anchorIds vazio — o chamador deve curto-circuitar.');
  }

  const builders = stockJoinBuilders(db, args.integracaoId, args.depositoId);

  // No eslint-disable needed here, unlike the `collection(...)` sources above:
  // the refs come from `produtoCollection.docRef`, so nothing raw is addressed.
  const snap = await db
    .pipeline()
    .documents(anchorIds.map((id) => produtoCollection.docRef(db, {}, id)))
    .define(
      pipelines.documentId(pipelines.field('__name__')).as('anchorId'),
      builders.kitKeysDefine('anchorKitKeys'),
    )
    .sort(pipelines.ascending(pipelines.field('__name__')))
    .select(...stockFamilyProjection(builders))
    .execute();

  const rows: StockFamilyRow[] = [];
  for (const result of snap.results) {
    const data = result.data() as Record<string, unknown>;
    const anchorId =
      typeof data.anchorId === 'string' && data.anchorId !== '' ? data.anchorId : null;
    if (anchorId == null) continue; // projected server-side; purely defensive
    rows.push(mapFamilyRow(anchorId, data));
  }
  return rows;
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

/* ------------------------- ledger movement pre-pass ------------------------ */

/** Net movement of one `(produto, depósito)` pair over the sweep's window. */
export interface MovimentoDaJanela {
  /** Σ `movimento` — the signed change in `quantidade`. */
  dq: number;
  /** Σ `movimentoReservada` — the signed change in `quantidadeReservada`. */
  dr: number;
  /**
   * At least one row in the window carries **no `movimento` key**, so the sums
   * above do not account for the whole window and `anterior` cannot be
   * reconstructed. Consumers must treat the pair as *unknown* and send —
   * never as "the sums say it did not move", which is how a legacy row would
   * otherwise silence a real movement.
   *
   * ⚠️ "Unknown" has exactly ONE wire representation: the field is **absent**.
   * `historicoEstoque` v2 writes `movimento` on every row it creates, and the
   * v1→v2 migration OMITS the key on a balanço whose delta it cannot recover
   * rather than storing an explicit `null` — precisely so this single
   * existence test is complete. Keep it that way.
   */
  desconhecido: boolean;
}

/** Map key for {@link MovimentosDaJanela}. Exported so tests build fixtures. */
export function chaveMovimento(produtoId: string, depositoId: string): string {
  return `${produtoId}/${depositoId}`;
}

export type MovimentosDaJanela = ReadonlyMap<string, MovimentoDaJanela>;

export interface FetchMovimentosArgs {
  /** Inclusive lower bound (ms since epoch) — the sweep's frozen window start. */
  desdeMs: number;
  /** Scopes the aggregate to the conta's depósito. */
  depositoId: string;
}

/** The movement seam the sweeps consume — injectable so tests stub it. */
export type FetchMovimentosDaJanela = (
  db: Firestore,
  args: FetchMovimentosArgs,
) => Promise<MovimentosDaJanela>;

/**
 * The UNCORRELATED ledger pre-pass: **ONE** pipeline execution per tick,
 * returning the net stock movement of every `(produto, depósito)` pair that
 * moved inside the window. `anterior = atual − Σmovimento` then falls out
 * locally, for every family, at no per-family cost.
 *
 * This REPLACES the `pedidos` sold-ids pass (ADR 0014). That pass existed only
 * because a kit sale left no trace on the kit, and it answered a weaker
 * question ("did something sell") with a silent 10 000-id cap (#806 S10). Asking
 * the stock ledger instead answers the question the sweep actually has — *did
 * the published number change* — and cannot truncate: the result is one row per
 * moved pair, not per movement.
 *
 * ⚠️ Requires `historicoEstoque` v2, where `movimento` is a signed delta on
 * **every** row including a balanço. v1 stored a balanço's absolute counted
 * value in the same field, which would make this sum silently wrong rather than
 * visibly absent — the reason the schema had to change first.
 *
 * ⚠️ **Index**: `historicoEstoque(timestamp, parentId, depositoOuterRef)`,
 * COLLECTION_GROUP. An aggregate without a covering index buffers every group in
 * the 128 MiB budget and can `RESOURCE_EXHAUSTED` — this one is not optional.
 *
 * Fails OPEN **explicitly**, not by omission. A row whose `movimento` key is
 * absent (a legacy-era v1 row — the migrated corpus is full of them) is skipped
 * by `sum`, which on its own would make the window look
 * like it moved nothing and let {@link deveEnviarFamilia} SKIP a real movement.
 * So the aggregate also counts those rows per group and reports
 * {@link MovimentoDaJanela.desconhecido}; the reconstruction then drops the pair
 * and the policy sends. A pair simply **absent** from the result did not move at
 * all — that one is genuinely unchanged, and skipping it is the point.
 *
 * ⚠️ Still blind to a quantity written with **no ledger row whatsoever** (the ML
 * import's unaudited `merge`, `import.ts` / `importVariations.ts`): there is
 * nothing in the window to count. That gap is closed at the source, by making
 * that writer append a row — tracked separately.
 *
 * NOT emulator-runnable (pipelines never are) — tested through the seam.
 */
export const fetchMovimentosDaJanela: FetchMovimentosDaJanela = async (db, args) => {
  // Both accepted *OuterRef forms (outerRef.ts invariant: readers tolerate the
  // bare form) — the same disjunction THE query uses.
  const depMatch = pipelines.or(
    pipelines.equal(pipelines.field('depositoOuterRef'), `documents/depositos/${args.depositoId}`),
    pipelines.equal(pipelines.field('depositoOuterRef'), `depositos/${args.depositoId}`),
  );

  // eslint-disable-next-line no-restricted-syntax -- pipeline SOURCE stage, not a raw ref; defineAdminCollection handles have no pipeline surface
  const snap = await db
    .pipeline()
    .collectionGroup('historicoEstoque')
    .where(pipelines.and(pipelines.field('timestamp').greaterThanOrEqual(args.desdeMs), depMatch))
    .aggregate({
      accumulators: [
        pipelines.sum('movimento').as('dq'),
        pipelines.sum('movimentoReservada').as('dr'),
        // The fail-open counter: rows `sum` silently ignored because they carry
        // no `movimento` at all. Same scan, no extra query.
        pipelines.countIf(pipelines.not(pipelines.exists('movimento'))).as('nDesconhecido'),
      ],
      groups: ['parentId', 'depositoOuterRef'],
    })
    .execute();

  const movimentos = new Map<string, MovimentoDaJanela>();
  for (const result of snap.results) {
    const row = result.data() as Record<string, unknown>;
    const parentId = row.parentId;
    if (typeof parentId !== 'string' || parentId === '') continue;
    // The aggregate groups by the RAW `depositoOuterRef`, and the filter above
    // accepts both accepted encodings (`documents/depositos/x` and
    // `depositos/x` — the outerRef.ts invariant), so ONE pair can come back as
    // TWO groups. The scope is a single depósito either way, so key on the arg
    // and ACCUMULATE — a `set` here would drop whichever group arrived first.
    const chave = chaveMovimento(parentId, args.depositoId);
    const anterior = movimentos.get(chave);
    movimentos.set(chave, {
      dq: (anterior?.dq ?? 0) + (finiteNumber(row.dq) ?? 0),
      dr: (anterior?.dr ?? 0) + (finiteNumber(row.dr) ?? 0),
      desconhecido: (anterior?.desconhecido ?? false) || (finiteNumber(row.nDesconhecido) ?? 0) > 0,
    });
  }
  return movimentos;
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

export interface StatusGate {
  /** May this listing receive an `available_quantity` update? */
  enviar: boolean;
  /** Status outside the documented set (null/undefined included) — caller logs. */
  desconhecido: boolean;
}

/**
 * The listing-status whitelist (module doc): send iff `status === 'active'` OR
 * (`'paused'` AND `sub_status` includes `'out_of_stock'` — ML auto-reactivates
 * on qty>0). A null/undefined/undocumented status is `desconhecido` and never
 * `enviar`.
 *
 * ⚠️ A null answers `enviar: false` for EVERY caller, deliberately. Three of the
 * four call sites pass a LIVE `GET /items` response (#781's send-time
 * verification, the `items` re-arm in `itemsStatusSync`, and the
 * `reverificar-anuncio` route), where a null status means ML reported none —
 * which must never read as sendable, or a latched listing re-arms itself. Only
 * `buildSendTasks` passes a stored link doc, where a null instead means "written
 * by the Flutter app before the field existed" (#780) — a different question,
 * answered by its own rung there rather than by widening this contract.
 */
export function podeEnviarEstoque(
  status: string | null | undefined,
  subStatus: string[] | null | undefined,
): StatusGate {
  const desconhecido = status == null || !DOCUMENTED_ML_STATUSES.has(status);
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
 * The constraining components this kit declares that the join did **not** bring
 * back — i.e. the ones whose stock we cannot see. Empty for a non-kit, for a kit
 * with no constraining component, and for a kit whose components all resolved.
 *
 * "Constraining" has to mean exactly what {@link kitEstoqueDisponivel} means by
 * it, or the guard and the arithmetic drift apart: `limitarEstoque !== false`
 * and a finite `quantidade > 0`, over `componentesKitEntries`' shape filter.
 *
 * The usual cause is a stale `componentesKitKeys` denorm: the join is keyed on
 * that array, so a component missing from it is never fetched and
 * `kitEstoqueDisponivel` scores it 0 (#238) — the kit floors to 0 without
 * anything having gone wrong with its actual stock. A component that genuinely
 * has no estoque doc at this depósito lands here too, and is treated the same,
 * because from here the two are indistinguishable.
 */
function componentesNaoResolvidos(member: FamilyMember): string[] {
  if (!member.ehKit || member.ehKitVirtual) return [];
  const disponiveis = disponivelByProdutoIdFrom(member.componentEstoques);
  return componentesKitEntries(member.componentesKit)
    .filter(([, kit]) => kit.limitarEstoque !== false)
    .filter(([, kit]) => Number.isFinite(kit.quantidade) && kit.quantidade > 0)
    .filter(([produtoId]) => typeof disponiveis[produtoId] !== 'number')
    .map(([produtoId]) => produtoId);
}

/**
 * True when a kit's published quantity **cannot be verified**: it declares
 * constraining components and not one of them resolved.
 *
 * ⚠️ This does NOT suppress the send — it forces it. See
 * {@link quantidadesAnteriores}, which omits such a member so
 * {@link deveEnviarFamilia} fails open, and the `console.error` in
 * {@link buildSendTasks}. The full reasoning lives in ADR 0014, but the short
 * version belongs here because this is where it would be inverted:
 *
 * **An unverifiable kit publishes 0, and that is the safe direction.** ML
 * auto-reactivates a listing paused as `out_of_stock` the moment a positive
 * quantity arrives (see {@link podeEnviarEstoque}, which keeps sending to
 * exactly that state), so a zeroed listing heals itself. Leaving ML holding
 * whatever it already has does not: if that number is positive, the listing
 * keeps selling stock the ERP cannot account for, and an oversell cannot be
 * un-sold.
 *
 * ⚠️ #806 S12 proposed the opposite — skip rather than send 0 — and that was
 * **deliberately inverted**, not left undone. Do not "restore" it from the issue
 * text.
 */
function kitNaoVerificavel(member: FamilyMember): boolean {
  const declarados = componentesKitEntries(member.componentesKit).filter(
    ([, kit]) =>
      kit.limitarEstoque !== false && Number.isFinite(kit.quantidade) && kit.quantidade > 0,
  );
  if (declarados.length === 0) return false;
  return componentesNaoResolvidos(member).length === declarados.length;
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
 * The window's net movement for the pair one estoque row belongs to.
 *
 * ⚠️ The owning produto is passed **in**, never read off the row — that is #932.
 * THE query does not project `parentId` on a member's OWN estoque row
 * (`ownEstoque`'s `select`, and it has no reason to: a `subcollection('estoques')`
 * probe is already bound to the produto being processed, so the owner IS
 * `member.produtoId`). Reading the denorm here instead made every own row
 * unkeyable, and an unkeyable row reads as "did not move" — a silent skip that
 * dropped every ordinary produto's stock change on every tier. Component rows
 * DO carry the denorm, because their join (`compEstoques`) matches on it.
 */
function movimentoDaLinha(
  produtoId: unknown,
  depositoId: string,
  movimentos: MovimentosDaJanela,
): MovimentoDaJanela | null {
  // No join key ⇒ nothing in the ledger can be attributed to this row. Reads as
  // "did not move", the same as a pair with no rows in the window.
  if (typeof produtoId !== 'string' || produtoId === '') return null;
  return movimentos.get(chaveMovimento(produtoId, depositoId)) ?? null;
}

/**
 * Rebuild ONE member's estoque row as it stood at the window start, by undoing
 * the window's net movement. `null` when the pair never moved — the caller reads
 * that as "unchanged", which is exactly right.
 *
 * ⚠️ Only call this once {@link movimentoDesconhecido} has cleared the row. A
 * pair with an unreadable row has meaningless sums, and subtracting them would
 * manufacture a *confident* wrong `anterior` — the one outcome the fail-open
 * contract exists to prevent.
 */
function desfazerMovimento(
  row: RawEstoqueRow,
  produtoId: unknown,
  depositoId: string,
  movimentos: MovimentosDaJanela,
): RawEstoqueRow | null {
  const mov = movimentoDaLinha(produtoId, depositoId, movimentos);
  if (mov == null) return null;
  return {
    ...row,
    quantidade: (finiteNumber(row.quantidade) ?? 0) - mov.dq,
    quantidadeReservada: (finiteNumber(row.quantidadeReservada) ?? 0) - mov.dr,
  };
}

/** True when this row's pair moved by an amount the ledger cannot report. */
function movimentoDesconhecido(
  produtoId: unknown,
  depositoId: string,
  movimentos: MovimentosDaJanela,
): boolean {
  return movimentoDaLinha(produtoId, depositoId, movimentos)?.desconhecido === true;
}

/**
 * Every family member's send quantity **as it stood at the window start** —
 * `atual − Σmovimento`, run back through the SAME kit math so a kit's floor is
 * recomputed rather than approximated.
 *
 * This is what lets the sweep answer "did the published number actually change"
 * without any per-family query: {@link fetchMovimentosDaJanela} pays once per
 * tick, and this is pure arithmetic on top of it.
 *
 * ⚠️ A member is **omitted** — not approximated — when any estoque its quantity
 * depends on (its own, or a kit component's) moved by an unreadable amount.
 * {@link deveEnviarFamilia} reads a missing entry as *unknown* and sends. This
 * is the fail-open path, and it only works because the member is left out
 * entirely: a fallback to the current row would read as "unchanged" and skip.
 *
 * ⚠️ The two row classes are keyed DIFFERENTLY and must stay that way (#932): a
 * member's OWN row by `member.produtoId` (the subcollection probe is bound to
 * that produto, so the projection has no `parentId` to give), a component row by
 * its `parentId` denorm (its collection-group join matches on exactly that).
 */
export function quantidadesAnteriores(
  row: StockFamilyRow,
  depositoId: string,
  movimentos: MovimentosDaJanela,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const member of [row.anchor, ...row.children]) {
    // ⚠️ THE OMISSION IS THE MECHANISM, for both arms below. A member left out
    // of this map is read by `deveEnviarFamilia` as *unknown* and SENDS.
    // Falling back to the current row instead would make `anterior === atual`
    // and skip — which is a silent drop, not a safe default.
    const desconhecido =
      (member.estoque != null && movimentoDesconhecido(member.produtoId, depositoId, movimentos)) ||
      member.componentEstoques.some((e) =>
        movimentoDesconhecido(e.parentId, depositoId, movimentos),
      );
    // A kit whose components did not resolve is unverifiable, and the ledger
    // cannot tell us so: the reconstruction would rebuild `anterior` from the
    // SAME broken component set, land on the same 0, and conclude "unchanged"
    // about a listing whose published number may be badly wrong. Omitting it
    // forces the send, and what gets sent is 0 — the safe direction, because ML
    // auto-reactivates on qty > 0 while an oversell cannot be undone. This is
    // #806 S12, resolved in the opposite direction to the one it proposed; see
    // {@link kitNaoVerificavel} and ADR 0014 before changing it.
    if (desconhecido || kitNaoVerificavel(member)) continue;
    const anterior: FamilyMember = {
      ...member,
      estoque:
        member.estoque == null
          ? null
          : (desfazerMovimento(member.estoque, member.produtoId, depositoId, movimentos) ??
            member.estoque),
      componentEstoques: member.componentEstoques.map(
        (e) => desfazerMovimento(e, e.parentId, depositoId, movimentos) ?? e,
      ),
    };
    const quantidade = quantidadeDoMembro(anterior);
    if (quantidade != null) out.set(member.produtoId, quantidade);
  }
  return out;
}

/**
 * The send policy (ADR 0014), replacing the old sold/recent/low-stock activity
 * heuristic. Exact rather than approximate, because the ledger can now be summed:
 *
 * ```
 * send  ⟺  ∃ member: anterior ≠ atual  ∧  ¬( incremental ∧ min(anterior, atual) > LIMIAR_ALTO )
 * ```
 *
 * The first clause is the #695 ask — a component movement that does not change a
 * kit's floored quantity produces no task. The second is the freshness tier: a
 * listing sitting comfortably high on BOTH sides of the movement cannot oversell
 * inside a 15-minute window, so it waits for the daily pass.
 *
 * ⚠️ `min(anterior, atual)`, never `atual` alone — see {@link limiarEstoqueAlto}.
 * `110 → 95` must send; gating on the current value would skip it.
 *
 * Fails OPEN: a member with no reconstructed previous value is treated as
 * changed. That single rule is the inventory of every "this sends even though
 * nothing looks like it moved" case, so keep it complete:
 *  - the first sweep after deploy (no baseline at all);
 *  - a Flutter-era `historicoEstoque` row carrying no `movimento`, which `sum`
 *    silently ignores;
 *  - the ML import's unaudited `merge`, which moves a quantity while writing no
 *    ledger row;
 *  - a kit whose constraining components did not resolve, so its quantity
 *    cannot be verified at all ({@link kitNaoVerificavel}) — it sends 0.
 */
export function deveEnviarFamilia(
  quantidadesAtuais: ReadonlyMap<string, number>,
  anteriores: ReadonlyMap<string, number> | null,
  incremental: boolean,
): boolean {
  if (anteriores == null) return true;
  const limiar = limiarEstoqueAlto();
  for (const [produtoId, atual] of quantidadesAtuais) {
    const anterior = anteriores.get(produtoId);
    if (anterior == null) return true; // unknown ⇒ send
    if (anterior === atual) continue; // this member did not move
    if (!incremental) return true; // daily/full: any change is enough
    if (Math.min(anterior, atual) <= limiar) return true; // near the danger zone
    // Changed, but high on both sides — not worth the fast lane. Keep looking:
    // a sibling variation may still be low enough to justify the whole send.
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
  /**
   * The ML item id, when the rung that fired knew one. Present so the manual
   * push (#819) can name WHICH anúncio it skipped instead of only the produto —
   * a family can hold several listings on one conta (the link join deliberately
   * has no `limit(1)`), so "produto X: anúncio em erro" is not actionable.
   * Absent on anchor-level rungs and on `'sem-item-id'` (there is no id yet).
   *
   * The sweep only reads `skips.length`, so this is purely additive. Do NOT
   * re-derive the link join outside `buildSendTasks` to get it — that second
   * derivation is exactly how the sent quantity drifts.
   */
  itemId?: string | null;
  /** The `produtoMercadoLivre` link doc, when the rung that fired knew one. */
  linkDocId?: string | null;
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
 * `'aguardando-migracao'` (`estado 'am'`, mid-UP-migration — stamped by
 * `itemsStatusSync` from ML's own migration tags, which is the value's only
 * producer now that the Flutter app is switched off at the cutover, #1087),
 * `'anuncio-em-erro'` (`estado 'E'` — the send handler verified with ML that the
 * anúncio is healthy and it was our PAYLOAD that was refused, so re-sending it
 * unchanged only re-earns the rejection, #781), `'status-nao-enviavel'`
 * (whitelist gate PER listing; `desconhecido` statuses additionally warn with
 * that listing's itemId — status tracking per Lucas). A listing whose `status`
 * is ABSENT skips the whitelist entirely and sends optimistically (#780 — the
 * legacy arm, module doc), the sole exception being `estado 'c'`, which reuses
 * `'status-nao-enviavel'`.
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
  // DEFENSIVE-ONLY rung: S1 already filters the conta server-side (keep the S1
  // term). Since #920 it earns its keep twice over — the array is maintained by
  // an EVENTUALLY-consistent trigger, so this is the rung that catches a stale
  // entry the trigger has not caught up with. Keep both it and the S6
  // projection: dropping the projection alone silently disables this check.
  if (!row.integracoesComProduto.includes(opts.integracaoId)) {
    return skipOnly(anchorId, 'conta-fora-do-produto');
  }

  // ⚠️ The alarm for an unverifiable kit — and it is ONLY an alarm. The member
  // still emits, carrying the 0 that `kitEstoqueDisponivel` computed, because
  // publishing 0 is the recoverable direction: ML auto-reactivates the listing
  // when a positive quantity next arrives, whereas leaving it advertising a
  // stale positive number sells stock the ERP cannot account for.
  //
  // Do NOT turn this into a `skips.push(...)` next to the `'kit-virtual'` rung
  // below. That is #806 S12's proposal and it was deliberately inverted (ADR
  // 0014); a skip here re-opens the oversell it was filed against.
  //
  // What the log is FOR: the zero itself is legitimate, but a kit reaching this
  // state usually means a stale `componentesKitKeys` denorm, which is a data
  // defect nothing else surfaces. Naming the components makes it findable.
  for (const member of [row.anchor, ...row.children]) {
    if (!kitNaoVerificavel(member)) continue;
    console.error(
      '[mercado-livre] stock-sync: kit sem componentes resolvíveis — publicando 0 ' +
        '(provável `componentesKitKeys` desatualizado)',
      {
        integracaoId: opts.integracaoId,
        produtoId: member.produtoId,
        anchorId,
        componentes: componentesNaoResolvidos(member).slice(0, 10),
      },
    );
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
      skips.push({ produtoId: anchorId, reason: 'sem-item-id', linkDocId });
      continue;
    }
    if (link.estado === 'am') {
      skips.push({ produtoId: anchorId, reason: 'aguardando-migracao', itemId, linkDocId });
      continue;
    }
    // #781: the send handler's terminal branch stamps `'E'` when ML confirmed the
    // anúncio is healthy and it was therefore OUR payload it refused — rebuilding
    // the identical payload next tick just re-earns the same rejection. Every
    // other terminal case records the listing's real ML status instead, and the
    // whitelist below skips those. Cleared by an `items` webhook or the produto
    // tab's "Reverificar anúncio" action.
    if (link.estado === ESTADO_PUBLICACAO_ML.erro) {
      skips.push({ produtoId: anchorId, reason: 'anuncio-em-erro', itemId, linkDocId });
      continue;
    }

    if (link.status == null) {
      // #780 — LEGACY-authored link. `status`/`sub_status` arrived with the
      // `items` status-sync (#440); the legacy app that authored the migrated
      // links never wrote them, so EVERY inherited link is null here. Running them through the whitelist would answer "não enviável"
      // for the whole catalogue, making the flag flip a total, silent stock
      // outage — and a listing that never changes never fires `items`, so it
      // would never self-heal either.
      //
      // They are therefore sent OPTIMISTICALLY, because the send is its own
      // backfill and both of its outcomes record the real status: an accepted
      // PUT returns the listing and `estoqueSend` writes `status`/`sub_status`
      // straight back, and a rejected one is verified against ML on the last
      // attempt (#781) and writes them back too. So the null resolves to real
      // ML data either way — at zero extra API cost on the happy path, which no
      // pre-flip `GET` pass can match, and with no ordering requirement against
      // the flag flip.
      //
      // The one trim: `estado 'c'` is the Flutter app already telling us the
      // listing is closed, so the send is a doomed 3 PUTs + 1 GET (#781's
      // ladder) that teaches nothing. `'E'` needs no rung here — the
      // `anuncio-em-erro` rung above already took it. `'pa'` is deliberately
      // NOT trimmed: `estado` cannot express sub-status, so a paused legacy
      // link may well be `paused/out_of_stock`, which the whitelist admits, and
      // trimming it would leave it unsent forever — the very outage this closes.
      //
      // This rung lives HERE rather than inside `podeEnviarEstoque` because the
      // question is specific to a STORED link doc. The gate's other callers
      // pass a live ML response, where a null status means something else
      // entirely — see its docblock.
      if (link.estado === ESTADO_PUBLICACAO_ML.cancelado) {
        skips.push({ produtoId: anchorId, reason: 'status-nao-enviavel', itemId, linkDocId });
        continue;
      }
    } else {
      const statusGate = podeEnviarEstoque(
        typeof link.status === 'string' ? link.status : null,
        Array.isArray(link.sub_status)
          ? link.sub_status.filter((s): s is string => typeof s === 'string')
          : null,
      );
      // Reached only for a status that is PRESENT, so `desconhecido` here is a
      // real ML-side surprise and stays loud (status tracking, per Lucas). The
      // legacy null above is the expected shape, not an anomaly, and is not
      // logged at all: at one line per listing per tick it would bury the tick
      // summary on the first sweeps after the flag flip.
      if (statusGate.desconhecido) {
        console.warn('[mercado-livre] stock-sync: status de anúncio fora do conjunto documentado', {
          integracaoId: opts.integracaoId,
          produtoId: anchorId,
          itemId,
          status: link.status,
        });
      }
      if (!statusGate.enviar) {
        skips.push({ produtoId: anchorId, reason: 'status-nao-enviavel', itemId, linkDocId });
        continue;
      }
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

    // Exact string match is safe here — this field is always the canonical
    // `documents/...` form, in migrated docs too (see importVariations.ts).
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
          skips.push({ produtoId: child.produtoId, reason: 'sem-link', itemId, linkDocId });
          continue;
        }
        const varId =
          typeof varLink.id === 'number' && Number.isFinite(varLink.id) ? varLink.id : null;
        if (varId == null) {
          skips.push({ produtoId: child.produtoId, reason: 'sem-item-id', itemId, linkDocId });
          continue;
        }
        const quantidade = quantidades.get(child.produtoId) ?? null;
        if (quantidade == null) {
          skips.push({ produtoId: child.produtoId, reason: 'kit-virtual', itemId, linkDocId });
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
        skips.push({ produtoId: anchorId, reason: 'variations-excede-limite', itemId, linkDocId });
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
        skips.push({ produtoId: child.produtoId, reason: 'sem-link', linkDocId });
        continue;
      }
      const varItemId =
        typeof varLink.itemId === 'string' && varLink.itemId !== '' ? varLink.itemId : null;
      if (varItemId == null) {
        skips.push({ produtoId: child.produtoId, reason: 'sem-item-id', linkDocId });
        continue;
      }
      if (emittedItemIds.has(varItemId)) continue; // cycle-wide dedup — silent (set above)
      const quantidade = quantidades.get(child.produtoId) ?? null;
      if (quantidade == null) {
        skips.push({
          produtoId: child.produtoId,
          reason: 'kit-virtual',
          itemId: varItemId,
          linkDocId,
        });
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
