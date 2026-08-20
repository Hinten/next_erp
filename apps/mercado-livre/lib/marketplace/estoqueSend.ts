/**
 * Mercado Livre **stock send task handler** (Step 10 PR B, produtos-first
 * rework) — the core behind the `sendMercadoLivreStock` `onTaskDispatched`
 * queue (`functions/src/sendStock.ts`). One task = one ML API call (the whole
 * point of the new queue): the sweeps (PR C) enqueue one task per ML call and
 * this handler executes exactly one `PUT /items/{itemId}` carrying the
 * payload's numbers.
 *
 * ---- Master flag (#805): `isStockSyncEnabled()` gates this handler as well as
 * the sweeps. The sweep's own check cannot stop a backlog it has already
 * enqueued, so `MERCADO_LIVRE_STOCK_SYNC_ENABLED != '1'` drains the queue here
 * without touching Firestore or ML. `MERCADO_LIVRE_TASKS_DISABLED` stays the
 * shared everything-off valve; this one is stock-only.
 *
 * ---- Payloads CARRY quantities, computed at sweep time (owner-locked
 * 2026-07-27 — the INVERSE of the first cut's "targets, never quantities"
 * contract; legacy BigQuery parity: the Flutter sender likewise transmitted
 * sweep-computed numbers and never re-read produtos/estoques). The sweep runs
 * THE joined query once (`bulkEstoquePlan.fetchStockFamilies`), computes every
 * family member's quantity (`quantidadesDaFamilia`) and bakes the result into
 * the task — `quantidade` XOR `variations` — together with `linkDocId`, the
 * status-writeback target, so the handler re-resolves NOTHING: no fresh gate,
 * no fresh quantities, no produto/link/children/estoque reads. Firestore
 * reads per task: the per-conta pause state doc (plus the context loader's
 * own conta/token loads).
 *
 * ---- Retry staleness — the trade the owner chose over a monotonic guard: a
 * Cloud Tasks retry, or a task parked behind a 429 pause, sends numbers up to
 * `now − sweepComputedAtMs` old and can briefly overwrite a newer value; the
 * next sweep converges. Every `'sent'` logs `ageMs` so that staleness stays
 * observable.
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
 *   - other 4xx (404 incl.) → NEVER trusted on one sample: ML answers 4xx for
 *     transient reasons too, so RETHROW until `deps.retryCount` reaches the last
 *     of `STOCK_SEND_MAX_ATTEMPTS`. On that final attempt the handler asks ML
 *     what the listing IS (`registrarRejeicaoFinal`) and records that — the true
 *     `status`/`sub_status`, plus `estado 'E'` only when ML reports the listing
 *     healthy and it is therefore our payload that is wrong — then SUCCESS to the
 *     queue. Recording only `estado` and leaving a stale `status: 'active'`
 *     behind is what made a rejected send re-send 96×/day forever (#781).
 *     Two refinements ride that same verification GET, at zero extra ML cost:
 *       · **#707** — a rejection coded `item.variations.invalid` is the one this
 *         handler can REPAIR. It diffs the family's variation links against the
 *         live `variations[]` and marks the phantoms `closed`; a prune that
 *         marked something then SKIPS the `'E'` latch, so the next sweep re-sends
 *         the corrected payload instead of waiting for a human. Legacy-model
 *         only — see `variacoesFantasma.ts`;
 *       · **#1142** — a `kind: 'variationItem'` task is ONE MEMBER of a
 *         User-Products family, so its verdict goes to the MEMBER's own link and
 *         the parent only ever takes the fold. Writing it straight through would
 *         let one member cancel the family, which is a silent sweep outage;
 *   - reauth → lastError on the state doc, SUCCESS (a dead credential never
 *     self-heals by retrying — reconnecting the conta is a human action);
 *   - 5xx / network / Firestore / anything else → RETHROW (transient).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { millisToMicros } from '@delfrance/core/datetime';
import { ESTADO_PUBLICACAO_ML, idFromRef, toOuterRef } from '@delfrance/schemas';
import {
  type MlItem,
  MercadoLivreError,
  MercadoLivreHttpError,
  MercadoLivreReauthRequiredError,
  createMercadoLivreApi,
  estadoFromMlStatus,
} from '@delfrance/integrations-mercado-livre';
import {
  estoqueMercadoLivreSyncCollection,
  produtoMercadoLivreLinkCollection,
  variacaoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';

import {
  PAUSE_REENQUEUE_JITTER_MAX_S,
  STOCK_SEND_MAX_ATTEMPTS,
  STOCK_SYNC_FLAG_ENV,
  isStockSyncEnabled,
  maxPauseReenqueues,
  podeEnviarEstoque,
  ratePauseMin,
} from './bulkEstoquePlan';
import {
  type MemberFoldTarget,
  applyItemStatusToLink,
  applyMemberStatusAndFold,
} from './itemsStatusSync';
import { familyMemberQuery } from './upMemberLink';
import {
  SUB_STATUS_VARIACAO_REMOVIDA,
  idsDasVariacoesVivas,
  planejarPoda,
  temCausaVariacoesInvalidas,
  type MembroFamilia,
} from './variacoesFantasma';
import { loadMercadoLivreContext } from './mercadoLivre';
import { MlTasksDisabledError } from './mlTasks';
import type { MlStockTaskScheduler } from './mlStockTasks';
import { clearFalha, type FalhaPatch, falhaPatch } from './publishFalhas';

/* ------------------------------- task payload ------------------------------ */

