import { z } from 'zod';
import { ID_LOTE_FEED_AMAZON_REGEX } from './feedAmazon';
import type { produtoAmazonLinkSchema } from './produto/collection/amazonLink';
import type { estoqueProdutoSchema } from './produto/collection/estoque';
import { docIdSchema } from './shared/outerRef';
import { type TimestampLike, ttlExpiry } from './shared/ttl';

/**
 * The documents of the Amazon stock sync (step 12), and the numbers that pick
 * how a stock batch leaves the ERP. Every collection here is Admin-only.
 *
 * ## `sincronizacaoEstoqueAmazon/{contaId}` — the tick's state
 *
 * The 5-minute delta tick reads the window of `estoques` stamps at the conta's
 * depósito since its cursor. Per conta: the cursor (`cursorMs`) and the
 * depósito it was taken at (`depositoDoCursor`: a cursor means nothing at
 * another depósito, whose earlier stamps sit below it), the tick's own
 * single-flight lease (`vez`), when it last finished, its consecutive failures,
 * and `semDeposito`, the flag the `estoque-sem-deposito` aviso is raised and
 * resolved on (only on its TRANSITION, so a steady state makes no aviso call).
 *
 * ## `reconciliacaoEstoqueAmazon/{contaId}` — the daily reconcile run
 *
 * One run per conta at a time, held by (`execucaoId`, `proximaPagina`): a page
 * re-derives that pair from a fresh read before it walks, and only the page
 * holding the run advances `progressoEmMs`. The walk reads the conta's link docs one ref form
 * at a time (`cursores`), and the depósito it read (`depositoOuterRef`) is
 * pinned for every send the run makes. `relogioInicio` is the run's FIRST
 * read's `readTime`: every aviso the run raises or resolves is clocked by it.
 *
 * ## `pedidoReconciliacaoEstoqueAmazon/{contaId}` — a request for a run
 *
 * Apart from the run, so writing a request never invalidates a page's
 * precondition on the run's document. `reexecucaoAutomaticaEmMs` is the guard
 * of the automatic request a failed feed makes: at most one per conta per day.
 *
 * ## `reconciliacaoEstoqueAmazon/{contaId}/divergenciasEstoqueAmazon/{execucaoId}-{n}`
 *
 * One block per walked page `n`: the drift that page found (≤ 300 SKUs), with
 * the depósito the walk read. Overwritten by a retried page (its content comes
 * from live reads), read by id, never queried. `expiraEm` is its TTL stamp,
 * REQUIRED, so a block written without one fails its parse instead of living
 * forever. The TTL policy on `divergenciasEstoqueAmazon` is a `TTL_POLICIES`
 * row plus its `fieldOverrides` entry, declared with the block's writer.
 *
 * ## Units
 *
 * Every instant stored as a number is MILLISECONDS since epoch, a strict
 * non-negative safe integer (never the tolerant `millisSinceEpoch()`, whose
 * coercion would turn a hand-edited value into a different instant): the
 * values these are compared with (`estoques.ultimaModificacao`, the feed core's
 * stamps) are all ms. The two instants that are not numbers are `relogioInicio`,
 * a Firestore `Timestamp`, and `expiraEm`, the TTL stamp (`./shared/ttl`).
 *
 * ## The depósito refs are stored CANONICAL
 *
 * `depositoDoCursor` and both `depositoOuterRef` fields hold
 * `documents/depositos/<id>` only, whatever form the conta's own field holds:
 * the writer normalises before storing, and a reader compares after
 * normalising the conta's value the same way. One stored form, so the stored
 * side of every comparison is exact.
 *
 * ## Admin-only / default-deny
 *
 * NOT registered in `ALL_DOMAINS` and no Meta, so the rules generator emits no
 * match block and no client can read any of them. Unknown keys are STRIPPED.
 * Bare schemas, never a `{ schema, meta }` export (`registry.test.ts`); the
 * Admin handles in `@delfrance/data/admin/collections` spell the paths.
 */

/** A non-negative SAFE integer: what every compared number here is. */
function inteiroSeguro() {
  return z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
}

/* -------------------------------------------------------------------------- */
/*                              The batch numbers                             */
/* -------------------------------------------------------------------------- */

