/**
 * The JOBS-QUEUE contract (step 12a, PR 12-b; the reconcile page since step
 * 12, PR 12-f): the payload union of the four feed tasks and the stock
 * reconcile's page, and every task NAME they mint.
 *
 * ## The payloads: ids, closed tokens and numbers only
 *
 * Every payload is `.strict()` and versioned (`v: 1`), and every field is an
 * id under its grammar, a closed token or a ms number, so a payload is O(1)
 * whatever the batch's size and never carries a SKU list, a URL, a token or
 * Amazon's text (a Cloud Tasks body is visible in the console and the dispatch
 * logs). Every `feedId` passes the package's `FEED_ID_AMAZON_REGEX`.
 *
 *  - `feed-enviar` — build and submit one feed. Its `lote` is a union:
 *    - a BLOCK batch `{ tipo: 'blocos', execucaoIdRun, parteInicial, partes,
 *      esperaAteMs }`: a RANGE of one run's stored input parts — the run whose
 *      parts it reads (`execucaoIdRun`, never the batch's own `execucaoId`),
 *      the first part and how many, fixed by the producer (so a later run can
 *      never change what this send reads). `partes` is at most
 *      {@link MAX_PARTES_LOTE_BLOCOS_FEED_AMAZON}, so the stock provider's
 *      `on` document stays inside the package's limits (a dry-run one too,
 *      for SKUs of up to 400 bytes once JSON-encoded): a run with more parts
 *      is several batches, each its own lease holder
 *      ({@link execucaoIdDoLoteBlocosFeed}). `esperaAteMs` bounds how long a
 *      batch turned away by a held lease keeps re-enqueuing itself;
 *    - a WINDOW batch `{ tipo: 'janela', desdeMs, ateMs, manterDesdeMs,
 *      commitAposMs, forcarPorCommit, esperaAteMs, depositoId }`: the bounded
 *      movement window `(desdeMs, ateMs]` and its keep rule WHOLE; the provider
 *      re-derives the members from it at send, under the very rule its
 *      producer kept rows by. `forcarPorCommit` marks a recovery-born batch
 *      that forces (its forcing cannot be folded into a bare start, so it
 *      waits, up to `esperaAteMs`); a tick-born batch carries the tick's commit
 *      filter, `forcarPorCommit: false`, and no `esperaAteMs` (a recovery's
 *      with no snapshot carries `forcarPorCommit: false` and no `esperaAteMs`
 *      too, keeping by stamp alone). Refused when
 *      `desdeMs ≥ ateMs`, when both keep fields are `null`, when it forces with
 *      no commit filter, or unless `esperaAteMs` is set exactly when
 *      `forcarPorCommit` is true.
 *  - `feed-resultado` — one poll rung, a notification wake-up or an adoption:
 *    `contaId` is `null` only for a wake-up (the notification names a seller,
 *    not a conta); `rodada` is the rung's index.
 *  - `feed-incerto` — the wait after a `createFeed` whose answer was lost.
 *  - `feed-recuperar` — what a feed's end (or a lease release that found
 *    turned-away batches pending: `vez`) leaves to recover. A `vez` recovery
 *    has no feed outcome: its `snapshotEmMs` and `janela` are `null` and its
 *    `pendenteDesdeMs` is REQUIRED; any other outcome carries the feed's
 *    snapshot. `janela` is the recovered feed's own window (a window batch),
 *    its keep rule whole, `forcarPorCommit` included.
 *  - `reconciliacao` (step 12, PR 12-f) — ONE page of a stock reconcile run:
 *    the conta, the run (`execucaoId`) and the page number. The page re-derives
 *    from the run's document whether it is the page the run walks next, so a
 *    duplicate dispatch does nothing.
 *
 * ## The names: every one carries the conta
 *
 * A `feedId` is unique only per seller, so every name of a feed task hashes the
 * conta in (the notification's, which has no conta, hashes the seller). Each is
 * `sha256Hex` of a prefixed, `:`-joined preimage whose fields cannot hold `:`
 * (two exceptions, both unambiguous: the `vez:` reference prefix adds a field,
 * and a seller id may hold `:` but is followed only by the digits-only
 * `feedId`), so two preimages never coincide:
 *
 *  - {@link nomeConsultaFeed} — one per (conta, feed, rung); an adoption names
 *    its rung `adocao` (or `adocao:<date>`);
 *  - {@link nomeNotificacaoFeed} — (seller or `-`, feed): a redelivered
 *    notification dedupes;
 *  - {@link nomeIncertoFeed}, {@link nomeEnvioFeed} — (conta, the send run);
 *  - {@link nomeRecuperacaoFeed} — (conta, the feed or run it recovers, the
 *    pending start it folded): a retried tail that read the SAME start
 *    dedupes, one that read another start enqueues one more recovery instead
 *    of meeting the first one's tombstone. A payload's reference is
 *    {@link referenciaDaRecuperacaoFeed} (a `vez` recovery's is prefixed);
 *  - {@link nomePaginaReconciliacao} — (conta, run, page): every enqueue of
 *    one page of one run is one task; {@link nomeRetomadaReconciliacao} —
 *    (conta, run, page, the stalled run's last progress stamp): the re-kick of
 *    a run that lost its next task, one per stall.
 *
 * A window batch's own `execucaoId` is minted from its PRODUCER's identity:
 * a tick's from its window ({@link execucaoIdDaJanelaFeed}: the same window
 * twice is one batch), a recovery's from the recovery itself
 * ({@link execucaoIdDaRecuperacaoFeed}: never from its `ateMs`, so a retried
 * recovery that re-derives a later `ateMs` meets its own first batch's name
 * instead of minting a twin the first would turn away). A block batch's from
 * its run and its index in the run's partition
 * ({@link execucaoIdDoLoteBlocosFeed}: batch `k` of run `R`): two batches of
 * one run are two lease holders — one id would read the second batch as the
 * first one's own retry — and a decide run again names each batch as before.
 */