/**
 * The stock send task payload — carries the SWEEP-COMPUTED quantities (module
 * doc). Enqueued by the sweeps (PR C) and by the pause gate's self re-enqueue;
 * re-validated on every dispatch (Cloud Tasks payloads are wire data).
 *
 * Deliberately PLAIN zod (the registry-safe convention — no `.refine`): the
 * "exactly ONE of `quantidade` / `variations` non-null" invariant is enforced
 * by the handler instead (both null → dropped `'payload-sem-quantidade'`;
 * both non-null → `variations` wins, loudly).
 *
 * `bulkEstoquePlan.buildSendTasks`'s `StockSendTaskDraft` mirrors this shape
 * field-for-field, so the sweep's drafts parse verbatim — pinned (compile-time
 * and runtime) in estoqueSend.test.ts.
 */
export const mlStockSendTaskSchema = z.object({
  integracaoId: z.string().min(1),
  /** The family ANCHOR produto — the writeback path segment + log identity. */
  produtoId: z.string().min(1),
  /** The ONE MLB item this task PUTs. */
  itemId: z.string().min(1),
  kind: z.enum(['item', 'variationItem']),
  /** UP model: the variation child behind `itemId`; null on `kind: 'item'`. */
  variacaoProdutoId: z.string().min(1).nullable().default(null),
  /** The conta's `produtoMercadoLivre` link doc id — the status-writeback target, NEVER re-resolved. */
  linkDocId: z.string().min(1),
  /** Single-item quantity (sweep-computed) — null when `variations` carries the numbers. */
  quantidade: z.number().int().min(0).nullable().default(null),
  /** Old-model bulk send: one entry per variation, `id` = the NUMERIC variação-link id. */
  variations: z
    .array(z.object({ id: z.number().int(), available_quantity: z.number().int().min(0) }))
    .nullable()
    .default(null),
  /** When the sweep computed the quantities (ms since epoch) — feeds the `ageMs` sent log. */
  sweepComputedAtMs: z.number().int(),
  /** The sweep tick that enqueued this task (log correlation only). */
  sweepId: z.string().min(1),
  /** How many times the pause gate re-enqueued this task (capped → drop). */
  reenqueues: z.number().int().min(0).default(0),
});
export type MlStockSendTask = z.infer<typeof mlStockSendTaskSchema>;

/* -------------------------------- dependencies ----------------------------- */

/**
 * The minimal ML API surface the send needs (injectable for tests). `getItem` is
 * used ONLY by the terminal 4xx branch — never on the happy path, and never on a
 * non-final attempt — to learn the listing's real state before recording it.
 */
export interface StockSendApi {
  updateItem(id: string, payload: Record<string, unknown>): Promise<MlItem>;
  getItem(id: string): Promise<MlItem>;
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
   * Cloud Tasks attempt index (0-based), defaulting to 0. ML answers 4xx for
   * transient reasons too, so the 4xx branch RETHROWS (the queue retries with
   * backoff) until this is the LAST attempt — only then does it ask ML for the
   * listing's real state and record it. Mirrors `processPriceSyncJob` /
   * `processMassImportJob`, which take the same index positionally; it rides
   * `deps` here so the handler keeps its 3-arg signature.
   */
  retryCount?: number;
  /**
   * Whole-second jitter added to a pause re-enqueue delay, `0..maxS`.
   * Injectable so tests get deterministic delay math; the default is
   * `Math.random`-based, capped at `PAUSE_REENQUEUE_JITTER_MAX_S`.
   */
  jitterSec?: (maxS: number) => number;
  /**
   * Skip the `MERCADO_LIVRE_STOCK_SYNC_ENABLED` gate below. Set ONLY by the
   * manual push (#819), never by the queue handler.
   *
   * The flag governs the UNATTENDED blast radius — three sweeps enqueuing for
   * the whole catalogue, 96× a day — and it stays off until the window in which
   * the legacy Flutter stock sender is decommissioned. An operator pushing a
   * hand-picked selection is a different risk class: it is permission-gated,
   * bounded, reported per listing, and the legacy app exposes its own manual
   * "Enviar Estoque" button doing the same thing today. Gating the manual route
   * on this flag would ship it INERT until the cutover, leaving the new send
   * path unexercised exactly when we most want it proven.
   *
   * ⚠️ `functions/src/sendStock.ts` must never set this — pinned by
   * `stockSendMaxAttempts.test.ts`, which reads that file's source.
   */
  ignoreSyncFlag?: boolean;
}

