/**
 * The NF-e upload's task contract (step 14, PR 14-b): the payload of the
 * `processAmazonNfeUpload` queue, its ladders and bounds, and the FIVE pure
 * builders that are the only way a payload is ever made. Unwired here: the
 * trigger, the queue and the handler that enqueue and read it arrive in 14-c.
 *
 * ## What the payload carries — and what it deliberately does not
 *
 * `{ pedidoId, nfeId, fase, degrau, envioIncerto, reenvios, leituraAntes,
 * pausas }` and nothing else, every field REQUIRED. NO conta, NO order number,
 * NO access key and NO XML: the conta and the order are re-derived from the
 * FRESH pedido on every dispatch (its ownership proof, `pedidoNfe.ts`), and the
 * XML is read from the NF-e document. A Cloud Tasks payload is visible in the
 * console and in the dispatch logs.
 *
 * - `fase` — `envio` (a status-first read, then at most ONE submit) or
 *   `verificacao` (a read-only look at Amazon's verdict; it never submits).
 * - `degrau` — the rung of the verification ladder
 *   ({@link ESCADA_VERIFICACAO_NFE_AMAZON_S}), 0 … 9.
 * - `envioIncerto` — the submit before this chain may have landed without a
 *   confirmed 2xx (a 5xx, a timeout, a dropped connection, a 2xx off its
 *   schema), so a `sem-nota` may mean "never arrived" rather than "refused".
 * - `reenvios` — 0 or 1: how many automatic resubmits this chain already made.
 *   The chain's ONE resubmit is {@link reenvioNfeAmazon}'s, and every other
 *   builder COPIES the value, so no chain ever submits a third time.
 * - `leituraAntes` — the status reading the last submit was planned on
 *   (`sem-nota` or `recusada`), so a verification inside the read-after-write
 *   lag can tell the OLD rejection our submit followed from a new one.
 * - `pausas` — re-enqueues spent on a 429 (no queue attempt spent), 0 … 5.
 *
 * ## The copy rules (pinned by the builders' tests)
 *
 * - Only {@link tarefaInicialNfeAmazon} — the trigger and the re-drive route —
 *   mints `reenvios: 0`, `leituraAntes: null`, `pausas: 0` from nothing.
 * - Every chain builder COPIES `reenvios` from the incoming payload.
 * - {@link aposEnvioNfeAmazon} sets `leituraAntes` to the reading the submit
 *   was planned on (`null` when the dispatch did not submit).
 * - {@link reenvioNfeAmazon} is the ONLY builder that yields `reenvios: 1`.
 * - A rung or fase change resets `pausas` to 0; {@link pausaNfeAmazon} keeps
 *   everything else and adds 1.
 * - A builder answers `null` where its chain has no next step (the ladder's
 *   last rung, the pause bound, the resubmit already spent) and throws a
 *   `RangeError` only on a programming error (the wrong fase handed in, an id
 *   outside its grammar). No call site builds a payload literal.
 *
 * ⚠️ `.strict()`: this queue has exactly the producers this folder names (the
 * trigger, the re-drive route and the handler's own re-enqueues), so a payload
 * carrying anything more is a producer this module does not know.
 *
 * ⚠️ LIGHT on purpose: the NF-e trigger imports this module, and the trigger's
 * import closure is pinned file by file (`estrutura.test.ts`'s NF-e D11 guard,
 * type edges walked) to hold no SP-API value import and nothing of `pedidos/`
 * but `orderIds.ts` — so this file imports `zod` alone, and never the status
 * reader (whose reading names it re-exports from here, never the reverse).
 */
import { z } from 'zod';

/* ---------------------------------- the phase --------------------------------- */

/** Which half of the flow a task runs. A `verificacao` NEVER submits. */
export const faseNfeAmazonSchema = z.enum(['envio', 'verificacao']);

export type FaseNfeAmazon = z.infer<typeof faseNfeAmazonSchema>;

