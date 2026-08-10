/**
 * The MANUAL stock push (#819) — "enviar estoque agora" for a hand-picked set of
 * produtos, as opposed to the three scheduled sweeps.
 *
 * Why it exists: until now the only thing that ever sent `available_quantity` to
 * Mercado Livre was the `sendMercadoLivreStock` queue, fed exclusively by
 * `onSchedule` sweeps. An operator seeing a wrong quantity had to wait up to 15
 * minutes, or until 02:00 — or, for a kit whose component moved but which did
 * not itself sell, until the MONTHLY pass (ADR 0014's accepted trade). The
 * legacy Flutter app had this button (`.old/lib/produtos/pages/enviarEstoqueDialog.dart`,
 * bulk multi-select capped at 50) and the port dropped it.
 *
 * Shape, and how it differs from a sweep tick:
 *
 *  - **Synchronous.** The acceptance is a per-LISTING outcome, and enqueueing
 *    would answer the operator's latency complaint with more latency (the queue's
 *    `minBackoffSeconds` alone is 30) and less information. The work is bounded
 *    at {@link MANUAL_PUSH_MAX_PRODUTOS} by construction, so it needs neither a
 *    job document nor a poll route.
 *  - **Force-send.** No ledger pre-pass, no `deveEnviarFamilia`: the operator is
 *    asserting the published number is wrong, so asking "did it change" would be
 *    both expensive and beside the point. See `fetchStockFamiliesByIds`.
 *  - **Sends through `processStockSendTask` verbatim.** That handler already owns
 *    the pause gate, the context load, the depósito guard, body construction, the
 *    single `PUT`, the `mergeIfExists` writeback and #781's terminal branch. A
 *    second sender would be a second place for the sent quantity to drift.
 *
 * ⚠️ **The retry ladder is load-bearing, not ceremony.** #781's rule is that ONE
 * 4xx from ML is evidence, not proof ("não podemos confiar cegamente nos códigos
 * 4xx do mercado livre"), and `processStockSendTask` implements it by only
 * verifying-and-recording on `retryCount === STOCK_SEND_MAX_ATTEMPTS - 1`. So the
 * two tempting inline calls are both wrong: `retryCount: 0` once lets the 4xx
 * escape with nothing recorded and nothing learned, and
 * `retryCount: MAX - 1` once latches a listing on a single transient blip. The
 * ladder below maps its own LAST attempt onto `STOCK_SEND_MAX_ATTEMPTS - 1` and
 * every earlier one onto `0`, which decouples the two caps and still never acts
 * on one sample.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { millisToMicros } from '@delfrance/core/datetime';
import { ESTADO_PUBLICACAO_ML, idFromRef } from '@delfrance/schemas';
import { MercadoLivreError, MercadoLivreHttpError } from '@delfrance/integrations-mercado-livre';
import { produtoCollection } from '@delfrance/data/admin/collections';

import {
  type FetchStockFamiliesByIds,
  type RawStockLinkRow,
  type SendSkip,
  type StockFamilyRow,
  type StockSendTaskDraft,
  STOCK_SEND_MAX_ATTEMPTS,
  buildSendTasks,
  concurrentDispatches,
  envInt,
  fetchStockFamiliesByIds,
  quantidadesDaFamilia,
} from './estoquePlan';
import { type StockContextLoader, type StockSendResult, processStockSendTask } from './estoqueSend';
import type { LinkStatusTarget } from './itemsStatusSync';
import { MlTasksDisabledError } from './mlTasks';
import type { MlStockTaskScheduler } from './mlStockTasks';
import { type ReverificarApi, reverificarAnuncio } from './reverificarAnuncio';

/* --------------------------------- tunables -------------------------------- */

/**
 * Legacy parity (`produtoTableView.dart:1153`). An oversize selection is
 * REJECTED, never truncated: silently dropping 150 of 200 produtos under a green
 * summary is the silent-under-send failure this whole area is built to avoid.
 */
export const MANUAL_PUSH_MAX_PRODUTOS = 50;

/**
 * PUT attempts per listing before `processStockSendTask` is allowed to reach its
 * verify-and-record branch. Two, not three: a human is waiting, and two PUTs plus
 * ML's own verification `GET` is already three samples. Must stay
 * `<= STOCK_SEND_MAX_ATTEMPTS` — pinned in `stockSendMaxAttempts.test.ts`.
 */