function defaultJitterSec(maxS: number): number {
  return Math.floor(Math.random() * (maxS + 1));
}

/* ---------------------------------- result --------------------------------- */

export type StockSendOutcome =
  | 'sent' // the ONE ML call succeeded and the link writeback landed
  | 'skipped' // deterministic no-send (master flag off, or conta misconfigured — no depósito)
  | 'paused-requeued' // conta paused → the task re-enqueued itself past the pause
  | 'dropped' // malformed/quantity-less payload or pause re-enqueue cap — never retried
  | 'erro-registrado'; // deterministic ML failure recorded — SUCCESS to the queue

export interface StockSendResult {
  outcome: StockSendOutcome;
  /**
   * Machine-readable detail for skipped/dropped/erro outcomes; null otherwise.
   *
   * The `erro-registrado` vocabulary, since each says something different about
   * what to do next: `variacoes-podadas` (#707 repaired the payload — NOT
   * latched, the next sweep retries), `payload-rejeitado` (latched `'E'`),
   * `anuncio-nao-enviavel` / `anuncio-inexistente` (ML’s own status stops it),
   * `membro-inexistente` (one UP member closed; the family took the fold),
   * `membro-nao-encontrado` / `verificacao-indisponivel` / `sem-api` (nothing was
   * confirmed — conservative stop), `reauth`.
   */
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

