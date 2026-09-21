/**
 * The Shopee STOCK SEND handler (master-plan step 12, #1520) — one task, one
 * listing, **one** `update_stock` call, and a declared error ladder that turns
 * every refusal Shopee can file into either a conta pause, a listing-level
 * diagnosis or a rethrow.
 *
 * `processShopeeStockSendTask` is the whole of it. The queue wrapper
 * (`functions/src/sendStock.ts`) and the manual push both call this function
 * and nothing else under this folder: the ORDER of the rungs below is the
 * contract, not an implementation detail, and each one exists because doing it
 * later costs a read, a Shopee call or a wrong write.
 *
 * ## What it deliberately does NOT do
 *
 * **It never recomputes a quantity.** The number in the payload is the number
 * the sweep computed, and it is sent verbatim on the first attempt and on every
 * retry. Refreshing it would cost ~51 subcollection reads per attempt for a
 * family and would make two attempts of one task publish two different numbers
 * with nothing recording which won. The payload's AGE is logged instead
 * (`ageMs`), so a stale number is visible rather than silently repaired.
 *
 * **It runs no conta gates.** `contaEstoque.ts`'s gates are the sweep's
 * optimisation — they stop N tasks being built. The arms below are the
 * CORRECTNESS: a conta that became FBS between the plan and the dispatch is
 * caught here by the refusal, not by a gate this handler could also run.
 *
 * **It performs no verification read.** Shopee's refusals are code-exact on
 * HTTP 200, so a recognised code IS the proof; a read-back would make this
 * module a fifth writer of `item_status` and buy nothing. The ONE point read it
 * does perform is of the LINK document, and only to copy the two fingerprint
 * halves onto a refusal.
 *
 * **It reads no ambient clock and starts no timer.** Every instant is
 * `deps.nowMs`, the TICK's instant in MILLISECONDS, threaded from the caller
 * (`podeEnviarEstoque.ts`'s rule 2). Two listings sent in one manual push must
 * not straddle an expiry.
 *
 * ## The order, and why each rung is where it is
 *
 * 0.  zod parse. A malformed payload is dropped with the field PATHS only —
 *     never the body, which on this channel can carry a shop's own data.
 * 0.5 the master valve, ABOVE the pause gate, so an off valve costs ZERO
 *     Firestore reads.
 * 1.  the model-count guard, BEFORE the client is built, so a chunker
 *     regression cannot spend a Shopee call proving itself.
 * 2.  the pause gate — ONE state-doc read. A paused conta re-enqueues the task
 *     with a delay rather than sleeping or failing: a delayed re-enqueue
 *     consumes no queue attempt, which is the only way to express "wait six
 *     hours" without burning the three the queue allows.
 * 3.  the client.
 * 4.  ONE `update_stock`.
 * 5.  attribution by `model_id`, then the write-backs.
 *
 * ## The ladder
 *
 * Narrowing runs `ShopeeRateLimitError` → `ShopeeReauthRequiredError` →
 * `ShopeeApiPartialError` → `ShopeeApiError` → rethrow, because all four sit in
 * ONE `instanceof` chain and a bare `instanceof ShopeeApiError` above any of
 * them swallows the other three. Inside the last arm the LETTERED arms
 * (A, G, F1, F2, E, B, C, D, H, J, K) run in that declared order over one pure
 * table, {@link classificarCodigoDeEstoque}, which the per-model reason texts
 * walk as well — one table, one order, no second copy free to drift.
 *
 * ⚠️ Arm **I** (a genuine `ShopeeApiPartialError`) is reached through the CLASS
 * ladder and therefore sits ABOVE the lettered arms, although the seam's table
 * prints it between H and J. That is forced, not chosen: the class extends
 * `ShopeeApiError`, so it must be narrowed first or it never matches at all.
 * The letter order governs the lettered arms only.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  SHOPEE_ERROR_KIND,
  ShopeeApiError,
  ShopeeApiPartialError,
  ShopeeConfigError,
  ShopeeError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  shopeeCodeSemPrefixoDeModulo,
  shopeeUpdateStockSchema,
  type ShopeeClient,
  type ShopeeErrorKind,
  type ShopeeUpdateStock,
} from '@delfrance/integrations-shopee';
import { produtoShopeeLinkCollection } from '@delfrance/data/admin/collections';
import { z } from 'zod';

import { proximaViradaDaCotaMs } from '../anuncios/pausarAnuncio';
import type { AvisoDeps } from '../avisos/autorizacao';
import { loadShopeeContext } from '../core/shopee';
import { validationPaths } from '../core/validationIssues';
import { avisarEstoqueAcimaDoDisponivel, resolverEstoqueAcimaDoDisponivel } from './avisoEstoque';
import {
  MAX_MODELOS_POR_TASK,
  MOTIVOS_DE_PAUSA,
  PAUSE_REENQUEUE_JITTER_MAX_S,
  isShopeeStockSyncEnabled,
  maxPauseReenqueues,
  pausaFeriasH,
  pausaLojaH,
  promocaoRetryMin,
  ratePauseMin,
  type MotivoDePausa,
} from './constantesEstoque';
import {
  MENSAGEM_POR_MOTIVO,
  MOTIVO_ESTOQUE_SHOPEE,
  RESULTADO_MODELO,
  ShopeeStockTasksDisabledError,
  type LinhaDeModeloEnviada,
  type MotivoEstoqueShopee,
} from './errosEstoque';
import {
  armarPausa,
  estaPausada,
  lerEstadoEstoque,
  registrarErroDaConta,
  type EstadoEstoqueLido,
} from './estadoEstoque';
import {
  codigoDoErp,
  registrarEnvioLimpo,
  registrarEnvioParcial,
  registrarRecusaDeEstoque,
  registrarRecusaDeModelo,
  type AlvoDoLink,
} from './linkEstoque';
import type { TarefaDeEstoqueShopee } from './planoEstoque';
import { aplicarPiso, ehRecusaDePiso, pisoPorModelo } from './reservaPromocao';
import type { AgendadorEstoqueShopee } from './shopeeStockTasks';

/** The one log tag of this module. */
const TAG_LOG = '[shopee/estoque] envio de estoque';

/** Seconds → milliseconds, spelled once. */
const MS_POR_SEGUNDO = 1_000;
/** Minutes → milliseconds, spelled once (`ratePauseMin`/`promocaoRetryMin`). */
const MS_POR_MINUTO = 60 * MS_POR_SEGUNDO;

/* -------------------------------------------------------------------------- */
/*                               the task payload                              */
/* -------------------------------------------------------------------------- */

/**
 * The queue body, EXACTLY as the planner emits it.
 *
 * ⚠️ `.strict()`, and that is the point: a field added on one side alone is a
 * `payload-invalido` DROP at this end, loudly, rather than a silently ignored
 * key. The planner's {@link TarefaDeEstoqueShopee} is the other side of the
 * same contract and a test parses one straight through.
 *
 * ⚠️ ONE `modelos` array — never `quantidade XOR modelos`. The no-model listing
 * travels as a single entry with `modelId: 0`, which is a LEGITIMATE value all
 * the way to the wire: never a truthiness test, never folded to null.
 *
 * ⚠️ **No `.max(50)` here, deliberately.** The chunker's cut is checked by rung
 * 1 below, which records `task-excede-limite` ON THE LISTING; a zod refusal
 * would be an anonymous drop with no trace anywhere a human looks.
 */