export const MANUAL_PUSH_MAX_ATTEMPTS = 2;

/** Backoff between manual attempts (ms) — short, because a human is waiting. */
export const MANUAL_PUSH_RETRY_DELAY_MS = 1_500;

/** Wall-clock budget. Past it the remainder is REPORTED, never silently dropped. */
export function manualPushDeadlineMs(): number {
  return envInt('MERCADO_LIVRE_STOCK_MANUAL_DEADLINE_MS', 120_000);
}

/**
 * Never exceed what the send queue was deployed with: overshooting earns a 429,
 * which stamps `pausedUntilUs` and breaks the SWEEP for the whole conta.
 */
export function manualPushConcurrency(): number {
  return envInt('MERCADO_LIVRE_STOCK_MANUAL_CONCURRENCY', concurrentDispatches());
}

/** Cap on re-arm `GET /items` calls per request. */
export function manualRearmMaxGets(): number {
  return envInt('MERCADO_LIVRE_STOCK_MANUAL_REARM_MAX_GETS', 100);
}

/* ------------------------------ result envelope ----------------------------- */

export type PushEstoqueOutcome =
  | 'enviado' // the channel accepted the quantity
  | 'pulado' // deterministically not sent — see `motivo`
  | 'falha' // the channel refused, or was unreachable
  | 'nao-tentado'; // aborted before its turn (rate-limit pause, deadline)

/**
 * One listing's outcome. Deliberately channel-NEUTRAL: `anuncioId` rather than
 * `itemId`, `variacoes` rather than `variations`. A second marketplace's
 * `POST /api/marketplace/<canal>/enviar-estoque` returns this same envelope, and
 * the web registry dispatches on it without knowing which channel answered.
 */
export interface PushEstoqueListing {
  /** The produto whose quantity this listing publishes — the family ANCHOR. */
  produtoId: string;
  produtoNome: string | null;
  /** The variation child behind a per-variation listing; null otherwise. */
  variacaoProdutoId: string | null;
  /** Channel-side listing id (ML: the MLB item id). Null when never published. */
  anuncioId: string | null;
  /** The ERP link doc id — the UI's key back into the produto's anúncios tab. */
  linkDocId: string | null;
  outcome: PushEstoqueOutcome;
  /** Machine-readable code; null only on `'enviado'`. */
  motivo: string | null;
  /** Operator-facing pt-BR text — always present, always safe to render. */
  mensagem: string;
  /** The quantity actually sent; null when nothing was sent. */
  quantidade: number | null;
  /** Entry count when the channel took a bulk variations payload; else null. */
  variacoes: number | null;
  /** Present only when a re-arm was requested for this listing. */
  rearme: { executado: boolean; estado: string | null; enviavel: boolean } | null;
}

export interface PushEstoqueSemEnvio {
  produtoId: string;
  produtoNome: string | null;
  motivo: string;
  mensagem: string;
}

export interface PushEstoqueResponse {
  canal: 'mercado-livre';
  integracaoId: string;
  contaNome: string | null;
  /** Deduped request size. */
  solicitados: number;
  /** Anchors actually discovered. */
  familias: number;
  resumo: { enviados: number; pulados: number; falhas: number; naoTentados: number };
  listings: PushEstoqueListing[];
  /** Requested produtos that produced no listing at all, and why. */
  produtosSemEnvio: PushEstoqueSemEnvio[];
  /** ISO-8601 — set when the conta is rate-limit paused; the rest was not attempted. */
  pausadoAte: string | null;
}

/* ---------------------------------- guards --------------------------------- */

/**
 * A conta-level refusal the ROUTE turns into a 4xx. These are fail-fast: none of
 * them can be reported per listing, because they stop the whole request.
 */
export class ManualPushGuardError extends Error {
  constructor(
    readonly code: 'ML_CONTA_SEM_DEPOSITO' | 'ML_CONTA_PAUSADA' | 'ML_CONTA_MULTIORIGEM',
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ManualPushGuardError';
  }
}

/* ------------------------------ skip vocabulary ----------------------------- */

/**
 * pt-BR for every reason a listing can come back unsent. The manual push is the
 * ONLY surface where these reach a human, so each one names the cause AND the
 * remedy — a bare `'anuncio-em-erro'` is not actionable.
 */