  // (0.5) Master flag (#805). The sweep gates on it too, but its backlog is
  // ALREADY enqueued when the flag flips — up to `maxTasksPerSweep()` tasks per
  // conta, ~17min of draining at the queue's 2/s — so without this check the
  // documented kill switch keeps hitting ML for the whole drain. Runs BEFORE the
  // pause gate so a drained task costs zero Firestore reads.
  //
  // Ack, never retry: a retry would only re-read the same env. The task is lost
  // rather than deferred, which is the same bargain the pause re-enqueue cap
  // takes — the next enabled sweep re-covers the produto.
  //
  // WARN, not info: the sweep logs its no-op at info because being off is its
  // steady state (the flag ships OFF and it ticks every 15min). A task reaching
  // THIS handler while off is abnormal — it means a backlog is draining behind
  // an emergency stop.
  if (deps.ignoreSyncFlag !== true && !isStockSyncEnabled()) {
    console.warn(
      `[mercado-livre] stock-send: sync desabilitado (${STOCK_SYNC_FLAG_ENV} != '1') — task descartada`,
      { integracaoId: payload.integracaoId, itemId: payload.itemId, sweepId: payload.sweepId },
    );
    return { outcome: 'skipped', reason: 'sync-desabilitado' };
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

  // Hoisted out of the try so the terminal 4xx branch in the catch can re-use the
  // SAME authenticated client for its verification GET (no second token resolve).
  let api: StockSendApi | null = null;

  try {
    // (2) Account context → depósito guard → live ML API (the notificacao.ts
    // runner chain). The depósito presence check is a CHEAP conta-misconfig
    // guard — it reads the integração doc the context already loaded (no extra
    // query) and runs BEFORE the token resolve, so a depósito-less conta never
    // needs (or refreshes) a token. Mirrors sincronizarEstoquePedido's 'sem
    // depósito' skip; the sweep should never have enqueued for such a conta.
    const contextLoader = deps.contextLoader ?? loadMercadoLivreContext;
    const apiFactory = deps.apiFactory ?? createMercadoLivreApi;
    const ctx = await contextLoader(db, payload.integracaoId);
    const depositoRef = ctx.conta.depositoOuterRef;
    const depositoId =
      typeof depositoRef === 'string' && depositoRef !== '' ? idFromRef(depositoRef) : '';
    if (!depositoId) {
      console.warn('[mercado-livre] stock-send: integração sem depósito — nada a enviar', {
        integracaoId: payload.integracaoId,
        itemId: payload.itemId,
      });
      return { outcome: 'skipped', reason: 'sem-deposito' };
    }
    const channelCtx = await ctx.resolveChannelContext(nowMs);
    api = apiFactory({ getAccessToken: async () => channelCtx.accessToken });

    // (3) The request body — the payload's sweep-computed numbers, VERBATIM
    // (module doc: no re-resolution, no fresh reads). The schema stays plain,
    // so the exactly-one invariant is enforced here: both null is an enqueue
    // bug (a retry would fail identically → drop); both non-null prefers the
    // bulk `variations`, loudly.
    if (payload.variations != null && payload.quantidade != null) {
      console.warn(
        '[mercado-livre] stock-send: payload com quantidade E variations — variations vence',
        { integracaoId: payload.integracaoId, itemId: payload.itemId, sweepId: payload.sweepId },
      );
    }
    const body: Record<string, unknown> | null =
      payload.variations != null
        ? { variations: payload.variations }
        : payload.quantidade != null
          ? { available_quantity: payload.quantidade }
          : null;
    if (body == null) {
      console.error(
        '[mercado-livre] stock-send: payload sem quantidade nem variations — task descartada',
        { integracaoId: payload.integracaoId, itemId: payload.itemId, sweepId: payload.sweepId },
      );
      return { outcome: 'dropped', reason: 'payload-sem-quantidade' };
    }

    // (4) The ONE ML API call this task exists for.
    const resp = await api.updateItem(payload.itemId, body);

    // (5) Writeback (itemsStatusSync discipline): merge the fresh listing
    // status onto the link doc the PAYLOAD names (`linkDocId` under the anchor
    // `produtoId` — carried from the sweep, never re-resolved) so the derived
    // estado + raw status/sub_status never go stale on a successful send.
    // `mergeIfExists`: `linkDocId` rides from the sweep and is never re-resolved,
    // so the link may have been deleted while this task sat in the queue. An
    // upsert would resurrect a ghost doc holding only these keys.
    //
    // ⚠️ A `kind: 'variationItem'` task is the EXCEPTION, and it is the same
    // one-member-speaks-for-the-family failure the terminal branch below fixes,
    // in the success direction: `resp` describes ONE member's ML item while
    // `linkDocId` names the FAMILY's parent link. Writing `resp.status` there
    // publishes one member's lifecycle as the family's, and the parent gate in
    // `buildSendTasks` then skips EVERY sibling the moment a member comes back
    // `paused` or `under_review` on an otherwise accepted PUT. So a member send
    // writes no status at all — only the heal (`clearFalha`) and the stamp, both
    // of which are legitimately family-wide.
    //
    // ⚠️ It does not write the MEMBER's own status either, and that is a
    // deliberate scope limit rather than an oversight. The member's link doc id
    // is not in the payload, so reaching it costs a subcollection read on the
    // HOT path — one per member task, 96× a day across the catalogue — to record
    // a value that is `active` by construction (ML just accepted a stock update
    // for it). The rungs that genuinely need a member status all write it
    // already: the `items` webhook, #707's prune, and the terminal-4xx fold.
    // The consequence is that `membroPodeEnviar`'s optimistic arm converges only
    // through those three — the safe direction, since it sends. Recorded next to
    // the other residual in `apps/mercado-livre/CLAUDE.md`.
    const ehMembro = payload.variacaoProdutoId != null;
    const applied = await produtoMercadoLivreLinkCollection.mergeIfExists(
      db,
      { produtoId: payload.produtoId },
      payload.linkDocId,
      {
        ...(ehMembro
          ? {}
          : {
              estado: estadoFromMlStatus(resp.status),
              status: resp.status ?? null,
              sub_status: resp.sub_status ?? [],
            }),
        ultimaModificacao: nowMs,
        // A send that lands clears whatever diagnosis the last failure left
        // behind — otherwise the produto tab keeps showing a red alert for a
        // fault that has since healed (#781).
        ...clearFalha(),
      },
    );
    if (!applied) {
      console.warn(
        '[mercado-livre] stock-send: link removido durante o envio — writeback ignorado',
        {
          integracaoId: payload.integracaoId,
          produtoId: payload.produtoId,
          linkDocId: payload.linkDocId,
          itemId: payload.itemId,
        },
      );
    }

    // Staleness observability (module doc): the numbers were computed at sweep
    // time and sent verbatim — `ageMs` says how old they were.
    console.info('[mercado-livre] stock-send: enviado', {
      integracaoId: payload.integracaoId,
      itemId: payload.itemId,
      sweepId: payload.sweepId,
      ageMs: nowMs - payload.sweepComputedAtMs,
    });
    return { outcome: 'sent', reason: null };
  } catch (err) {
    // (6) Narrowed error policy (module doc) — anything unlisted RETHROWS.
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
        // gate. pauseCount is an advisory counter (no tx) — reuse the pause
        // gate's read from the top of this task instead of a second get().
        const pauseSec = err.retryAfterSec ?? ratePauseMin() * 60;
        const pauseCount = finiteNumber(stateRaw.pauseCount) ?? 0;
        await estoqueMercadoLivreSyncCollection.merge(db, {}, payload.integracaoId, {
          pausedUntilUs: millisToMicros(nowMs + pauseSec * 1000),
          pauseCount: pauseCount + 1,
          lastError: err.message,
          lastErrorAtUs: nowUs,
        });
        throw err;
      }
      if (err.status >= 400 && err.status < 500) {
        // ML answers 4xx for transient reasons too, so ONE rejection is evidence,
        // not proof: rethrow and let the queue's backoff re-run the whole send
        // (the repo's `retryCount < MAX - 1` ladder — massImport.ts:412,
        // precoSync.ts:681, notifications/pipeline.ts:180).
        const retryCount = deps.retryCount ?? 0;
        if (retryCount < STOCK_SEND_MAX_ATTEMPTS - 1) throw err;

        // LAST attempt. Never derive the terminal state from the rejection alone:
        // ask ML what this listing actually IS and record THAT, so the sweep's
        // existing status gate can act on it. Writing only `estado` and leaving a
        // stale `status: 'active'` behind is exactly what made a rejected send
        // rebuild and re-send forever, 96×/day (#781).
        console.error(
          '[mercado-livre] stock-send: rejeição do ML na última tentativa — verificando o anúncio',
          {
            integracaoId: payload.integracaoId,
            itemId: payload.itemId,
            status: err.status,
            error: err.message,
            retryCount,
          },
        );
        return await registrarRejeicaoFinal(db, api, payload, err, nowMs);
      }
      throw err; // 5xx — transient, the queue retries
    }
    throw err; // network / Firestore / anything unclassified — transient or a coding bug
  }
}

