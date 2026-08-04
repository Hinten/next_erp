/**
 * "Atualizar preços" manual bulk price-sync core (ERP→ML) — Step 11 PR C. A
 * MANUAL-ONLY flow by owner decision: prices, unlike stock, have no continuous
 * upstream mutation stream worth chasing — they change in deliberate batches
 * (price-table edits), and an automated sweep could silently fight a seller
 * running ML promotions. So there is NO schedule and NO trigger: a user clicks
 * "Atualizar preços" on the conta screen (PR D), optionally allowing decreases
 * (`baixarPreco`, default OFF — gate 4 below), and this module pushes each
 * linked produto's price (the conta's tabela normal —
 * `produto.precos[<tabelaNormalId>].valor`) to its ML listings exactly once.
 *
 * ---- Orchestration is a CLONE of the Step-8 mass-import core
 * (`massImport.ts`), NOT the Step-10 sweep + task-per-call stock pipeline: ONE
 * `enviosPrecoMercadoLivre` job doc is the single checkpoint for a
 * self-continuing Cloud Tasks chain (`processMercadoLivrePriceSync`) that
 * alternates planning one produto page (`fetchPrecoPage` + `buildPrecoDrafts`,
 * `precoPlan.ts`) with draining up to `precoItemsPerDispatch()` queued drafts,
 * re-enqueuing itself until the plan cursor exhausts AND the `fila` drains.
 * The resume model (plan only when `fila` is empty and planning isn't
 * concluded), the per-item checkpoint, the capped skip/failure detail lists
 * with uncapped counters, and the final-attempt `failed` stamp all mirror
 * massImport.ts — see its module doc for the rationale behind each.
 *
 * ---- Plugin bypass (Step-10 precedent): `MarketplaceChannel.pushPrice`
 * exists, but this module calls `MercadoLivreApi.updateItem` directly, exactly
 * like the stock stack bypasses `pushInventory`: the plugin contract's
 * `MinorUnits` (integer centavos, no floats) does not fit the reais floats the
 * produto price tables store and ML's wire format speaks, and the per-listing
 * GET-before-PUT gates below need the raw `MlItem` anyway. Folding this flow
 * into the plugin contract is a tracked post-migration follow-up.
 *
 * ---- Price source (owner-locked, resolved at PLAN time by
 * `buildPrecoDrafts`): `propagatePriceToChildren: true` (the default) sends
 * the ANCHOR produto's price for the whole family; `false` sends each UP
 * variation item its own CHILD produto's `precos` entry (a child with no
 * entry is a per-child skip). Legacy-model listings ALWAYS carry the anchor
 * price — ML legacy `variations[]` only accept one uniform price. A queued
 * draft is therefore just "PUT `preco` on `itemId`".
 *
 * ---- ⚠️ Price-only bodies (live ML behaviour since 2026-03-18): on an item
 * whose seller activated ML price automation, `PUT /items/{id}` with a
 * price-ONLY body fails loudly (400 `item.price.not_modifiable` → terminal
 * skip `PRECO_NAO_MODIFICAVEL`, gate 6), but a price bundled with ANY other
 * field returns 200 with the price SILENTLY IGNORED — the one failure mode
 * that never surfaces. So every body this module sends carries price fields
 * and nothing else, and gate 7 re-verifies the echoed price anyway.
 *
 * ---- Per-item gates, in order (drain phase):
 *  (1) fresh `GET /items/{id}` — 429 pauses the job, other 4xx records a
 *      `GET_PRODUTO_ERROR` failure, a dead credential fails the whole job,
 *      5xx/network rethrow (the queue retries);
 *  (2) skip-if-equal (`PRECO_ANTIGO_IGUAL`) — also what makes a replayed
 *      dispatch idempotent after a crash between PUT and checkpoint;
 *  (3) fresh status gate (`podeEnviarPreco`: CLOSED / FORBIDDEN /
 *      STATUS_<x>) + the mid-migration tag skip (`AGUARDANDO_MIGRACAO`);
 *  (4) decrease guard (`PRECO_ANTIGO_MAIOR`) unless the run set `baixarPreco`;
 *  (5) build the price-only body (per-variation for legacy `variations[]`);
 *  (6) `PUT /items/{id}` — `PRECO_NAO_MODIFICAVEL` terminal skip /
 *      `UPDATE_PRECO_ERROR` failure with the link stamped `estado 'E'` /
 *      pause / job-fail / rethrow, same classes as (1);
 *  (7) verify the echoed price (`PRECO_NAO_ATUALIZADO` on mismatch, no stamp);
 *  (8) success writeback onto the link (fresh status; plus `precoPublicado`
 *      for `item` drafts only — variation siblings share the parent link doc);
 *  (9) per-item checkpoint merge.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { roundReais } from '@delfrance/core/money';
import {
  ENVIO_PRECO_MERCADO_LIVRE_STATUS,
  type EnvioPrecoMercadoLivre,
  idFromRef,
} from '@delfrance/schemas';
import {
  type MlItem,
  MercadoLivreHttpError,
  MercadoLivreReauthRequiredError,
  createMercadoLivreApi,
  estadoFromMlStatus,
} from '@delfrance/integrations-mercado-livre';
import {
  envioPrecoMercadoLivreCollection,
  produtoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';

import {
  PLAN_PAGE_DRAFTS_CAP,
  PRICE_SYNC_FAILURES_CAP,
  PRICE_SYNC_MAX_PAUSES,
  PRICE_SYNC_SKIPS_CAP,
  type FetchPrecoPage,
  buildPrecoDrafts,
  fetchPrecoPage,
  podeEnviarPreco,
  precoItemsPerDispatch,
  precoPageLimit,
  precoRatePauseMin,
} from './precoPlan';
import { loadMercadoLivreContext } from '../core/mercadoLivre';
import type { MlPriceSyncScheduler } from '../tasks/mlPriceSyncTasks';

/**
 * The deployed `onTaskDispatched` function name — which is ALSO its
 * auto-provisioned Cloud Tasks queue name. Single source of truth (mirrors
 * `massImport.ts`'s `MERCADO_LIVRE_MASS_IMPORT_QUEUE`): the producer
 * (`mlPriceSyncTasks.ts`) builds the region-qualified queue path from it, and
 * the consumer (`functions/src`) must name its `export const` exactly this.
 * Lives in this neutral core module (not the scheduler file) so the scheduler
 * can import it without this module ever depending on the Functions SDK.
 */