import { sha256Hex } from '@delfrance/data/admin';
import { FEED_ID_AMAZON_REGEX } from '@delfrance/integrations-amazon-sp-api';
import {
  CONTA_ID_AMAZON_REGEX,
  DESFECHO_FEED_AMAZON,
  ID_LOTE_FEED_AMAZON_REGEX,
  ORIGEM_LOTE_FEED_AMAZON_REGEX,
  TIPO_LOTE_FEED_AMAZON,
  camposJanelaFeedAmazon,
  desfechoFeedAmazonSchema,
  fluxoFeedAmazonSchema,
  sellingPartnerIdValido,
  verificarJanelaFeedAmazon,
} from '@delfrance/schemas';
import { z } from 'zod';

/* ---------------------------------- grammars ---------------------------------- */

/** A non-negative SAFE integer: `String(n)` is plain digits, never an exponent. */
function inteiroSeguro() {
  return z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
}

const contaIdSchema = () => z.string().regex(CONTA_ID_AMAZON_REGEX);
const feedIdSchema = () => z.string().regex(FEED_ID_AMAZON_REGEX);
const execucaoIdSchema = () => z.string().regex(ID_LOTE_FEED_AMAZON_REGEX);
const origemLoteSchema = () => z.string().regex(ORIGEM_LOTE_FEED_AMAZON_REGEX);

/** The payload version every task carries. */
export const VERSAO_TAREFA_LOTE_AMAZON = 1;

/* ---------------------------------- the tipos --------------------------------- */

export const tipoTarefaLoteAmazonSchema = z.enum([
  'feed-enviar',
  'feed-resultado',
  'feed-incerto',
  'feed-recuperar',
  'reconciliacao',
]);
export type TipoTarefaLoteAmazon = z.infer<typeof tipoTarefaLoteAmazonSchema>;
export const TIPO_TAREFA_LOTE_AMAZON = {
  enviar: 'feed-enviar',
  resultado: 'feed-resultado',
  incerto: 'feed-incerto',
  recuperar: 'feed-recuperar',
  reconciliacao: 'reconciliacao',
} as const satisfies Record<string, TipoTarefaLoteAmazon>;

