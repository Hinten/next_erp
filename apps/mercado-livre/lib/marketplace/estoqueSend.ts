/**
 * Mercado Livre **stock send task handler** (Step 10 PR B) — the core behind
 * the `sendMercadoLivreStock` `onTaskDispatched` queue (`functions/src/
 * sendStock.ts`). One task = one ML API call (the whole point of the new
 * queue): the sweeps (PR C) enqueue a task per send unit, and this handler
 * executes exactly one `PUT /items/{itemId}`.
 *
 * ---- Payloads carry TARGETS, never quantities. A Cloud Tasks retry (or a
 * task parked behind a 429 pause) can fire minutes after the sweep that
 * enqueued it — a quantity baked into the payload would overwrite newer stock
 * with a stale number. So the payload names WHAT to send (`integracaoId`,
 * family anchor `produtoId`, the one `itemId`, kind) and the handler re-reads
 * everything decision-relevant at execution time: the send gate
 * (`resolveSendUnits` — link, status whitelist, publicado/conta/kit gates) and
 * the quantities (`computeQuantidades`). A gate that closed since the sweep is
 * a success-skip, never an error.
 *
 * ---- Per-conta 429 pause (`estoqueMercadoLivreSync/{integracaoId}`): on a
 * rate-limit the handler stamps `pausedUntilUs` (Retry-After when ML sent one,
 * else `ratePauseMin()`) and RETHROWS so the queue's backoff retries the task
 * into the pause gate; a task that lands while the conta is paused re-enqueues
 * itself past the pause (plus bounded jitter so a burst doesn't re-land as a
 * burst), counter-capped at `maxPauseReenqueues()` — beyond the cap it drops,
 * and the next sweep re-covers the produto.
 *
 * ---- Error policy (no generic catch — narrowed, rethrow otherwise):
 *   - 429 → pause stamp + RETHROW (retry rides the queue backoff);
 *   - other 4xx (404 incl.) → deterministic: `estado 'E'` + `errors` stamped
 *     on the link (publish.ts precedent), SUCCESS to the queue (no retry);
 *   - reauth → lastError on the state doc, SUCCESS (a dead credential never
 *     self-heals by retrying — reconnecting the conta is a human action);
 *   - 5xx / network / Firestore / anything else → RETHROW (transient).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { millisToMicros } from '@delfrance/core/datetime';
import { idFromRef, toOuterRef } from '@delfrance/schemas';
import {
  type MlItem,
  MercadoLivreHttpError,
  MercadoLivreReauthRequiredError,
  createMercadoLivreApi,
  estadoFromMlStatus,
} from '@delfrance/integrations-mercado-livre';
import {
  estoqueMercadoLivreSyncCollection,
  produtoCollection,
  produtoMercadoLivreLinkCollection,
  variacaoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';

import {
  PAUSE_REENQUEUE_JITTER_MAX_S,
  type ResolvedLinkIdentity,
  computeQuantidades,
  maxPauseReenqueues,
  ratePauseMin,
  resolveSendUnits,
} from './estoquePlan';
import { loadMercadoLivreContext } from './mercadoLivre';
import { MlTasksDisabledError } from './mlTasks';
import type { MlStockTaskScheduler } from './mlStockTasks';

/* ------------------------------- task payload ------------------------------ */

/**
 * The stock send task payload — TARGETS ONLY, never quantities (module doc).
 * Enqueued by the sweeps (PR C) and by the pause gate's self re-enqueue;
 * re-validated on every dispatch (Cloud Tasks payloads are wire data).
 */
export const mlStockSendTaskSchema = z.object({
  integracaoId: z.string().min(1),
  /** The family ANCHOR produto — quantities are computed for this family. */
  produtoId: z.string().min(1),
  /** The ONE MLB item this task PUTs. */
  itemId: z.string().min(1),
  kind: z.enum(['item', 'variationItem']),
  /** UP model: the variation child behind `itemId`; null on `kind: 'item'`. */
  variacaoProdutoId: z.string().min(1).nullable().default(null),
  /** The sweep tick that enqueued this task (log correlation only). */
  sweepId: z.string().min(1),
  /** How many times the pause gate re-enqueued this task (capped → drop). */
  reenqueues: z.number().int().min(0).default(0),
});
export type MlStockSendTask = z.infer<typeof mlStockSendTaskSchema>;

/* -------------------------------- dependencies ----------------------------- */

/** The minimal ML API surface the send needs (injectable for tests). */
export interface StockSendApi {
  updateItem(id: string, payload: Record<string, unknown>): Promise<MlItem>;
}