export const MERCADO_LIVRE_PRICE_SYNC_QUEUE = 'processMercadoLivrePriceSync';

/** In-task retry cap — the Cloud Tasks `retryConfig.maxAttempts` (kept in sync). */
export const PRICE_SYNC_MAX_ATTEMPTS = 3;

/**
 * A `running` job whose `updatedAt` is older than this bound is treated as
 * ORPHANED by the `startPriceSyncJob` guard: a crash that bypasses the
 * final-attempt `failed` stamp would otherwise brick the conta's "Atualizar
 * preços" button forever. 6h is far beyond the 540s function timeout × the
 * queue's retry attempts, so a genuinely live job always checkpoints inside it.
 */
export const PRICE_SYNC_STALE_RUNNING_MS = 6 * 60 * 60 * 1000;

/** ML `tags` prefix marking an in-progress User-Products migration — both known
 * tags (`variations_migration_source` / `variations_migration_uptin`, the
 * `itemsStatusSync.ts` MIGRATION_TAGS pair) share it. A mid-migration listing
 * must not be written to; the migration handoff (#441) re-links it and the
 * NEXT manual run covers the successor items. */
const MIGRATION_TAG_PREFIX = 'variations_migration_';

export const priceSyncTaskSchema = z
  .object({
    jobId: z.string().min(1),
    integracaoId: z.string().min(1),
  })
  .passthrough();
