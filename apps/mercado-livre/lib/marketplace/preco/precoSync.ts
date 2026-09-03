/**
 * "Atualizar preços" manual bulk price-sync core (ERP→ML) — Step 11 PR C. A
 * MANUAL-ONLY flow by owner decision: prices, unlike stock, have no continuous
 * upstream mutation stream worth chasing — they change in deliberate batches
 * (price-table edits), and an automated sweep could silently fight a seller
 * running ML promotions. So there is NO schedule and NO trigger: a user clicks
 * "Atualizar preços" on the channel list screen (`/canais/mercado-livre`, PR D;
 * moved off the per-conta screen by #816, so one click can cover several
 * selected contas — still ONE job per conta), optionally allowing decreases
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
 * ---- ⚠️ This module calls `MercadoLivreApi.updateItem` directly, and the note
 * that used to sit here called that a "plugin bypass" of
 * `MarketplaceChannel.pushPrice`. It was not a bypass; it was the only thing
 * that could work, and #815 deleted the contract on exactly this evidence. Two
 * reasons, both still true: the contract typed money as `MinorUnits` (integer
 * centavos) while the produto price tables and ML's own wire both speak reais
 * floats, so there was no correct place to convert; and the per-listing
 * GET-before-PUT gates below need the raw `MlItem`, which a
 * `(ctx, update) => PushResult` signature cannot carry. The replacement is
 * declarative — `MARKETPLACE_TIPO_CAPS.enviarPreco` says whether a channel can
 * do this at all; the how stays here.
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
 * that never surfaces. So every body the sender builds carries price fields
 * and nothing else, and gate 7 re-verifies the echoed price anyway.
 *
 * ---- Per-item gates (1)-(8) live in `precoDraftSend.ts`, shared verbatim
 * with the manual produto-scoped push (#804) so there is only ever ONE place
 * the sent price is decided. This module owns gate (9), the per-item
 * checkpoint, plus the job-level meaning of each outcome: a `pausa` re-enqueues
 * WITHOUT consuming the draft, a `fatal` stamps the job `failed`, and
 * `pulado`/`falha` feed the capped detail lists behind uncapped counters.
 */
import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import {
  ENVIO_PRECO_FASE,
  ENVIO_PRECO_MERCADO_LIVRE_STATUS,
  ENVIO_PRECO_RESULTADO,
  type EnvioPrecoFase,
  type EnvioPrecoMercadoLivre,
  type LinhaRelatorioEnvioPreco,
  RELATORIO_ENVIO_PRECO_ERRO_MAX,
  RELATORIO_ENVIO_PRECO_SHARD_SIZE,
  idFromRef,
  relatorioEnvioPrecoRowKey,
  relatorioEnvioPrecoShardId,
} from '@delfrance/schemas';
import {
  MercadoLivreHttpError,
  createMercadoLivreApi,
} from '@delfrance/integrations-mercado-livre';
import {
  envioPrecoMercadoLivreCollection,
  relatorioEnvioPrecoMercadoLivreCollection,
} from '@delfrance/data/admin/collections';

import {
  PLAN_PAGE_DRAFTS_CAP,
  PRICE_SYNC_FAILURES_CAP,
  PRICE_SYNC_MAX_PAUSES,
  PRICE_SYNC_SKIPS_CAP,
  type FetchPrecoPage,
  buildPrecoDrafts,
  fetchPrecoPage,
  precoItemsPerDispatch,
  precoPageLimit,
  precoRatePauseMin,
} from './precoPlan';
import {
  type FetchPrecoReconPage,
  PRECO_RECON_MAX_PAGES,
  fetchPrecoReconPage,
  precoReconPageLimit,
  precoReconciliacaoHabilitada,
} from './precoReconciliacao';
import { type PriceSyncApi, enviarPrecoDraft } from './precoDraftSend';
import { loadMercadoLivreContext } from '../core/mercadoLivre';
import type { MlPriceSyncScheduler } from './mlPriceSyncTasks';

/**
 * Re-exported under its original name: the type moved to `precoDraftSend.ts`
 * (which must not import from here — that would close a cycle), but this module
 * is where every existing consumer imports it from.
 */
