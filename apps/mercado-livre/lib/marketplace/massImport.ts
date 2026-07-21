/**
 * "Importar todos os anúncios" mass-import core (ML→ERP) — issue #621. An
 * architecture upgrade over the legacy Flutter flow, which drove the whole
 * scan+import loop client-side (`providers/importacao.dart:119-188`) with no
 * resume: a `running` job doc (`importacaoMercadoLivreCollection`) is the
 * single checkpoint for a Cloud Tasks-driven, server-side loop that pages
 * through the seller's full listing set
 * (`GET /users/{id}/items/search?search_type=scan`, `MercadoLivreApi.scanSellerItems`)
 * and imports every unregistered item (`importProduto`, #519-#521) in bounded
 * batches, re-enqueuing itself until the scan is exhausted and the queue
 * (`fila`) drains. The web UI polls the job doc for progress.
 *
 * ---- Resume model (why a single `fila.length === 0` check decides whether to
 * scan, never `scrollId` alone): every dispatch ends with EITHER `status` still
 * `running` (more scanning and/or draining left) OR flipped to `completed` —
 * flipped in THE SAME dispatch that first observes `fila` empty AND the scan
 * cursor exhausted (`scrollId === null`). So whenever a `running` job is picked
 * up with an EMPTY `fila`, that can only mean one of two things: (a) this is the
 * very first dispatch (`scrollId` is also `null`, nothing scanned yet — scanning
 * with a `null` scrollId is exactly `scanSellerItems`'s "start a new scan"), or
 * (b) a previous dispatch left a non-exhausted cursor (`scrollId` non-null) with
 * an emptied `fila` — the next page is due. Both cases want the SAME action
 * ("scan one page"), so gating purely on `fila.length === 0` is equivalent to,
 * and simpler than, tracking a separate "have we ever scanned" flag — and it
 * can never cause an accidental full re-scan of an already-`completed` job,
 * because that status transition already happened before a subsequent dispatch
 * could occur (a `completed`/`failed` job is a `noop` below).
 *
 * ---- Per-item checkpoint: every drained item (success OR contained failure)
 * is merge-persisted individually (`fila` minus that id + the updated counters)
 * BEFORE moving to the next one — so a crash/infra-error mid-drain (which
 * THROWS, unlike a per-item `MercadoLivreImportError`/`MercadoLivreError`)
 * loses at most the one in-flight item; a retry resumes from the persisted
 * `fila`, never re-importing what already succeeded (`importProduto` itself is
 * additionally idempotent, so even a duplicate replay converges).
 *
 * ---- Failures bookkeeping: `failureCount` is an UNCAPPED running total;
 * `failures` (the UI-facing detail list) stops growing at
 * `MASS_IMPORT_FAILURES_CAP` — so a pathological catalog can't balloon the job
 * doc, while the count still reports the true number of contained failures.
 *
 * ---- Error containment: a per-item `MercadoLivreImportError` (blocked import
 * — closed listing, wrong seller, …) or `MercadoLivreError` (ML API failure for
 * THIS item) is recorded and the drain continues; anything else (Firestore /
 * network / a coding bug) propagates — retried in-task up to
 * `MASS_IMPORT_MAX_ATTEMPTS`, and on the FINAL attempt the job is stamped
 * `failed` with the error message (mirrors `notificacao.ts`'s
 * `handleNotificationTask` final-attempt persist, including tolerating a
 * secondary failure while stamping it).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import {
  type MercadoLivreApi,
  MercadoLivreError,
  createMercadoLivreApi,
} from '@delfrance/integrations-mercado-livre';
import { type ImportacaoMercadoLivre, type MassImportOptions } from '@delfrance/schemas';
import {
  importacaoMercadoLivreCollection,
  produtoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';

import { type ImportDeps, importProduto } from './import';
import { type ImportOptions, MercadoLivreImportError } from './importCore';
import { refMatchesIntegracao } from './linkRefs';
import { loadMercadoLivreContext } from './mercadoLivre';
import { type Bucket } from './arquivoUpload';
import { getAdminBucket } from '../firebase/admin';

/**
 * The deployed `onTaskDispatched` function name — which is ALSO its
 * auto-provisioned Cloud Tasks queue name. Single source of truth (mirrors
 * `notificacao.ts`'s `MERCADO_LIVRE_NOTIFICATION_QUEUE`): the producer
 * (`mlMassImportTasks.ts`) builds the region-qualified queue path from it, and
 * the consumer (`functions/src`) must name its `export const` exactly this.
 * Lives in this neutral core module (not the scheduler file) so the scheduler
 * can import it without this module ever depending on the Functions SDK.
 */