/** Who enqueued a result rung: the ladder, a notification wake-up, or an adoption. */
export const origemResultadoFeedAmazonSchema = z.enum(['notificacao', 'consulta', 'adocao']);
export type OrigemResultadoFeedAmazon = z.infer<typeof origemResultadoFeedAmazonSchema>;
export const ORIGEM_RESULTADO_FEED_AMAZON = {
  notificacao: 'notificacao',
  consulta: 'consulta',
  adocao: 'adocao',
} as const satisfies Record<string, OrigemResultadoFeedAmazon>;

/** A recovery's outcome: a feed's, or `vez` (a release that found batches pending). */
export const desfechoRecuperacaoFeedAmazonSchema = z.enum([
  ...desfechoFeedAmazonSchema.options,
  'vez',
]);
export type DesfechoRecuperacaoFeedAmazon = z.infer<typeof desfechoRecuperacaoFeedAmazonSchema>;
export const DESFECHO_RECUPERACAO_FEED_AMAZON = {
  ...DESFECHO_FEED_AMAZON,
  vez: 'vez',
} as const satisfies Record<string, DesfechoRecuperacaoFeedAmazon>;

/* ---------------------------------- the batch --------------------------------- */

/**
 * The most stored input parts ONE block batch reads (module header): a drift
 * block holds at most `MAX_ITENS_DIVERGENCIA_ESTOQUE_AMAZON` (300) SKUs, one
 * message each, and the package refuses a WHOLE document of more than
 * `MAX_MENSAGENS_FEED` (25,000) messages or `MAX_BYTES_FEED` (9,500,000)
 * minified UTF-8 bytes — every valid entry with it, and a batch rebuilt the
 * same way the next day is refused again.
 *
 * Derived for an upper bound of the worst document the stock provider can
 * build: 50 full blocks are 15,000 messages (60% of the message cap); each
 * message at most 393 bytes plus its comma — a SKU of 40 code points
 * (`alvoValido`'s bound on a member a submitted feed carries) of 4-byte
 * characters, the longest JSON rendering of a non-negative number
 * (`Number.MAX_VALUE`, 23 characters: the shared core floors the quantity and
 * clamps it at 0 but sets no ceiling, and the package's stock builder sends
 * only a safe integer, which renders shorter), a five-digit
 * `messageId` — and the header with a 64-character seller id of escaped
 * characters: 5,899,099 bytes (62% of the byte cap). The tightest cap is 80
 * blocks (bytes bind first: 81 worst-case blocks exceed 9.5 MB); 50 keeps the
 * headroom, which also covers a dry-run document (built from every member, an
 * invalid SKU included) whose SKUs hold up to 400 bytes each once JSON-encoded.
 * Derived for the stock provider's message: a fluxo whose message is larger
 * needs its own bound. Pinned through the package's own builder by
 * `estoque/provedorLoteEstoque.test.ts`.
 */
export const MAX_PARTES_LOTE_BLOCOS_FEED_AMAZON = 50;

/**
 * The most MESSAGES one price block batch carries (step 13, PR 13-c;
 * provisional): a price batch packs consecutive parts while their items stay
 * within this AND their count within {@link MAX_PARTES_LOTE_BLOCOS_FEED_AMAZON}.
 * Derived for the worst price message, larger than the stock one (three
 * prices, the selectors and the listing's own `productType` of 64
 * characters): 9,000 worst-case messages and the report header build
 * 6,236,161 bytes (66% of the package's byte cap). The tightest cap is 13,704
 * such messages (bytes bind first), so 50 FULL parts (15,000 messages) would
 * be refused; 9,000 also covers a dry-run document whose SKUs hold up to 400
 * bytes once JSON-encoded. Pinned through the package's own builder by
 * `preco/limitesLotePreco.test.ts`. It sits here, beside the block cap, so the
 * feed core never imports the price modules.
 */
export const MAX_MENSAGENS_LOTE_PRECO_AMAZON = 9_000;