export const shopeeStockSendTaskSchema = z
  .object({
    integracaoId: z.string().min(1),
    /** The ANCHOR produto — the family head, not necessarily the stock owner. */
    produtoId: z.string().min(1),
    linkDocId: z.string().min(1),
    /** A NUMBER on this channel, never the digits of one. */
    itemId: z.number().int().positive(),
    categoryId: z.number().int().positive().nullable().default(null),
    sweepId: z.string().min(1),
    /** MILLISECONDS — the instant the SWEEP computed these quantities. */
    sweepComputadoEmMs: z.number().int(),
    reenfileiramentos: z.number().int().min(0).default(0),
    /** 1-BASED. A 0 here is a malformed payload, not the first part. */
    parte: z.number().int().min(1).default(1),
    totalDePartes: z.number().int().min(1).default(1),
    modelos: z
      .array(
        z.object({
          /** `0` = the no-model item. A real key, everywhere. */
          modelId: z.number().int().min(0),
          /** The CHILD produto — the one that owns the stock. */
          produtoId: z.string().min(1),
          varLinkDocId: z.string().nullable().default(null),
          /** UNCLAMPED by the category band — the sender owns the clamp. */
          quantidade: z.number().int().min(0),
        }),
      )
      .min(1),
  })
  .strict();

/**
 * The payload type callers annotate with.
 *
 * ⚠️ An ALIAS of the planner's type on purpose, not a second name for the same
 * shape: the scheduler seam (`shopeeStockTasks.ts`) types `enqueue` with
 * {@link TarefaDeEstoqueShopee}, and re-pointing it at a zod-inferred twin
 * would break the sweep, whose rows are `readonly`. The schema's OUTPUT is
 * structurally equal to it and assigns in the direction this module needs
 * (`Array` → `ReadonlyArray`); a test pins both directions.
 */
export type ShopeeStockSendTask = TarefaDeEstoqueShopee;

/** What a parse of {@link shopeeStockSendTaskSchema} actually produces. */
type PayloadDeEnvio = z.infer<typeof shopeeStockSendTaskSchema>;

/* -------------------------------------------------------------------------- */
/*                                  the result                                 */
/* -------------------------------------------------------------------------- */

/** What happened to ONE task. */
export type OutcomeEnvioEstoque =
  | 'enviado'
  | 'enviado-parcial'
  | 'pulado'
  | 'pausado-reenfileirado'
  | 'descartado'
  | 'erro-registrado';

/**
 * The closed set, so a caller names a member instead of spelling a slug.
 *
 * ⚠️ `descartado` and `erro-registrado` are BOTH successes as far as the queue
 * is concerned — the task is done and must not be retried. The difference is
 * where the fact was written: `erro-registrado` left a diagnosis on the LISTING,
 * `descartado` left one on the CONTA (or nowhere, for a valve).
 */
export const OUTCOME_ENVIO_ESTOQUE = {
  enviado: 'enviado',
  enviadoParcial: 'enviado-parcial',
  pulado: 'pulado',
  pausadoReenfileirado: 'pausado-reenfileirado',
  descartado: 'descartado',
  erroRegistrado: 'erro-registrado',
} as const satisfies Record<string, OutcomeEnvioEstoque>;

/** The whole verdict of one task. */
export interface ResultadoEnvioEstoqueShopee {
  readonly outcome: OutcomeEnvioEstoque;
  /** Machine-readable; `null` only on a fully clean `enviado`. */
  readonly motivo: MotivoEstoqueShopee | null;
  /** Shopee's own code VERBATIM (prefix and all), or `erp:<motivo>` when ours. */
  readonly codigo: string | null;
  /** One row per model of the payload, in the payload's order. */
  readonly modelos: readonly LinhaDeModeloEnviada[];
  /** The sum of what was SENT for the accepted models — never the echo. */
  readonly quantidadeEnviada: number;
  /** How many Shopee calls this task actually made (0, 1, 2 or 3). */
  readonly chamadasShopee: number;
  /** MS. Set when this task armed or observed a conta pause. */
  readonly pausadoAte: number | null;
}

/* -------------------------------------------------------------------------- */
/*                                   the deps                                  */
/* -------------------------------------------------------------------------- */

/** Every seam the handler needs, supplied by the surface that can build them. */
export interface EnvioEstoqueDeps {
  /** The enqueue seam — used by the pause rung and by the burst arm. */
  readonly scheduler: AgendadorEstoqueShopee;
  /** The ONE clock reading of this dispatch, in MILLISECONDS. */
  readonly nowMs: number;
  /**
   * The queue's attempt counter, LOGGED and never branched on.
   *
   * Nothing this handler does depends on which attempt it is: the payload is
   * sent verbatim every time, and every arm either finishes the task or
   * rethrows for the queue's own ladder. It is carried so a log line can say
   * "this listing has now failed twice" without a second data source.
   */
  readonly retryCount?: number;
  /**
   * Bypass the master valve. **Only the manual push may set it** — the queue
   * wrapper never does, and a source-text test pins that.
   */
  readonly ignoreSyncFlag?: boolean;
  /**
   * Jitter, in SECONDS, for a delayed re-enqueue. Default: a deterministic `0`.
   *
   * ⚠️ The randomness belongs to the FUNCTIONS wrapper, not here: a module that
   * reaches for a random number of its own cannot be tested for the delay it
   * computed, and two identical tasks must be able to produce identical delays
   * under test.
   */
  readonly jitterSec?: (maxS: number) => number;
  /** The Shopee client seam. Default: the conta's context + a shop client. */
  readonly clientFor?: (db: Firestore, integracaoId: string) => Promise<ShopeeClient>;
  /**
   * The avisos counter seam — `(by) => FieldValue.increment(by)`.
   *
   * ⚠️ REQUIRED, and not in the seam's own deps list. The clamp aviso
   * (`avisoEstoque.ts`) and its resolver both take an `AvisoDeps`, and neither
   * can be built here: a runtime `firebase-admin` import belongs to the surface,
   * which is exactly why `anuncios/pausarAnuncio.ts` carries the same member.
   * Required rather than optional so a call site that forgets it is a compile
   * error instead of a silently unraised aviso.
   */
  readonly increment: (by: number) => unknown;
}

/** The two aviso entry points read exactly these two members. */
function depsDeAviso(deps: EnvioEstoqueDeps): AvisoDeps {
  return { increment: deps.increment, nowMs: deps.nowMs };
}

/* -------------------------------------------------------------------------- */
/*                          the classification table                           */
/* -------------------------------------------------------------------------- */

/**
 * Which arm a `(codigo, mensagem, kind)` triple lands in.
 *
 * The discriminant is the ACTION, not the motivo, because three arms do
 * something to the CONTA and the rest do something to the LISTING; a table
 * returning only a motivo would force every caller to re-derive that split.
 */
type Classificacao =
  /** Arm A — the reserved floor. Code-blind, message-matched, and FIRST. */
  | { readonly arm: 'piso' }
  /** Arm G — the shop is on holiday; the end time decides the pause. */
  | { readonly arm: 'ferias' }
  /** Arm F1 — a multi-warehouse shop this integration cannot address. */
  | { readonly arm: 'local' }
  /** Arm E — a shop-shaped block; the conta pauses and the slug says which. */
  | { readonly arm: 'forma-de-loja'; readonly motivo: MotivoEstoqueShopee }
  /** Arm B — a promotion holds the listing; a TIME skip, not a state skip. */
  | { readonly arm: 'promocao' }
  /** Arms F2 / C / D / H — terminal per listing, with a fingerprint. */
  | { readonly arm: 'terminal'; readonly motivo: MotivoEstoqueShopee }
  /** Arm J — Shopee's own hiccup; the queue owns it. */
  | { readonly arm: 'transitorio' }
  /** Arm K — a code nobody taught us. Recorded, never retried. */
  | { readonly arm: 'desconhecida' };