/**
 * THE SWITCH: the largest stock batch sent as per-SKU patches. A batch of 1 to
 * 30 distinct SKUs goes as one `patchListingsItem` task per SKU; 31 or more as
 * one `JSON_LISTINGS_FEED`. It counts the batch's members as its producer sees
 * them, before any live read, so a batch never moves between forms. Amazon
 * recommends the feed above about 1,500 items per 5 minutes; this repo switches
 * far below that on purpose (fewer patch calls, at the price of a feed's
 * latency).
 *
 * ⚠️ NOT {@link LIMIAR_ZERO_SEM_LINHA_ESTOQUE_AMAZON}: that one is a
 * catalogue-scale floor, and a change to either must never move the other.
 */
export const LIMIAR_FEED_ESTOQUE_AMAZON = 30;

/**
 * The largest WINDOW batch (a delta feed: the SKUs a movement window maps to).
 * Above it the movement is catalogue-scale and goes to a reconcile run. It is
 * the tick's own window cap: 10 pages of 300 rows.
 */
export const MAX_SKUS_FEED_DELTA_ESTOQUE_AMAZON = 3_000;

/**
 * The reconcile's catalogue-scale floor: a run whose enviável SKUs publish 0
 * for lack of ANY estoque row at the depósito at least this many times (or for
 * more than half of them) sends nothing and raises `estoque-deposito-sem-linhas`
 * — a wrong or emptied depósito would otherwise zero the catalogue in one feed.
 *
 * ⚠️ Deliberately a DIFFERENT constant from {@link LIMIAR_FEED_ESTOQUE_AMAZON}:
 * the switch picks a batch's form, this refuses a send whose zeros look like a
 * depósito problem. A drift of 31 rowless zeros is an ordinary feed.
 */
export const LIMIAR_ZERO_SEM_LINHA_ESTOQUE_AMAZON = 1_500;

/** The most SKUs one drift block holds: one walk page reads at most this many link docs. */
export const MAX_ITENS_DIVERGENCIA_ESTOQUE_AMAZON = 300;

/* -------------------------------------------------------------------------- */
/*                               The index fields                             */
/* -------------------------------------------------------------------------- */

/**
 * The tick's window query, IN INDEX ORDER: a collection-group read of
 * `estoques` with `depositoOuterRef ==` one ref form and `ultimaModificacao`
 * bounded on both sides. Typed against the estoque schema's own keys, so a
 * renamed field breaks the build here. Pinned against `firestore.indexes.json`
 * (the collection-group entry, with the trailing `__name__` the query orders
 * by) by `estoqueAmazon.indexes.test.ts`.
 */
export const CAMPOS_INDICE_JANELA_ESTOQUE_AMAZON = [
  'depositoOuterRef',
  'ultimaModificacao',
] as const satisfies ReadonlyArray<keyof typeof estoqueProdutoSchema.shape>;

/**
 * The reconcile's walk, IN INDEX ORDER: a collection-group read of `prodAmazon`
 * with `contaAmazonOuterRef ==` one ref form, paged by document key. Typed
 * against the link schema's own keys. Pinned against `firestore.indexes.json`
 * (the collection-group entry, with the trailing `__name__` the walk orders by)
 * by `estoqueAmazon.indexes.test.ts`.
 */
export const CAMPOS_INDICE_VARREDURA_VINCULOS_AMAZON = [
  'contaAmazonOuterRef',
] as const satisfies ReadonlyArray<keyof typeof produtoAmazonLinkSchema.shape>;

/* -------------------------------------------------------------------------- */
/*                                  Grammars                                  */
/* -------------------------------------------------------------------------- */

/**
 * A depósito ref as these documents store it: CANONICAL only (module header),
 * its id in the feed core's id grammar ({@link ID_LOTE_FEED_AMAZON_REGEX}), the
 * same id a stock task payload's `depositoId` carries.
 */
export const REF_DEPOSITO_ESTOQUE_AMAZON_REGEX = /^documents\/depositos\/[A-Za-z0-9_-]{1,128}$/;

/**
 * A link doc's full path, the walk's key cursor: `produtos/<id>/prodAmazon/<id>`,
 * without the `documents/` prefix (the form a document key is read back in).
 */
export const CAMINHO_VINCULO_ESTOQUE_AMAZON_REGEX = /^produtos\/[^/]+\/prodAmazon\/[^/]+$/;

