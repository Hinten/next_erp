/**
 * Mercado Livre **stock-sync compute core** (Step 10 PR A) — the building
 * blocks behind the 15-minute + 2AM stock sweeps (PR C) and the
 * `sendMercadoLivreStock` task handler (PR B). No scheduling, no task enqueue
 * and no ML API call lives here: this module only DISCOVERS which produtos had
 * stock movement, decides whether a listing may receive stock at all, resolves
 * a produto family into per-ML-call send units, and computes the quantity to
 * send.
 *
 * Legacy parity anchors (`.old/packages/canais_de_venda`, verified 2026-07-24):
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
 *    `quantidadeParaEnvio` returns null and the send-unit resolution skips
 *    `'kit-virtual'`.
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
 * ---- Discovery/resolution = TWO pipeline executions per conta per sweep (the
 * owner-approved joined design, PR #678 review). Against the ~19k-produto
 * catalog the first cut (driver pipeline + chunked classic kit queries +
 * per-candidate doc reads) issued O(candidates) queries per sweep; correlated
 * subqueries push every join server-side, so the query COUNT stays constant:
 *   Q1 `fetchChangedEstoquesJoined` — changed estoques of one depósito with,
 *      per row: the owning produto (scalar join on `__name__`), the kit
 *      parents consuming it (reverse join on `componentesKitKeys`) and a 30d
 *      sales flag (`historicoEstoque` probe). Keyset-paginated
 *      (`ultimaModificacao` + `__name__` tuple — no re-fetch, no dedup).
 *   Q2 `fetchResolutionBundle` — one `documents()` pipeline over the family
 *      anchors, joining this conta's `produtoMercadoLivre` link (scalar) and
 *      the variation children + their `variacaoMercadoLivre` links (nested
 *      array — nesting depth 3 of the 20 allowed).
 * Constant query count is NOT free per row: every correlated subquery seeks
 * its own index once per outer row, and Enterprise auto-creates NO indexes —
 * an unindexed subquery silently full-scans per row, billed by data scanned.
 * Index ledger (PR C declares the new entries):
 *  - driver: `estoques(depositoOuterRef ASC, ultimaModificacao ASC, __name__
 *    ASC)` COLLECTION_GROUP — `__name__` EXPLICIT (Enterprise omits the
 *    implicit trailing key Standard docs assume; the keyset tuple needs it);
 *  - produto scalar join: `__name__` equality → primary-key seek, no entry;
 *  - kit reverse join: `produtos(componentesKitKeys CONTAINS)`;
 *  - sales probe: `historicoEstoque(tipo ASC, timestamp ASC)` COLLECTION_GROUP;
 *  - children: the `paiId` equality rides the existing `produtos(paiId, nome)`
 *    index as a prefix;
 *  - link probe: unindexed scan of a 1-2 doc subcollection — noise.
 * The 128 MiB materialization ceiling spans the WHOLE query including every
 * joined document — hence each subquery `select`s a minimal field set (ids +
 * link scalars, never full produto docs) and the sales probe is `limit(1)`.
 *
 * ---- `ehExpansaoDeKit` provenance honesty: a kit parent discovered through a
 * changed COMPONENT carries the **component's** estoque doc path, timestamp,
 * quantities and `temVenda30d` in its `EstoqueCandidato` — the parent's own
 * estoque/produto is NOT read during discovery (`produto: null`; Q2's anchor
 * read supplies the parent's gate fields). Downstream filters (PR C's
 * low-stock limiar) therefore evaluate the TRIGGERING doc, and the real family
 * quantity is always recomputed fresh by `computeQuantidades` at send time.
 *
 * ---- Config: business tunables read `process.env` LAZILY (at call time,
 * never at module load — mirrors `orderBackfill`'s flag check) so functions
 * cold starts and the unit tests both see current values; pure mechanics stay
 * code constants.
 */