/* --------------------------------- helpers --------------------------------- */

/**
 * Terminal 4xx handling (#781) — reached ONLY on the queue's last attempt, once
 * the retry ladder has failed to get the send through.
 *
 * The rejection proves the send failed; it does NOT say why, and ML publishes no
 * canonical cause table for `PUT /items/{id}`. So rather than matching error
 * strings, ask ML for the listing and let its real state decide — written through
 * the SAME helper the `items` webhook uses, so the two can never disagree:
 *
 *  - a listing ML reports as NOT sendable (closed / inactive / payment_required /
 *    under_review / paused without `out_of_stock`) needs no latch at all —
 *    recording its true status is enough, because `podeEnviarEstoque` skips it;
 *  - a listing ML reports as HEALTHY is the residual case (ML is fine, our
 *    payload is not), so it additionally gets `estado 'E'`, which the gate skips;
 *  - a 404 means the listing is GONE. `syncItemStatus` treats that as a no-op
 *    (`'item-gone'`); doing the same HERE would leave `status: 'active'` standing
 *    and the loop running, so the closed state is stamped explicitly;
 *  - if the verification GET itself fails, nothing was confirmed — fall back to
 *    the conservative `estado 'E'` stop and log loudly.
 *
 * Every branch returns SUCCESS to the queue: the state is recorded, and either an
 * `items` webhook or the produto tab's "Reverificar anúncio" action re-arms it.
 *
 * ---- TWO SHAPES REACH HERE, and conflating them is #1142's failure.
 *
 * `kind: 'item'` is one listing: the payload's `itemId` IS what `linkDocId`
 * points at, so everything above writes straight through.
 *
 * `kind: 'variationItem'` is ONE MEMBER of a User-Products family: `linkDocId`
 * names the FAMILY's parent link while `itemId` names the member's own ML item
 * (`buildSendTasks`). Writing the member's verdict onto the parent would let a
 * single member speak for the whole family — and for `closed` that is a SILENT
 * OUTAGE, not a visible error: `estado 'c'` fails `linkHasLiveListing`, which
 * drops the conta from `integracoesComProduto`, the anchor pre-filter BOTH sweeps
 * open with. The produto simply stops being selected, and nothing logs a reason.
 * `upFamilyStatus.ts` exists for exactly this, so the member path lands on the
 * same fold the `items` webhook does (`applyMemberStatusAndFold`) and only ever
 * writes the member's status to the MEMBER's own link.
 *
 * ⚠️ Every member-path writeback also passes `skipDenorm` by construction — it
 * never reaches `applyItemStatusToLink` at all. The denorm key is the parent
 * link's own `id` (publish and import both stamped the FAMILY id), so
 * `updateParentDenorm` handed a member id would `arrayUnion` an entry nothing can
 * ever remove, and its cancel arm's `externalId` filter would match nothing.
 */