/** The minimal account-context surface the send needs (injectable for tests). */
export interface StockSendContext {
  /** The parsed integração doc (`depositoOuterRef` rides through). */
  readonly conta: Readonly<Record<string, unknown>>;
  resolveChannelContext(now?: number): Promise<{ accessToken: string }>;
}

export type StockContextLoader = (db: Firestore, integracaoId: string) => Promise<StockSendContext>;

export type StockApiFactory = (config: { getAccessToken: () => Promise<string> }) => StockSendApi;

export interface StockSendDeps {
  /** The stock-queue enqueue seam (`createMlStockTaskScheduler()` in prod). */
  scheduler: MlStockTaskScheduler;
  /** ONE clock read for the whole task (`Date.now()` in prod, never re-read here). */
  nowMs: number;
  /** Defaults to `loadMercadoLivreContext` (the notificacao.ts runner chain). */
  contextLoader?: StockContextLoader;
  /** Defaults to `createMercadoLivreApi` (same chain). */
  apiFactory?: StockApiFactory;
  /**
   * Whole-second jitter added to a pause re-enqueue delay, `0..maxS`.
   * Injectable so tests get deterministic delay math; the default is
   * `Math.random`-based, capped at `PAUSE_REENQUEUE_JITTER_MAX_S`.
   */
  jitterSec?: (maxS: number) => number;
}

function defaultJitterSec(maxS: number): number {
  return Math.floor(Math.random() * (maxS + 1));
}

/* ---------------------------------- result --------------------------------- */

export type StockSendOutcome =
  | 'sent' // the ONE ML call succeeded and the link writeback landed
  | 'skipped' // deterministic no-send (gate closed / no depósito / no quantity)
  | 'paused-requeued' // conta paused → the task re-enqueued itself past the pause
  | 'dropped' // malformed payload or pause re-enqueue cap — never retried
  | 'erro-registrado'; // deterministic ML failure recorded — SUCCESS to the queue

export interface StockSendResult {
  outcome: StockSendOutcome;
  /** Machine-readable detail for skipped/dropped/erro outcomes; null otherwise. */
  reason: string | null;
}

/* ---------------------------------- handler -------------------------------- */

/**
 * Process one stock send task. Deterministic outcomes RETURN (success to the
 * queue); transient failures THROW so the queue retries with backoff — a 429
 * deliberately throws AFTER stamping the pause so the retry lands in the pause
 * gate instead of hammering ML.
 */