/** A block batch (module header): a range of one run's stored input parts. */
export const loteBlocosFeedAmazonSchema = z
  .object({
    tipo: z.literal(TIPO_LOTE_FEED_AMAZON.blocos),
    /** The run whose parts the batch reads — never the batch's own `execucaoId`. */
    execucaoIdRun: execucaoIdSchema(),
    /** The first part read. */
    parteInicial: inteiroSeguro(),
    /** How many parts the provider reads from `parteInicial`: 1 to the cap. */
    partes: z.number().int().min(1).max(MAX_PARTES_LOTE_BLOCOS_FEED_AMAZON),
    /** ms — a turned-away block batch re-enqueues itself until then. */
    esperaAteMs: inteiroSeguro(),
  })
  .strict()
  .superRefine((lote, ctx) => {
    // The last part's number must be a safe integer: a part id spells it in digits.
    // Compared by a subtraction, which is exact here (a sum past the safe
    // integers rounds, and can round back onto one).
    if (lote.partes - 1 > Number.MAX_SAFE_INTEGER - lote.parteInicial) {
      ctx.addIssue({
        code: 'custom',
        message: 'a última parte não é um inteiro seguro',
        path: ['parteInicial'],
      });
    }
  });
export type LoteBlocosFeedAmazon = z.infer<typeof loteBlocosFeedAmazonSchema>;

/** A window batch (module header). */
export const loteJanelaFeedAmazonSchema = z
  .object({
    tipo: z.literal(TIPO_LOTE_FEED_AMAZON.janela),
    ...camposJanelaFeedAmazon(),
    /**
     * ms — set exactly when the batch forces (`forcarPorCommit`: a recovery's,
     * with a snapshot), which waits behind a held lease until then; null for a
     * batch that does not force (the tick's, or a recovery's with no snapshot).
     */
    esperaAteMs: inteiroSeguro().nullable(),
  })
  .strict()
  .superRefine((lote, ctx) => {
    verificarJanelaFeedAmazon(lote, ctx);
    if (lote.forcarPorCommit !== (lote.esperaAteMs !== null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'esperaAteMs é definido exatamente quando forcarPorCommit é true',
        path: ['esperaAteMs'],
      });
    }
  });
export type LoteJanelaFeedAmazon = z.infer<typeof loteJanelaFeedAmazonSchema>;

export const loteFeedAmazonSchema = z.discriminatedUnion('tipo', [
  loteBlocosFeedAmazonSchema,
  loteJanelaFeedAmazonSchema,
]);
export type LoteFeedAmazon = z.infer<typeof loteFeedAmazonSchema>;

/* --------------------------------- the payloads ------------------------------- */

/** `feed-enviar` (module header). */
export const tarefaEnviarFeedAmazonSchema = z
  .object({
    v: z.literal(VERSAO_TAREFA_LOTE_AMAZON),
    tipo: z.literal(TIPO_TAREFA_LOTE_AMAZON.enviar),
    fluxo: fluxoFeedAmazonSchema,
    contaId: contaIdSchema(),
    execucaoId: execucaoIdSchema(),
    /** The producer's label: opaque to the core, for the lines and the record. */
    origem: origemLoteSchema(),
    lote: loteFeedAmazonSchema,
  })
  .strict();
export type TarefaEnviarFeedAmazon = z.infer<typeof tarefaEnviarFeedAmazonSchema>;

/** `feed-resultado` (module header). */
export const tarefaResultadoFeedAmazonSchema = z
  .object({
    v: z.literal(VERSAO_TAREFA_LOTE_AMAZON),
    tipo: z.literal(TIPO_TAREFA_LOTE_AMAZON.resultado),
    /** null only for a notification wake-up. */
    contaId: contaIdSchema().nullable(),
    feedId: feedIdSchema(),
    rodada: inteiroSeguro(),
    origem: origemResultadoFeedAmazonSchema,
  })
  .strict();
export type TarefaResultadoFeedAmazon = z.infer<typeof tarefaResultadoFeedAmazonSchema>;

/** `feed-incerto` (module header). */
export const tarefaIncertoFeedAmazonSchema = z
  .object({
    v: z.literal(VERSAO_TAREFA_LOTE_AMAZON),
    tipo: z.literal(TIPO_TAREFA_LOTE_AMAZON.incerto),
    fluxo: fluxoFeedAmazonSchema,
    contaId: contaIdSchema(),
    execucaoId: execucaoIdSchema(),
  })
  .strict();
export type TarefaIncertoFeedAmazon = z.infer<typeof tarefaIncertoFeedAmazonSchema>;