async function registrarRejeicaoFinal(
  db: Firestore,
  api: StockSendApi | null,
  payload: MlStockSendTask,
  err: MercadoLivreHttpError,
  nowMs: number,
): Promise<StockSendResult> {
  const target = {
    produtoId: payload.produtoId,
    linkDocId: payload.linkDocId,
    itemId: payload.itemId,
  };
  // The stock PUT is rejected by the same validation pipeline a publish is, so
  // its `cause[]` is worth the same treatment. No item payload exists on this
  // path, so nothing resolves positionally — an `item.price` / `available_quantity`
  // cause has no control in the listing form anyway and lands above it.
  //
  // ⚠️ `api` is the endpoint discriminator, and the reason it is a parameter.
  // It is assigned only AFTER `resolveChannelContext` returns, so a null one means
  // the failure happened before the item client existed — and a non-`invalid_grant`
  // token refresh throws a plain `MercadoLivreHttpError` carrying the
  // `/oauth/token` body (`oauth.ts`), which lands in this same terminal-4xx
  // branch. Reading that body would persist a token-endpoint response into a
  // document any `d_produto` reader can open.
  const diagnostico = falhaPatch(err, err.message, api != null ? 'item' : 'nao-item');

  // Unreachable today — a MercadoLivreHttpError from the PUT implies the client
  // was built. Guarded so a future reorder degrades to the conservative stop
  // rather than throwing past the recording step.
  if (api == null) return await pararComErro(db, target, diagnostico, nowMs, 'sem-api');

  // A UP member resolves its own link doc up front: every branch below needs it,
  // and failing to find one is itself a reason to take the conservative stop
  // rather than to write the member's verdict onto the family.
  let membro: MembroDaFamilia | null = null;
  if (payload.variacaoProdutoId != null) {
    membro = await resolverMembroDaFamilia(db, payload);
    if (membro == null) {
      console.error(
        '[mercado-livre] stock-send: link do membro não encontrado — parada conservadora ' +
          '(o veredito de UM membro nunca pode ser escrito no link da família)',
        {
          integracaoId: payload.integracaoId,
          produtoId: payload.produtoId,
          variacaoProdutoId: payload.variacaoProdutoId,
          itemId: payload.itemId,
        },
      );
      return await pararComErro(db, target, diagnostico, nowMs, 'membro-nao-encontrado');
    }
  }

  let item: MlItem;
  try {
    item = await api.getItem(payload.itemId);
  } catch (getErr) {
    if (getErr instanceof MercadoLivreHttpError && getErr.status === 404) {
      console.error(
        '[mercado-livre] stock-send: anúncio inexistente no ML — registrado como cancelado',
        {
          integracaoId: payload.integracaoId,
          itemId: payload.itemId,
          variacaoProdutoId: payload.variacaoProdutoId,
        },
      );
      const fechado = { status: 'closed', sub_status: [] as string[] };
      if (membro != null) {
        // The MEMBER is gone, not the family. `applyMemberStatusAndFold` writes
        // `closed` to the member's own link and re-derives the parent from EVERY
        // member — so `estado 'c'` can only land once every observed one is
        // closed, which is `foldFamilyStatus`'s whole contract.
        await applyMemberStatusAndFold(db, payload.integracaoId, membro.foldTarget, {
          status: fechado.status,
          subStatus: fechado.sub_status,
        });
        return await gravarDiagnostico(db, target, diagnostico, nowMs, 'membro-inexistente');
      }
      await applyItemStatusToLink(db, payload.integracaoId, target, fechado, {
        nowMs,
        extra: { ...diagnostico },
      });
      return { outcome: 'erro-registrado', reason: 'anuncio-inexistente' };
    }
    if (getErr instanceof MercadoLivreError) {
      console.warn(
        '[mercado-livre] stock-send: verificação do anúncio indisponível — parada conservadora',
        {
          integracaoId: payload.integracaoId,
          itemId: payload.itemId,
          variacaoProdutoId: payload.variacaoProdutoId,
          error: getErr.message,
        },
      );
      return await pararComErro(db, target, diagnostico, nowMs, 'verificacao-indisponivel');
    }
    throw getErr; // Firestore / anything unclassified — transient or a coding bug
  }

  // #707 — the ONE cause this handler can actually repair, and the item GET it
  // needs is the one just made (zero extra ML calls, exactly like legacy).
  const podadas = await podarVariacoesFantasma(db, payload, item, diagnostico.causas);

  const sendable = podeEnviarEstoque(item.status, item.sub_status).enviar;

  if (membro != null) {
    // Record what ML said about THIS member on the member's own link, and let the
    // fold decide what that means for the family.
    await applyMemberStatusAndFold(db, payload.integracaoId, membro.foldTarget, {
      status: item.status ?? null,
      subStatus: item.sub_status ?? null,
    });
    if (!sendable) {
      return await gravarDiagnostico(db, target, diagnostico, nowMs, 'anuncio-nao-enviavel');
    }
    // ML says the member COULD take stock, so it was our payload it refused.
    // ⚠️ The latch is the FAMILY's — `estado` lives only on the parent link and
    // the schema deliberately gives a member none — so this stops the siblings
    // too. It is bounded and LOUD (the produto tab shows the diagnosis, the sweep
    // logs `anuncio-em-erro`, an `items` webhook or "Reverificar anúncio" clears
    // it), which is the opposite of the silent `estado 'c'` drop above; naming the
    // member is what makes the over-reach attributable.
    console.error(
      '[mercado-livre] stock-send: payload rejeitado para UM membro da família — ' +
        'a família inteira fica travada em erro até a próxima verificação',
      {
        integracaoId: payload.integracaoId,
        produtoId: payload.produtoId,
        variacaoProdutoId: payload.variacaoProdutoId,
        itemId: payload.itemId,
      },
    );
    return await pararComErro(db, target, diagnostico, nowMs, 'payload-rejeitado');
  }

  await applyItemStatusToLink(db, payload.integracaoId, target, item, {
    nowMs,
    // ML says this listing COULD take stock, so the rejection was about our
    // payload rather than the anúncio — latch it with the estado the gate skips.
    //
    // ⚠️ UNLESS the prune above just repaired that payload. `estado 'E'` is what
    // `buildSendTasks` skips on, so latching a listing we have already fixed
    // would leave the corrected payload unsent until a human clicks "Reverificar
    // anúncio" — a self-heal that does not heal. Having pruned, the next sweep
    // rebuilds without the phantom entries and the send is expected to land; if
    // it does not, the ladder runs again and the `podadas === 0` arm latches it
    // then, so #781's 96×/day loop cannot reopen.
    extra:
      sendable && podadas === 0
        ? { estado: ESTADO_PUBLICACAO_ML.erro, ...diagnostico }
        : { ...diagnostico },
  });
  return {
    outcome: 'erro-registrado',
    reason:
      podadas > 0 ? 'variacoes-podadas' : sendable ? 'payload-rejeitado' : 'anuncio-nao-enviavel',
  };
}