/**
 * A counter's key: a token, never free text — a per-SKU outcome motivo
 * (`pai-do-vinculo-ilegivel`) or a plain counter (`confirmadoPorGet`). The
 * closed vocabulary lives beside the walk that writes it.
 */
export const CHAVE_CONTAGEM_ESTOQUE_AMAZON_REGEX = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;

/** A depósito ref (module header). */
function refDeposito() {
  return z.string().regex(REF_DEPOSITO_ESTOQUE_AMAZON_REGEX);
}

/** A run id: the feed core's id grammar, so a run's id can also name a feed send. */
function idExecucao() {
  return z.string().regex(ID_LOTE_FEED_AMAZON_REGEX);
}

/**
 * A stored Firestore `Timestamp`, returned UNCHANGED: recognised EXACTLY as the
 * TTL field recognises one, minus the `Date` only a TTL writer stamps. Never a
 * number and never a `Date`: a clock taken from a `readTime` is compared on the
 * Firestore timeline it came from.
 */
function instanteFirestore() {
  const comoTtl = ttlExpiry();
  return z.custom<TimestampLike>(
    (valor) => !(valor instanceof Date) && comoTtl.safeParse(valor).success,
    {
      message: 'esperado um Timestamp do Firestore (um readTime), nunca um número ou uma Date',
    },
  );
}

/* -------------------------------------------------------------------------- */
/*                         sincronizacaoEstoqueAmazon                         */
/* -------------------------------------------------------------------------- */

/** The tick's single-flight lease: the run holding it and its expiry (ms). */
export const vezSincronizacaoEstoqueAmazonSchema = z.object({
  execucaoId: idExecucao(),
  /** ms — the lease's expiry; past it, another tick may take the lease. */
  ateMs: inteiroSeguro(),
});
export type VezSincronizacaoEstoqueAmazon = z.infer<typeof vezSincronizacaoEstoqueAmazonSchema>;

/** `sincronizacaoEstoqueAmazon/{contaId}` (module header). */
export const sincronizacaoEstoqueAmazonSchema = z.object({
  /**
   * ms — the window's cursor: advance-only at one depósito, and only past a
   * window that is durable; a depósito change, once durably handed off to a
   * reconcile, resets it together with `depositoDoCursor`. Null before the first tick.
   */
  cursorMs: inteiroSeguro().nullable().default(null),
  /** The depósito `cursorMs` was taken at, canonical; null before the first tick. */
  depositoDoCursor: refDeposito().nullable().default(null),
  /** The tick's lease; null = no tick holds it. */
  vez: vezSincronizacaoEstoqueAmazonSchema.nullable().default(null),
  /** ms — when a tick last finished for this conta. */
  ultimoTickMs: inteiroSeguro().nullable().default(null),
  /** Consecutive ticks of this conta that ended in a contained failure; 0 after a clean one. */
  falhasSeguidas: inteiroSeguro().default(0),
  /** The conta had no depósito at the last tick: the `estoque-sem-deposito` aviso's transition flag. */
  semDeposito: z.boolean().default(false),
});
export type SincronizacaoEstoqueAmazon = z.infer<typeof sincronizacaoEstoqueAmazonSchema>;

/* -------------------------------------------------------------------------- */
/*                         reconciliacaoEstoqueAmazon                         */
/* -------------------------------------------------------------------------- */

/**
 * The run's phase: `varrendo` (walking pages) → `decidindo` → `enviando` → one
 * end, `concluida` or `truncada` (a page gave up, or the depósito changed during
 * the walk: a truncated run resolves no aviso).
 */
export const faseReconciliacaoEstoqueAmazonSchema = z.enum([
  'varrendo',
  'decidindo',
  'enviando',
  'concluida',
  'truncada',
]);
export type FaseReconciliacaoEstoqueAmazon = z.infer<typeof faseReconciliacaoEstoqueAmazonSchema>;
export const FASE_RECONCILIACAO_ESTOQUE_AMAZON = {
  varrendo: 'varrendo',
  decidindo: 'decidindo',
  enviando: 'enviando',
  concluida: 'concluida',
  truncada: 'truncada',
} as const satisfies Record<string, FaseReconciliacaoEstoqueAmazon>;