/** The recovered feed's own window, as a recovery carries it. */
const janelaRecuperadaSchema = z
  .object(camposJanelaFeedAmazon())
  .strict()
  .superRefine(verificarJanelaFeedAmazon);

/** `feed-recuperar` (module header). */
export const tarefaRecuperarFeedAmazonSchema = z
  .object({
    v: z.literal(VERSAO_TAREFA_LOTE_AMAZON),
    tipo: z.literal(TIPO_TAREFA_LOTE_AMAZON.recuperar),
    fluxo: fluxoFeedAmazonSchema,
    contaId: contaIdSchema(),
    desfecho: desfechoRecuperacaoFeedAmazonSchema,
    /** The feed recovered; null when there is none (a lost `createFeed` answer, or a `vez`). */
    feedId: feedIdSchema().nullable(),
    execucaoId: execucaoIdSchema(),
    /** ms — the feed's snapshot; null exactly for `vez`. */
    snapshotEmMs: inteiroSeguro().nullable(),
    /** ms — the earliest start of the turned-away batches this recovery folds; required for `vez`. */
    pendenteDesdeMs: inteiroSeguro().nullable(),
    janela: janelaRecuperadaSchema.nullable(),
  })
  .strict()
  .superRefine((t, ctx) => {
    const vez = t.desfecho === DESFECHO_RECUPERACAO_FEED_AMAZON.vez;
    if (vez !== (t.snapshotEmMs === null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'snapshotEmMs é null exatamente quando o desfecho é vez',
        path: ['snapshotEmMs'],
      });
    }
    if (vez && t.janela !== null) {
      ctx.addIssue({
        code: 'custom',
        message: 'uma recuperação vez não carrega janela',
        path: ['janela'],
      });
    }
    if (vez && t.pendenteDesdeMs === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'uma recuperação vez exige pendenteDesdeMs',
        path: ['pendenteDesdeMs'],
      });
    }
  });
export type TarefaRecuperarFeedAmazon = z.infer<typeof tarefaRecuperarFeedAmazonSchema>;

/** `reconciliacao` (module header): one page of one stock reconcile run. */
export const tarefaPaginaReconciliacaoAmazonSchema = z
  .object({
    v: z.literal(VERSAO_TAREFA_LOTE_AMAZON),
    tipo: z.literal(TIPO_TAREFA_LOTE_AMAZON.reconciliacao),
    contaId: contaIdSchema(),
    execucaoId: execucaoIdSchema(),
    pagina: inteiroSeguro(),
  })
  .strict();
export type TarefaPaginaReconciliacaoAmazon = z.infer<typeof tarefaPaginaReconciliacaoAmazonSchema>;

/** Every jobs-queue payload: the feed core's four tasks and the reconcile page. */
export const tarefaLoteAmazonSchema = z.discriminatedUnion('tipo', [
  tarefaEnviarFeedAmazonSchema,
  tarefaResultadoFeedAmazonSchema,
  tarefaIncertoFeedAmazonSchema,
  tarefaRecuperarFeedAmazonSchema,
  tarefaPaginaReconciliacaoAmazonSchema,
]);
export type TarefaLoteAmazon = z.infer<typeof tarefaLoteAmazonSchema>;

/* ---------------------------------- the names --------------------------------- */

/** An id under its grammar, or a `RangeError` naming the grammar (never the value). */
function exigir(regex: RegExp, valor: string, nome: string): string {
  if (typeof valor !== 'string' || !regex.test(valor)) {
    throw new RangeError(`tarefaLote.ts: ${nome} fora da gramática`);
  }
  return valor;
}

/** A ms instant under its grammar, or a `RangeError`. */
function exigirMs(valor: number, nome: string): number {
  if (!Number.isSafeInteger(valor) || valor < 0) {
    throw new RangeError(`tarefaLote.ts: ${nome} não é um instante em ms`);
  }
  return valor;
}

/** A pending start in a preimage: its digits, or `-` when there is none. */
function campoDoPendente(pendenteDesdeMs: number | null): string {
  return pendenteDesdeMs === null ? '-' : String(exigirMs(pendenteDesdeMs, 'pendenteDesdeMs'));
}