export const MERCADO_LIVRE_MASS_IMPORT_QUEUE = 'processMercadoLivreMassImport';

/** In-task retry cap — the Cloud Tasks `retryConfig.maxAttempts` (kept in sync). */
export const MASS_IMPORT_MAX_ATTEMPTS = 3;

/** Items drained (via `importProduto`) per dispatch, before re-enqueuing. */
export const MASS_IMPORT_ITEMS_PER_DISPATCH = 20;

/** `failures` list cap — `failureCount` itself is never capped (see module doc). */
export const MASS_IMPORT_FAILURES_CAP = 100;

/** Firestore's own `where(field, 'in', values)` cap — chunk the skip-filter lookup. */
const LINK_QUERY_CHUNK_SIZE = 30;

export const massImportTaskSchema = z
  .object({
    jobId: z.string().min(1),
    integracaoId: z.string().min(1),
  })
  .passthrough();
export type MassImportTaskPayload = z.infer<typeof massImportTaskSchema>;

/** `startMassImportJob` guard — this integração already has a `running` job. */
export class MassImportAlreadyRunningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MassImportAlreadyRunningError';
  }
}

/**
 * Start a fresh mass-import job for `integracaoId` — guards against a second
 * concurrent run (one `running` job per conta at a time), then creates the
 * checkpoint doc at `status: 'running'` with an empty cursor/queue. The caller
 * (the `importar-todos` route) enqueues the first task AFTER this resolves; on
 * an enqueue failure the route marks the just-created job `failed` itself
 * (this function does not enqueue — it only creates the checkpoint).
 */
export async function startMassImportJob(
  db: Firestore,
  args: { integracaoId: string; options: MassImportOptions },
): Promise<string> {
  const running = await importacaoMercadoLivreCollection
    .ref(db, {})
    .where('integracaoId', '==', args.integracaoId)
    .where('status', '==', 'running')
    .limit(1)
    .get();
  if (!running.empty) {
    throw new MassImportAlreadyRunningError(
      `já existe uma importação em massa em andamento para a integração ${args.integracaoId}`,
    );
  }

  const now = Date.now();
  const jobId = importacaoMercadoLivreCollection.newDocId(db, {});
  await importacaoMercadoLivreCollection.set(db, {}, jobId, {
    integracaoId: args.integracaoId,
    status: 'running',
    scrollId: null,
    fila: [],
    scanned: 0,
    imported: 0,
    created: 0,
    skipped: 0,
    failureCount: 0,
    failures: [],
    options: args.options,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    erro: null,
  });
  return jobId;
}

/** The resolved per-account dependencies `processMassImportJob` needs to scan + import. */
export interface MassImportContext {
  api: MercadoLivreApi;
  sellerUserId: number | null;
  tabelaNormalOuterRef: string | null;
  tabelaPromocionalOuterRef: string | null;
  depositoOuterRef: string | null;
  /** Storage bucket for photo import; omitted degrades to "skip photos" (see `resolveOptionalBucket`). */
  bucket?: Bucket;
}

export interface MassImportRunDeps {
  db: Firestore;
  /** Injectable for tests; defaults to the live ML context + Storage bucket resolution. */
  resolveImportDeps?: (db: Firestore, integracaoId: string) => Promise<MassImportContext>;
  /** Injectable enqueuer for the next dispatch; required whenever the run continues. */
  scheduler?: { enqueue(payload: MassImportTaskPayload): Promise<void> };
  /** Injectable clock (tests) — one call per dispatch, reused for every persisted timestamp. */
  now?: () => number;
}

function asStringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function asNumberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * `getAdminBucket()` throws (a plain `Error`) when Storage bucket resolution
 * fails — a backend/env misconfiguration (`FIREBASE_STORAGE_BUCKET` /
 * `FIREBASE_PROJECT_ID` unset), never a per-item concern. `importProduto`
 * already treats a missing `bucket` as "skip this item's photos" (every other
 * option still applies), so a mass-import run degrades the SAME way here
 * instead of failing the entire batch of otherwise-importable listings over a
 * Storage config issue. Deliberately scoped to ONLY this one synchronous call
 * (not a broader try/catch) — narrower than the repo's usual per-class `catch`
 * convention because `getAdminBucket()`'s own failure surface is a single plain
 * `Error` with no dedicated class to narrow to; see `notes` in the PR for the
 * explicit call-out.
 */
function resolveOptionalBucket(): Bucket | undefined {
  try {
    return getAdminBucket();
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    return undefined;
  }
}