export type { PriceSyncApi };

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
  /**
   * Injectable for tests; defaults to `precoReconciliacao.fetchPrecoReconPage`.
   *
   * ⚠️ Its own dep rather than another name on the `./precoPlan` mock, because
   * `precoSync.test.ts` module-mocks that file WHOLESALE — an export added
   * there arrives `undefined` here unless someone also edits the mock factory.
   */
  fetchReconPage?: FetchPrecoReconPage;
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

/**
 * Stamp a job `failed` from OUTSIDE the dispatch closure — the final-attempt
 * catch, which cannot reach `fila`/`pendentes`/`checkpoint` because those are
 * scoped to the try it is attached to.
 *
 * It produces the same OUTCOME as `failJob`: one `JOB_INTERROMPIDO` row naming
 * the cause, plus `filaRestante` so the CSV can say how much was never
 * attempted. Those two are the whole point — without them a run that abandoned N
 * queued drafts reads as "0 itens não foram tentados" with no row explaining
 * anything, which is exactly what `relatorioCompleto: false` alone cannot convey.
 *
 * Re-reading is correct rather than merely convenient: whatever the dying
 * dispatch held in memory is gone, so the last committed checkpoint IS the run's
 * final state, and its `relatorioLinhas` is the shard cursor the row belongs at.
 * One batch, so the row and the terminal stamp cannot half-land.
 */
async function stampFalhaTerminal(
  db: Firestore,
  jobId: string,
  erro: string,
  nowMs: number,
): Promise<void> {
  const job = await readJob(db, jobId);
  if (!job) return; // nothing to stamp; the caller still logs the original error

  const linha: LinhaRelatorioEnvioPreco = {
    produtoId: job.integracaoId,
    variacaoProdutoId: null,
    anuncioId: null,
    linkDocId: null,
    resultado: ENVIO_PRECO_RESULTADO.naoTentado,
    fase: ENVIO_PRECO_FASE.envio,
    motivo: 'JOB_INTERROMPIDO',
    erro: erro.slice(0, RELATORIO_ENVIO_PRECO_ERRO_MAX),
    preco: null,
    precoAnterior: null,
    variacoes: null,
  };
  const total = job.relatorioLinhas + 1;
  const indice = Math.floor(job.relatorioLinhas / RELATORIO_ENVIO_PRECO_SHARD_SIZE);

  const batch = db.batch();
  batch.set(
    relatorioEnvioPrecoMercadoLivreCollection.docRef(
      db,
      { envioId: jobId },
      relatorioEnvioPrecoShardId(indice),
    ),
    relatorioEnvioPrecoMercadoLivreCollection.parseMerge({
      linhas: { [relatorioEnvioPrecoRowKey(linha)]: linha },
      timestamp: nowMs,
    }) as DocumentData,
    { merge: true },
  );
  batch.set(
    envioPrecoMercadoLivreCollection.docRef(db, {}, jobId),
    envioPrecoMercadoLivreCollection.parseMerge({
      status: 'failed',
      erro,
      filaRestante: job.fila.length,
      relatorioLinhas: total,
      relatorioShards: Math.floor((total - 1) / RELATORIO_ENVIO_PRECO_SHARD_SIZE) + 1,
      relatorioCompleto: false,
      finishedAt: nowMs,
      updatedAt: nowMs,
    }) as DocumentData,
    { merge: true },
  );
  await batch.commit();
}

/** Deterministic outcome of one dispatch — see the module doc for each branch. */
export type PriceSyncDispatchOutcome = 'done' | 'continued' | 'noop' | 'failed';