/* ------------------------- #707 phantom-variation prune -------------------- */

/**
 * Mark every `variacaoMercadoLivre` link of this family whose ML variation id no
 * longer exists on the listing, and return how many were marked (0 when the
 * rejection was not about variations at all).
 *
 * Three guards decide whether the diff runs, and each is legacy's own:
 *
 *  - `payload.variations != null` — only an OLD-model bulk send carries a
 *    `variations[]` array, and only such a payload can earn this cause;
 *  - `item.family_name == null` — the early return the legacy helper opens with
 *    (`produtos.dart:454`). Under User Products the array does not exist and the
 *    members are identified by `itemId`, so a legacy-shaped diff is meaningless;
 *  - the rejection actually names `item.variations.invalid`.
 *
 * ⚠️ Race discipline (root `CLAUDE.md` rule 7 / ADR 0011, class **B**): the
 * decision's ML half crosses the network, so the STORED half is re-read with
 * `tx.get` inside the transaction and `planejarPoda` runs on THAT snapshot —
 * never on one taken before the round trip. A concurrent import or publish
 * rewriting a member's `id` aborts this attempt instead of losing to it, which
 * matters because losing here marks a LIVE variation `closed` and silently stops
 * its stock. A Firestore failure rethrows like any other and the queue retries;
 * what must never happen is a partial prune being counted as a complete one, and
 * the transaction is what gives that.
 */
async function podarVariacoesFantasma(
  db: Firestore,
  payload: MlStockSendTask,
  item: MlItem,
  causas: FalhaPatch['causas'],
): Promise<number> {
  if (payload.variations == null) return 0;
  if (item.family_name != null) return 0;
  if (!temCausaVariacoesInvalidas(causas)) return 0;

  const idsVivos = idsDasVariacoesVivas(item);
  const query = familyMemberQuery(db, parentLinkOuterRef(payload));

  const podados = await db.runTransaction(async (tx) => {
    const snap = await tx.get(query);
    const membros: MembroFamilia[] = snap.docs.map((d) => ({
      docId: d.id,
      produtoId: d.ref.parent?.parent?.id ?? '',
      raw: d.data() as Record<string, unknown>,
    }));
    const alvos = planejarPoda(membros, idsVivos);
    for (const alvo of alvos) {
      tx.set(
        variacaoMercadoLivreLinkCollection.docRef(db, { produtoId: alvo.produtoId }, alvo.docId),
        { status: 'closed', sub_status: [SUB_STATUS_VARIACAO_REMOVIDA] },
        { merge: true },
      );
    }
    return alvos;
  });

  if (podados.length > 0) {
    console.warn(
      '[mercado-livre] stock-send: variações inexistentes no ML marcadas como closed (#707)',
      {
        integracaoId: payload.integracaoId,
        produtoId: payload.produtoId,
        itemId: payload.itemId,
        variacoes: podados.map((a) => a.variacaoId).slice(0, 20),
      },
    );
  }
  return podados.length;
}