/**
 * Production `resolveImportDeps` — mirrors the `/importar` route's own context
 * assembly (`loadMercadoLivreContext` → `resolveChannelContext` →
 * `createMercadoLivreApi`, the same conta-field narrowing), plus the
 * best-effort Storage bucket above.
 */
const defaultResolveImportDeps: NonNullable<MassImportRunDeps['resolveImportDeps']> = async (
  db,
  integracaoId,
) => {
  const ctx = await loadMercadoLivreContext(db, integracaoId);
  const channelCtx = await ctx.resolveChannelContext();
  const api = createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });
  return {
    api,
    sellerUserId: asNumberOrNull(ctx.conta.user_id),
    tabelaNormalOuterRef: asStringOrNull(ctx.conta.tabelaNormalOuterRef),
    tabelaPromocionalOuterRef: asStringOrNull(ctx.conta.tabelaPromocionalOuterRef),
    depositoOuterRef: asStringOrNull(ctx.conta.depositoOuterRef),
    bucket: resolveOptionalBucket(),
  };
};

/** The 7 `ImportOptions` fields `MassImportOptions` shares with a per-item import. */
function toImportOptions(options: MassImportOptions): ImportOptions {
  return {
    importarEstoque: options.importarEstoque,
    sobrescreverEstoque: options.sobrescreverEstoque,
    importarPreco: options.importarPreco,
    sobrescreverPreco: options.sobrescreverPreco,
    atualizarProdutoPai: options.atualizarProdutoPai,
    importarFotos: options.importarFotos,
    importarCategorias: options.importarCategorias,
  };
}

/**
 * Resolve which of `ids` already have a `produtoMercadoLivre` link for THIS
 * integração — the skip-filter for a plain re-scan (`atualizarCadastrados`
 * off). Chunked at Firestore's `where(..., 'in', ...)` cap (30); a link whose
 * `id` matches but whose `contaOuterRef` belongs to a DIFFERENT integração is
 * not counted (mirrors every other cross-app dedup lookup in this folder,
 * e.g. `import.ts`'s `resolveExistingProduto`).
 */
async function findRegisteredIds(
  db: Firestore,
  ids: readonly string[],
  integracaoId: string,
): Promise<Set<string>> {
  const registered = new Set<string>();
  for (let i = 0; i < ids.length; i += LINK_QUERY_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + LINK_QUERY_CHUNK_SIZE);
    const snap = await produtoMercadoLivreLinkCollection
      .groupQuery(db)
      .where('id', 'in', chunk)
      .get();
    for (const d of snap.docs) {
      const raw = d.data() as Record<string, unknown>;
      if (!refMatchesIntegracao(raw.contaOuterRef, integracaoId)) continue;
      if (typeof raw.id === 'string') registered.add(raw.id);
    }
  }
  return registered;
}

async function readJob(db: Firestore, jobId: string): Promise<ImportacaoMercadoLivre | null> {
  const snap = await importacaoMercadoLivreCollection.docRef(db, {}, jobId).get();
  if (!snap.exists) return null;
  return importacaoMercadoLivreCollection.parseRead(
    snap.data(),
    importacaoMercadoLivreCollection.docPath({}, jobId),
  );
}

/** Deterministic outcome of one dispatch — see the module doc for each branch. */
export type MassImportDispatchOutcome = 'done' | 'continued' | 'noop' | 'failed';

/**
 * Process one `processMercadoLivreMassImport` task dispatch: resume the job
 * doc, scan at most one page when the queue is empty, drain up to
 * `MASS_IMPORT_ITEMS_PER_DISPATCH` items, then either re-enqueue itself
 * (`'continued'`) or mark the job `completed` (`'done'`). `retryCount` is the
 * Cloud Tasks attempt index (0-based) — on the FINAL attempt an otherwise-fatal
 * error is persisted as `status: 'failed'` instead of re-thrown (mirrors
 * `notificacao.ts`'s `handleNotificationTask`).
 */