/** Where the walk stands in ONE conta ref form. */
export const cursorVarreduraEstoqueAmazonSchema = z.object({
  /** The last link doc walked in this form (its full path); null = not started. */
  ultimoCaminho: z.string().regex(CAMINHO_VINCULO_ESTOQUE_AMAZON_REGEX).nullable().default(null),
  /** This form's walk reached its end. */
  concluida: z.boolean().default(false),
});
export type CursorVarreduraEstoqueAmazon = z.infer<typeof cursorVarreduraEstoqueAmazonSchema>;

/** A form's cursor before the walk reads it. A function: every parse gets its own object. */
function cursorInicial(): CursorVarreduraEstoqueAmazon {
  return { ultimoCaminho: null, concluida: false };
}

/**
 * The walk's cursor per conta ref form: `canonica` (`documents/integracao/<id>`)
 * and `nua` (`integracao/<id>`), walked one at a time, each with its own `==`.
 */
export const cursoresVarreduraEstoqueAmazonSchema = z.object({
  canonica: cursorVarreduraEstoqueAmazonSchema.default(cursorInicial),
  nua: cursorVarreduraEstoqueAmazonSchema.default(cursorInicial),
});
export type CursoresVarreduraEstoqueAmazon = z.infer<typeof cursoresVarreduraEstoqueAmazonSchema>;

/**
 * The run's counters, summed page by page. The named ones are what the decide
 * and close steps branch on; `porChave` holds every per-SKU outcome motivo and
 * plain counter of the walk, for the run's line.
 */
export const contagensReconciliacaoEstoqueAmazonSchema = z.object({
  /** Link docs the walk read. */
  vinculosLidos: inteiroSeguro().default(0),
  /** Distinct SKUs evaluated (each on the page of its smallest link-doc path). */
  skusAvaliados: inteiroSeguro().default(0),
  /** SKUs that passed the link verdict and the listing gate. */
  enviaveis: inteiroSeguro().default(0),
  /** The drift: enviável SKUs whose ERP and Amazon quantities differ. */
  divergencias: inteiroSeguro().default(0),
  /** Enviável SKUs whose ERP 0 comes from NO estoque row at the depósito. */
  zeroSemLinha: inteiroSeguro().default(0),
  /** Link refusals a person must fix (the `estoque-vinculos-recusados` aviso). */
  recusasHumanas: inteiroSeguro().default(0),
  /** Links whose stored stock outcome is `recusado` AND whose SKU is still in drift. */
  recusadosEmDivergencia: inteiroSeguro().default(0),
  /** Every other count, keyed by its token. */
  porChave: z
    .record(z.string().regex(CHAVE_CONTAGEM_ESTOQUE_AMAZON_REGEX), inteiroSeguro())
    .default(() => ({})),
});
export type ContagensReconciliacaoEstoqueAmazon = z.infer<
  typeof contagensReconciliacaoEstoqueAmazonSchema
>;

/** The counters of a run that has walked nothing. A function: every parse gets its own object. */
function contagensZeradas(): ContagensReconciliacaoEstoqueAmazon {
  return {
    vinculosLidos: 0,
    skusAvaliados: 0,
    enviaveis: 0,
    divergencias: 0,
    zeroSemLinha: 0,
    recusasHumanas: 0,
    recusadosEmDivergencia: 0,
    porChave: {},
  };
}

/** `reconciliacaoEstoqueAmazon/{contaId}` (module header). */
export const reconciliacaoEstoqueAmazonSchema = z.object({
  /** The run: with `proximaPagina`, the pair a page re-derives before it walks. */
  execucaoId: idExecucao(),
  fase: faseReconciliacaoEstoqueAmazonSchema,
  /** The depósito the walk read, canonical: every send of this run is pinned to it. */
  depositoOuterRef: refDeposito(),
  cursores: cursoresVarreduraEstoqueAmazonSchema.default(() => ({
    canonica: cursorInicial(),
    nua: cursorInicial(),
  })),
  /** The page the run walks next. */
  proximaPagina: inteiroSeguro().default(0),
  /** Pages walked so far: at decide, the run's drift-block count. */
  paginas: inteiroSeguro().default(0),
  contagens: contagensReconciliacaoEstoqueAmazonSchema.default(contagensZeradas),
  /** ms — advanced ONLY by the page holding the run; null before the first page. */
  progressoEmMs: inteiroSeguro().nullable().default(null),
  /** The first page's `readTime`: the clock of every aviso the run raises or resolves. */
  relogioInicio: instanteFirestore().nullable().default(null),
  /** ms. */
  iniciadaEmMs: inteiroSeguro(),
  /** ms — when the run reached `concluida` or `truncada`; null before. */
  concluidaEmMs: inteiroSeguro().nullable().default(null),
});
export type ReconciliacaoEstoqueAmazon = z.infer<typeof reconciliacaoEstoqueAmazonSchema>;