import type { DocumentReference, Firestore } from 'firebase-admin/firestore';
// Pipeline expression builders live in the `/pipelines` subpath (admin
// `@google-cloud/firestore` v8). Namespace import — the module is `export =`d.
import * as pipelines from '@google-cloud/firestore/pipelines';
import {
  type ComponentesKit,
  componentesKitEntries,
  estoqueDisponivel,
  kitEstoqueDisponivel,
  makeEstoqueUid,
  toOuterRef,
} from '@delfrance/schemas';
import {
  estoqueCollection,
  produtoCollection,
  produtoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';

/* ------------------------------ configuration ----------------------------- */

/** The env flag gating the whole stock sync — ON only when it is exactly `'1'`. */
export const STOCK_SYNC_FLAG_ENV = 'MERCADO_LIVRE_STOCK_SYNC_ENABLED';

/** Cloud Tasks queue name for the stock send tasks (PR B's `onTaskDispatched`). */
export const MERCADO_LIVRE_STOCK_SEND_QUEUE = 'sendMercadoLivreStock';

/** Lower clamp of every quantity sent to ML (legacy clamp >= 0). */
export const ESTOQUE_MIN = 0;

/**
 * `historicoEstoque.tipo` values that count as "had sales" for the incremental
 * sweep's 30-day activity filter (PR C). Flutter-era rows carry `tipo: null`
 * and deliberately do NOT count — bounded by the 2AM full sweep.
 */
export const TIPOS_VENDA = ['reserva', 'saida'] as const;

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

/** Changed-estoques pipeline page size. */
export function candidatePageLimit(): number {
  return envInt('MERCADO_LIVRE_STOCK_CANDIDATE_PAGE_LIMIT', 1000);
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

/* -------------------- Q1: joined changed-estoques driver -------------------- */

/** One changed estoque doc, flattened to what discovery + the limiar filter need. */
export interface ChangedEstoque {
  /** Owning produto — 2nd segment of the estoque doc path. */
  produtoId: string;
  /** Full `produtos/<id>/estoques/<estId>` doc path. */
  estoqueDocPath: string;
  /** The doc's `ultimaModificacao` (ms since epoch — produto/estoque standard). */
  ultimaModificacaoMs: number;
  quantidade: number;
  quantidadeReservada: number;
}

/**
 * Raw (unvalidated) produto gate fields joined server-side by Q1/Q2 — read
 * defensively, exactly like a `doc.data()` record.
 */
export interface RawGateFields {
  paiId?: unknown;
  publicado?: unknown;
  ehKit?: unknown;
  ehKitVirtual?: unknown;
  integracoesComProduto?: unknown;
  timestamp?: unknown;
  [key: string]: unknown;
}

/** One Q1 row: a changed estoque with its three server-side joins attached. */
export interface EstoqueChangeRow extends ChangedEstoque {
  /** Scalar-joined owning produto; null when deleted mid-sweep (0-row subquery). */
  produto: RawGateFields | null;
  /** Ids of kit produtos consuming this produto (`componentesKitKeys` reverse join). */
  kitParentIds: string[];
  /** True when the estoque had a `TIPOS_VENDA` movement since `tipoVendaCutoffMs`. */
  temVenda30d: boolean;
}

export interface FetchChangedEstoquesJoinedArgs {
  /**
   * Conta being swept. Q1's stages are conta-agnostic (stock movement is
   * per-depósito) — carried for call-shape symmetry with Q2 + sweep logging.
   */
  integracaoId: string;
  /** Canonical `documents/depositos/<id>` ref string stored on the estoque docs. */
  depositoOuterRef: string;
  /** Exclusive window start (ms since epoch). */
  fromMs: number;
  /** Inclusive lower bound (ms) of the sales-activity probe (now − 30d). */
  tipoVendaCutoffMs: number;
  /** Page size override — defaults to `candidatePageLimit()`. */
  pageLimit?: number;
}

/** The Q1 seam — `discoverStockCandidates` takes it injectable (tests stub it). */
export type FetchChangedEstoquesJoined = (
  db: Firestore,
  args: FetchChangedEstoquesJoinedArgs,
) => Promise<EstoqueChangeRow[]>;

/** Keyset cursor: the last row of the previous page (total order, module doc). */
interface KeysetCursor {
  ultimaModificacaoMs: number;
  ref: DocumentReference;
}

/**
 * Q1 (module doc): every estoque doc of one depósito changed after `fromMs`,
 * with the produto scalar join, the kit-parent reverse join and the 30d sales
 * flag attached per row by correlated subqueries. Ascending
 * (`ultimaModificacao`, `__name__`) total order; page 1 filters
 * `ultimaModificacao > fromMs`, later pages replace the range term with the
 * keyset tuple `(um > lastUm) OR (um == lastUm AND __name__ > lastRef)` — a
 * keyset page never re-fetches its boundary, so there is no dedup and
 * termination is simply "raw page shorter than `pageLimit`". The sales flag is
 * derived server-side (`.toArrayExpression().length().greaterThan(0)` — the
 * SKILL §4 `restaurant_count` chaining).
 *
 * The subqueries seek per row (index ledger in the module doc). `define`d
 * variables are dropped from the output, and there is deliberately NO outer
 * `select` stage: `row.ref` must survive (a `select` drops it) because
 * produtoId/estoqueDocPath are derived from the doc path client-side.
 *
 * NOT emulator-runnable (pipelines never are) — tested through the seam;
 * live-validated by PR C's `check-stock-indexes.mjs`.
 */
export const fetchChangedEstoquesJoined: FetchChangedEstoquesJoined = async (db, args) => {
  const pageLimit = args.pageLimit ?? candidatePageLimit();
  const rows: EstoqueChangeRow[] = [];
  let cursor: KeysetCursor | null = null;

  for (;;) {
    // Explicit annotation: breaks the loop's inference cycle (cursor ← last ←
    // snap ← rangeTerm ← cursor's flow type).
    const rangeTerm: pipelines.BooleanExpression =
      cursor == null
        ? pipelines.greaterThan(pipelines.field('ultimaModificacao'), args.fromMs)
        : pipelines.or(
            pipelines.greaterThan(pipelines.field('ultimaModificacao'), cursor.ultimaModificacaoMs),
            pipelines.and(
              pipelines.equal(pipelines.field('ultimaModificacao'), cursor.ultimaModificacaoMs),
              // constant() accepts a DocumentReference — the tuple tiebreaker.
              pipelines.greaterThan(pipelines.field('__name__'), pipelines.constant(cursor.ref)),
            ),
          );

    // eslint-disable-next-line no-restricted-syntax -- pipeline SOURCE stage, not a raw ref; defineAdminCollection handles have no pipeline surface
    const snap = await db
      .pipeline()
      .collectionGroup('estoques')
      .where(
        pipelines.and(
          // Both accepted *OuterRef forms (outerRef.ts invariant: readers
          // tolerate the bare form) — two leading-equality index seeks.
          pipelines.or(
            pipelines.equal(pipelines.field('depositoOuterRef'), args.depositoOuterRef),
            pipelines.equal(
              pipelines.field('depositoOuterRef'),
              args.depositoOuterRef.replace(/^documents\//, ''),
            ),
          ),
          rangeTerm,
        ),
      )
      .sort(
        pipelines.ascending(pipelines.field('ultimaModificacao')),
        pipelines.ascending(pipelines.field('__name__')),
      )
      .limit(pageLimit)
      // parent() of a DOCUMENT ref hops to the parent document (the api.md §5
      // manual-equivalent: one hop from a subcollection doc to its owner), so
      // estoque `produtos/<pid>/estoques/<eid>` → the produto DOCUMENT.
      .define(
        pipelines.parent(pipelines.field('__name__')).as('produtoRef'),
        pipelines.documentId(pipelines.parent(pipelines.field('__name__'))).as('produtoId'),
      )
      .addFields(
        // (a) produto scalar join — 0 rows (deleted mid-sweep) → null.
        // eslint-disable-next-line no-restricted-syntax -- correlated-subquery SOURCE stage, not a raw ref; defineAdminCollection handles have no pipeline surface
        db
          .pipeline()
          .collection('produtos')
          .where(pipelines.field('__name__').equal(pipelines.variable('produtoRef')))
          .select(
            'paiId',
            'publicado',
            'ehKit',
            'ehKitVirtual',
            'integracoesComProduto',
            'timestamp',
          )
          .toScalarExpression()
          .as('produto'),
        // (b) kit-parents reverse join — ids only (128 MiB ceiling, module doc).
        // eslint-disable-next-line no-restricted-syntax -- correlated-subquery SOURCE stage (see chain-start note above)
        db
          .pipeline()
          .collection('produtos')
          .where(
            pipelines.arrayContains(
              pipelines.field('componentesKitKeys'),
              pipelines.variable('produtoId'),
            ),
          )
          .select(pipelines.documentId(pipelines.field('__name__')).as('kitId'))
          .toArrayExpression()
          .as('kitParents'),
        // (c) 30d sales flag — `limit(1)` existence probe, boolean server-side.
        pipelines
          .subcollection('historicoEstoque')
          .where(
            pipelines.and(
              // equalAny only exists as an Expression METHOD in v8.6.0 (the
              // free-function form is a docs-only spelling — skill api.md).
              pipelines.field('tipo').equalAny([...TIPOS_VENDA]),
              pipelines.greaterThanOrEqual(pipelines.field('timestamp'), args.tipoVendaCutoffMs),
            ),
          )
          .limit(1)
          .select('tipo')
          .toArrayExpression()
          .length()
          .greaterThan(0)
          .as('temVenda30d'),
      )
      .execute();

    for (const row of snap.results) {
      if (!row.ref) continue; // no outer `select` → ref is present; guard the optional type
      const data = row.data() as Record<string, unknown>;
      const ms = finiteNumber(data.ultimaModificacao);
      if (ms == null) continue; // matched the range server-side; purely defensive
      const produtoId = row.ref.path.split('/')[1];
      if (!produtoId) continue;
      rows.push({
        produtoId,
        estoqueDocPath: row.ref.path,
        ultimaModificacaoMs: ms,
        quantidade: finiteNumber(data.quantidade) ?? 0,
        quantidadeReservada: finiteNumber(data.quantidadeReservada) ?? 0,
        produto: (data.produto ?? null) as RawGateFields | null,
        kitParentIds: Array.isArray(data.kitParents)
          ? data.kitParents.filter((k): k is string => typeof k === 'string')
          : [],
        temVenda30d: data.temVenda30d === true,
      });
    }

    if (snap.results.length < pageLimit) break; // backlog drained
    const last = snap.results[snap.results.length - 1];
    const lastMs =
      last == null
        ? null
        : finiteNumber((last.data() as Record<string, unknown>).ultimaModificacao);
    if (last?.ref == null || lastMs == null) break; // defensive — cannot form the keyset tuple
    cursor = { ultimaModificacaoMs: lastMs, ref: last.ref };
  }
  return rows;
};

/* -------------------------------- discovery -------------------------------- */

/**
 * One send candidate. ⚠️ When `ehExpansaoDeKit` is true the estoque fields
 * (path, timestamp, quantities) and `temVenda30d` belong to the TRIGGERING
 * COMPONENT's doc, and `produto` is null — the kit parent's own estoque/
 * produto was not read during discovery (module doc); Q2's anchor read
 * resolves the parent's gate fields.
 */
export interface EstoqueCandidato extends ChangedEstoque {
  ehExpansaoDeKit: boolean;
  /** Q1-joined gate fields of THIS produto; null on kit-parent expansions. */
  produto: RawGateFields | null;
  temVenda30d: boolean;
}

export type DiscoverStockCandidatesArgs = FetchChangedEstoquesJoinedArgs;

export interface DiscoverStockCandidatesDeps {
  fetchChanged?: FetchChangedEstoquesJoined;
}

/**
 * Discover every produto needing a stock send for one depósito window, from
 * Q1's joined rows alone (no further reads): the directly-changed estoques
 * plus every kit parent consuming one of them as a component
 * (`row.kitParentIds`). De-duped into a Map keyed by produtoId; a parent whose
 * OWN estoque also changed stays a direct candidate (`ehExpansaoDeKit: false`
 * wins). A row whose `produto` join came back null (deleted mid-sweep) yields
 * NO direct candidate, but its kit parents still expand — the parents exist
 * independently and their own gate fields come from Q2's anchor read.
 * Quantities + `temVenda30d` ride along so PR C's limiar/activity filters need
 * no re-read.
 */
export async function discoverStockCandidates(
  db: Firestore,
  args: DiscoverStockCandidatesArgs,
  deps: DiscoverStockCandidatesDeps = {},
): Promise<Map<string, EstoqueCandidato>> {
  const fetchChanged = deps.fetchChanged ?? fetchChangedEstoquesJoined;
  const rows = await fetchChanged(db, args);

  const out = new Map<string, EstoqueCandidato>();
  for (const row of rows) {
    if (row.produto == null) continue; // produto deleted mid-sweep — no direct candidate
    if (out.has(row.produtoId)) continue; // one estoque per (produto, depósito) — defensive
    out.set(row.produtoId, {
      produtoId: row.produtoId,
      estoqueDocPath: row.estoqueDocPath,
      ultimaModificacaoMs: row.ultimaModificacaoMs,
      quantidade: row.quantidade,
      quantidadeReservada: row.quantidadeReservada,
      ehExpansaoDeKit: false,
      produto: row.produto,
      temVenda30d: row.temVenda30d,
    });
  }
  for (const row of rows) {
    for (const kitId of row.kitParentIds) {
      if (out.has(kitId)) continue; // direct change wins over expansion; first trigger wins
      out.set(kitId, {
        produtoId: kitId,
        estoqueDocPath: row.estoqueDocPath, // the component's doc — provenance in the docblock
        ultimaModificacaoMs: row.ultimaModificacaoMs,
        quantidade: row.quantidade,
        quantidadeReservada: row.quantidadeReservada,
        ehExpansaoDeKit: true,
        produto: null,
        temVenda30d: row.temVenda30d,
      });
    }
  }
  return out;
}

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

/* -------------------------------- send units ------------------------------- */

export type SendUnitKind = 'item' | 'variationItem';

/** One send unit = exactly ONE ML API call (the whole point of the new queue). */
export interface SendUnit {
  kind: SendUnitKind;
  /** The ML item id the call targets (family MLB for `'item'`, per-variation for UP). */
  itemId: string;
  /** The family ANCHOR produto — quantities are computed for this family. */
  produtoId: string;
  /** UP model: the variation child behind `itemId`; null on `kind: 'item'`. */
  variacaoProdutoId: string | null;
}

export type SendSkipReason =
  | 'sem-link'
  | 'sem-item-id'
  | 'aguardando-migracao'
  | 'status-nao-enviavel'
  | 'kit-virtual'
  | 'nao-publicado'
  | 'conta-fora-do-produto';

export interface SendSkip {
  /** The produto the reason applies to — the family anchor, or the UP child. */
  produtoId: string;
  reason: SendSkipReason;
}

/**
 * The conta's `produtoMercadoLivre` link doc under the family anchor — the
 * send handler's writeback target (PR B merges the ML response status onto it).
 */
export interface ResolvedLinkIdentity {
  /** Link doc id under `produtos/{produtoId}/produtoMercadoLivre`. */
  docId: string;
  /** The family ANCHOR produto the link doc lives under. */
  produtoId: string;
}

export interface ResolvedSendUnits {
  units: SendUnit[];
  skips: SendSkip[];
  /** Null only on early skips, before the conta's link doc is found. */
  link: ResolvedLinkIdentity | null;
}

function skipOnly(
  produtoId: string,
  reason: SendSkipReason,
  link: ResolvedLinkIdentity | null = null,
): ResolvedSendUnits {
  return { units: [], skips: [{ produtoId, reason }], link };
}

/* ----------------------- Q2: resolution bundle + ladder --------------------- */

/** Raw variação link row joined by Q2 — read defensively. */
export interface BundleVarLink {
  itemId?: unknown;
  id?: unknown;
  produtoMercadoLivreOuterRef?: unknown;
  [key: string]: unknown;
}

/** One variation child of an anchor, with its variação links. */
export interface BundleChild {
  childId: string;
  varLinks: BundleVarLink[];
}

/** Raw `produtoMercadoLivre` link scalar joined by Q2 — read defensively. */
export interface BundleLink {
  id?: unknown;
  estado?: unknown;
  status?: unknown;
  sub_status?: unknown;
  isUserProductModel?: unknown;
  linkDocId?: unknown;
  [key: string]: unknown;
}

/** Everything `resolveSendUnitsFromBundle` needs about one family anchor. */
export interface ResolutionAnchor {
  anchorId: string;
  /** The anchor doc's own raw fields (the `documents()` row IS the anchor doc). */
  produto: RawGateFields;
  /** This conta's link, or null when the conta has none. */
  link: BundleLink | null;
  /** Variation children, sorted by childId (determinism — see the docblock). */
  children: BundleChild[];
}

/** Anchor produto id → its resolution data. Missing id = anchor doc deleted. */
export type ResolutionBundle = Map<string, ResolutionAnchor>;

export interface FetchResolutionBundleArgs {
  integracaoId: string;
  /** Family-anchor produto ids (doc refs are built internally). */
  anchorRefsOrIds: string[];
}

/**
 * Q2 (module doc): one `documents()` pipeline over the family anchors, joining
 * per anchor:
 *  (a) this conta's `produtoMercadoLivre` link — a `limit(1)` scalar subquery
 *      matching `contaOuterRef` against BOTH accepted `*OuterRef` forms
 *      (`documents/integracao/<id>` and bare `integracao/<id>`) — the same
 *      two forms the in-memory `refMatchesIntegracao` (linkRefs.ts) tolerates
 *      on the import read path. The canonical form is the wire rule
 *      (importVariations.ts) and legacy writes at most one link per conta,
 *      which is what makes the `limit(1)`-scalar safe.
 *  (b) the variation children (`paiId == anchor`) with their
 *      `variacaoMercadoLivre` links — a nested array subquery (depth 3 of 20),
 *      minimal fields only (128 MiB ceiling, module doc).
 * The anchor rows themselves carry the anchor's own gate fields (documents()
 * rows ARE the anchor docs; no outer `select` strips them — `row.ref` also
 * survives, providing the anchorId). A produto deleted mid-sweep is silently
 * omitted by `documents()` → missing bundle entry → `'sem-link'` downstream.
 *
 * `documents()` requires >= 1 doc and rejects duplicates — both guarded here.
 * Children are sorted by childId client-side purely for output determinism;
 * the legacy `nome` order is NOT needed because unit order feeds nothing
 * order-sensitive (each unit is an independent ML call).
 */
export async function fetchResolutionBundle(
  db: Firestore,
  { integracaoId, anchorRefsOrIds }: FetchResolutionBundleArgs,
): Promise<ResolutionBundle> {
  const bundle: ResolutionBundle = new Map();
  const uniqueIds = [...new Set(anchorRefsOrIds)];
  if (uniqueIds.length === 0) return bundle; // documents() needs at least one doc
  const anchorRefs = uniqueIds.map((id) => produtoCollection.docRef(db, {}, id));

  const snap = await db
    .pipeline()
    .documents(anchorRefs)
    .define(pipelines.documentId(pipelines.field('__name__')).as('anchorId'))
    .addFields(
      // (a) link scalar join — legacy writes at most one link per conta, and
      // limit(1) makes the scalar safe even against dirty duplicate links.
      pipelines
        .subcollection('produtoMercadoLivre')
        .where(
          // Both accepted *OuterRef forms — mirrors refMatchesIntegracao
          // (linkRefs.ts); a 1-2 doc subcollection, the or() costs nothing.
          pipelines.or(
            pipelines.equal(
              pipelines.field('contaOuterRef'),
              `documents/integracao/${integracaoId}`,
            ),
            pipelines.equal(pipelines.field('contaOuterRef'), `integracao/${integracaoId}`),
          ),
        )
        .limit(1)
        .select(
          'id',
          'estado',
          'status',
          'sub_status',
          'isUserProductModel',
          pipelines.documentId(pipelines.field('__name__')).as('linkDocId'),
        )
        .toScalarExpression()
        .as('link'),
      // (b) children + their variação links (each nested row is a CHILD, so
      // subcollection() joins on the child's __name__).
      // eslint-disable-next-line no-restricted-syntax -- correlated-subquery SOURCE stage, not a raw ref; defineAdminCollection handles have no pipeline surface
      db
        .pipeline()
        .collection('produtos')
        .where(pipelines.equal(pipelines.field('paiId'), pipelines.variable('anchorId')))
        .select(
          pipelines.documentId(pipelines.field('__name__')).as('childId'),
          pipelines
            .subcollection('variacaoMercadoLivre')
            .select('itemId', 'id', 'produtoMercadoLivreOuterRef')
            .toArrayExpression()
            .as('varLinks'),
        )
        .toArrayExpression()
        .as('children'),
    )
    .execute();

  for (const row of snap.results) {
    if (!row.ref) continue; // no outer `select` → ref is present; guard the optional type
    const segments = row.ref.path.split('/');
    const anchorId = segments[segments.length - 1];
    if (!anchorId) continue;
    const data = row.data() as Record<string, unknown>;

    const link =
      data.link != null && typeof data.link === 'object' ? (data.link as BundleLink) : null;

    const children: BundleChild[] = [];
    for (const rawChild of Array.isArray(data.children) ? data.children : []) {
      if (rawChild == null || typeof rawChild !== 'object') continue;
      const child = rawChild as Record<string, unknown>;
      if (typeof child.childId !== 'string' || child.childId === '') continue;
      children.push({
        childId: child.childId,
        varLinks: Array.isArray(child.varLinks)
          ? child.varLinks.filter((v): v is BundleVarLink => v != null && typeof v === 'object')
          : [],
      });
    }
    children.sort((a, b) => (a.childId < b.childId ? -1 : a.childId > b.childId ? 1 : 0));

    bundle.set(anchorId, { anchorId, produto: data as RawGateFields, link, children });
  }
  return bundle;
}

export interface ResolveFromBundleArgs {
  integracaoId: string;
  /** The original candidate produto (context only — skips report on the anchor). */
  produtoId: string;
  /** The family anchor the bundle entry is keyed by. */
  anchorId: string;
  /**
   * The anchor's gate fields when the caller already holds them (the candidate
   * IS the anchor and Q1 joined its produto, or the wrapper read it). Null →
   * fall back to the bundle entry's own anchor fields (kit-parent expansions,
   * `paiId` children).
   */
  anchorProduto: RawGateFields | null;
}

/**
 * Pure assembly: resolve one family anchor into its send units from a Q2
 * bundle, reproducing the legacy decision ladder EXACTLY, in order:
 * `'sem-link'` (anchor produto missing — deleted mid-sweep, `documents()`
 * omits it — or no link for this conta), `'sem-item-id'` (never published),
 * `'aguardando-migracao'` (`estado 'am'`, mid-UP-migration, Flutter-driven),
 * `'status-nao-enviavel'` (whitelist gate; `desconhecido` statuses
 * additionally warn — status tracking per Lucas), `'kit-virtual'`,
 * `'nao-publicado'`, `'conta-fora-do-produto'`.
 *
 * Old model (`isUserProductModel !== true`): ONE `'item'` unit per FAMILY —
 * the task handler expands all variations into a single bulk `PUT items/{id}`
 * (still 1 task = 1 ML call). User Products: one `'variationItem'` unit per
 * variation child (each variation is its own ML item — no family bulk exists),
 * matching each child's variação link by
 * `produtoMercadoLivreOuterRef === toOuterRef(<parent link docPath>)` — exact
 * string match is safe here because both apps write the canonical
 * `documents/...` form for this field (see importVariations.ts). A childless
 * UP family degenerates to a single `'item'` unit.
 */
export function resolveSendUnitsFromBundle(
  bundle: ResolutionBundle,
  args: ResolveFromBundleArgs,
): ResolvedSendUnits {
  const { anchorId } = args;
  const anchor = bundle.get(anchorId) ?? null;
  if (anchor == null) return skipOnly(anchorId, 'sem-link'); // anchor doc gone
  const gate = args.anchorProduto ?? anchor.produto;

  const link = anchor.link;
  if (link == null) return skipOnly(anchorId, 'sem-link');
  const linkDocId =
    typeof link.linkDocId === 'string' && link.linkDocId !== '' ? link.linkDocId : null;
  const identity: ResolvedLinkIdentity | null =
    linkDocId == null ? null : { docId: linkDocId, produtoId: anchorId };

  const itemId = typeof link.id === 'string' && link.id !== '' ? link.id : null;
  if (itemId == null) return skipOnly(anchorId, 'sem-item-id', identity);
  if (link.estado === 'am') return skipOnly(anchorId, 'aguardando-migracao', identity);

  const statusGate = podeEnviarEstoque(
    typeof link.status === 'string' ? link.status : null,
    Array.isArray(link.sub_status)
      ? link.sub_status.filter((s): s is string => typeof s === 'string')
      : null,
  );
  if (statusGate.desconhecido) {
    console.warn('[mercado-livre] stock-sync: status de anúncio fora do conjunto documentado', {
      integracaoId: args.integracaoId,
      produtoId: anchorId,
      itemId,
      status: link.status ?? null,
    });
  }
  if (!statusGate.enviar) return skipOnly(anchorId, 'status-nao-enviavel', identity);

  if (gate.ehKitVirtual === true) return skipOnly(anchorId, 'kit-virtual', identity);
  if (gate.publicado !== true) return skipOnly(anchorId, 'nao-publicado', identity);
  const integracoes = Array.isArray(gate.integracoesComProduto) ? gate.integracoesComProduto : [];
  if (!integracoes.includes(args.integracaoId))
    return skipOnly(anchorId, 'conta-fora-do-produto', identity);

  if (link.isUserProductModel !== true) {
    return {
      units: [{ kind: 'item', itemId, produtoId: anchorId, variacaoProdutoId: null }],
      skips: [],
      link: identity,
    };
  }

  if (anchor.children.length === 0) {
    return {
      units: [{ kind: 'item', itemId, produtoId: anchorId, variacaoProdutoId: null }],
      skips: [],
      link: identity,
    };
  }

  const parentLinkOuterRef =
    linkDocId == null
      ? null
      : toOuterRef(produtoMercadoLivreLinkCollection.docPath({ produtoId: anchorId }, linkDocId));

  const units: SendUnit[] = [];
  const skips: SendSkip[] = [];
  for (const child of anchor.children) {
    // Exact string match is safe here — both apps write the canonical
    // `documents/...` form for this field (see importVariations.ts).
    const varLink =
      parentLinkOuterRef == null
        ? undefined
        : child.varLinks.find((raw) => raw.produtoMercadoLivreOuterRef === parentLinkOuterRef);
    if (varLink == null) {
      skips.push({ produtoId: child.childId, reason: 'sem-link' });
      continue;
    }
    const varItemId =
      typeof varLink.itemId === 'string' && varLink.itemId !== '' ? varLink.itemId : null;
    if (varItemId == null) {
      skips.push({ produtoId: child.childId, reason: 'sem-item-id' });
      continue;
    }
    units.push({
      kind: 'variationItem',
      itemId: varItemId,
      produtoId: anchorId,
      variacaoProdutoId: child.childId,
    });
  }
  return { units, skips, link: identity };
}

export interface ResolveSendUnitsArgs {
  integracaoId: string;
  produtoId: string;
}

/**
 * Single-family resolution — the PR B task-handler entry point (name/signature
 * kept for the stacked send-queue branch). Resolves the family ANCHOR (`paiId`
 * when the candidate is a variation child — e.g. a kit component estoque
 * living on a child; plain doc gets, fine for the one-family case), then runs
 * Q2 for that single anchor and the pure ladder above.
 */
export async function resolveSendUnits(
  db: Firestore,
  { integracaoId, produtoId }: ResolveSendUnitsArgs,
): Promise<ResolvedSendUnits> {
  const produtoSnap = await produtoCollection.docRef(db, {}, produtoId).get();
  if (!produtoSnap.exists) return skipOnly(produtoId, 'sem-link');
  const produtoRaw = (produtoSnap.data() ?? {}) as RawGateFields;
  const paiId =
    typeof produtoRaw.paiId === 'string' && produtoRaw.paiId !== '' ? produtoRaw.paiId : null;

  let anchorId = produtoId;
  let anchorProduto = produtoRaw;
  if (paiId != null) {
    anchorId = paiId;
    const parentSnap = await produtoCollection.docRef(db, {}, paiId).get();
    if (!parentSnap.exists) return skipOnly(anchorId, 'sem-link');
    anchorProduto = (parentSnap.data() ?? {}) as RawGateFields;
  }

  const bundle = await fetchResolutionBundle(db, { integracaoId, anchorRefsOrIds: [anchorId] });
  return resolveSendUnitsFromBundle(bundle, { integracaoId, produtoId, anchorId, anchorProduto });
}

/* --------------------------- quantities from the db ------------------------ */

export interface ComputeQuantidadesArgs {
  produtoId: string;
  depositoId: string;
}

/**
 * Fresh quantity for one produto at one depósito, or `null` for "do not send"
 * (produto gone, or `ehKitVirtual`). Estoque docs are read by their
 * DETERMINISTIC id (`makeEstoqueUid(produtoId, depositoId)`) — direct doc gets
 * for the produto's own estoque plus every `componentesKit` component's, no
 * query, no index. `disponivel` = quantidade − reservada (the schemas'
 * `estoqueDisponivel`); a missing estoque doc reads as null so the kit min
 * counts it as 0 (#238). Always called fresh at send time — task payloads
 * carry targets, never quantities.
 */
export async function computeQuantidades(
  db: Firestore,
  { produtoId, depositoId }: ComputeQuantidadesArgs,
): Promise<number | null> {
  const produtoSnap = await produtoCollection.docRef(db, {}, produtoId).get();
  if (!produtoSnap.exists) return null;
  const raw = (produtoSnap.data() ?? {}) as Record<string, unknown>;
  const ehKit = raw.ehKit === true;
  const ehKitVirtual = raw.ehKitVirtual === true;
  const componentesKit = ehKit ? (raw.componentesKit as ComponentesKit | null | undefined) : null;

  const ownDisponivel = (await readDisponivel(db, produtoId, depositoId)) ?? 0;

  const disponivelByProdutoId: Record<string, number | null> = {};
  if (ehKit) {
    // `componentesKitEntries` tolerates raw junk and yields the map's ids —
    // the only ids the kit min can consume (the denormalized
    // `componentesKitKeys` is discovery-only).
    const componentIds = componentesKitEntries(componentesKit).map(([id]) => id);
    await Promise.all(
      componentIds.map(async (id) => {
        disponivelByProdutoId[id] = await readDisponivel(db, id, depositoId);
      }),
    );
  }

  return quantidadeParaEnvio({
    ehKit,
    ehKitVirtual,
    componentesKit,
    ownDisponivel,
    disponivelByProdutoId,
  });
}

/** `disponivel` at one depósito via the deterministic estoque doc id; null when absent. */
async function readDisponivel(
  db: Firestore,
  produtoId: string,
  depositoId: string,
): Promise<number | null> {
  const snap = await estoqueCollection
    .docRef(db, { produtoId }, makeEstoqueUid(produtoId, depositoId))
    .get();
  if (!snap.exists) return null;
  const data = (snap.data() ?? {}) as Record<string, unknown>;
  return estoqueDisponivel({
    quantidade: finiteNumber(data.quantidade) ?? 0,
    quantidadeReservada: finiteNumber(data.quantidadeReservada) ?? 0,
  });
}

/* --------------------------------- helpers --------------------------------- */

/** Narrow a raw doc field to a finite number (tolerates legacy/missing data). */
function finiteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