export type PriceSyncTaskPayload = z.infer<typeof priceSyncTaskSchema>;

/** `startPriceSyncJob` guard — this integração already has a `running` job. */
export class PriceSyncAlreadyRunningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PriceSyncAlreadyRunningError';
  }
}

/**
 * Start a fresh price-sync job for `integracaoId` — guards against a second
 * concurrent run (one LIVE `running` job per conta at a time; a `running` doc
 * whose `updatedAt` is past `PRICE_SYNC_STALE_RUNNING_MS` is an orphan — it is
 * stamped `failed` and the new job proceeds), then creates the checkpoint doc
 * at `status: 'running'` with an empty plan cursor/queue (the schema defaults
 * fill every progress field). The caller (the
 * `atualizar-precos` route) enqueues the first task AFTER this resolves; on an
 * enqueue failure the route marks the just-created job `failed` itself (this
 * function does not enqueue — it only creates the checkpoint, mirroring
 * `startMassImportJob`).
 */
export async function startPriceSyncJob(
  db: Firestore,
  args: { integracaoId: string; baixarPreco: boolean; startedBy: string },
): Promise<{ jobId: string }> {
  const now = Date.now();
  const running = await envioPrecoMercadoLivreCollection
    .ref(db, {})
    .where('integracaoId', '==', args.integracaoId)
    .where('status', '==', 'running')
    .limit(1)
    .get();
  if (!running.empty) {
    const staleDoc = running.docs[0]!;
    const updatedAt = (staleDoc.data() as Record<string, unknown>).updatedAt;
    // Blocking only while the job is demonstrably alive (a checkpoint stamp
    // younger than the staleness bound). A missing/junk `updatedAt` cannot
    // prove liveness — treat it as stale rather than brick the button.
    if (typeof updatedAt === 'number' && now - updatedAt < PRICE_SYNC_STALE_RUNNING_MS) {
      throw new PriceSyncAlreadyRunningError(
        `já existe um envio de preços em andamento para a integração ${args.integracaoId}`,
      );
    }
    // Orphaned job (crash bypassed the final-attempt stamp): mark it failed —
    // best-effort, a stamp failure must not block the fresh job the user asked
    // for, so it is only logged.
    try {
      await envioPrecoMercadoLivreCollection.merge(db, {}, staleDoc.id, {
        status: 'failed',
        erro: 'job órfão — superado por um novo envio',
        finishedAt: now,
        updatedAt: now,
      });
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      console.warn('[mercado-livre] price-sync: falha ao marcar o job órfão como failed', {
        jobId: staleDoc.id,
        integracaoId: args.integracaoId,
        message: err.message,
      });
    }
  }

  const ref = await envioPrecoMercadoLivreCollection.add(
    db,
    {},
    {
      integracaoId: args.integracaoId,
      status: 'running',
      baixarPreco: args.baixarPreco,
      startedBy: args.startedBy,
      startedAt: now,
      updatedAt: now,
    },
  );
  return { jobId: ref.id };
}

/** The minimal ML API surface the price sync needs (injectable for tests). */
export interface PriceSyncApi {
  getItem(id: string): Promise<MlItem>;
  updateItem(id: string, payload: Record<string, unknown>): Promise<MlItem>;
}

/** The resolved per-account dependencies `processPriceSyncJob` needs. */
export interface PriceSyncContext {
  api: PriceSyncApi;
  /** The conta's normal price table ref — the plan's price source (`precos[<id>]`). */
  tabelaNormalOuterRef: string | null;
}

export interface PriceSyncRunDeps {
  db: Firestore;
  /** The price-sync queue enqueue seam (`createMlPriceSyncScheduler()` in prod). */
  scheduler: MlPriceSyncScheduler;
  /** Injectable for tests; defaults to the live ML context resolution. */
  resolveContext?: (db: Firestore, integracaoId: string) => Promise<PriceSyncContext>;
  /** Injectable for tests; defaults to `precoPlan.fetchPrecoPage`. */
  fetchPage?: FetchPrecoPage;
  /** Injectable clock (tests) — one call per dispatch, reused for every persisted timestamp. */
  now?: () => number;
}

function asStringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Production `resolveContext` — the same context assembly every ML server flow
 * uses (`loadMercadoLivreContext` → `resolveChannelContext` →
 * `createMercadoLivreApi`), plus the conta's tabela-normal ref the plan needs.
 */
const defaultResolveContext: NonNullable<PriceSyncRunDeps['resolveContext']> = async (
  db,
  integracaoId,
) => {
  const ctx = await loadMercadoLivreContext(db, integracaoId);
  const channelCtx = await ctx.resolveChannelContext();
  const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });
  return {
    api,
    tabelaNormalOuterRef: asStringOrNull(ctx.conta.tabelaNormalOuterRef),
  };
};

async function readJob(db: Firestore, jobId: string): Promise<EnvioPrecoMercadoLivre | null> {
  const snap = await envioPrecoMercadoLivreCollection.docRef(db, {}, jobId).get();
  if (!snap.exists) return null;
  return envioPrecoMercadoLivreCollection.parseRead(
    snap.data(),
    envioPrecoMercadoLivreCollection.docPath({}, jobId),
  );
}

/** The listing's CURRENT normal price — `base_price` (promo-independent) first,
 * the same `base_price ?? price` read the import uses; non-positive/absent → null. */
function currentListingPrice(item: MlItem): number | null {
  const raw = item.base_price ?? item.price;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? roundReais(raw) : null;
}

/** One raw price field carries the sent preco (numeric + `roundReais`-equal). */
function priceFieldMatches(raw: unknown, preco: number): boolean {
  return typeof raw === 'number' && Number.isFinite(raw) && roundReais(raw) === preco;
}

/** One fresh/echoed variation entry already carries the sent preco — the ONE
 * predicate shared by gate 2's variations-aware skip and gate 7's
 * variations-body verifier. */
function variationAtPreco(v: { price?: number | null }, preco: number): boolean {
  return priceFieldMatches(v.price, preco);
}

/** Gate 7, single-price body: read the SAME promo-independent field order gate
 * 2 uses (`base_price ?? price`), then accept a match on EITHER field — an
 * active ML promotion legitimately makes the echoed `price` differ from the
 * standard price, so only both fields missing the sent preco is a failure. */
function verifyItemPrice(resp: MlItem, preco: number): boolean {
  return priceFieldMatches(resp.base_price, preco) || priceFieldMatches(resp.price, preco);
}

/** Gate 7, variations body: EVERY echoed variation must carry the new price;
 * ML sometimes omits `variations` on the PUT echo — fall back to item-level. */
function verifyVariationsPrice(resp: MlItem, preco: number): boolean {
  const vars = resp.variations ?? [];
  if (vars.length === 0) return verifyItemPrice(resp, preco);
  return vars.every((v) => variationAtPreco(v, preco));
}

/** ML's price-automation rejection — a 400 whose body is
 * `{ "error": "item.price.not_modifiable", ... }`. `MercadoLivreHttpError.body`
 * is the parsed JSON when the response was JSON and the raw text otherwise, so
 * narrow defensively before reading `error`. */
function isPriceNotModifiable(body: unknown): boolean {
  return (
    body != null &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    (body as Record<string, unknown>).error === 'item.price.not_modifiable'
  );
}

/** Deterministic outcome of one dispatch — see the module doc for each branch. */
export type PriceSyncDispatchOutcome = 'done' | 'continued' | 'noop' | 'failed';