/* -------------------------------------------------------------------------- */
/*                      pedidoReconciliacaoEstoqueAmazon                      */
/* -------------------------------------------------------------------------- */

/** `pedidoReconciliacaoEstoqueAmazon/{contaId}` (module header). */
export const pedidoReconciliacaoEstoqueAmazonSchema = z.object({
  /** A run was requested and no run has claimed the request yet. */
  pendente: z.boolean().default(false),
  /** ms — the latest request. */
  pedidoEmMs: inteiroSeguro().nullable().default(null),
  /** ms — the latest AUTOMATIC request: the once-a-day guard reads it. */
  reexecucaoAutomaticaEmMs: inteiroSeguro().nullable().default(null),
});
export type PedidoReconciliacaoEstoqueAmazon = z.infer<
  typeof pedidoReconciliacaoEstoqueAmazonSchema
>;

/* -------------------------------------------------------------------------- */
/*                          divergenciasEstoqueAmazon                         */
/* -------------------------------------------------------------------------- */

/** One drifted SKU of a walk page. */
export const itemDivergenciaEstoqueAmazonSchema = z.object({
  /**
   * The SKU as its link doc stores it: tolerant here (the link schema's own
   * grammar), because a block write that refused a SKU would stop the whole
   * walk; the feed builder checks each SKU it sends.
   */
  sku: z.string().min(1),
  /** The produto whose stock the SKU publishes. */
  unidadeId: docIdSchema,
  /** Amazon's live quantity; null = the listing carried none (it counts as different). */
  quantidadeAmazon: inteiroSeguro().nullable(),
  /** The quantity the ERP publishes for the SKU (never negative). */
  quantidadeErp: inteiroSeguro(),
});
export type ItemDivergenciaEstoqueAmazon = z.infer<typeof itemDivergenciaEstoqueAmazonSchema>;

/** `reconciliacaoEstoqueAmazon/{contaId}/divergenciasEstoqueAmazon/{execucaoId}-{n}` (module header). */
export const divergenciaEstoqueAmazonSchema = z.object({
  execucaoId: idExecucao(),
  /** The depósito the walk read, canonical (a send checks the conta still has it). */
  depositoOuterRef: refDeposito(),
  itens: z.array(itemDivergenciaEstoqueAmazonSchema).max(MAX_ITENS_DIVERGENCIA_ESTOQUE_AMAZON),
  /**
   * TTL stamp, REQUIRED: a real `Date` on write — a numeric epoch is refused,
   * because a TTL policy silently ignores one (module header).
   */
  expiraEm: ttlExpiry(),
});
export type DivergenciaEstoqueAmazon = z.infer<typeof divergenciaEstoqueAmazonSchema>;

/**
 * A drift block's doc id, `<execucaoId>-<n>`: the ONE spelling the page that
 * writes block `n` and the send that reads blocks `0…partes−1` share. `n` is a
 * page number, so the id splits at its LAST `-`.
 *
 * @throws {RangeError} a run id outside its grammar, or a page that is not a
 *   non-negative safe integer (the message names the rule, never the value).
 */
export function idDivergenciaEstoqueAmazon(execucaoId: string, pagina: number): string {
  if (!ID_LOTE_FEED_AMAZON_REGEX.test(execucaoId)) {
    throw new RangeError('estoqueAmazon.ts: execucaoId fora de ID_LOTE_FEED_AMAZON_REGEX');
  }
  if (!Number.isSafeInteger(pagina) || pagina < 0) {
    throw new RangeError('estoqueAmazon.ts: pagina deve ser um inteiro seguro não negativo');
  }
  return `${execucaoId}-${String(pagina)}`;
}