/** The prefix of a `vez` recovery's reference. */
const PREFIXO_VEZ = 'vez:';

/** An adoption rung: `adocao`, or `adocao:<YYYY-MM-DD>` (one a day). */
const RODADA_ADOCAO = /^adocao(?::[0-9]{4}-[0-9]{2}-[0-9]{2})?$/;

/** A rung as a name names it: its index, or an adoption's label. */
export type RodadaConsultaFeed = number | 'adocao' | `adocao:${string}`;

/**
 * A recovery's reference: the feed it recovers, or the run when there is no
 * feed; a `vez` recovery's is {@link referenciaVezFeed} of its releaser's.
 */
function exigirReferencia(referencia: string): string {
  const base = referencia.startsWith(PREFIXO_VEZ)
    ? referencia.slice(PREFIXO_VEZ.length)
    : referencia;
  exigir(ID_LOTE_FEED_AMAZON_REGEX, base, 'referencia');
  return referencia;
}

/** A poll rung's name: (conta, feed, rung). */
export function nomeConsultaFeed(
  contaId: string,
  feedId: string,
  rodada: RodadaConsultaFeed,
): string {
  exigir(CONTA_ID_AMAZON_REGEX, contaId, 'contaId');
  exigir(FEED_ID_AMAZON_REGEX, feedId, 'feedId');
  const campo =
    typeof rodada === 'number'
      ? String(exigirMs(rodada, 'rodada'))
      : exigir(RODADA_ADOCAO, rodada, 'rodada');
  return sha256Hex(`feed:consulta:${contaId}:${feedId}:${campo}`);
}

/** A notification wake-up's name: (seller, feed); `-` when the notification names no seller. */
export function nomeNotificacaoFeed(sellerId: string | null, feedId: string): string {
  if (sellerId !== null && !sellingPartnerIdValido(sellerId)) {
    throw new RangeError('tarefaLote.ts: sellerId fora da gramática');
  }
  exigir(FEED_ID_AMAZON_REGEX, feedId, 'feedId');
  return sha256Hex(`feed:notificacao:${sellerId ?? '-'}:${feedId}`);
}

/** The uncertain wait's name: (conta, the send run). */
export function nomeIncertoFeed(contaId: string, execucaoId: string): string {
  exigir(CONTA_ID_AMAZON_REGEX, contaId, 'contaId');
  exigir(ID_LOTE_FEED_AMAZON_REGEX, execucaoId, 'execucaoId');
  return sha256Hex(`feed:incerto:${contaId}:${execucaoId}`);
}

/** A send's name: (conta, the send run's `execucaoId`). */
export function nomeEnvioFeed(contaId: string, execucaoId: string): string {
  exigir(CONTA_ID_AMAZON_REGEX, contaId, 'contaId');
  exigir(ID_LOTE_FEED_AMAZON_REGEX, execucaoId, 'execucaoId');
  return sha256Hex(`feed:envio:${contaId}:${execucaoId}`);
}

/** A `vez` recovery's reference: its releaser's `feedId` or `execucaoId`, prefixed. */
export function referenciaVezFeed(referenciaDoLiberador: string): string {
  exigir(ID_LOTE_FEED_AMAZON_REGEX, referenciaDoLiberador, 'referencia');
  return `${PREFIXO_VEZ}${referenciaDoLiberador}`;
}

/**
 * The reference of a `feed-recuperar` payload, the ONE derivation its name,
 * its handler and a recovery-born batch's `execucaoId` share: the recovered
 * feed's `feedId`, else the send run's `execucaoId`; for a `vez` recovery, the
 * same releaser's reference through {@link referenciaVezFeed}, so a `vez`
 * recovery never shares an identity with the tail recovery of its releaser.
 */
export function referenciaDaRecuperacaoFeed(t: TarefaRecuperarFeedAmazon): string {
  const doLiberador = t.feedId ?? t.execucaoId;
  return t.desfecho === DESFECHO_RECUPERACAO_FEED_AMAZON.vez
    ? referenciaVezFeed(doLiberador)
    : exigir(ID_LOTE_FEED_AMAZON_REGEX, doLiberador, 'referencia');
}