/**
 * Process one `processMercadoLivrePriceSync` task dispatch: resume the job
 * doc, plan at most one produto page when the queue is empty and planning
 * isn't concluded, drain up to `precoItemsPerDispatch()` drafts through the
 * per-item gates, reconcile at most one LINK page once both are exhausted
 * (#1072 — report-only, flag-gated), then either re-enqueue itself
 * (`'continued'`) or mark the job `completed` (`'done'`). `retryCount` is the
 * Cloud Tasks attempt index (0-based) — on the FINAL attempt an otherwise-fatal
 * error is persisted as `status: 'failed'` instead of re-thrown (mirrors
 * `processMassImportJob`).
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
    let afterLinkPath = job.afterLinkPath;
    let reconciliacaoConcluida = job.reconciliacaoConcluida;
    let reconciliacaoPaginas = job.reconciliacaoPaginas;
    let naoEnumerados = job.naoEnumerados;
    let linksReconciliados = job.linksReconciliados;
    let planejados = job.planejados;
    let enviados = job.enviados;
    let pulados = job.pulados;
    let falhas = job.falhas;
    let pausas = job.pausas;
    let skips = [...job.skips];
    let failures = [...job.failures];
    let relatorioLinhas = job.relatorioLinhas;
    let relatorioShards = job.relatorioShards;

    /**
     * Report rows produced since the last COMMITTED checkpoint. In memory only —
     * it never touches the job doc, so the 1 MiB bound is untouched — and it is
     * cleared by `checkpoint()` after the batch commits, never before. A commit
     * that throws therefore leaves the rows queued and `relatorioLinhas`
     * unadvanced, so the retry re-produces exactly the same rows under exactly
     * the same keys.
     */
    let pendentes: LinhaRelatorioEnvioPreco[] = [];

    /** Queue one report row. Deduped by KEY at flush time, never by outcome. */
    const registrarLinha = (linha: LinhaRelatorioEnvioPreco): void => {
      pendentes.push(linha);
    };

    /** Skips bookkeeping — the count is UNCAPPED; the UI detail list stops at the cap. */
    const registerSkip = (entrada: {
      itemId: string | null;
      produtoId: string;
      code: string;
      fase: EnvioPrecoFase;
      linkDocId?: string | null;
      variacaoProdutoId?: string | null;
      precoAnterior?: number | null;
      preco?: number | null;
    }): void => {
      pulados += 1;
      const linkDocId = entrada.linkDocId ?? null;
      const precoAnterior = entrada.precoAnterior ?? null;
      if (skips.length < PRICE_SYNC_SKIPS_CAP) {
        skips = [
          ...skips,
          {
            itemId: entrada.itemId,
            produtoId: entrada.produtoId,
            code: entrada.code,
            linkDocId,
            precoAnterior,
          },
        ];
      }
      registrarLinha({
        produtoId: entrada.produtoId,
        variacaoProdutoId: entrada.variacaoProdutoId ?? null,
        anuncioId: entrada.itemId,
        linkDocId,
        resultado: ENVIO_PRECO_RESULTADO.pulado,
        fase: entrada.fase,
        motivo: entrada.code,
        erro: null,
        preco: entrada.preco ?? null,
        precoAnterior,
        variacoes: null,
      });
    };

    /** Failures bookkeeping — same cap discipline as the skips. */
    const registerFailure = (entrada: {
      itemId: string;
      produtoId: string;
      code: string;
      error: string;
      linkDocId: string | null;
      variacaoProdutoId: string | null;
      precoAnterior: number | null;
      preco: number | null;
    }): void => {
      falhas += 1;
      if (failures.length < PRICE_SYNC_FAILURES_CAP) {
        failures = [
          ...failures,
          {
            itemId: entrada.itemId,
            produtoId: entrada.produtoId,
            code: entrada.code,
            error: entrada.error,
            linkDocId: entrada.linkDocId,
            precoAnterior: entrada.precoAnterior,
          },
        ];
      }
      registrarLinha({
        produtoId: entrada.produtoId,
        variacaoProdutoId: entrada.variacaoProdutoId,
        anuncioId: entrada.itemId,
        linkDocId: entrada.linkDocId,
        resultado: ENVIO_PRECO_RESULTADO.falha,
        fase: ENVIO_PRECO_FASE.envio,
        motivo: entrada.code,
        erro: entrada.error.slice(0, RELATORIO_ENVIO_PRECO_ERRO_MAX),
        preco: entrada.preco,
        precoAnterior: entrada.precoAnterior,
        variacoes: null,
      });
    };

    /**
     * The success branch, which the job previously recorded as nothing but
     * `enviados += 1` — so a completed run could say twelve prices moved and
     * name none of them. This is the row the CSV is actually FOR.
     */
    const registerEnviado = (entrada: {
      itemId: string;
      produtoId: string;
      linkDocId: string | null;
      variacaoProdutoId: string | null;
      preco: number;
      precoAnterior: number | null;
      variacoes: number | null;
    }): void => {
      enviados += 1;
      registrarLinha({
        produtoId: entrada.produtoId,
        variacaoProdutoId: entrada.variacaoProdutoId,
        anuncioId: entrada.itemId,
        linkDocId: entrada.linkDocId,
        resultado: ENVIO_PRECO_RESULTADO.enviado,
        fase: ENVIO_PRECO_FASE.envio,
        motivo: null,
        erro: null,
        preco: entrada.preco,
        precoAnterior: entrada.precoAnterior,
        variacoes: entrada.variacoes,
      });
    };

    /**
     * ⚠️ Every mutable above must appear in the job patch. A field missing from
     * it is silently never persisted: nothing throws, the value resets to its
     * schema default on the next dispatch, and a phase gated on it re-enqueues
     * forever. (A field in the patch but NOT in the schema is the loud failure —
     * `parseMerge` re-parses `.strict()` and throws.)
     *
     * ⚠️ The job patch and the report rows commit in ONE `db.batch()`, and that
     * is what makes a Cloud Tasks retry safe. Written separately there are two
     * windows and both lose: row-then-consume duplicates the item on a retry,
     * consume-then-row drops its row entirely. Batched, a crash before the
     * commit re-processes the item and re-reports it exactly once, and a crash
     * after does neither.
     *
     * ⚠️ A batch is NOT a transaction — nothing here is read-modify-write, since
     * the shard index is derived from `relatorioLinhas`, a counter that only
     * advances on a committed checkpoint. Promoting this to a Firestore
     * transaction would buy nothing and cost an OCC retry loop inside a 540s
     * worker.
     *
     * ⚠️ The phrase above deliberately avoids the bare API name:
     * `firestore-transaction-inventory.test.js` greps the literal token across
     * the repo and cannot tell a CALL from a mention in a comment, so naming it
     * here would demand an inventory entry for a file that runs no transaction —
     * i.e. a false entry in the ledger that exists to be trusted.
     */
    const checkpoint = async (): Promise<void> => {
      // Assign each pending row its shard from the PERSISTED counter, so a
      // retried dispatch recomputes the same index rather than drifting.
      const porShard = new Map<number, Record<string, LinhaRelatorioEnvioPreco>>();
      let total = relatorioLinhas;
      for (const linha of pendentes) {
        const indice = Math.floor(total / RELATORIO_ENVIO_PRECO_SHARD_SIZE);
        let bucket = porShard.get(indice);
        if (!bucket) porShard.set(indice, (bucket = {}));
        bucket[relatorioEnvioPrecoRowKey(linha)] = linha;
        total += 1;
      }
      const shards =
        total === 0 ? 0 : Math.floor((total - 1) / RELATORIO_ENVIO_PRECO_SHARD_SIZE) + 1;

      const batch = db.batch();
      batch.set(
        envioPrecoMercadoLivreCollection.docRef(db, {}, payload.jobId),
        envioPrecoMercadoLivreCollection.parseMerge({
          fila,
          afterAnchorId,
          planejamentoConcluido,
          afterLinkPath,
          reconciliacaoConcluida,
          reconciliacaoPaginas,
          naoEnumerados,
          linksReconciliados,
          planejados,
          enviados,
          pulados,
          falhas,
          pausas,
          skips,
          failures,
          relatorioLinhas: total,
          relatorioShards: shards,
          updatedAt: nowMs,
        }) as DocumentData,
        { merge: true },
      );
      for (const [indice, linhas] of porShard) {
        batch.set(
          relatorioEnvioPrecoMercadoLivreCollection.docRef(
            db,
            { envioId: payload.jobId },
            relatorioEnvioPrecoShardId(indice),
          ),
          relatorioEnvioPrecoMercadoLivreCollection.parseMerge({
            // ⚠️ A nested-map merge, which Firestore DEEP-merges under
            // `{merge:true}` — the shard keeps the rows already in it. The
            // offline FakeDb models that; `precoRelatorio.firestore.test.ts` is
            // what proves it against a real Firestore.
            linhas,
            timestamp: nowMs,
          }) as DocumentData,
          { merge: true },
        );
      }
      await batch.commit();

      // After the commit, though the ordering is DEFENSIVE rather than
      // load-bearing, and the comment here used to claim otherwise: a throwing
      // commit aborts the whole dispatch, so this local state is discarded
      // either way and the retry re-reads `relatorioLinhas` from the job doc.
      // (Proven, not assumed — moving these above `commit()` fails no spec.)
      // What IS load-bearing is that the counter lives on the DOCUMENT and is
      // written in the same batch as the rows it indexes; that is what makes a
      // retry recompute the same shard instead of drifting.
      relatorioLinhas = total;
      relatorioShards = shards;
      pendentes = [];
    };

    /** Terminal job failure — deterministic, never retried (`extra` rides along). */
    const failJob = async (
      erro: string,
      extra: Record<string, unknown> = {},
    ): Promise<'failed'> => {
      // ⚠️ ONE synthetic row, not `fila.length` `nao-tentado` ones. Flushing the
      // queue would write up to `PLAN_PAGE_DRAFTS_CAP` rows to say "we stopped",
      // so the count rides `filaRestante` and the report carries a single row
      // naming the cause. The CSV reads both.
      registrarLinha({
        produtoId: payload.integracaoId,
        variacaoProdutoId: null,
        anuncioId: null,
        linkDocId: null,
        resultado: ENVIO_PRECO_RESULTADO.naoTentado,
        fase: ENVIO_PRECO_FASE.envio,
        motivo: 'JOB_INTERROMPIDO',
        erro: erro.slice(0, RELATORIO_ENVIO_PRECO_ERRO_MAX),
        preco: null,
        precoAnterior: null,
        variacoes: null,
      });
      // Flush the row (and every counter) through the batch, THEN stamp the
      // terminal state. Two writes, deliberately: `relatorioCompleto` must stay
      // false here, and a failure stamp that also carried the rows would have to
      // duplicate the whole shard-assignment path.
      await checkpoint();
      await envioPrecoMercadoLivreCollection.merge(db, {}, payload.jobId, {
        ...extra,
        status: 'failed',
        erro,
        filaRestante: fila.length,
        relatorioCompleto: false,
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
        for (const s of plan.skips) {
          registerSkip({
            itemId: s.itemId,
            produtoId: s.produtoId,
            code: s.code,
            linkDocId: s.linkDocId,
            fase: ENVIO_PRECO_FASE.plano,
          });
        }
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

      // ---- Gates (1)-(8), shared verbatim with the manual push. The job's
      // only remaining say is what each outcome MEANS to the checkpoint.
      const outcome = await enviarPrecoDraft(db, draft, ctx.api, {
        nowMs,
        baixarPreco: job.baixarPreco,
      });

      // A dead credential fails every remaining item identically — reconnecting
      // the conta is a human action, so fail the whole job.
      if (outcome.kind === 'fatal') return failJob(outcome.erro);
      // NOT consumed: the delayed re-dispatch retries this same draft (a PUT
      // that landed before the 429 replays as PRECO_ANTIGO_IGUAL via gate 2).
      if (outcome.kind === 'pausa') return pausePath(outcome.err);

      // The three terminal branches, each now recording what it did rather than
      // only that it happened. `outcome.precoAtual` rides every one of them —
      // this is where the job used to drop it.
      if (outcome.kind === 'pulado') {
        registerSkip({
          itemId: draft.itemId,
          produtoId: draft.produtoId,
          code: outcome.code,
          fase: ENVIO_PRECO_FASE.envio,
          linkDocId: draft.linkDocId,
          variacaoProdutoId: draft.variacaoProdutoId,
          precoAnterior: outcome.precoAtual,
          preco: draft.preco,
        });
      } else if (outcome.kind === 'falha') {
        registerFailure({
          itemId: draft.itemId,
          produtoId: draft.produtoId,
          code: outcome.code,
          error: outcome.error,
          linkDocId: draft.linkDocId,
          variacaoProdutoId: draft.variacaoProdutoId,
          precoAnterior: outcome.precoAtual,
          preco: draft.preco,
        });
      } else {
        registerEnviado({
          itemId: draft.itemId,
          produtoId: draft.produtoId,
          linkDocId: draft.linkDocId,
          variacaoProdutoId: draft.variacaoProdutoId,
          preco: outcome.preco,
          precoAnterior: outcome.precoAtual,
          variacoes: outcome.variacoes,
        });
      }
      await consume();
    }

    // (b2) RECONCILE one link page (#1072) — only once the anchor plan is
    // drained AND the fila is empty, so a job a human just clicked moves prices
    // first and reports at the end. Both existing mid-flight stops are excluded
    // by that gate: a `PLAN_PAGE_DRAFTS_CAP` stop leaves `planejamentoConcluido`
    // false, and a drain-cap stop leaves the fila non-empty.
    //
    // This phase produces SKIPS ONLY — no draft, no ML call, no link writeback
    // (see `precoReconciliacao`'s module doc for why class 3 is not sendable).
    if (
      fila.length === 0 &&
      planejamentoConcluido &&
      !reconciliacaoConcluida &&
      precoReconciliacaoHabilitada()
    ) {
      reconciliacaoPaginas += 1;
      if (reconciliacaoPaginas > PRECO_RECON_MAX_PAGES) {
        // A cursor that stops advancing returns the same page forever. Refuse
        // loudly rather than chain tasks until something else kills the job —
        // and say so in the report, so a truncated one is never read as clean.
        registerSkip({
          itemId: null,
          produtoId: payload.integracaoId,
          code: 'RECONCILIACAO_INCOMPLETA',
          fase: ENVIO_PRECO_FASE.reconciliacao,
        });
        reconciliacaoConcluida = true;
      } else {
        const fetchRecon = deps.fetchReconPage ?? fetchPrecoReconPage;
        const page = await fetchRecon(db, {
          integracaoId: payload.integracaoId,
          afterLinkPath,
          pageLimit: precoReconPageLimit(),
        });
        for (const orfao of page.naoEnumerados) {
          naoEnumerados += 1;
          registerSkip({
            itemId: orfao.itemId,
            produtoId: orfao.produtoId,
            code: orfao.code,
            fase: ENVIO_PRECO_FASE.reconciliacao,
          });
        }
        linksReconciliados += page.inspecionados;
        afterLinkPath = page.nextAfterLinkPath;
        reconciliacaoConcluida = page.nextAfterLinkPath == null;
      }
      await checkpoint();
    }

    // (c) Continue (re-enqueue) or complete.
    if (
      fila.length > 0 ||
      !planejamentoConcluido ||
      (!reconciliacaoConcluida && precoReconciliacaoHabilitada())
    ) {
      await deps.scheduler.enqueue({ jobId: payload.jobId, integracaoId: payload.integracaoId });
      return 'continued';
    }

    await envioPrecoMercadoLivreCollection.merge(db, {}, payload.jobId, {
      status: 'completed',
      // ⚠️ The ONLY place this is written true. Reaching here means the fila is
      // drained AND `planejamentoConcluido` AND the reconciliation is done, so
      // it is exactly the claim "the report covers the whole run" — which is
      // what stops a partial CSV from reading like a clean one.
      relatorioCompleto: true,
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
      // ⚠️ The SAME outcome `failJob` produces, and it has to be: a persistent ML
      // 5xx, a `batch.commit()` failure and a `scheduler.enqueue()` failure all
      // land here, and this used to write only `status`/`erro` — so `filaRestante`
      // stayed at its schema default `0` and no `JOB_INTERROMPIDO` row existed.
      // The CSV would then have rendered a run that abandoned N queued drafts as
      // "0 itens não foram tentados", with nothing in the report naming the cause.
      //
      // It re-reads rather than sharing `failJob`'s state because `fila`,
      // `pendentes` and `checkpoint` are all scoped to the try this catch is
      // attached to. The persisted doc is the right source anyway: whatever this
      // dispatch had queued in memory died with the throw, so the last committed
      // checkpoint IS the run's final state.
      await stampFalhaTerminal(db, payload.jobId, err.message, nowMs);
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