/**
 * Process one `processMercadoLivrePriceSync` task dispatch: resume the job
 * doc, plan at most one produto page when the queue is empty and planning
 * isn't concluded, drain up to `precoItemsPerDispatch()` drafts through the
 * per-item gates, then either re-enqueue itself (`'continued'`) or mark the
 * job `completed` (`'done'`). `retryCount` is the Cloud Tasks attempt index
 * (0-based) — on the FINAL attempt an otherwise-fatal error is persisted as
 * `status: 'failed'` instead of re-thrown (mirrors `processMassImportJob`).
 */
export async function processPriceSyncJob(
  deps: PriceSyncRunDeps,
  payload: PriceSyncTaskPayload,
  retryCount: number,
): Promise<PriceSyncDispatchOutcome> {
  const { db } = deps;
  const resolveContext = deps.resolveContext ?? defaultResolveContext;
  const nowMs = deps.now ? deps.now() : Date.now(); // one clock read for the whole dispatch

  const job = await readJob(db, payload.jobId);
  if (!job || job.status !== ENVIO_PRECO_MERCADO_LIVRE_STATUS.running) return 'noop';

  try {
    const ctx = await resolveContext(db, payload.integracaoId);
    const tabelaRef = ctx.tabelaNormalOuterRef;
    const tabelaNormalId =
      typeof tabelaRef === 'string' && tabelaRef !== '' ? idFromRef(tabelaRef) : '';

    // Mutable working copy of the job's cursor + progress. Every persisted
    // checkpoint below merges the WHOLE set — the fields are all owned by this
    // one dispatch chain, so a uniform merge is equivalent to massImport's
    // per-phase minimal merges, with one less way to forget a field.
    let fila = [...job.fila];
    let afterAnchorId = job.afterAnchorId;
    let planejamentoConcluido = job.planejamentoConcluido;
    let planejados = job.planejados;
    let enviados = job.enviados;
    let pulados = job.pulados;
    let falhas = job.falhas;
    let pausas = job.pausas;
    let skips = [...job.skips];
    let failures = [...job.failures];

    /** Skips bookkeeping — the count is UNCAPPED; the UI detail list stops at the cap. */
    const registerSkip = (itemId: string | null, produtoId: string, code: string): void => {
      pulados += 1;
      if (skips.length < PRICE_SYNC_SKIPS_CAP) {
        skips = [...skips, { itemId, produtoId, code }];
      }
    };
    /** Failures bookkeeping — same cap discipline as the skips. */
    const registerFailure = (
      itemId: string,
      produtoId: string,
      code: string,
      error: string,
    ): void => {
      falhas += 1;
      if (failures.length < PRICE_SYNC_FAILURES_CAP) {
        failures = [...failures, { itemId, produtoId, code, error }];
      }
    };

    const checkpoint = async (): Promise<void> => {
      await envioPrecoMercadoLivreCollection.merge(db, {}, payload.jobId, {
        fila,
        afterAnchorId,
        planejamentoConcluido,
        planejados,
        enviados,
        pulados,
        falhas,
        pausas,
        skips,
        failures,
        updatedAt: nowMs,
      });
    };

    /** Terminal job failure — deterministic, never retried (`extra` rides along). */
    const failJob = async (
      erro: string,
      extra: Record<string, unknown> = {},
    ): Promise<'failed'> => {
      await envioPrecoMercadoLivreCollection.merge(db, {}, payload.jobId, {
        ...extra,
        status: 'failed',
        erro,
        finishedAt: nowMs,
        updatedAt: nowMs,
      });
      return 'failed';
    };

    /**
     * 429 PAUSE PATH (gate 1 or 6): the head item is NOT consumed — the
     * delayed re-dispatch retries it (a PUT that actually landed before the
     * 429 replays as `PRECO_ANTIGO_IGUAL` via gate 2). Bounded: a conta that
     * keeps rate-limiting past `PRICE_SYNC_MAX_PAUSES` fails the job instead
     * of chaining delayed tasks forever.
     */
    const pausePath = async (err: MercadoLivreHttpError): Promise<'continued' | 'failed'> => {
      pausas += 1;
      if (pausas > PRICE_SYNC_MAX_PAUSES) {
        return failJob('rate limit persistente', { pausas });
      }
      await checkpoint();
      await deps.scheduler.enqueue(
        { jobId: payload.jobId, integracaoId: payload.integracaoId },
        { scheduleDelaySeconds: err.retryAfterSec ?? precoRatePauseMin() * 60 },
      );
      return 'continued';
    };

    // No tabela normal → no price source at all. The route pre-checks the
    // conta before creating a job, so hitting this mid-job is a config
    // regression — deterministic, retrying cannot help (unreachable in practice).
    if (!tabelaNormalId) {
      return failJob('integração sem tabela de preços normal');
    }

    // (a) PLAN one produto page ONLY when there's nothing left to drain and
    // the plan cursor isn't exhausted — the massImport resume model, with the
    // explicit `planejamentoConcluido` flag standing in for `scrollId == null`
    // (this cursor is an anchor doc id, so null can't double as "exhausted").
    if (fila.length === 0 && !planejamentoConcluido) {
      const fetchPage = deps.fetchPage ?? fetchPrecoPage;
      const page = await fetchPage(db, {
        integracaoId: payload.integracaoId,
        afterAnchorId,
        pageLimit: precoPageLimit(),
      });
      // Rows are consumed ONE at a time under `PLAN_PAGE_DRAFTS_CAP`: a row
      // whose drafts would push the fila past the cap — while the fila already
      // holds at least one draft — stops the page mid-way. The cursor then
      // parks on the LAST CONSUMED row's produtoId (a mid-page keyset resume,
      // valid because the anchor keyset is on the document id) and planning
      // stays open; the unconsumed rows (drafts AND skips) re-plan on the next
      // dispatch, so nothing is lost or duplicated. A first row past the cap
      // still lands whole — `MAX_DRAFTS_PER_FAMILY` governs that.
      let lastConsumedAnchorId: string | null = null;
      let pageFullyConsumed = true;
      for (const row of page.rows) {
        const plan = buildPrecoDrafts(row, {
          integracaoId: payload.integracaoId,
          tabelaNormalId,
        });
        if (fila.length > 0 && fila.length + plan.drafts.length > PLAN_PAGE_DRAFTS_CAP) {
          pageFullyConsumed = false;
          break;
        }
        fila = [...fila, ...plan.drafts];
        planejados += plan.drafts.length;
        for (const s of plan.skips) registerSkip(s.itemId, s.produtoId, s.code);
        lastConsumedAnchorId = row.produtoId;
      }
      if (pageFullyConsumed) {
        afterAnchorId = page.nextAfterAnchorId;
        planejamentoConcluido = page.nextAfterAnchorId == null;
      } else {
        afterAnchorId = lastConsumedAnchorId;
      }
      await checkpoint();
      // Fall through: the SAME dispatch starts draining what it just planned.
    }

    // (b) DRAIN up to the per-dispatch cap, checkpointing after EVERY item.
    const perDispatch = precoItemsPerDispatch();
    let drained = 0;
    while (fila.length > 0 && drained < perDispatch) {
      drained += 1;
      const draft = fila[0]!;

      // (9) Per-item checkpoint — a crash right after this write resumes from
      // exactly here on retry, losing at most the one in-flight item; a
      // replayed already-sent item converges as PRECO_ANTIGO_IGUAL via gate (2).
      const consume = async (): Promise<void> => {
        fila = fila.slice(1);
        await checkpoint();
      };

      // ---- (1) Fresh GET — the skip/decrease/status gates below must judge
      // the listing as it is NOW, not as it was at plan time.
      let item: MlItem;
      try {
        item = await ctx.api.getItem(draft.itemId);
      } catch (err) {
        if (err instanceof MercadoLivreReauthRequiredError) {
          // A dead credential fails every remaining item identically —
          // reconnecting the conta is a human action, so fail the whole job.
          return failJob('credencial do Mercado Livre expirada — reconecte a conta');
        }
        if (err instanceof MercadoLivreHttpError) {
          if (err.status === 429) return pausePath(err);
          if (err.status >= 400 && err.status < 500) {
            // Deterministic (404 gone, 403…) — record and move on.
            registerFailure(draft.itemId, draft.produtoId, 'GET_PRODUTO_ERROR', err.message);
            await consume();
            continue;
          }
          throw err; // 5xx — transient, the queue retries
        }
        throw err; // network / validation / anything unclassified — the queue retries
      }

      // The FRESH variation ids an `item` draft would PUT through (gate 5's
      // legacy variations body) — also gate 2's equality source: on a legacy
      // variations listing the item-level price is not authoritative, so the
      // skip must judge every variation. `variationItem` drafts PUT on their
      // own MLB item and never carry a variations body.
      const freshVariations =
        draft.kind === 'item' ? (item.variations ?? []).filter((v) => v.id != null) : [];

      // ---- (2) Skip-if-equal: the listing already carries this price. With
      // variations, EVERY one must already sit at the target price — one
      // drifted variation must still be corrected by the PUT.
      const current = currentListingPrice(item);
      const alreadyEqual =
        freshVariations.length > 0
          ? freshVariations.every((v) => variationAtPreco(v, draft.preco))
          : current != null && current === draft.preco;
      if (alreadyEqual) {
        registerSkip(draft.itemId, draft.produtoId, 'PRECO_ANTIGO_IGUAL');
        await consume();
        continue;
      }

      // ---- (3) Fresh status gate + the mid-migration tag skip (see the
      // MIGRATION_TAG_PREFIX doc — mirrors itemsStatusSync's tag check).
      const gate = podeEnviarPreco(item.status, item.sub_status);
      if (!gate.ok) {
        registerSkip(draft.itemId, draft.produtoId, gate.code);
        await consume();
        continue;
      }
      if ((item.tags ?? []).some((t) => t.startsWith(MIGRATION_TAG_PREFIX))) {
        registerSkip(draft.itemId, draft.produtoId, 'AGUARDANDO_MIGRACAO');
        await consume();
        continue;
      }

      // ---- (4) Decrease guard: never lower a listing's price unless the
      // user ticked "Permitir baixar preços" for THIS run.
      if (current != null && draft.preco < current && !job.baixarPreco) {
        registerSkip(draft.itemId, draft.produtoId, 'PRECO_ANTIGO_MAIOR');
        await consume();
        continue;
      }

      // ---- (5) The price-only body — NEVER any other field (the 2026-03-18
      // hazard in the module doc: a price bundled with other fields is
      // silently ignored on automation-active items; price-only keeps the
      // failure a loud 400 that gate 6 maps to PRECO_NAO_MODIFICAVEL).
      let body: Record<string, unknown>;
      let sentVariations = false;
      if (freshVariations.length > 0) {
        // Legacy model: a listing with variations only accepts its (uniform)
        // price through the variations array — one entry per FRESH variation
        // id (stored ids could miss a variation added since the last import).
        sentVariations = true;
        body = { variations: freshVariations.map((v) => ({ id: v.id, price: draft.preco })) };
      } else {
        // UP model (`variationItem`: the variation IS its own MLB item) and
        // variation-less listings — plain item-level price.
        body = { price: draft.preco };
      }

      // ---- (6) The ONE PUT this draft exists for.
      let resp: MlItem;
      try {
        resp = await ctx.api.updateItem(draft.itemId, body);
      } catch (err) {
        if (err instanceof MercadoLivreReauthRequiredError) {
          return failJob('credencial do Mercado Livre expirada — reconecte a conta');
        }
        if (err instanceof MercadoLivreHttpError) {
          if (err.status === 429) return pausePath(err);
          if (err.status === 400 && isPriceNotModifiable(err.body)) {
            // The seller opted this item into ML's OWN price automation — our
            // price is rejected by design and the listing is healthy. Terminal
            // SKIP, and deliberately NO link stamp: `estado 'E'` would
            // misreport a live listing as broken.
            registerSkip(draft.itemId, draft.produtoId, 'PRECO_NAO_MODIFICAVEL');
            await consume();
            continue;
          }
          if (err.status >= 400 && err.status < 500) {
            // Deterministic rejection — stamp the link exactly like
            // estoqueSend/publish do, record the failure, move on.
            await produtoMercadoLivreLinkCollection.merge(
              db,
              { produtoId: draft.produtoId },
              draft.linkDocId,
              { estado: 'E', errors: [err.message], ultimaModificacao: nowMs },
            );
            registerFailure(draft.itemId, draft.produtoId, 'UPDATE_PRECO_ERROR', err.message);
            await consume();
            continue;
          }
          throw err; // 5xx — transient, the queue retries
        }
        throw err; // network / anything unclassified — the queue retries
      }

      // ---- (7) Verify the echo actually carries the new price (the silent-
      // ignore hazard's cousin: a 200 whose price did not stick). NO link
      // stamp: the PUT was accepted and the listing is healthy — `estado 'E'`
      // would misreport it; the failure row carries the diagnosis.
      const verified = sentVariations
        ? verifyVariationsPrice(resp, draft.preco)
        : verifyItemPrice(resp, draft.preco);
      if (!verified) {
        registerFailure(
          draft.itemId,
          draft.produtoId,
          'PRECO_NAO_ATUALIZADO',
          `resposta do Mercado Livre não confirmou o preço ${draft.preco}`,
        );
        await consume();
        continue;
      }

      // ---- (8) Success writeback (estoqueSend's status-writeback shape).
      // Only `item` drafts also stamp `precoPublicado` (the publish.ts field):
      // sibling `variationItem` drafts all share the PARENT link doc, and with
      // `propagatePriceToChildren: false` a per-child stamp would flip-flop to
      // whichever child was sent last — so variation sends stamp status only.
      const writeback: Record<string, unknown> = {
        estado: estadoFromMlStatus(resp.status),
        status: resp.status ?? null,
        sub_status: resp.sub_status ?? [],
        ultimaModificacao: nowMs,
      };
      if (draft.kind === 'item') writeback.precoPublicado = draft.preco;
      await produtoMercadoLivreLinkCollection.merge(
        db,
        { produtoId: draft.produtoId },
        draft.linkDocId,
        writeback,
      );
      enviados += 1;
      await consume();
    }

    // (c) Continue (re-enqueue) or complete.
    if (fila.length > 0 || !planejamentoConcluido) {
      await deps.scheduler.enqueue({ jobId: payload.jobId, integracaoId: payload.integracaoId });
      return 'continued';
    }

    await envioPrecoMercadoLivreCollection.merge(db, {}, payload.jobId, {
      status: 'completed',
      finishedAt: nowMs,
      updatedAt: nowMs,
    });
    return 'done';
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    if (retryCount < PRICE_SYNC_MAX_ATTEMPTS - 1) throw err; // let the queue retry with backoff

    // Final attempt: persist the failure instead of throwing (mirrors
    // massImport.ts / notificacao.ts's handleNotificationTask) — tolerate (but
    // log) a secondary failure while stamping it, never masking the original
    // error.
    try {
      await envioPrecoMercadoLivreCollection.merge(db, {}, payload.jobId, {
        status: 'failed',
        erro: err.message,
        finishedAt: nowMs,
        updatedAt: nowMs,
      });
    } catch (persistErr) {
      if (!(persistErr instanceof Error)) throw persistErr;
      console.error(
        '[mercado-livre] falha ao marcar o envio de preços como failed na tentativa final',
        {
          jobId: payload.jobId,
          integracaoId: payload.integracaoId,
          cause: err.message,
          persistError: persistErr.message,
        },
      );
    }
    return 'failed';
  }
}