const MENSAGEM_POR_MOTIVO: Record<string, string> = {
  'sem-anuncio': 'Este produto não tem anúncio nesta conta.',
  'sem-id-externo': 'O anúncio ainda não foi publicado no Mercado Livre.',
  'aguardando-migracao': 'Anúncio em migração para User Products — envio suspenso.',
  'anuncio-em-erro':
    'Pulado: o anúncio está marcado com erro. O Mercado Livre confirmou que o anúncio está ' +
    'saudável, então foi o envio anterior que ele recusou. Marque "Reenviar anúncios com erro" ' +
    'para reverificar e tentar de novo.',
  'status-nao-enviavel': 'O Mercado Livre não aceita envio de estoque para este anúncio agora.',
  'kit-virtual': 'Kit virtual: o Mercado Livre monta a quantidade a partir dos componentes.',
  'nao-publicado': 'O produto está oculto (não publicado) no ERP.',
  'conta-fora-do-produto': 'O produto não está vinculado a esta conta.',
  'variacoes-excede-limite': 'A família tem variações demais para um único envio.',
  'produto-nao-encontrado': 'Produto não encontrado.',
  'familia-nao-encontrada': 'Produto não encontrado ou não é um produto pai.',
  'sem-deposito': 'A conta não tem depósito configurado.',
  'conta-pausada': 'Não tentado: o Mercado Livre limitou as requisições desta conta.',
  'tempo-esgotado': 'Não tentado: o tempo do envio se esgotou. Tente com menos produtos.',
  'anuncio-inexistente': 'O anúncio não existe mais no Mercado Livre.',
  reauth: 'A conta precisa ser reconectada ao Mercado Livre.',
  'erro-canal': 'O Mercado Livre não respondeu. Tente novamente.',
};

/** Channel-neutral rename of `SendSkipReason` (ML wording must not leak). */
const MOTIVO_POR_SKIP: Record<string, string> = {
  'sem-link': 'sem-anuncio',
  'sem-item-id': 'sem-id-externo',
  'aguardando-migracao': 'aguardando-migracao',
  'anuncio-em-erro': 'anuncio-em-erro',
  'status-nao-enviavel': 'status-nao-enviavel',
  'kit-virtual': 'kit-virtual',
  'nao-publicado': 'nao-publicado',
  'conta-fora-do-produto': 'conta-fora-do-produto',
  'variations-excede-limite': 'variacoes-excede-limite',
};

function mensagemDe(motivo: string, fallback = 'Não enviado.'): string {
  return MENSAGEM_POR_MOTIVO[motivo] ?? fallback;
}

/**
 * Map one `StockSendResult` onto the channel-neutral envelope. Exported and pure
 * so a second channel can reuse it and so the table is unit-testable.
 *
 * `'erro-registrado'` maps to `falha`, not success: it is a SUCCESS to the queue
 * (the state was recorded, stop retrying) but a FAILURE to the operator, who
 * asked for the quantity to reach ML and it did not.
 */
export function toPushOutcome(r: StockSendResult): {
  outcome: PushEstoqueOutcome;
  motivo: string | null;
} {
  switch (r.outcome) {
    case 'sent':
      return { outcome: 'enviado', motivo: null };
    case 'skipped':
      return { outcome: 'pulado', motivo: r.reason ?? 'nao-enviado' };
    case 'paused-requeued':
      return { outcome: 'nao-tentado', motivo: 'conta-pausada' };
    case 'dropped':
      return r.reason === 'tasks-desabilitadas'
        ? { outcome: 'nao-tentado', motivo: 'conta-pausada' }
        : { outcome: 'falha', motivo: r.reason ?? 'erro-canal' };
    case 'erro-registrado':
      return { outcome: 'falha', motivo: r.reason ?? 'erro-canal' };
  }
}

/* ----------------------------- anchor resolution ---------------------------- */

export interface AnchorsResolvidos {
  /** Anchor ids, deduped, in first-seen request order. */
  anchorIds: string[];
  /** Requested produto id → the anchor it resolved to (outcome attribution). */
  anchorPorProdutoId: Map<string, string>;
  /** Anchor id → the best `nome` we saw for it (report labels). */
  nomePorProdutoId: Map<string, string>;
  /** Requested ids with no produto document. */
  naoEncontrados: string[];
}