export async function processMassImportJob(
  deps: MassImportRunDeps,
  payload: MassImportTaskPayload,
  retryCount: number,
): Promise<MassImportDispatchOutcome> {
  const { db } = deps;
  const resolveImportDeps = deps.resolveImportDeps ?? defaultResolveImportDeps;
  const nowMs = deps.now ? deps.now() : Date.now(); // one clock read for the whole dispatch

  const job = await readJob(db, payload.jobId);
  if (!job || job.status !== 'running') return 'noop';

  try {
    const ctx = await resolveImportDeps(db, payload.integracaoId);

    let fila = [...job.fila];
    let scrollId = job.scrollId;
    let scanned = job.scanned;
    let skipped = job.skipped;

    // (a) Scan one page ONLY when there's nothing left to drain — see the
    // module doc for why this single condition is the correct "not exhausted"
    // gate (covers both "never scanned yet" and "next page is due").
    if (fila.length === 0) {
      if (ctx.sellerUserId == null) {
        throw new MercadoLivreImportError(['integração sem user_id — reconecte a conta']);
      }
      const page = await ctx.api.scanSellerItems(ctx.sellerUserId, scrollId);
      const results = page.results ?? [];
      scanned += results.length;
      // Stop paging once this page's results are empty OR its scroll_id is
      // absent/empty — there is no `limit` on this endpoint (legacy parity).
      const nextScroll =
        typeof page.scroll_id === 'string' && page.scroll_id.length > 0 && results.length > 0
          ? page.scroll_id
          : null;

      let unregistered = results;
      if (!job.options.atualizarCadastrados && results.length > 0) {
        const registered = await findRegisteredIds(db, results, payload.integracaoId);
        skipped += registered.size;
        unregistered = results.filter((id) => !registered.has(id));
      }

      fila = unregistered;
      scrollId = nextScroll;
      await importacaoMercadoLivreCollection.merge(db, {}, payload.jobId, {
        scrollId,
        fila,
        scanned,
        skipped,
        updatedAt: nowMs,
      });
    }

    // (b) Drain up to the per-dispatch cap, checkpointing after EVERY item.
    let imported = job.imported;
    let created = job.created;
    let failureCount = job.failureCount;
    let failures = [...job.failures];

    let drained = 0;
    while (fila.length > 0 && drained < MASS_IMPORT_ITEMS_PER_DISPATCH) {
      const itemId = fila[0]!;
      fila = fila.slice(1);
      drained += 1;

      try {
        const importDeps: ImportDeps = {
          db,
          api: ctx.api,
          integracaoId: payload.integracaoId,
          sellerUserId: ctx.sellerUserId,
          tabelaNormalOuterRef: ctx.tabelaNormalOuterRef,
          tabelaPromocionalOuterRef: ctx.tabelaPromocionalOuterRef,
          depositoOuterRef: ctx.depositoOuterRef,
          bucket: ctx.bucket,
          options: toImportOptions(job.options),
          familyFanOut: false,
        };
        const res = await importProduto(importDeps, itemId);
        imported += 1;
        if (res.created) created += 1;
      } catch (err) {
        if (err instanceof MercadoLivreImportError || err instanceof MercadoLivreError) {
          failureCount += 1;
          if (failures.length < MASS_IMPORT_FAILURES_CAP) {
            failures = [...failures, { itemId, error: err.message }];
          }
        } else {
          throw err; // infra/coding failure — not per-item containable
        }
      }

      // Per-item checkpoint — a crash right after this write resumes from
      // exactly here on retry (the module doc's resume-model guarantee).
      await importacaoMercadoLivreCollection.merge(db, {}, payload.jobId, {
        fila,
        imported,
        created,
        failureCount,
        failures,
        updatedAt: nowMs,
      });
    }

    // (c) Continue (re-enqueue) or complete.
    if (fila.length > 0 || scrollId != null) {
      if (!deps.scheduler) {
        throw new Error(
          'processMassImportJob: há mais trabalho pendente mas nenhum scheduler foi fornecido para reenfileirar o job.',
        );
      }
      await deps.scheduler.enqueue({ jobId: payload.jobId, integracaoId: payload.integracaoId });
      return 'continued';
    }

    await importacaoMercadoLivreCollection.merge(db, {}, payload.jobId, {
      status: 'completed',
      finishedAt: nowMs,
      updatedAt: nowMs,
    });
    return 'done';
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    if (retryCount < MASS_IMPORT_MAX_ATTEMPTS - 1) throw err; // let the queue retry with backoff

    // Final attempt: persist the failure instead of throwing (mirrors
    // notificacao.ts's handleNotificationTask) — tolerate (but log) a
    // secondary failure while stamping it, never masking the original error.
    try {
      await importacaoMercadoLivreCollection.merge(db, {}, payload.jobId, {
        status: 'failed',
        erro: err.message,
        finishedAt: nowMs,
        updatedAt: nowMs,
      });
    } catch (persistErr) {
      if (!(persistErr instanceof Error)) throw persistErr;
      console.error(
        '[mercado-livre] falha ao marcar a importação em massa como failed na tentativa final',
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