/** The closed set of {@link FaseNfeAmazon}, so code names a phase instead of spelling it. */
export const FASE_NFE_AMAZON = {
  envio: 'envio',
  verificacao: 'verificacao',
} as const satisfies Record<string, FaseNfeAmazon>;

/* ----------------------------- the planned-on reading ----------------------------- */

/**
 * The two status readings a submit is ever planned on — the `sem-nota` and
 * `recusada` of the status reader (`statusNfe.ts` takes its spellings from
 * HERE, so the two modules cannot drift apart).
 */
export const leituraAntesNfeAmazonSchema = z.enum(['sem-nota', 'recusada']);

export type LeituraAntesNfeAmazon = z.infer<typeof leituraAntesNfeAmazonSchema>;

export const LEITURA_ANTES_NFE_AMAZON = {
  semNota: 'sem-nota',
  recusada: 'recusada',
} as const satisfies Record<string, LeituraAntesNfeAmazon>;

/* ------------------------------- ladders and bounds ------------------------------- */

/**
 * The verification ladder: the delay, in SECONDS, before rung N's read. Σ
 * 85,680 s ≈ 23.8 h per submit — the "24 h" of the master plan is this RUNG
 * COUNT, not a wall clock (step-14 plan §3 decision 26).
 */
export const ESCADA_VERIFICACAO_NFE_AMAZON_S = [
  60, 120, 300, 600, 1800, 3600, 7200, 14400, 28800, 28800,
] as const;

/** The last rung (9): a `processando` there ends the chain with an aviso. */
export const ULTIMO_DEGRAU_NFE_AMAZON = ESCADA_VERIFICACAO_NFE_AMAZON_S.length - 1;

/**
 * The 429 pauses, in SECONDS, indexed by the incoming `pausas` (≈ 15.5 min in
 * all). At `pausas === PAUSAS_NFE_AMAZON_S.length` the bound is reached.
 */
export const PAUSAS_NFE_AMAZON_S = [30, 60, 120, 240, 480] as const;

/** The queue's attempts (`retryConfig.maxAttempts`, pinned in 14-c). */
export const TENTATIVAS_NFE_AMAZON = 4;

/** The queue (the name #1938 already uses). */
export const FILA_NFE_AMAZON = 'processAmazonNfeUpload';

/** At most this many automatic resubmits per chain. */
export const MAX_REENVIOS_NFE_AMAZON = 1;

/* --------------------------------- the payload -------------------------------- */

/** A pedido id: the Amazon importer's sha256 digest, lowercase hex. */
const PEDIDO_ID = /^[0-9a-f]{64}$/;

/**
 * A Firestore document id as an `nfev4` path segment carries it: no `/`, not
 * `.` or `..`, not `__…__`, 1 to 128 characters (apps/nfe writes `s<tpEmis>`;
 * a legacy auto id is 20).
 */
const NFE_ID = /^(?!\.\.?$)(?!__.*__$)[^/]{1,128}$/;

/** The Cloud Tasks body (module header). */
export const tarefaNfeAmazonSchema = z
  .object({
    pedidoId: z.string().regex(PEDIDO_ID),
    nfeId: z.string().regex(NFE_ID),
    fase: faseNfeAmazonSchema,
    degrau: z.number().int().min(0).max(ULTIMO_DEGRAU_NFE_AMAZON),
    envioIncerto: z.boolean(),
    reenvios: z.number().int().min(0).max(MAX_REENVIOS_NFE_AMAZON),
    leituraAntes: leituraAntesNfeAmazonSchema.nullable(),
    pausas: z.number().int().min(0).max(PAUSAS_NFE_AMAZON_S.length),
  })
  .strict();

export type TarefaNfeAmazon = z.infer<typeof tarefaNfeAmazonSchema>;

/* --------------------------------- the builders -------------------------------- */

function exigirFase(t: TarefaNfeAmazon, fase: FaseNfeAmazon, construtor: string): void {
  if (t.fase !== fase) {
    throw new RangeError(`tarefaNfe.ts: ${construtor} recebeu uma tarefa de outra fase`);
  }
}