/* --------------------------- User-Products member -------------------------- */

/** The member link behind a `kind: 'variationItem'` task. */
interface MembroDaFamilia {
  foldTarget: MemberFoldTarget;
}

/** The canonical `documents/...` ref of the parent link this task names. */
function parentLinkOuterRef(payload: MlStockSendTask): string {
  return toOuterRef(
    produtoMercadoLivreLinkCollection.docPath({ produtoId: payload.produtoId }, payload.linkDocId),
  );
}

/**
 * The `variacaoMercadoLivre` link doc behind this member task, or null.
 *
 * The child produto holds a handful of links, so the whole subcollection is read
 * and filtered in code — no `where`, hence no index, the same trade
 * `sobrevivemVariacoesDoProduto` takes for the same reason.
 *
 * The match is `itemId` AND the parent ref, which is exactly the pair
 * `buildSendTasks` matched on to emit this task. An ML item id is globally
 * unique, so the parent term only guards against a data defect — but a defect is
 * precisely when writing to the wrong family would hurt.
 */
async function resolverMembroDaFamilia(
  db: Firestore,
  payload: MlStockSendTask,
): Promise<MembroDaFamilia | null> {
  const childId = payload.variacaoProdutoId;
  if (childId == null) return null;
  const pmlOuterRef = parentLinkOuterRef(payload);
  const snap = await variacaoMercadoLivreLinkCollection.ref(db, { produtoId: childId }).get();
  for (const d of snap.docs) {
    const raw = d.data() as Record<string, unknown>;
    if (raw.itemId !== payload.itemId) continue;
    if (raw.produtoMercadoLivreOuterRef !== pmlOuterRef) continue;
    return {
      foldTarget: {
        produtoId: payload.produtoId,
        linkDocId: payload.linkDocId,
        memberProdutoId: childId,
        memberDocId: d.id,
        pmlOuterRef,
      },
    };
  }
  return null;
}

/* --------------------------------- helpers --------------------------------- */

/**
 * Record the diagnosis on the family link WITHOUT latching it.
 *
 * The counterpart of {@link pararComErro} for the cases where the stop is already
 * recorded somewhere more precise — the member's own link, or the listing's real
 * ML status — so `estado 'E'` would only over-reach.
 */
async function gravarDiagnostico(
  db: Firestore,
  target: { produtoId: string; linkDocId: string },
  diagnostico: FalhaPatch,
  nowMs: number,
  reason: string,
): Promise<StockSendResult> {
  const applied = await produtoMercadoLivreLinkCollection.mergeIfExists(
    db,
    { produtoId: target.produtoId },
    target.linkDocId,
    { ...diagnostico, ultimaModificacao: nowMs },
  );
  if (!applied) {
    console.warn('[mercado-livre] stock-send: link removido — diagnóstico não registrado', {
      produtoId: target.produtoId,
      linkDocId: target.linkDocId,
      reason,
    });
  }
  return { outcome: 'erro-registrado', reason };
}

/**
 * The conservative stop: record the failure without a verified listing state.
 * `estado 'E'` is what the sweep's gate skips on, so the loop still terminates.
 */
async function pararComErro(
  db: Firestore,
  target: { produtoId: string; linkDocId: string },
  diagnostico: FalhaPatch,
  nowMs: number,
  reason: string,
): Promise<StockSendResult> {
  // `mergeIfExists`: a link deleted mid-flight needs no diagnosis, and an
  // upsert here would recreate it as a ghost the sweep can never clean up.
  const applied = await produtoMercadoLivreLinkCollection.mergeIfExists(
    db,
    { produtoId: target.produtoId },
    target.linkDocId,
    { estado: ESTADO_PUBLICACAO_ML.erro, ...diagnostico, ultimaModificacao: nowMs },
  );
  if (!applied) {
    console.warn('[mercado-livre] stock-send: link removido — erro não registrado no anúncio', {
      produtoId: target.produtoId,
      linkDocId: target.linkDocId,
      reason,
    });
  }
  return { outcome: 'erro-registrado', reason };
}

/** Narrow a raw doc field to a finite number (tolerates legacy/missing data). */
function finiteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