/** Arm E — the five codes, each with the slug an operator reads. */
const FORMA_DE_LOJA_POR_CODIGO: Record<string, MotivoEstoqueShopee> = {
  // [sic] — Shopee's own spelling of "update".
  error_wms_shop_block_upate_stock: MOTIVO_ESTOQUE_SHOPEE.lojaArmazem,
  error_busi_cannot_edit_vsku: MOTIVO_ESTOQUE_SHOPEE.lojaVsku,
  error_seller_under_penalty: MOTIVO_ESTOQUE_SHOPEE.lojaComPenalidade,
  error_perm_non_admin: MOTIVO_ESTOQUE_SHOPEE.semPermissao,
  cnsc_shop_block: MOTIVO_ESTOQUE_SHOPEE.lojaCnscNaoMigrada,
};

/** Arm B — the three promotion hard blocks, Shopee's spellings verbatim [sic]. */
const CODIGOS_DE_PROMOCAO: readonly string[] = [
  'error_cannt_edit_stock_in_promotion',
  'error_promotion_cantnot_update_stock',
  'error_model_update_stock_model_in_promotion',
];

/** Arm C — the listing has models and the request did not, or the reverse. */
const CODIGOS_DE_FORMA_DE_MODELO: readonly string[] = [
  'error_in_item_promotion_nomodel_to_models',
  'error_edit_item_stock_for_item_has_model',
];

/** Arm D — who the listing belongs to, or whether it exists at all. */
const IDENTIDADE_POR_CODIGO: Record<string, MotivoEstoqueShopee> = {
  error_item_not_belong_shop: MOTIVO_ESTOQUE_SHOPEE.anuncioDeOutraLoja,
  error_item_not_found: MOTIVO_ESTOQUE_SHOPEE.anuncioInexistente,
  error_nil_shopid_or_itemid: MOTIVO_ESTOQUE_SHOPEE.anuncioInexistente,
};

/**
 * THE table. One walk, one declared order, used by BOTH the error ladder and
 * the per-model `failed_reason` classifier — the second copy that would
 * otherwise drift toward plausible (root `CLAUDE.md`).
 *
 * ⚠️ `codigo` arrives VERBATIM (module prefix and all) and `nu` is the stripped
 * spelling; both are consulted, because `error.param` strips to a bare `param`
 * while `product.error_item_uneditable` strips to something meaningful. Only
 * the STRIPPED form is ever matched against this table's keys, and only the
 * VERBATIM one is ever stored.
 *
 * ⚠️ The order is load-bearing three times over:
 *   - **A first and code-blind** — one of the four documented floor refusals
 *     arrives under `error.param`, whose stripped form matches nothing;
 *   - **G above E and F1** — `error_auth` has five meanings and holiday mode is
 *     one of them;
 *   - **E above J** — `error_server` carries both the FBS refusal and "please
 *     try later", and reading the FBS one as transient retries a conta that
 *     structurally cannot accept the write.
 */
function classificarCodigoDeEstoque(
  codigo: string,
  mensagem: string,
  kind: ShopeeErrorKind,
): Classificacao {
  const nu = shopeeCodeSemPrefixoDeModulo(codigo) ?? codigo;
  const msg = mensagem.toLowerCase();

  // ---- A: the reserved floor. ANY code; the message is the whole test. ----
  if (ehRecusaDePiso(mensagem)) return { arm: 'piso' };

  // ---- G: holiday mode, above every other `error_auth` meaning. ----
  if (nu === 'error_holiday_mode_change_stock') return { arm: 'ferias' };
  if (nu === 'error_auth' && msg.includes('holiday mode')) return { arm: 'ferias' };

  // ---- F1: a stock location this integration cannot address. ----
  if (nu === 'error_auth' && msg.includes('location_id')) return { arm: 'local' };
  if (nu === 'error_inner' && msg.includes('invalid stock location id')) return { arm: 'local' };
  if (nu === 'error_busi' && msg.includes('multi warehouse')) return { arm: 'local' };

  // ---- F2: the listing's stock structure is not the one we sent. ----
  if (nu === 'error_param' && msg.includes('different stock structure')) {
    return { arm: 'terminal', motivo: MOTIVO_ESTOQUE_SHOPEE.estruturaDeEstoqueDivergente };
  }

  // ---- E: the shop's own shape. Above J. ----
  const forma = FORMA_DE_LOJA_POR_CODIGO[nu];
  if (forma !== undefined) return { arm: 'forma-de-loja', motivo: forma };
  if (msg.includes('cnsc shop not upgraded')) {
    return { arm: 'forma-de-loja', motivo: MOTIVO_ESTOQUE_SHOPEE.lojaCnscNaoMigrada };
  }
  if (msg.includes('normal stock must be equal to 0')) {
    return { arm: 'forma-de-loja', motivo: MOTIVO_ESTOQUE_SHOPEE.lojaFbs };
  }

  // ---- B: a promotion holds the listing. A TIME skip. ----
  if (CODIGOS_DE_PROMOCAO.includes(nu)) return { arm: 'promocao' };

  // ---- C: models where there are none, or none where there are models. ----
  if (CODIGOS_DE_FORMA_DE_MODELO.includes(nu)) {
    return { arm: 'terminal', motivo: MOTIVO_ESTOQUE_SHOPEE.formaDeModeloDivergente };
  }

  // ---- D: identity. ----
  const identidade = IDENTIDADE_POR_CODIGO[nu];
  if (identidade !== undefined) return { arm: 'terminal', motivo: identidade };
  if (nu === 'error_param' && (msg.includes('repeat model_id') || msg.includes('wrong model_id'))) {
    return { arm: 'terminal', motivo: MOTIVO_ESTOQUE_SHOPEE.modeloInvalido };
  }

  // ---- H: the listing is locked against edits. ----
  if (nu === 'error_item_uneditable') {
    return { arm: 'terminal', motivo: MOTIVO_ESTOQUE_SHOPEE.anuncioNaoEditavel };
  }

  // ---- J: Shopee's own hiccup. ----
  if (kind === SHOPEE_ERROR_KIND.transient) return { arm: 'transitorio' };
  if (nu === 'error_inner' || nu === 'error_system_busy') return { arm: 'transitorio' };
  if (msg.includes('please try later')) return { arm: 'transitorio' };

  // ---- K ----
  return { arm: 'desconhecida' };
}

/**
 * The per-model half: a `failed_reason` TEXT through the SAME table, reduced to
 * a motivo.
 *
 * ⚠️ `failed_reason` is free text, not a code, so it is handed in as BOTH
 * arguments — the message needles are what actually match — and `kind` is
 * `other`, because one refused model of a partially accepted call is never a
 * reason to retry the whole task.
 */
function motivoDoModeloRecusado(texto: string): MotivoEstoqueShopee {
  const c = classificarCodigoDeEstoque(texto, texto, SHOPEE_ERROR_KIND.other);
  switch (c.arm) {
    case 'piso':
      return MOTIVO_ESTOQUE_SHOPEE.pisoDeReservaNaoAtendido;
    case 'ferias':
      return MOTIVO_ESTOQUE_SHOPEE.lojaEmFerias;
    case 'local':
      return MOTIVO_ESTOQUE_SHOPEE.multiArmazem;
    case 'forma-de-loja':
    case 'terminal':
      return c.motivo;
    case 'promocao':
      return MOTIVO_ESTOQUE_SHOPEE.bloqueadoPorPromocao;
    case 'transitorio':
    case 'desconhecida':
      // A transient-looking reason on ONE model of an otherwise accepted call
      // is not retryable either: the other models landed, and re-driving the
      // task would republish them. Recorded with the raw text instead.
      return MOTIVO_ESTOQUE_SHOPEE.recusaDesconhecida;
  }
}

