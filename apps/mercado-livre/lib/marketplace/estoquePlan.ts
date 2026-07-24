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
 *    `quantidadeParaEnvio` returns null and `resolveSendUnits` skips
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
 * ---- `ehExpansaoDeKit` provenance honesty: a kit parent discovered through a
 * changed COMPONENT carries the **component's** estoque doc path, timestamp
 * and quantities in its `EstoqueCandidato` — the parent's own estoque is NOT
 * read during discovery. Downstream filters (PR C's low-stock limiar)
 * therefore evaluate the TRIGGERING doc, and the real family quantity is
 * always recomputed fresh by `computeQuantidades` at send time.
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
  estoqueDisponivel,
  kitEstoqueDisponivel,
  makeEstoqueUid,
  toOuterRef,
} from '@delfrance/schemas';
import {
  estoqueCollection,
  produtoCollection,
  produtoMercadoLivreLinkCollection,
  variacaoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';

import { refMatchesIntegracao } from './linkRefs';

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

/** `array-contains-any` accepts at most 10 candidates per classic query. */
export const KIT_PARENT_CHUNK = 10;

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

/* ------------------------- changed-estoques pipeline ----------------------- */

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

export interface FetchChangedEstoquesArgs {
  /** Canonical `documents/depositos/<id>` ref string stored on the estoque docs. */
  depositoOuterRef: string;
  /** Exclusive window start (ms since epoch). */
  fromMs: number;
  /** Page size override — defaults to `candidatePageLimit()`. */
  pageLimit?: number;
}

/** The pipeline seam — `discoverStockCandidates` takes it injectable (tests stub it). */
export type FetchChangedEstoques = (
  db: Firestore,
  args: FetchChangedEstoquesArgs,
) => Promise<ChangedEstoque[]>;

/**
 * THE pipeline (the only one in the stock sync): every estoque doc of one
 * depósito changed after `fromMs`, ascending by `ultimaModificacao`. A
 * `collectionGroup('estoques')` scan with an equality + range filter — rides
 * the `estoques(depositoOuterRef ASC, ultimaModificacao ASC)` COLLECTION_GROUP
 * index (PR C declares it; Enterprise auto-creates NOTHING and an unindexed
 * pipeline silently full-scans, billed by data scanned).
 *
 * Deliberately NO `select` stage: `row.ref` must stay present (a `select`
 * drops it) because the produtoId is derived from the doc path.
 *
 * Pagination: pipelines have no cursor, so a full page re-executes with
 * `>= lastSeenMs` (ties at the boundary are re-fetched and de-duped by doc
 * path). Termination is on RAW page size — a page shorter than `pageLimit`
 * means the range is drained. It must NOT be on the de-duplicated new-row
 * count: every `>=` re-cover necessarily re-fetches the boundary doc, so a
 * new-row count is structurally < pageLimit on every page after the first and
 * would cap the scan at 2 pages, silently dropping the backlog tail.
 * Bounded risk accepted: if MORE than `pageLimit` docs share one
 * `ultimaModificacao` value, a full page can yield zero new rows with no way
 * to advance the bound — the loop then warns loudly and truncates rather than
 * spin. Impossible at realistic page sizes for per-produto stock writes.
 *
 * NOT emulator-runnable (pipelines never are) — tested through the seam;
 * live-validated by PR C's `check-stock-indexes.mjs`.
 */
export const fetchChangedEstoquesPipeline: FetchChangedEstoques = async (db, args) => {
  const pageLimit = args.pageLimit ?? candidatePageLimit();
  const seen = new Set<string>();
  const rows: ChangedEstoque[] = [];
  let bound = args.fromMs;
  let inclusive = false; // first page is `> fromMs`; re-covers use `>= lastSeenMs`

  for (;;) {
    // eslint-disable-next-line no-restricted-syntax -- pipeline SOURCE stage, not a raw ref; defineAdminCollection handles have no pipeline surface
    const snap = await db
      .pipeline()
      .collectionGroup('estoques')
      .where(
        pipelines.and(
          pipelines.equal(pipelines.field('depositoOuterRef'), args.depositoOuterRef),
          inclusive
            ? pipelines.greaterThanOrEqual(pipelines.field('ultimaModificacao'), bound)
            : pipelines.greaterThan(pipelines.field('ultimaModificacao'), bound),
        ),
      )
      .sort(pipelines.ascending(pipelines.field('ultimaModificacao')))
      .limit(pageLimit)
      .execute();

    let newRows = 0;
    let lastSeenMs: number | null = null;
    for (const row of snap.results) {
      if (!row.ref) continue; // no `select` → ref is present; guard the optional type
      const data = row.data() as Record<string, unknown>;
      const ms = finiteNumber(data.ultimaModificacao);
      if (ms == null) continue; // matched the range server-side; purely defensive
      lastSeenMs = ms; // ascending sort → the last valid row is the page max
      const path = row.ref.path;
      if (seen.has(path)) continue; // boundary tie re-fetched by the `>=` re-cover
      seen.add(path);
      newRows += 1;
      const produtoId = path.split('/')[1];
      if (!produtoId) continue;
      rows.push({
        produtoId,
        estoqueDocPath: path,
        ultimaModificacaoMs: ms,
        quantidade: finiteNumber(data.quantidade) ?? 0,
        quantidadeReservada: finiteNumber(data.quantidadeReservada) ?? 0,
      });
    }

    if (snap.results.length < pageLimit || lastSeenMs == null) break; // backlog drained
    if (newRows === 0) {
      // Full page, zero new rows: > pageLimit docs share one ultimaModificacao
      // and all are already collected — the `>=` bound cannot advance. Truncate
      // loudly instead of spinning; the next sweep re-covers from its window.
      console.warn(
        `[estoquePlan] pagination stuck on ultimaModificacao tie at ${bound} ` +
          `(page of ${snap.results.length} rows, all previously seen) — truncating scan`,
      );
      break;
    }
    bound = lastSeenMs;
    inclusive = true;
  }
  return rows;
};

/* --------------------------- kit-parent expansion -------------------------- */

/** A kit produto that consumes at least one of the queried components. */
export interface KitParent {
  produtoId: string;
  /** The parent's denormalized component-id array (raw, string-filtered). */
  componentesKitKeys: string[];
}

/** The kit-parent seam — `discoverStockCandidates` takes it injectable. */
export type FetchKitParents = (db: Firestore, componentIds: string[]) => Promise<KitParent[]>;

/**
 * Kit parents of the given component produtos: classic
 * `produtos where componentesKitKeys array-contains-any <chunk>` queries,
 * chunked at `KIT_PARENT_CHUNK` (the classic-query candidate cap), de-duped
 * across chunks. Rides the `produtos(componentesKitKeys CONTAINS)` index
 * (PR C declares it). Classic on purpose — small, emulator-testable, and the
 * pipeline buys nothing here.
 */
export const fetchKitParentsQuery: FetchKitParents = async (db, componentIds) => {
  const unique = [...new Set(componentIds)];
  const byId = new Map<string, KitParent>();
  for (let i = 0; i < unique.length; i += KIT_PARENT_CHUNK) {
    const chunk = unique.slice(i, i + KIT_PARENT_CHUNK);
    const snap = await produtoCollection
      .ref(db, {})
      .where('componentesKitKeys', 'array-contains-any', chunk)
      .get();
    for (const doc of snap.docs) {
      if (byId.has(doc.id)) continue; // a parent can match several chunks
      const raw = (doc.data() as Record<string, unknown>).componentesKitKeys;
      byId.set(doc.id, {
        produtoId: doc.id,
        componentesKitKeys: Array.isArray(raw)
          ? raw.filter((k): k is string => typeof k === 'string')
          : [],
      });
    }
  }
  return [...byId.values()];
};

/* -------------------------------- discovery -------------------------------- */

/**
 * One send candidate. ⚠️ When `ehExpansaoDeKit` is true the estoque fields
 * (path, timestamp, quantities) belong to the TRIGGERING COMPONENT's doc —
 * the kit parent's own estoque was not read during discovery (module doc).
 */
export interface EstoqueCandidato extends ChangedEstoque {
  ehExpansaoDeKit: boolean;
}

export interface DiscoverStockCandidatesArgs {
  depositoOuterRef: string;
  fromMs: number;
  pageLimit?: number;
}

export interface DiscoverStockCandidatesDeps {
  fetchChanged?: FetchChangedEstoques;
  fetchKitParents?: FetchKitParents;
}

/**
 * Discover every produto needing a stock send for one depósito window: the
 * directly-changed estoques (pipeline) plus every kit parent consuming one of
 * the changed produtos as a component (classic chunked expansion). De-duped
 * into a Map keyed by produtoId; a parent whose OWN estoque also changed stays
 * a direct candidate (`ehExpansaoDeKit: false` wins). Quantities ride along so
 * PR C's limiar filter needs no re-read.
 */
export async function discoverStockCandidates(
  db: Firestore,
  args: DiscoverStockCandidatesArgs,
  deps: DiscoverStockCandidatesDeps = {},
): Promise<Map<string, EstoqueCandidato>> {
  const fetchChanged = deps.fetchChanged ?? fetchChangedEstoquesPipeline;
  const fetchKitParents = deps.fetchKitParents ?? fetchKitParentsQuery;

  const changed = await fetchChanged(db, args);
  const out = new Map<string, EstoqueCandidato>();
  for (const row of changed) {
    // One estoque per (produto, depósito) — the first occurrence wins defensively.
    if (out.has(row.produtoId)) continue;
    out.set(row.produtoId, { ...row, ehExpansaoDeKit: false });
  }
  if (changed.length === 0) return out;

  const parents = await fetchKitParents(
    db,
    changed.map((r) => r.produtoId),
  );
  for (const parent of parents) {
    if (out.has(parent.produtoId)) continue; // direct change wins over kit expansion
    const keys = new Set(parent.componentesKitKeys);
    const trigger = changed.find((r) => keys.has(r.produtoId));
    if (!trigger) continue; // defensive — seam returned an unrelated parent
    out.set(parent.produtoId, {
      ...trigger,
      produtoId: parent.produtoId,
      ehExpansaoDeKit: true,
    });
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

export interface ResolveSendUnitsArgs {
  integracaoId: string;
  produtoId: string;
}

export interface ResolvedSendUnits {
  units: SendUnit[];
  skips: SendSkip[];
}

function skipOnly(produtoId: string, reason: SendSkipReason): ResolvedSendUnits {
  return { units: [], skips: [{ produtoId, reason }] };
}

/**
 * Resolve one candidate produto into the send units its family needs, for one
 * integração. The ANCHOR is the family parent (`paiId` when the candidate is a
 * variation child — e.g. a kit component estoque living on a child). Reads the
 * anchor's `produtoMercadoLivre` subcollection and filters `contaOuterRef` in
 * memory (tolerant matching, same as import/status-sync — the wire has no
 * server-filterable conta field).
 *
 * Skips, evaluated in order: `'sem-link'` (no produto/anchor doc or no link
 * for this conta — a produto deleted mid-sweep lands here too),
 * `'sem-item-id'` (never published), `'aguardando-migracao'` (`estado 'am'`,
 * mid-UP-migration, Flutter-driven), `'status-nao-enviavel'` (whitelist gate;
 * `desconhecido` statuses additionally warn — status tracking per Lucas),
 * `'kit-virtual'`, `'nao-publicado'`, `'conta-fora-do-produto'`.
 *
 * Old model (`isUserProductModel !== true`): ONE `'item'` unit per FAMILY —
 * the task handler expands all variations into a single bulk `PUT items/{id}`
 * (still 1 task = 1 ML call). User Products: one `'variationItem'` unit per
 * variation child (each variation is its own ML item — no family bulk exists);
 * a childless UP family degenerates to a single `'item'` unit. Children ride
 * the existing `produtos(paiId, nome)` index, hence the `orderBy('nome')`.
 */
export async function resolveSendUnits(
  db: Firestore,
  { integracaoId, produtoId }: ResolveSendUnitsArgs,
): Promise<ResolvedSendUnits> {
  // (a) Resolve the family anchor.
  const produtoSnap = await produtoCollection.docRef(db, {}, produtoId).get();
  if (!produtoSnap.exists) return skipOnly(produtoId, 'sem-link');
  const produtoRaw = (produtoSnap.data() ?? {}) as Record<string, unknown>;
  const paiId =
    typeof produtoRaw.paiId === 'string' && produtoRaw.paiId !== '' ? produtoRaw.paiId : null;

  let anchorId = produtoId;
  let anchorRaw = produtoRaw;
  if (paiId != null) {
    anchorId = paiId;
    const parentSnap = await produtoCollection.docRef(db, {}, paiId).get();
    if (!parentSnap.exists) return skipOnly(anchorId, 'sem-link');
    anchorRaw = (parentSnap.data() ?? {}) as Record<string, unknown>;
  }

  // (b) This conta's link under the anchor (in-memory conta filter).
  const linkSnap = await produtoMercadoLivreLinkCollection.ref(db, { produtoId: anchorId }).get();
  let link: Record<string, unknown> | null = null;
  let linkDocId: string | null = null;
  for (const d of linkSnap.docs) {
    const raw = d.data() as Record<string, unknown>;
    if (!refMatchesIntegracao(raw.contaOuterRef, integracaoId)) continue;
    link = raw;
    linkDocId = d.id;
    break;
  }
  if (link == null || linkDocId == null) return skipOnly(anchorId, 'sem-link');

  const itemId = typeof link.id === 'string' && link.id !== '' ? link.id : null;
  if (itemId == null) return skipOnly(anchorId, 'sem-item-id');
  if (link.estado === 'am') return skipOnly(anchorId, 'aguardando-migracao');

  // (c) Listing-status whitelist gate.
  const gate = podeEnviarEstoque(
    typeof link.status === 'string' ? link.status : null,
    Array.isArray(link.sub_status)
      ? link.sub_status.filter((s): s is string => typeof s === 'string')
      : null,
  );
  if (gate.desconhecido) {
    console.warn('[mercado-livre] stock-sync: status de anúncio fora do conjunto documentado', {
      integracaoId,
      produtoId: anchorId,
      itemId,
      status: link.status ?? null,
    });
  }
  if (!gate.enviar) return skipOnly(anchorId, 'status-nao-enviavel');

  // (d) Produto-level gates (legacy publicado / conta / kit-virtual gates).
  if (anchorRaw.ehKitVirtual === true) return skipOnly(anchorId, 'kit-virtual');
  if (anchorRaw.publicado !== true) return skipOnly(anchorId, 'nao-publicado');
  const integracoes = Array.isArray(anchorRaw.integracoesComProduto)
    ? anchorRaw.integracoesComProduto
    : [];
  if (!integracoes.includes(integracaoId)) return skipOnly(anchorId, 'conta-fora-do-produto');

  // (e) Old model → ONE family unit.
  if (link.isUserProductModel !== true) {
    return {
      units: [{ kind: 'item', itemId, produtoId: anchorId, variacaoProdutoId: null }],
      skips: [],
    };
  }

  // (f) User Products → one unit per variation child.
  const childrenSnap = await produtoCollection
    .ref(db, {})
    .where('paiId', '==', anchorId)
    .orderBy('nome', 'asc')
    .get();
  if (childrenSnap.docs.length === 0) {
    return {
      units: [{ kind: 'item', itemId, produtoId: anchorId, variacaoProdutoId: null }],
      skips: [],
    };
  }

  const parentLinkOuterRef = toOuterRef(
    produtoMercadoLivreLinkCollection.docPath({ produtoId: anchorId }, linkDocId),
  );
  const units: SendUnit[] = [];
  const skips: SendSkip[] = [];
  for (const child of childrenSnap.docs) {
    const varSnap = await variacaoMercadoLivreLinkCollection.ref(db, { produtoId: child.id }).get();
    // Exact string match is safe here — both apps write the canonical
    // `documents/...` form for this field (see importVariations.ts).
    const varLink = varSnap.docs
      .map((d) => d.data() as Record<string, unknown>)
      .find((raw) => raw.produtoMercadoLivreOuterRef === parentLinkOuterRef);
    if (varLink == null) {
      skips.push({ produtoId: child.id, reason: 'sem-link' });
      continue;
    }
    const varItemId =
      typeof varLink.itemId === 'string' && varLink.itemId !== '' ? varLink.itemId : null;
    if (varItemId == null) {
      skips.push({ produtoId: child.id, reason: 'sem-item-id' });
      continue;
    }
    units.push({
      kind: 'variationItem',
      itemId: varItemId,
      produtoId: anchorId,
      variacaoProdutoId: child.id,
    });
  }
  return { units, skips };
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