/**
 * The FIRST payload of an upload: fase `envio`, rung 0, nothing spent. The
 * trigger's and the re-drive route's, and nobody else's.
 *
 * @throws {RangeError} an id outside its grammar (the message names the
 *   grammar, never the value).
 */
export function tarefaInicialNfeAmazon(pedidoId: string, nfeId: string): TarefaNfeAmazon {
  if (!PEDIDO_ID.test(pedidoId)) {
    throw new RangeError('tarefaNfe.ts: pedidoId fora da gramática (64 hex minúsculos)');
  }
  if (!NFE_ID.test(nfeId)) {
    throw new RangeError('tarefaNfe.ts: nfeId fora da gramática de id de documento');
  }
  return {
    pedidoId,
    nfeId,
    fase: FASE_NFE_AMAZON.envio,
    degrau: 0,
    envioIncerto: false,
    reenvios: 0,
    leituraAntes: null,
    pausas: 0,
  };
}

/**
 * The verification chain that follows an `envio` dispatch: rung 0, `reenvios`
 * COPIED, `leituraAntes` = the reading the submit was planned on (`null` when
 * the dispatch did not submit — an `envio` that read `processando`), and
 * `envioIncerto` as the submit's outcome left it.
 *
 * @throws {RangeError} a payload that is not in fase `envio`.
 */
export function aposEnvioNfeAmazon(
  t: TarefaNfeAmazon,
  leituraAntes: LeituraAntesNfeAmazon | null,
  envioIncerto: boolean,
): TarefaNfeAmazon {
  exigirFase(t, FASE_NFE_AMAZON.envio, 'aposEnvioNfeAmazon');
  return {
    pedidoId: t.pedidoId,
    nfeId: t.nfeId,
    fase: FASE_NFE_AMAZON.verificacao,
    degrau: 0,
    envioIncerto,
    reenvios: t.reenvios,
    leituraAntes,
    pausas: 0,
  };
}

/**
 * The next rung of a verification: `degrau + 1`, `pausas` reset, everything
 * else COPIED. `null` at the last rung — the ladder's end is the caller's.
 *
 * @throws {RangeError} a payload that is not in fase `verificacao`.
 */
export function proximoDegrauNfeAmazon(t: TarefaNfeAmazon): TarefaNfeAmazon | null {
  exigirFase(t, FASE_NFE_AMAZON.verificacao, 'proximoDegrauNfeAmazon');
  if (t.degrau >= ULTIMO_DEGRAU_NFE_AMAZON) return null;
  return { ...t, degrau: t.degrau + 1, pausas: 0 };
}

/**
 * The chain's ONE automatic resubmit: back to fase `envio` (a status-first read
 * runs again before it submits), `reenvios: 1`, rung 0, nothing else carried.
 * `null` when the chain already spent it: a second resubmit is never built.
 *
 * @throws {RangeError} a payload that is not in fase `verificacao`.
 */
export function reenvioNfeAmazon(t: TarefaNfeAmazon): TarefaNfeAmazon | null {
  exigirFase(t, FASE_NFE_AMAZON.verificacao, 'reenvioNfeAmazon');
  if (t.reenvios >= MAX_REENVIOS_NFE_AMAZON) return null;
  return {
    pedidoId: t.pedidoId,
    nfeId: t.nfeId,
    fase: FASE_NFE_AMAZON.envio,
    degrau: 0,
    envioIncerto: false,
    reenvios: 1,
    leituraAntes: null,
    pausas: 0,
  };
}

/**
 * The same dispatch again after a 429: `pausas + 1`, everything else KEPT (fase
 * and rung included). `null` at the pause bound — the caller's last-chance
 * rule answers it.
 */
export function pausaNfeAmazon(t: TarefaNfeAmazon): TarefaNfeAmazon | null {
  if (t.pausas >= PAUSAS_NFE_AMAZON_S.length) return null;
  return { ...t, pausas: t.pausas + 1 };
}