/**
 * A recovery's name: (conta, the reference, the pending start it folded or
 * `-`). The reference is the recovered feed's `feedId`, else the send run's
 * `execucaoId`; for a `vez` recovery, {@link referenciaVezFeed}. A payload's
 * is {@link referenciaDaRecuperacaoFeed}.
 */
export function nomeRecuperacaoFeed(
  contaId: string,
  referencia: string,
  pendenteDesdeMs: number | null,
): string {
  exigir(CONTA_ID_AMAZON_REGEX, contaId, 'contaId');
  exigirReferencia(referencia);
  return sha256Hex(`feed:recuperacao:${contaId}:${referencia}:${campoDoPendente(pendenteDesdeMs)}`);
}

/** A TICK-born window batch's `execucaoId`: one per (conta, window). */
export function execucaoIdDaJanelaFeed(contaId: string, desdeMs: number, ateMs: number): string {
  exigir(CONTA_ID_AMAZON_REGEX, contaId, 'contaId');
  exigirMs(desdeMs, 'desdeMs');
  exigirMs(ateMs, 'ateMs');
  if (desdeMs >= ateMs) throw new RangeError('tarefaLote.ts: janela vazia ou invertida');
  return sha256Hex(`janela:${contaId}:${String(desdeMs)}:${String(ateMs)}`);
}

/**
 * A BLOCK batch's `execucaoId` (module header): batch `lote` (0-based) of the
 * run `execucaoIdRun`'s partition — one per (conta, run, batch), never the
 * run's own id, so every batch of one run is its own lease holder.
 */
export function execucaoIdDoLoteBlocosFeed(
  contaId: string,
  execucaoIdRun: string,
  lote: number,
): string {
  exigir(CONTA_ID_AMAZON_REGEX, contaId, 'contaId');
  exigir(ID_LOTE_FEED_AMAZON_REGEX, execucaoIdRun, 'execucaoIdRun');
  if (!Number.isSafeInteger(lote) || lote < 0) {
    throw new RangeError('tarefaLote.ts: lote deve ser um inteiro seguro não negativo');
  }
  return sha256Hex(`blocos:${contaId}:${execucaoIdRun}:${String(lote)}`);
}

/**
 * A RECOVERY-born window batch's `execucaoId`: the recovery's own identity, the
 * same inputs as {@link nomeRecuperacaoFeed} — never its window's bounds.
 */
export function execucaoIdDaRecuperacaoFeed(
  contaId: string,
  referencia: string,
  pendenteDesdeMs: number | null,
): string {
  exigir(CONTA_ID_AMAZON_REGEX, contaId, 'contaId');
  exigirReferencia(referencia);
  return sha256Hex(`recuperacao:${contaId}:${referencia}:${campoDoPendente(pendenteDesdeMs)}`);
}

/** A reconcile page's name: (conta, run, page). */
export function nomePaginaReconciliacao(
  contaId: string,
  execucaoId: string,
  pagina: number,
): string {
  exigir(CONTA_ID_AMAZON_REGEX, contaId, 'contaId');
  exigir(ID_LOTE_FEED_AMAZON_REGEX, execucaoId, 'execucaoId');
  return sha256Hex(`rec:${contaId}:${execucaoId}:${String(exigirMs(pagina, 'pagina'))}`);
}

/**
 * The re-kick of a stalled run (module header): (conta, run, the page it
 * walks next, the run's last progress stamp in ms). A run that stalls again
 * after progressing has a new stamp, so a new name; the same stall re-kicked
 * twice is one task.
 */
export function nomeRetomadaReconciliacao(
  contaId: string,
  execucaoId: string,
  pagina: number,
  marcoMs: number,
): string {
  exigir(CONTA_ID_AMAZON_REGEX, contaId, 'contaId');
  exigir(ID_LOTE_FEED_AMAZON_REGEX, execucaoId, 'execucaoId');
  return sha256Hex(
    `rec:${contaId}:${execucaoId}:${String(exigirMs(pagina, 'pagina'))}:retomada:${String(
      exigirMs(marcoMs, 'marcoMs'),
    )}`,
  );
}