/* -------------------------------------------------------------------------- */
/*                              the working context                            */
/* -------------------------------------------------------------------------- */

interface Contador {
  n: number;
}

interface Contexto {
  readonly db: Firestore;
  readonly payload: PayloadDeEnvio;
  readonly deps: EnvioEstoqueDeps;
  readonly alvo: AlvoDoLink;
  readonly estado: EstadoEstoqueLido;
  readonly client: ShopeeClient;
  readonly chamadas: Contador;
}

/** The two fingerprint halves, exactly AS READ. `undefined` folds to `null`. */
interface ImpressaoDoAnuncio {
  readonly estadoAnuncio: string | null;
  readonly itemStatus: string | null;
}

function textoOuNulo(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * ONE tolerant point read of the listing's link document, for the fingerprint a
 * refusal has to carry.
 *
 * ⚠️ Read, never invented. The gate's skip set compares two RECORDED READINGS
 * for identity: a half we made up would arm a skip against a reading nobody
 * took, and a half we omitted would leave the PREVIOUS reading standing beside
 * a fresh one.
 *
 * A deleted link answers two `null`s, which is the honest reading of a document
 * that is not there; the write that follows will resolve `false` anyway.
 */
async function lerImpressaoDoAnuncio(
  db: Firestore,
  payload: PayloadDeEnvio,
): Promise<ImpressaoDoAnuncio> {
  const snap = await produtoShopeeLinkCollection
    .docRef(db, { produtoId: payload.produtoId }, payload.linkDocId)
    .get();
  const raw: Record<string, unknown> = snap.data() ?? {};
  return {
    estadoAnuncio: textoOuNulo(raw.estadoAnuncio),
    itemStatus: textoOuNulo(raw.item_status),
  };
}

/** The client seam — `pausarAnuncio.ts`'s shape, verbatim. */
async function clienteDeEstoque(
  db: Firestore,
  integracaoId: string,
  deps: EnvioEstoqueDeps,
): Promise<ShopeeClient> {
  if (deps.clientFor !== undefined) return deps.clientFor(db, integracaoId);
  const ctx = await loadShopeeContext(db, integracaoId);
  return ctx.createShopClient();
}

/** A result with everything defaulted — every arm overrides what it knows. */
function resultado(
  outcome: OutcomeEnvioEstoque,
  extra: Partial<ResultadoEnvioEstoqueShopee> = {},
): ResultadoEnvioEstoqueShopee {
  return {
    outcome,
    motivo: null,
    codigo: null,
    modelos: [],
    quantidadeEnviada: 0,
    chamadasShopee: 0,
    pausadoAte: null,
    ...extra,
  };
}

/* -------------------------------------------------------------------------- */
/*                            the delayed re-enqueue                           */
/* -------------------------------------------------------------------------- */

/**
 * Re-enqueue THIS task, held until `ate`, with one more `reenfileiramentos`.
 *
 * ⚠️ A delayed re-enqueue does NOT consume a queue attempt, which is the whole
 * reason a pause is expressed this way rather than by sleeping (there is no
 * timer in this folder) or by throwing (which spends one of the three attempts
 * on waiting and dead-letters the task long before a six-hour pause expires).
 *
 * ⚠️ The options object is built ONLY when there is a delay — `scheduleDelaySeconds`
 * is OMITTED, never passed as `undefined`. "No delay" and "a delay of undefined"
 * are not the same request to Cloud Tasks.
 *
 * Answers `false` when the tasks valve is closed, which the caller turns into a
 * named discard rather than a failure.
 */
async function reenfileirarComAtraso(
  payload: PayloadDeEnvio,
  deps: EnvioEstoqueDeps,
  ate: number,
): Promise<boolean> {
  const jitter = deps.jitterSec ?? (() => 0);
  const espera = Math.max(0, Math.ceil((ate - deps.nowMs) / MS_POR_SEGUNDO));
  const atraso = espera + jitter(PAUSE_REENQUEUE_JITTER_MAX_S);
  try {
    await deps.scheduler.enqueue(
      { ...payload, reenfileiramentos: payload.reenfileiramentos + 1 },
      { scheduleDelaySeconds: atraso },
    );
  } catch (err) {
    if (err instanceof ShopeeStockTasksDisabledError) return false;
    throw err;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/*                                 attribution                                 */
/* -------------------------------------------------------------------------- */

/** What one envelope (happy path or partial payload) said about each model. */
interface Atribuicao {
  readonly linhas: readonly LinhaDeModeloEnviada[];
  readonly enviados: number;
  readonly recusados: number;
  readonly semResposta: number;
  readonly quantidadeEnviada: number;
  /** The FIRST refused model's `failed_reason`, VERBATIM. Never a join. */
  readonly primeiraRecusa: { readonly codigo: string; readonly motivo: MotivoEstoqueShopee } | null;
}

/** What a clamp did to one model, when the floor path ran. */
interface ClampDoModelo {
  /** The reserved floor this model carried, or `null` for "no floor at all". */
  readonly piso: number | null;
  readonly clampado: boolean;
  /** The quantity the payload asked for, before the floor raised it. */
  readonly solicitada: number;
}

/**
 * Attribution by `model_id`, through a `Map`.
 *
 * ⚠️ **Never by position.** Shopee is free to reorder either list and to answer
 * about a subset; a positional read produces a result that is wrong in a way no
 * assertion on counts can see.
 *
 * ⚠️ `model_id: 0` is a legitimate key — `Map.has(0)` is the question, never
 * `if (modelId)`.
 *
 * ⚠️ BOTH lists are read even when the envelope's `error` was empty. The probe
 * measured a bogus model beside a valid one answering HTTP 200 with `error: ''`
 * and BOTH lists populated: the absence of a thrown error is not the absence of
 * a refusal.
 *
 * ⚠️ `success_list[].stock` is NOT the authority. What is recorded is what we
 * SENT — step 11 measured a stale echo on this provider, and "what Shopee says
 * it stored" is a claim, while "what we asked for" is a fact.
 */
function atribuirPorModelo(
  payload: PayloadDeEnvio,
  envelope: ShopeeUpdateStock,
  clamps: ReadonlyMap<number, ClampDoModelo> | null,
): Atribuicao {
  const aceitos = new Set<number>();
  for (const linha of envelope.success_list) aceitos.add(linha.model_id);
  const recusas = new Map<number, string>();
  for (const linha of envelope.failure_list) {
    recusas.set(linha.model_id, linha.failed_reason ?? '');
  }

  const linhas: LinhaDeModeloEnviada[] = [];
  let enviados = 0;
  let recusados = 0;
  let semResposta = 0;
  let quantidadeEnviada = 0;
  let primeiraRecusa: Atribuicao['primeiraRecusa'] = null;

  for (const m of payload.modelos) {
    const clamp = clamps?.get(m.modelId) ?? null;
    const solicitada = clamp?.solicitada ?? m.quantidade;
    const clampado = clamp?.clampado === true;
    const piso = clamp?.piso ?? null;

    if (recusas.has(m.modelId)) {
      const texto = recusas.get(m.modelId) ?? '';
      const motivo = motivoDoModeloRecusado(texto);
      recusados += 1;
      if (primeiraRecusa === null) primeiraRecusa = { codigo: texto, motivo };
      linhas.push({
        modelId: m.modelId,
        produtoId: m.produtoId,
        varLinkDocId: m.varLinkDocId,
        quantidadeSolicitada: solicitada,
        quantidadeEnviada: null,
        resultado: RESULTADO_MODELO.recusado,
        motivo,
        codigo: texto,
        mensagem: MENSAGEM_POR_MOTIVO[motivo],
        clampado,
        piso,
      });
      continue;
    }

    if (aceitos.has(m.modelId)) {
      enviados += 1;
      quantidadeEnviada += m.quantidade;
      const motivo = clampado ? MOTIVO_ESTOQUE_SHOPEE.clampadoNaReserva : null;
      linhas.push({
        modelId: m.modelId,
        produtoId: m.produtoId,
        varLinkDocId: m.varLinkDocId,
        quantidadeSolicitada: solicitada,
        quantidadeEnviada: m.quantidade,
        resultado: RESULTADO_MODELO.enviado,
        motivo,
        codigo: null,
        mensagem: motivo === null ? '' : MENSAGEM_POR_MOTIVO[motivo],
        clampado,
        piso,
      });
      continue;
    }

    // In NEITHER list: Shopee answered about this call but said nothing about
    // this model. Counted and legible, never recorded as a refusal — there is
    // no diagnosis to record and arming the skip set on silence would stop the
    // retry that fixes it.
    semResposta += 1;
    linhas.push({
      modelId: m.modelId,
      produtoId: m.produtoId,
      varLinkDocId: m.varLinkDocId,
      quantidadeSolicitada: solicitada,
      quantidadeEnviada: null,
      resultado: RESULTADO_MODELO.semResposta,
      motivo: MOTIVO_ESTOQUE_SHOPEE.modeloSemResposta,
      codigo: null,
      mensagem: MENSAGEM_POR_MOTIVO[MOTIVO_ESTOQUE_SHOPEE.modeloSemResposta],
      clampado,
      piso,
    });
  }

  return { linhas, enviados, recusados, semResposta, quantidadeEnviada, primeiraRecusa };
}

/* -------------------------------------------------------------------------- */
/*                                the write-backs                              */
/* -------------------------------------------------------------------------- */

/**
 * A terminal refusal of the whole listing: the diagnosis plus BOTH fingerprint
 * halves, so the gate can skip this listing until one of the two readings moves.
 *
 * `ate` is supplied ONLY by the promotion arm — the one refusal no future
 * reading can lift, because a promotion ending moves no `item_status`.
 */
async function recusarAnuncio(
  ctx: Contexto,
  motivo: MotivoEstoqueShopee,
  codigo: string,
  ate?: number,
): Promise<ResultadoEnvioEstoqueShopee> {
  const impressao = await lerImpressaoDoAnuncio(ctx.db, ctx.payload);
  await registrarRecusaDeEstoque(ctx.db, ctx.alvo, {
    nowMs: ctx.deps.nowMs,
    motivo,
    codigo,
    mensagem: MENSAGEM_POR_MOTIVO[motivo],
    estadoAnuncio: impressao.estadoAnuncio,
    itemStatus: impressao.itemStatus,
    ate,
  });
  return resultado(OUTCOME_ENVIO_ESTOQUE.erroRegistrado, {
    motivo,
    codigo,
    chamadasShopee: ctx.chamadas.n,
  });
}

/**
 * Arm what the CONTA is blocked by, and drop this task.
 *
 * ⚠️ No listing write. A conta-wide block is not a property of this listing, and
 * recording it as one would arm a fingerprint that the next `item_status` change
 * silently clears — a guard that rejects the wrong thing and then stops
 * rejecting at the wrong time. The conta's own document is where an operator
 * looks, and `pausaCodigo` carries Shopee's spelling verbatim.
 */
async function pausarConta(
  ctx: Contexto,
  ate: number,
  motivoDaPausa: MotivoDePausa,
  motivo: MotivoEstoqueShopee,
  codigo: string | null,
): Promise<ResultadoEnvioEstoqueShopee> {
  await armarPausa(ctx.db, ctx.payload.integracaoId, {
    ate,
    motivo: motivoDaPausa,
    codigo,
    pauseCountAtual: ctx.estado.pauseCount,
  });
  return resultado(OUTCOME_ENVIO_ESTOQUE.descartado, {
    motivo,
    codigo,
    chamadasShopee: ctx.chamadas.n,
    pausadoAte: ate,
  });
}

/**
 * The write-backs for an envelope that was read: clean, or partial.
 *
 * ⚠️ CLEAN means every model of the payload was ACCEPTED — no refusal, no
 * silence. `registrarEnvioLimpo` is the module's only clearer, and calling it on
 * anything less wipes the fingerprint of a refusal that is still live.
 */
async function gravarEnvelope(
  ctx: Contexto,
  a: Atribuicao,
  clampou: boolean,
): Promise<ResultadoEnvioEstoqueShopee> {
  const nowMs = ctx.deps.nowMs;

  if (a.recusados === 0 && a.semResposta === 0) {
    await registrarEnvioLimpo(ctx.db, ctx.alvo, {
      nowMs,
      quantidade: a.quantidadeEnviada,
      modelos: a.enviados,
    });

    if (clampou) {
      // Do NOT resolve: a send that still needed the floor is evidence the
      // clamp is STILL happening, not that it stopped.
      return resultado(OUTCOME_ENVIO_ESTOQUE.enviado, {
        motivo: MOTIVO_ESTOQUE_SHOPEE.clampadoNaReserva,
        modelos: a.linhas,
        quantidadeEnviada: a.quantidadeEnviada,
        chamadasShopee: ctx.chamadas.n,
      });
    }

    // ⚠️ The ONE thing that ever closes an `estoqueAcimaDoDisponivel` row.
    // There is no sweep for this tipo: an unresolved row stands until the
    // 90-day retention sweep on a collection with no dismiss button, so a
    // clean unclamped send MUST run it. One call per DISTINCT produto of the
    // task, because the aviso is keyed on the MODEL's produto.
    //
    // ⚠️ Deliberately NOT wrapped: it runs after the listing's own write has
    // landed, so a failure here loses nothing and the queue's retry re-drives a
    // send that is idempotent at Shopee (payload-verbatim).
    const deps = depsDeAviso(ctx.deps);
    for (const produtoId of new Set(a.linhas.map((l) => l.produtoId))) {
      await resolverEstoqueAcimaDoDisponivel(
        ctx.db,
        { integracaoId: ctx.payload.integracaoId, produtoId },
        deps,
      );
    }

    return resultado(OUTCOME_ENVIO_ESTOQUE.enviado, {
      modelos: a.linhas,
      quantidadeEnviada: a.quantidadeEnviada,
      chamadasShopee: ctx.chamadas.n,
    });
  }

  // A PARTIAL. `registrarEnvioParcial` deliberately does NOT stamp
  // `estoqueEnviadoEm` — the child rows' visibility is anchored on it.
  const primeira = a.primeiraRecusa;
  const codigo = primeira?.codigo ?? codigoDoErp(MOTIVO_ESTOQUE_SHOPEE.modeloSemResposta);
  const motivoDaMensagem = primeira?.motivo ?? MOTIVO_ESTOQUE_SHOPEE.modeloSemResposta;
  await registrarEnvioParcial(ctx.db, ctx.alvo, {
    nowMs,
    quantidade: a.quantidadeEnviada,
    modelos: a.enviados,
    codigo,
    mensagem: MENSAGEM_POR_MOTIVO[motivoDaMensagem],
  });

  for (const linha of a.linhas) {
    if (linha.resultado !== RESULTADO_MODELO.recusado) continue;
    if (linha.varLinkDocId === null) continue;
    await registrarRecusaDeModelo(
      ctx.db,
      {
        integracaoId: ctx.payload.integracaoId,
        produtoId: linha.produtoId,
        varLinkDocId: linha.varLinkDocId,
      },
      { nowMs, codigo: linha.codigo ?? '' },
    );
  }

  return resultado(OUTCOME_ENVIO_ESTOQUE.enviadoParcial, {
    motivo: MOTIVO_ESTOQUE_SHOPEE.envioParcial,
    codigo,
    modelos: a.linhas,
    quantidadeEnviada: a.quantidadeEnviada,
    chamadasShopee: ctx.chamadas.n,
  });
}

/* -------------------------------------------------------------------------- */
/*                                the floor path                               */
/* -------------------------------------------------------------------------- */

/**
 * Arm A, LAZILY: read the promotions, raise every model to its reserved floor,
 * and try the SAME call once more with the FULL clamped list.
 *
 * ⚠️ ONE `get_item_promotion` and ONE retry. There is no loop here and no
 * second read: a second arm-A refusal after a clamp means the floor we computed
 * is not the floor Shopee is enforcing, and repeating the pair would learn the
 * same nothing again.
 *
 * ⚠️ An EMPTY floor map is the TERMINAL case, not a clamp to zero — the module
 * learned nothing, so there is nothing to retry with.
 *
 * ⚠️ The category band is NOT consulted. No band travels in the payload in v1,
 * so `piso-acima-da-banda` cannot fire and is deliberately unreachable from
 * here; a genuinely over-band send lands in arm K as evidence, which is the
 * signal that would justify carrying the band.
 *
 * ⚠️ The full clamped list is re-sent, including models that did not move.
 * The probe measured that a partial `stock_list` leaves omitted models
 * untouched, so sending everything is safe whether Shopee refuses per model or
 * per envelope — and it is the only shape that works if the refusal was about
 * the envelope.
 */
async function caminhoDoPiso(
  ctx: Contexto,
  codigoOriginal: string,
): Promise<ResultadoEnvioEstoqueShopee> {
  let promocoes;
  try {
    ctx.chamadas.n += 1;
    promocoes = await ctx.client.getItemPromotion({ itemIds: [ctx.payload.itemId] });
  } catch (err) {
    // A throttle or a dead token during the floor read is a transport
    // condition, not a verdict about this listing: hand it back to the ladder's
    // own arms by rethrowing, and let the queue re-drive the whole task.
    if (err instanceof ShopeeRateLimitError) throw err;
    if (err instanceof ShopeeReauthRequiredError) throw err;
    if (err instanceof ShopeeApiError) {
      return recusarAnuncio(ctx, MOTIVO_ESTOQUE_SHOPEE.pisoDeReservaNaoAtendido, codigoOriginal);
    }
    throw err;
  }

  const pisos = pisoPorModelo(promocoes, ctx.payload.itemId);
  if (pisos.size === 0) {
    return recusarAnuncio(ctx, MOTIVO_ESTOQUE_SHOPEE.pisoDeReservaNaoAtendido, codigoOriginal);
  }

  const clamps = new Map<number, ClampDoModelo>();
  const lista: { model_id: number; seller_stock: { stock: number }[] }[] = [];
  const quantidades = new Map<number, number>();
  let algumMoveu = false;
  for (const m of ctx.payload.modelos) {
    // ⚠️ `pisos.get(id) ?? null`, never `|| null`: model_id 0 is a legitimate
    // key and a floor of 0 is a real answer, not an absence.
    const piso = pisos.get(m.modelId) ?? null;
    const aplicado = aplicarPiso(m.quantidade, piso);
    clamps.set(m.modelId, {
      piso,
      clampado: aplicado.clampado,
      solicitada: m.quantidade,
    });
    quantidades.set(m.modelId, aplicado.valor);
    if (aplicado.clampado) algumMoveu = true;
    lista.push({ model_id: m.modelId, seller_stock: [{ stock: aplicado.valor }] });
  }

  if (!algumMoveu) {
    // The floor exists and changes nothing, so the retry would be byte-identical
    // to the call that was just refused. Terminal without spending it.
    return recusarAnuncio(ctx, MOTIVO_ESTOQUE_SHOPEE.pisoDeReservaNaoAtendido, codigoOriginal);
  }

  let envelope;
  try {
    ctx.chamadas.n += 1;
    const resposta = await ctx.client.updateStock({
      item_id: ctx.payload.itemId,
      stock_list: lista,
    });
    envelope = resposta.response;
  } catch (err) {
    // The ladder itself rethrows anything that is not one of the package's
    // classes; narrowing here as well is what keeps this `catch` from being a
    // generic one, and it says the same thing in one fewer hop.
    if (!(err instanceof ShopeeError)) throw err;
    return tratarErroDoEnvio(err, ctx, true);
  }

  // The payload's own quantities are what get RECORDED, so the clamped values
  // have to travel with them: a row must say what was sent, not what was asked.
  const clampado: PayloadDeEnvio = {
    ...ctx.payload,
    modelos: ctx.payload.modelos.map((m) => ({
      ...m,
      quantidade: quantidades.get(m.modelId) ?? m.quantidade,
    })),
  };
  const a = atribuirPorModelo(clampado, envelope, clamps);

  await avisarDoClamp(ctx, a, clamps);
  return gravarEnvelope(ctx, a, true);
}

/**
 * ONE aviso per task, for the WIDEST gap the clamp had to bridge.
 *
 * ⚠️ Numbers and ids only: `entidade` is the model's own produto (what the
 * operator restocks and what `urlInterna` links to), `reservado` is the floor
 * and `disponivel` is what the ERP held BEFORE the clamp raised it. Never a
 * listing title and never a promotion body.
 *
 * One row per task rather than one per model, because the operator's action is
 * the same for all of them and N rows for one listing is noise the inbox never
 * recovers from.
 */
async function avisarDoClamp(
  ctx: Contexto,
  a: Atribuicao,
  clamps: ReadonlyMap<number, ClampDoModelo>,
): Promise<void> {
  let escolhido: { produtoId: string; piso: number; disponivel: number; folga: number } | null =
    null;
  for (const linha of a.linhas) {
    if (!linha.clampado) continue;
    const clamp = clamps.get(linha.modelId);
    if (clamp === undefined || clamp.piso === null) continue;
    const folga = clamp.piso - clamp.solicitada;
    if (escolhido !== null && folga <= escolhido.folga) continue;
    escolhido = {
      produtoId: linha.produtoId,
      piso: clamp.piso,
      disponivel: clamp.solicitada,
      folga,
    };
  }
  if (escolhido === null) return;

  await avisarEstoqueAcimaDoDisponivel(
    ctx.db,
    {
      integracaoId: ctx.payload.integracaoId,
      produtoId: escolhido.produtoId,
      itemId: ctx.payload.itemId,
      piso: escolhido.piso,
      disponivel: escolhido.disponivel,
    },
    depsDeAviso(ctx.deps),
  );
}

/* -------------------------------------------------------------------------- */
/*                                  the ladder                                 */
/* -------------------------------------------------------------------------- */

/**
 * Every failure of an `update_stock`, in the ONE narrowing order all four
 * classes require.
 *
 * `pisoJaTentado` is what makes the floor path non-recursive: the retry inside
 * `caminhoDoPiso` re-enters here with it set, so a second arm-A refusal is
 * terminal by construction rather than by a counter somebody has to keep.
 */
async function tratarErroDoEnvio(
  err: unknown,
  ctx: Contexto,
  pisoJaTentado: boolean,
): Promise<ResultadoEnvioEstoqueShopee> {
  const nowMs = ctx.deps.nowMs;

  // ---- the rate limits, both flavours ----
  if (err instanceof ShopeeRateLimitError) {
    if (err.kind === SHOPEE_ERROR_KIND.burst) {
      const segundos = err.retryAfterSeconds ?? ratePauseMin() * 60;
      const ate = nowMs + segundos * MS_POR_SEGUNDO;
      await armarPausa(ctx.db, ctx.payload.integracaoId, {
        ate,
        motivo: MOTIVOS_DE_PAUSA.burst,
        codigo: err.code,
        pauseCountAtual: ctx.estado.pauseCount,
      });
      const agendado = await reenfileirarComAtraso(ctx.payload, ctx.deps, ate);
      if (!agendado) {
        return resultado(OUTCOME_ENVIO_ESTOQUE.descartado, {
          motivo: MOTIVO_ESTOQUE_SHOPEE.tasksDesabilitadas,
          codigo: err.code,
          chamadasShopee: ctx.chamadas.n,
          pausadoAte: ate,
        });
      }
      return resultado(OUTCOME_ENVIO_ESTOQUE.pausadoReenfileirado, {
        codigo: err.code,
        chamadasShopee: ctx.chamadas.n,
        pausadoAte: ate,
      });
    }

    // Daily. `retryAfterSeconds` is deliberately NOT consulted: the quota
    // resets at a fixed wall-clock instant and a proxy's `Retry-After` says
    // less than the documented reset does.
    const ate = proximaViradaDaCotaMs(nowMs);
    return pausarConta(
      ctx,
      ate,
      MOTIVOS_DE_PAUSA.cotaDiaria,
      MOTIVO_ESTOQUE_SHOPEE.cotaDiaria,
      err.code,
    );
  }

  // ---- the token is dead: a CONTA fact, and SUCCESS to the queue ----
  if (err instanceof ShopeeReauthRequiredError) {
    await registrarErroDaConta(ctx.db, ctx.payload.integracaoId, err.message, nowMs);
    return resultado(OUTCOME_ENVIO_ESTOQUE.erroRegistrado, {
      motivo: MOTIVO_ESTOQUE_SHOPEE.reauth,
      codigo: err.code,
      chamadasShopee: ctx.chamadas.n,
    });
  }

  // ---- arm I: the documented coexisting-error partial ----
  if (err instanceof ShopeeApiPartialError) {
    // ⚠️ RE-PARSED, never cast: `parsed` is `unknown` on purpose and a cast here
    // is the exact shape `no-unvalidated-response` exists to ban.
    const relido = shopeeUpdateStockSchema.safeParse(err.parsed);
    if (relido.success) {
      const a = atribuirPorModelo(ctx.payload, relido.data.response, null);
      return gravarEnvelope(ctx, a, false);
    }
    // A partial whose payload does not re-parse tells us nothing per model;
    // it is exactly as unrecognised as an unknown code.
    console.error(TAG_LOG, {
      evento: 'parcial-ilegivel',
      integracaoId: ctx.payload.integracaoId,
      linkDocId: ctx.payload.linkDocId,
      campos: validationPaths(relido.error.issues),
    });
    return recusarAnuncio(ctx, MOTIVO_ESTOQUE_SHOPEE.recusaDesconhecida, err.code);
  }

  // ---- the lettered arms ----
  if (err instanceof ShopeeApiError) {
    const codigo = err.code;
    const c = classificarCodigoDeEstoque(codigo, err.message, err.kind);

    switch (c.arm) {
      case 'piso':
        if (pisoJaTentado) {
          return recusarAnuncio(ctx, MOTIVO_ESTOQUE_SHOPEE.pisoDeReservaNaoAtendido, codigo);
        }
        return caminhoDoPiso(ctx, codigo);

      case 'ferias': {
        const ate = await instanteDoFimDasFerias(ctx, nowMs);
        return pausarConta(
          ctx,
          ate,
          MOTIVOS_DE_PAUSA.lojaEmFerias,
          MOTIVO_ESTOQUE_SHOPEE.lojaEmFerias,
          codigo,
        );
      }

      case 'local':
        return pausarConta(
          ctx,
          nowMs + pausaLojaH(),
          MOTIVOS_DE_PAUSA.lojaBloqueada,
          MOTIVO_ESTOQUE_SHOPEE.multiArmazem,
          codigo,
        );

      case 'forma-de-loja':
        return pausarConta(
          ctx,
          nowMs + pausaLojaH(),
          MOTIVOS_DE_PAUSA.lojaBloqueada,
          c.motivo,
          codigo,
        );

      case 'promocao':
        // A TIME skip, not a state skip: a promotion ending moves no
        // `item_status`, so a fingerprint-only skip would latch for ever.
        return recusarAnuncio(
          ctx,
          MOTIVO_ESTOQUE_SHOPEE.bloqueadoPorPromocao,
          codigo,
          nowMs + promocaoRetryMin() * MS_POR_MINUTO,
        );

      case 'terminal':
        return recusarAnuncio(ctx, c.motivo, codigo);

      case 'transitorio':
        // The queue's own ladder owns this one. Nothing is written: a retry
        // that succeeds must not leave a refusal behind it.
        throw err;

      case 'desconhecida':
        // ⚠️ Recorded and NEVER retried. An unrecognised code that retries is
        // three identical calls and a dead-letter, with the same non-answer.
        console.error(TAG_LOG, {
          evento: 'recusa-desconhecida',
          integracaoId: ctx.payload.integracaoId,
          linkDocId: ctx.payload.linkDocId,
          itemId: ctx.payload.itemId,
          codigo,
        });
        return recusarAnuncio(ctx, MOTIVO_ESTOQUE_SHOPEE.recusaDesconhecida, codigo);
    }
  }

  // `ShopeeHttpError`, `ShopeeNetworkError`, `ShopeeSchemaError`,
  // `ShopeeConfigError` (a CALLER bug — never contained) and anything else.
  throw err;
}

/**
 * Arm G's one read: when does the holiday end?
 *
 * ⚠️ `holiday_mode_end_time` is SECONDS, like every Shopee timestamp, and
 * everything in this app is milliseconds.
 *
 * ⚠️ Any failure of the read — a refusal, a shop that reports no end time, a
 * time already in the past — falls back to the fixed pause. Rethrowing would
 * turn a pause into a retry of a call the shop structurally cannot accept.
 *
 * ⚠️ `pausaFeriasH()` is ALREADY MILLISECONDS. Multiplying it again turns a
 * six-hour pause into several years, and the conta simply never sends.
 */
async function instanteDoFimDasFerias(ctx: Contexto, nowMs: number): Promise<number> {
  const fallback = nowMs + pausaFeriasH();
  try {
    ctx.chamadas.n += 1;
    const modo = await ctx.client.getShopHolidayMode();
    const fim = modo.holiday_mode_end_time;
    if (typeof fim !== 'number') return fallback;
    const emMs = fim * MS_POR_SEGUNDO;
    return emMs > nowMs ? emMs : fallback;
  } catch (err) {
    // ⚠️ Narrow on the package's OWN base class — every transport, HTTP, schema
    // and API failure of this read means the same thing here: "we could not
    // learn when the holiday ends", and the fixed pause is the answer. The one
    // exclusion is `ShopeeConfigError`, which is a CALLER bug (a malformed
    // request we built) and must never be contained as a provider condition.
    if (err instanceof ShopeeError && !(err instanceof ShopeeConfigError)) return fallback;
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/*                                the entry point                              */
/* -------------------------------------------------------------------------- */

/**
 * Process ONE stock-send task. Resolving is SUCCESS to the queue in every case
 * the ladder names; only a rethrow asks for a retry.
 */
export async function processShopeeStockSendTask(
  db: Firestore,
  rawPayload: unknown,
  deps: EnvioEstoqueDeps,
): Promise<ResultadoEnvioEstoqueShopee> {
  // ---- 0. the payload ----
  const lido = shopeeStockSendTaskSchema.safeParse(rawPayload);
  if (!lido.success) {
    // ⚠️ PATHS and codes only. The body of a stock task names produtos and a
    // conta, and a log line is a second copy free to outlive the first.
    console.warn(TAG_LOG, {
      outcome: OUTCOME_ENVIO_ESTOQUE.descartado,
      motivo: MOTIVO_ESTOQUE_SHOPEE.payloadInvalido,
      campos: validationPaths(lido.error.issues),
    });
    return resultado(OUTCOME_ENVIO_ESTOQUE.descartado, {
      motivo: MOTIVO_ESTOQUE_SHOPEE.payloadInvalido,
    });
  }
  const payload = lido.data;

  // ---- 0.5 the master valve, ABOVE the pause gate: zero reads when off ----
  if (deps.ignoreSyncFlag !== true && !isShopeeStockSyncEnabled()) {
    const r = resultado(OUTCOME_ENVIO_ESTOQUE.pulado, {
      motivo: MOTIVO_ESTOQUE_SHOPEE.syncDesabilitado,
    });
    console.warn(TAG_LOG, linhaDeLog(payload, deps, r));
    return r;
  }

  const alvo: AlvoDoLink = {
    integracaoId: payload.integracaoId,
    produtoId: payload.produtoId,
    linkDocId: payload.linkDocId,
  };
  const chamadas: Contador = { n: 0 };

  // ---- 1. the chunker's cut, BEFORE any context load ----
  if (payload.modelos.length > MAX_MODELOS_POR_TASK) {
    const codigo = codigoDoErp(MOTIVO_ESTOQUE_SHOPEE.taskExcedeLimite);
    const impressao = await lerImpressaoDoAnuncio(db, payload);
    await registrarRecusaDeEstoque(db, alvo, {
      nowMs: deps.nowMs,
      motivo: MOTIVO_ESTOQUE_SHOPEE.taskExcedeLimite,
      codigo,
      mensagem: MENSAGEM_POR_MOTIVO[MOTIVO_ESTOQUE_SHOPEE.taskExcedeLimite],
      estadoAnuncio: impressao.estadoAnuncio,
      itemStatus: impressao.itemStatus,
    });
    const r = resultado(OUTCOME_ENVIO_ESTOQUE.erroRegistrado, {
      motivo: MOTIVO_ESTOQUE_SHOPEE.taskExcedeLimite,
      codigo,
    });
    console.warn(TAG_LOG, linhaDeLog(payload, deps, r));
    return r;
  }

  // ---- 2. the pause gate: ONE state-doc read ----
  const estado = await lerEstadoEstoque(db, payload.integracaoId);
  if (estaPausada(estado, deps.nowMs)) {
    const ate = estado.pausadoAte ?? deps.nowMs;
    if (payload.reenfileiramentos >= maxPauseReenqueues()) {
      const r = resultado(OUTCOME_ENVIO_ESTOQUE.descartado, {
        motivo: MOTIVO_ESTOQUE_SHOPEE.pausaReenqueuesEsgotados,
        pausadoAte: ate,
      });
      console.warn(TAG_LOG, linhaDeLog(payload, deps, r));
      return r;
    }
    // ⚠️ No client is built on this path — that is the rung's whole point, and
    // it is why the re-enqueue takes the payload rather than the context.
    const agendado = await reenfileirarComAtraso(payload, deps, ate);
    const r = agendado
      ? resultado(OUTCOME_ENVIO_ESTOQUE.pausadoReenfileirado, {
          motivo: MOTIVO_ESTOQUE_SHOPEE.contaPausada,
          pausadoAte: ate,
        })
      : resultado(OUTCOME_ENVIO_ESTOQUE.descartado, {
          motivo: MOTIVO_ESTOQUE_SHOPEE.tasksDesabilitadas,
          pausadoAte: ate,
        });
    console.warn(TAG_LOG, linhaDeLog(payload, deps, r));
    return r;
  }

  // ---- 3. the client ----
  const client = await clienteDeEstoque(db, payload.integracaoId, deps);
  const ctx: Contexto = { db, payload, deps, alvo, estado, client, chamadas };

  // ---- 4. ONE update_stock. No `location_id` key: this channel's contas are
  // single-warehouse by the conta gate, and a location on one entry and not on
  // another is a structure error Shopee makes sticky. ----
  let r: ResultadoEnvioEstoqueShopee;
  try {
    chamadas.n += 1;
    const resposta = await client.updateStock({
      item_id: payload.itemId,
      stock_list: payload.modelos.map((m) => ({
        model_id: m.modelId,
        seller_stock: [{ stock: m.quantidade }],
      })),
    });
    const a = atribuirPorModelo(payload, resposta.response, null);
    r = await gravarEnvelope(ctx, a, false);
  } catch (err) {
    // Same narrow as the floor path's: every failure `update_stock` can produce
    // descends from the package's own base class, and anything that does not is
    // a bug in our own code, which must never be filed as a provider refusal.
    if (!(err instanceof ShopeeError)) throw err;
    r = await tratarErroDoEnvio(err, ctx, false);
  }

  // eslint-disable-next-line no-console -- expected on every healthy task; a warn nobody can act on is what hides the real ones
  console.info(TAG_LOG, linhaDeLog(payload, deps, r));
  return r;
}

/**
 * The ONE log line per task.
 *
 * ⚠️ Ids, counts and slugs — never a body, never a token, never a produto name.
 * `ageMs` is the payload's age and is the whole diagnostic for a quantity this
 * handler deliberately never refreshes.
 */
function linhaDeLog(
  payload: PayloadDeEnvio,
  deps: EnvioEstoqueDeps,
  r: ResultadoEnvioEstoqueShopee,
): Record<string, unknown> {
  return {
    integracaoId: payload.integracaoId,
    produtoId: payload.produtoId,
    linkDocId: payload.linkDocId,
    itemId: payload.itemId,
    sweepId: payload.sweepId,
    parte: payload.parte,
    totalDePartes: payload.totalDePartes,
    modelos: payload.modelos.length,
    ageMs: deps.nowMs - payload.sweepComputadoEmMs,
    tentativa: deps.retryCount ?? 0,
    reenfileiramentos: payload.reenfileiramentos,
    outcome: r.outcome,
    motivo: r.motivo,
    codigo: r.codigo,
    quantidadeEnviada: r.quantidadeEnviada,
    chamadasShopee: r.chamadasShopee,
    pausadoAte: r.pausadoAte,
  };
}