export async function processStockSendTask(
  db: Firestore,
  rawPayload: unknown,
  deps: StockSendDeps,
): Promise<StockSendResult> {
  // (0) Parse. A malformed payload is a coding/enqueue bug — a retry would
  // fail identically forever, so log + drop (mirrors handleNotificationTask).
  let payload: MlStockSendTask;
  try {
    payload = mlStockSendTaskSchema.parse(rawPayload);
  } catch (err) {
    if (err instanceof z.ZodError) {
      console.error('[mercado-livre] stock-send: payload inválido — task descartada', {
        issues: err.issues,
      });
      return { outcome: 'dropped', reason: 'payload-invalido' };
    }
    throw err;
  }

  const nowMs = deps.nowMs;
  const nowUs = millisToMicros(nowMs);
  const stateRef = () => estoqueMercadoLivreSyncCollection.docRef(db, {}, payload.integracaoId);

  // (1) Pause gate: a 429-paused conta must not be hit again. Re-enqueue past
  // the pause (+ jitter, so a parked burst doesn't re-land as a burst) up to
  // the cap; beyond it, drop — the next sweep re-covers the produto anyway.
  const stateSnap = await stateRef().get();
  const stateRaw = (stateSnap.data() ?? {}) as Record<string, unknown>;
  const pausedUntilUs = finiteNumber(stateRaw.pausedUntilUs);
  if (pausedUntilUs != null && pausedUntilUs > nowUs) {
    if (payload.reenqueues >= maxPauseReenqueues()) {
      console.error(
        '[mercado-livre] stock-send: limite de re-enqueues de pausa atingido — task descartada ' +
          '(o próximo sweep re-cobre o produto)',
        { integracaoId: payload.integracaoId, itemId: payload.itemId, sweepId: payload.sweepId },
      );
      return { outcome: 'dropped', reason: 'pausa-reenqueues-esgotados' };
    }
    const remainingSec = Math.ceil((pausedUntilUs - nowUs) / 1_000_000);
    const jitter = (deps.jitterSec ?? defaultJitterSec)(PAUSE_REENQUEUE_JITTER_MAX_S);
    try {
      await deps.scheduler.enqueue(
        { ...payload, reenqueues: payload.reenqueues + 1 },
        { scheduleDelaySeconds: remainingSec + jitter },
      );
    } catch (err) {
      // Migration/test valve: with MERCADO_LIVRE_TASKS_DISABLED=1 the scheduler
      // refuses — degrade to a clean drop (next sweep re-covers) instead of
      // letting the task retry-loop into the dead letter queue.
      if (err instanceof MlTasksDisabledError) {
        console.warn('[mercado-livre] stock-send: tasks desabilitadas durante pausa — descartada', {
          integracaoId: payload.integracaoId,
          itemId: payload.itemId,
          sweepId: payload.sweepId,
        });
        return { outcome: 'dropped', reason: 'tasks-desabilitadas' };
      }
      throw err;
    }
    return { outcome: 'paused-requeued', reason: null };
  }

  // The link identity (writeback target) once resolved — the 4xx error stamp
  // needs it inside the catch.
  let link: ResolvedLinkIdentity | null = null;

  try {
    // (2) Account context → depósito → live ML API (the notificacao.ts runner
    // chain). The depósito check runs BEFORE the token resolve — a conta with
    // no depósito has nothing to send, so it never needs (or refreshes) a token.
    const contextLoader = deps.contextLoader ?? loadMercadoLivreContext;
    const apiFactory = deps.apiFactory ?? createMercadoLivreApi;
    const ctx = await contextLoader(db, payload.integracaoId);
    const depositoRef = ctx.conta.depositoOuterRef;
    const depositoId =
      typeof depositoRef === 'string' && depositoRef !== '' ? idFromRef(depositoRef) : '';
    if (!depositoId) {
      // Mirrors sincronizarEstoquePedido's 'sem depósito' skip.
      console.warn('[mercado-livre] stock-send: integração sem depósito — nada a enviar', {
        integracaoId: payload.integracaoId,
        itemId: payload.itemId,
      });
      return { outcome: 'skipped', reason: 'sem-deposito' };
    }
    const channelCtx = await ctx.resolveChannelContext(nowMs);
    const api = apiFactory({ getAccessToken: async () => channelCtx.accessToken });

    // (3) FRESH gate: re-resolve the family's send units and find this task's
    // target. Absent — the gate closed since the sweep (status flipped, link
    // gone, listing now 'am', produto unpublished…) — is a success-skip.
    const resolved = await resolveSendUnits(db, {
      integracaoId: payload.integracaoId,
      produtoId: payload.produtoId,
    });
    link = resolved.link;
    const unit = resolved.units.find((u) => u.itemId === payload.itemId);
    if (unit == null || link == null) {
      console.warn('[mercado-livre] stock-send: gate fechado desde o sweep — task ignorada', {
        integracaoId: payload.integracaoId,
        itemId: payload.itemId,
        skips: resolved.skips,
      });
      return { outcome: 'skipped', reason: 'unidade-ausente' };
    }

    // (4) FRESH quantities → request body.
    let body: Record<string, unknown>;
    if (unit.kind === 'variationItem') {
      // UP model: each variation is its own ML item → single quantity.
      const qty = await computeQuantidades(db, {
        produtoId: unit.variacaoProdutoId ?? unit.produtoId,
        depositoId,
      });
      if (qty == null) return { outcome: 'skipped', reason: 'quantidade-indisponivel' };
      body = { available_quantity: qty };
    } else {
      const childrenSnap = await produtoCollection
        .ref(db, {})
        .where('paiId', '==', unit.produtoId)
        .orderBy('nome', 'asc')
        .get();
      if (childrenSnap.docs.length === 0) {
        // Childless listing → single quantity for the anchor itself.
        const qty = await computeQuantidades(db, { produtoId: unit.produtoId, depositoId });
        if (qty == null) return { outcome: 'skipped', reason: 'quantidade-indisponivel' };
        body = { available_quantity: qty };
      } else {
        // Old model with variations: ONE bulk PUT carrying every child that
        // has a numeric variação link id (parity: legacy sent what it could).
        const parentLinkOuterRef = toOuterRef(
          produtoMercadoLivreLinkCollection.docPath({ produtoId: link.produtoId }, link.docId),
        );
        const variations: Array<{ id: number; available_quantity: number }> = [];
        for (const child of childrenSnap.docs) {
          const varSnap = await variacaoMercadoLivreLinkCollection
            .ref(db, { produtoId: child.id })
            .get();
          const varLink = varSnap.docs
            .map((d) => d.data() as Record<string, unknown>)
            .find((raw) => raw.produtoMercadoLivreOuterRef === parentLinkOuterRef);
          // The NUMERIC ML variation `id` this time — NOT the UP `itemId`.
          const variationId =
            typeof varLink?.id === 'number' && Number.isInteger(varLink.id) ? varLink.id : null;
          if (variationId == null) {
            console.warn(
              '[mercado-livre] stock-send: variação sem link/id numérico — fora do envio',
              { integracaoId: payload.integracaoId, itemId: unit.itemId, produtoId: child.id },
            );
            continue;
          }
          const qty = await computeQuantidades(db, { produtoId: child.id, depositoId });
          if (qty == null) {
            console.warn(
              '[mercado-livre] stock-send: variação sem quantidade computável — fora do envio',
              { integracaoId: payload.integracaoId, itemId: unit.itemId, produtoId: child.id },
            );
            continue;
          }
          variations.push({ id: variationId, available_quantity: qty });
        }
        if (variations.length === 0) return { outcome: 'skipped', reason: 'sem-variacoes' };
        body = { variations };
      }
    }

    // (5) The ONE ML API call this task exists for.
    const resp = await api.updateItem(unit.itemId, body);

    // (6) Writeback (itemsStatusSync discipline): merge the fresh listing
    // status onto the anchor's link doc so the derived estado + raw
    // status/sub_status never go stale on a successful send.
    await produtoMercadoLivreLinkCollection.merge(db, { produtoId: link.produtoId }, link.docId, {
      estado: estadoFromMlStatus(resp.status),
      status: resp.status ?? null,
      sub_status: resp.sub_status ?? [],
      ultimaModificacao: nowMs,
    });
    return { outcome: 'sent', reason: null };
  } catch (err) {
    // (7) Narrowed error policy (module doc) — anything unlisted RETHROWS.
    if (err instanceof MercadoLivreReauthRequiredError) {
      // A dead credential never self-heals by retrying — record and succeed.
      console.error('[mercado-livre] stock-send: credencial morta — reconecte a conta', {
        integracaoId: payload.integracaoId,
        itemId: payload.itemId,
        error: err.message,
      });
      await estoqueMercadoLivreSyncCollection.merge(db, {}, payload.integracaoId, {
        lastError: err.message,
        lastErrorAtUs: nowUs,
      });
      return { outcome: 'erro-registrado', reason: 'reauth' };
    }
    if (err instanceof MercadoLivreHttpError) {
      if (err.status === 429) {
        // Rate limit: stamp the per-conta pause (Retry-After when ML sent one)
        // and RETHROW — the queue's backoff retries this task into the pause
        // gate. pauseCount is an advisory counter: read-modify-write, no tx.
        const pauseSec = err.retryAfterSec ?? ratePauseMin() * 60;
        const countSnap = await stateRef().get();
        const countRaw = (countSnap.data() ?? {}) as Record<string, unknown>;
        const pauseCount = finiteNumber(countRaw.pauseCount) ?? 0;
        await estoqueMercadoLivreSyncCollection.merge(db, {}, payload.integracaoId, {
          pausedUntilUs: millisToMicros(nowMs + pauseSec * 1000),
          pauseCount: pauseCount + 1,
          lastError: err.message,
          lastErrorAtUs: nowUs,
        });
        throw err;
      }
      if (err.status >= 400 && err.status < 500) {
        // Deterministic rejection (404 gone, 400 validation…) — a retry fails
        // identically. Stamp the link like publish.ts does and succeed.
        console.error('[mercado-livre] stock-send: rejeição determinística do ML — sem retry', {
          integracaoId: payload.integracaoId,
          itemId: payload.itemId,
          status: err.status,
          error: err.message,
        });
        if (link != null) {
          await produtoMercadoLivreLinkCollection.merge(
            db,
            { produtoId: link.produtoId },
            link.docId,
            { estado: 'E', errors: [err.message], ultimaModificacao: nowMs },
          );
        }
        return { outcome: 'erro-registrado', reason: 'http-4xx' };
      }
      throw err; // 5xx — transient, the queue retries
    }
    throw err; // network / Firestore / anything unclassified — transient or a coding bug
  }
}

/* --------------------------------- helpers --------------------------------- */

/** Narrow a raw doc field to a finite number (tolerates legacy/missing data). */
function finiteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