/**
 * Resolve each selected produto to its family ANCHOR, one masked point read each.
 *
 * Not folded into the pipeline, for a decisive reason: `documents([...])`
 * **silently omits a missing document**, so the pipeline alone cannot tell
 * "produto does not exist" from "produto exists but is not an anchor" — and the
 * per-listing report needs both. It is also emulator-runnable, so half the
 * route's tests need no pipeline mock.
 *
 * Exactly ONE hop. A 2-deep `paiId` chain is pathological; it simply comes back
 * with no family row and is reported `familia-nao-encontrada`.
 */
export async function resolverAnchors(
  db: Firestore,
  produtoIds: readonly string[],
): Promise<AnchorsResolvidos> {
  const pedidos = [...new Set(produtoIds)];
  const snaps = await db.getAll(...pedidos.map((id) => produtoCollection.docRef(db, {}, id)), {
    fieldMask: ['paiId', 'nome'],
  });

  const anchorIds: string[] = [];
  const vistos = new Set<string>();
  const anchorPorProdutoId = new Map<string, string>();
  const nomePorProdutoId = new Map<string, string>();
  const naoEncontrados: string[] = [];

  snaps.forEach((snap, i) => {
    const produtoId = pedidos[i]!;
    if (!snap.exists) {
      naoEncontrados.push(produtoId);
      return;
    }
    const data = (snap.data() ?? {}) as Record<string, unknown>;
    if (typeof data.nome === 'string' && data.nome !== '') {
      nomePorProdutoId.set(produtoId, data.nome);
    }
    const paiId = typeof data.paiId === 'string' && data.paiId !== '' ? data.paiId : null;
    const anchorId = paiId ?? produtoId;
    anchorPorProdutoId.set(produtoId, anchorId);
    if (!vistos.has(anchorId)) {
      vistos.add(anchorId);
      anchorIds.push(anchorId);
    }
  });

  return { anchorIds, anchorPorProdutoId, nomePorProdutoId, naoEncontrados };
}

/* ---------------------------------- the run --------------------------------- */

/**
 * The ML surface the manual push needs beyond what the send handler builds:
 * `getItem` for the re-arm pass (hence extending `ReverificarApi`, so the two
 * cannot disagree) and `getMe` for the multiorigin guard.
 */
export interface ManualPushApi extends ReverificarApi {
  getMe(): Promise<{ id?: number; tags?: readonly string[] | null }>;
}

export interface EnviarEstoqueManualArgs {
  integracaoId: string;
  produtoIds: readonly string[];
  /**
   * Re-verify a latched listing (`estado 'E'`) against ML and clear its errors
   * before sending. Default FALSE, deliberately: `'E'` is written only when ML
   * confirmed the anúncio is healthy and it was therefore OUR payload it
   * refused, so re-sending the identical payload just re-earns the rejection.
   * Auto-re-arming on every click would turn the button into a 4xx generator.
   */
  reenviarComErro?: boolean;
}

export interface EnviarEstoqueManualDeps {
  /** ONE clock read for the whole request. */
  nowMs: number;
  /** The conta context, already loaded by the route (depósito + nome + token). */
  conta: Readonly<Record<string, unknown>>;
  contaNome: string | null;
  /** Memoized per request — every send reuses this one context. */
  contextLoader: StockContextLoader;
  api: ManualPushApi;
  fetchFamilies?: FetchStockFamiliesByIds;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable purely so tests do not go near the real handler. */
  sendTask?: typeof processStockSendTask;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The pause gate inside `processStockSendTask` enqueues a Cloud Task to defer
 * past the pause. Doing that behind an operator's back is wrong — the manual
 * push must SAY "conta pausada", not silently defer — so it gets a scheduler
 * that refuses.
 *
 * ⚠️ It must throw `MlTasksDisabledError` specifically: that is the ONLY error
 * the handler's pause branch narrows on, and anything else would rethrow
 * unclassified. The handler then returns `dropped/'tasks-desabilitadas'`, which
 * {@link toPushOutcome} renames `conta-pausada`.
 */
const schedulerQueRecusa: MlStockTaskScheduler = {
  enqueue() {
    return Promise.reject(new MlTasksDisabledError());
  },
};

/** True when the family's link row is latched by #781's `estado 'E'`. */
function estaLatched(link: RawStockLinkRow): boolean {
  return link.estado === ESTADO_PUBLICACAO_ML.erro;
}

export async function enviarEstoqueManual(
  db: Firestore,
  args: EnviarEstoqueManualArgs,
  deps: EnviarEstoqueManualDeps,
): Promise<PushEstoqueResponse> {
  const { nowMs, conta, api } = deps;
  const fetchFamilies = deps.fetchFamilies ?? fetchStockFamiliesByIds;
  const sleep = deps.sleep ?? defaultSleep;
  const sendTask = deps.sendTask ?? processStockSendTask;

  // (1) Depósito guard — the same conta-misconfig check the sweep makes, and the
  // reason the send handler would otherwise skip every task with 'sem-deposito'.
  const depositoRef = conta.depositoOuterRef;
  const depositoId =
    typeof depositoRef === 'string' && depositoRef !== '' ? idFromRef(depositoRef) : '';
  if (depositoId === '') {
    throw new ManualPushGuardError(
      'ML_CONTA_SEM_DEPOSITO',
      400,
      'A conta não tem depósito configurado — configure-o em Canais de venda.',
    );
  }

  // (2) Multiorigin guard. NOT optional: ML SILENTLY IGNORES `PUT /items` stock
  // on a `warehouse_management` conta, so without this probe the button would
  // report a confident "enviado" for a call ML dropped on the floor — the worst
  // possible outcome for a feature whose entire purpose is trust. One
  // `GET /users/me` per request, never per listing.
  const user = await api.getMe();
  if ((user.tags ?? []).includes('warehouse_management')) {
    throw new ManualPushGuardError(
      'ML_CONTA_MULTIORIGEM',
      409,
      'Conta multiorigem (warehouse_management): o envio de estoque por anúncio não se aplica.',
    );
  }

  // (3) Resolve anchors — see resolverAnchors for why this is not in the pipeline.
  const solicitados = [...new Set(args.produtoIds)];
  const resolved = await resolverAnchors(db, solicitados);

  const listings: PushEstoqueListing[] = [];
  const produtosSemEnvio: PushEstoqueSemEnvio[] = [];
  const nomeDe = (produtoId: string): string | null =>
    resolved.nomePorProdutoId.get(produtoId) ?? null;

  for (const produtoId of resolved.naoEncontrados) {
    produtosSemEnvio.push({
      produtoId,
      produtoNome: null,
      motivo: 'produto-nao-encontrado',
      mensagem: mensagemDe('produto-nao-encontrado'),
    });
  }

  if (resolved.anchorIds.length === 0) {
    return montarResposta(
      args.integracaoId,
      deps.contaNome,
      solicitados.length,
      0,
      listings,
      produtosSemEnvio,
      null,
    );
  }

  // (4) ONE pipeline execution — force-all over exactly these anchors.
  const rows = await fetchFamilies(db, {
    integracaoId: args.integracaoId,
    depositoId,
    anchorIds: resolved.anchorIds,
  });
  const rowPorAnchor = new Map(rows.map((r) => [r.anchorId, r]));

  // An anchor the query did not return: the produto is gone, or it is itself a
  // variation child (2-deep chain). Either way it is REPORTED, never dropped.
  for (const anchorId of resolved.anchorIds) {
    if (rowPorAnchor.has(anchorId)) continue;
    produtosSemEnvio.push({
      produtoId: anchorId,
      produtoNome: nomeDe(anchorId),
      motivo: 'familia-nao-encontrada',
      mensagem: mensagemDe('familia-nao-encontrada'),
    });
  }

  // (5) Optional re-arm pass, BEFORE buildSendTasks so the refreshed state is
  // what the ladder sees. The in-memory link row is patched from the same ML
  // response rather than re-executing the pipeline (which would double the cost
  // and open a race).
  const rearmePorLink = new Map<
    string,
    { executado: boolean; estado: string | null; enviavel: boolean }
  >();
  if (args.reenviarComErro === true) {
    let orcamento = manualRearmMaxGets();
    for (const row of rows) {
      for (const link of row.links) {
        if (!estaLatched(link)) continue;
        const linkDocId = typeof link.linkDocId === 'string' ? link.linkDocId : null;
        const itemId = typeof link.id === 'string' && link.id !== '' ? link.id : null;
        if (linkDocId == null || itemId == null) continue;
        if (orcamento <= 0) {
          rearmePorLink.set(linkDocId, { executado: false, estado: null, enviavel: false });
          continue;
        }
        orcamento -= 1;
        const target: LinkStatusTarget = { produtoId: row.anchorId, linkDocId, itemId };
        const res = await reverificarAnuncio(db, args.integracaoId, target, api, nowMs);
        rearmePorLink.set(linkDocId, {
          executado: true,
          estado: res.estado,
          enviavel: res.enviavel,
        });
        // Patch the row so buildSendTasks reads the REFRESHED state. When ML now
        // reports the listing as not sendable, the listing skips with the more
        // informative 'status-nao-enviavel' instead of 'anuncio-em-erro'.
        link.estado = res.estado;
        link.status = res.status;
        link.sub_status = res.subStatus ?? [];
      }
    }
  }

  // (6) Plan. No deveEnviarFamilia and no ledger pass — manual means always send.
  const tarefas: Array<{ task: StockSendTaskDraft; row: StockFamilyRow }> = [];
  const skips: SendSkip[] = [];
  for (const row of rows) {
    const quantidades = quantidadesDaFamilia(row);
    const built = buildSendTasks(row, quantidades, {
      integracaoId: args.integracaoId,
      // Deterministic and self-describing in the send handler's logs.
      sweepId: `manual-${args.integracaoId}-${nowMs}`,
      // Manual quantities are computed NOW, so the handler's `ageMs` reads ~0.
      sweepComputedAtMs: nowMs,
    });
    skips.push(...built.skips);
    for (const task of built.tasks) tarefas.push({ task, row });
  }

  for (const skip of skips) {
    const motivo = MOTIVO_POR_SKIP[skip.reason] ?? skip.reason;
    listings.push({
      produtoId: skip.produtoId,
      produtoNome: nomeDe(skip.produtoId),
      variacaoProdutoId: null,
      anuncioId: skip.itemId ?? null,
      linkDocId: skip.linkDocId ?? null,
      outcome: 'pulado',
      motivo,
      mensagem: mensagemDe(motivo),
      quantidade: null,
      variacoes: null,
      rearme: skip.linkDocId != null ? (rearmePorLink.get(skip.linkDocId) ?? null) : null,
    });
  }

  // (7) Send, bounded. A 429 aborts the run: retrying inline would only re-enter
  // the pause gate, and hammering a rate-limited conta is the one thing this
  // must never do.
  // ⚠️ ELAPSED wall-clock, measured from here — never `deps.nowMs + budget`.
  // `nowMs` is the request's ONE logical clock read and is INJECTED (tests pin
  // it, and the send handler stamps `sweepComputedAtMs` from it), so comparing
  // it against a live `Date.now()` mixes two different clocks: any injected
  // value in the past makes the deadline trip on the very first listing and the
  // whole run reports `nao-tentado`.
  const iniciadoEmMs = Date.now();
  const orcamentoMs = manualPushDeadlineMs();
  let pausadoAte: string | null = null;
  let abortado = false;

  const executar = async (item: { task: StockSendTaskDraft; row: StockFamilyRow }) => {
    const { task } = item;
    const base = {
      produtoId: task.produtoId,
      produtoNome: nomeDe(task.produtoId),
      variacaoProdutoId: task.variacaoProdutoId,
      anuncioId: task.itemId,
      linkDocId: task.linkDocId,
      quantidade: task.quantidade,
      variacoes: task.variations?.length ?? null,
      rearme: rearmePorLink.get(task.linkDocId) ?? null,
    };

    if (abortado || Date.now() - iniciadoEmMs > orcamentoMs) {
      const motivo = abortado ? 'conta-pausada' : 'tempo-esgotado';
      listings.push({ ...base, outcome: 'nao-tentado', motivo, mensagem: mensagemDe(motivo) });
      return;
    }

    try {
      const result = await enviarComLadder(db, task, deps, sleep, sendTask);
      const { outcome, motivo } = toPushOutcome(result);
      listings.push({
        ...base,
        outcome,
        motivo,
        mensagem:
          outcome === 'enviado'
            ? `Estoque ${String(task.quantidade ?? task.variations?.length ?? '')} enviado.`
            : mensagemDe(motivo ?? 'erro-canal'),
        quantidade: outcome === 'enviado' ? task.quantidade : null,
      });
      if (outcome === 'nao-tentado' && motivo === 'conta-pausada') abortado = true;
    } catch (err) {
      if (err instanceof MercadoLivreHttpError && err.status === 429) {
        abortado = true;
        pausadoAte = new Date(nowMs + (err.retryAfterSec ?? 300) * 1000).toISOString();
        listings.push({
          ...base,
          outcome: 'nao-tentado',
          motivo: 'conta-pausada',
          mensagem: mensagemDe('conta-pausada'),
        });
        return;
      }
      if (err instanceof MercadoLivreError) {
        listings.push({
          ...base,
          outcome: 'falha',
          motivo: 'erro-canal',
          mensagem: err.message,
        });
        return;
      }
      throw err; // Firestore / coding bug — never swallowed
    }
  };

  await runPool(tarefas, manualPushConcurrency(), executar);

  return montarResposta(
    args.integracaoId,
    deps.contaNome,
    solicitados.length,
    rows.length,
    listings,
    produtosSemEnvio,
    pausadoAte,
  );
}

/* --------------------------------- internals -------------------------------- */

/**
 * The bounded ladder (module doc). Maps its own last attempt onto
 * `STOCK_SEND_MAX_ATTEMPTS - 1` so `processStockSendTask` only verifies and
 * records THERE, and every earlier attempt onto `0` so a transient 4xx just
 * retries. A 429 breaks out immediately — no retry, no enqueue.
 */
async function enviarComLadder(
  db: Firestore,
  task: StockSendTaskDraft,
  deps: EnviarEstoqueManualDeps,
  sleep: (ms: number) => Promise<void>,
  sendTask: typeof processStockSendTask,
): Promise<StockSendResult> {
  let ultimoErro: unknown = null;
  for (let attempt = 0; attempt < MANUAL_PUSH_MAX_ATTEMPTS; attempt++) {
    const ultima = attempt === MANUAL_PUSH_MAX_ATTEMPTS - 1;
    try {
      return await sendTask(db, task, {
        scheduler: schedulerQueRecusa,
        nowMs: deps.nowMs,
        contextLoader: deps.contextLoader,
        retryCount: ultima ? STOCK_SEND_MAX_ATTEMPTS - 1 : 0,
        // The pause path never enqueues here, so jitter is meaningless — pin it
        // to 0 so the delay math is deterministic in tests.
        jitterSec: () => 0,
        // #819: the manual push works before the sweep flag flips. See the field
        // docblock on StockSendDeps for why that is not a hole in the kill switch.
        ignoreSyncFlag: true,
      });
    } catch (err) {
      if (err instanceof MercadoLivreHttpError && err.status === 429) throw err;
      ultimoErro = err;
      if (ultima) throw err;
      await sleep(MANUAL_PUSH_RETRY_DELAY_MS);
    }
  }
  // Unreachable: the loop either returns or throws on its last iteration.
  throw ultimoErro instanceof Error ? ultimoErro : new Error('envio manual falhou');
}

/** Fixed-size worker pool preserving no particular completion order. */
async function runPool<T>(
  items: readonly T[],
  size: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i]!);
    }
  });
  await Promise.all(workers);
}

function montarResposta(
  integracaoId: string,
  contaNome: string | null,
  solicitados: number,
  familias: number,
  listings: PushEstoqueListing[],
  produtosSemEnvio: PushEstoqueSemEnvio[],
  pausadoAte: string | null,
): PushEstoqueResponse {
  return {
    canal: 'mercado-livre',
    integracaoId,
    contaNome,
    solicitados,
    familias,
    resumo: {
      enviados: listings.filter((l) => l.outcome === 'enviado').length,
      pulados: listings.filter((l) => l.outcome === 'pulado').length,
      falhas: listings.filter((l) => l.outcome === 'falha').length,
      naoTentados: listings.filter((l) => l.outcome === 'nao-tentado').length,
    },
    listings,
    produtosSemEnvio,
    pausadoAte,
  };
}

/** Exported for the route's `millisToMicros`-based pause pre-check. */
export { millisToMicros };
