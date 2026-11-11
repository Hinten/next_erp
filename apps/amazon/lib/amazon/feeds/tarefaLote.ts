/**
 * The feed core's JOBS-QUEUE contract (step 12a, PR 12-b): the payload union
 * of the four feed tasks and every task NAME the core mints. Unwired in 12-b:
 * the producers and the dispatcher arrive in 12-c.
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
 *    - a BLOCK batch `{ tipo: 'blocos', partes, esperaAteMs }`: `partes` is how
 *      many stored input parts the provider reads, fixed by the producer (so a
 *      later run can never change what this send reads); `esperaAteMs` bounds
 *      how long a batch turned away by a held lease keeps re-enqueuing itself;
 *    - a WINDOW batch `{ tipo: 'janela', desdeMs, ateMs, manterDesdeMs,
 *      commitAposMs, esperaAteMs, depositoId }`: the bounded movement window
 *      `(desdeMs, ateMs]` and its keep rule; the provider re-derives the
 *      members from it at send. `commitAposMs` set marks a RECOVERY-born batch
 *      (its commit filter cannot be folded into a bare start, so it waits, up to
 *      `esperaAteMs`); a TICK-born one carries neither. Refused when
 *      `desdeMs ≥ ateMs`, when both keep fields are `null`, or when exactly
 *      one of `commitAposMs` and `esperaAteMs` is set.
 *  - `feed-resultado` — one poll rung, a notification wake-up or an adoption:
 *    `contaId` is `null` only for a wake-up (the notification names a seller,
 *    not a conta); `rodada` is the rung's index.
 *  - `feed-incerto` — the wait after a `createFeed` whose answer was lost.
 *  - `feed-recuperar` — what a feed's end (or a lease release that found
 *    turned-away batches pending: `vez`) leaves to recover. A `vez` recovery
 *    has no feed outcome: its `snapshotEmMs` and `janela` are `null` and its
 *    `pendenteDesdeMs` is REQUIRED; any other outcome carries the feed's
 *    snapshot. `janela` is the recovered feed's own window (a window batch).
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
 *    {@link referenciaDaRecuperacaoFeed} (a `vez` recovery's is prefixed).
 *
 * A window batch's own `execucaoId` is minted from its PRODUCER's identity:
 * a tick's from its window ({@link execucaoIdDaJanelaFeed}: the same window
 * twice is one batch), a recovery's from the recovery itself
 * ({@link execucaoIdDaRecuperacaoFeed}: never from its `ateMs`, so a retried
 * recovery that re-derives a later `ateMs` meets its own first batch's name
 * instead of minting a twin the first would turn away).
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
]);
export type TipoTarefaLoteAmazon = z.infer<typeof tipoTarefaLoteAmazonSchema>;
export const TIPO_TAREFA_LOTE_AMAZON = {
  enviar: 'feed-enviar',
  resultado: 'feed-resultado',
  incerto: 'feed-incerto',
  recuperar: 'feed-recuperar',
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

/** A block batch (module header). */
export const loteBlocosFeedAmazonSchema = z
  .object({
    tipo: z.literal(TIPO_LOTE_FEED_AMAZON.blocos),
    /** How many input parts the provider reads: at least one. */
    partes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    /** ms — a turned-away block batch re-enqueues itself until then. */
    esperaAteMs: inteiroSeguro(),
  })
  .strict();
export type LoteBlocosFeedAmazon = z.infer<typeof loteBlocosFeedAmazonSchema>;

/** A window batch (module header). */
export const loteJanelaFeedAmazonSchema = z
  .object({
    tipo: z.literal(TIPO_LOTE_FEED_AMAZON.janela),
    ...camposJanelaFeedAmazon(),
    /** ms — null for a tick-born batch; a recovery-born one waits until then. */
    esperaAteMs: inteiroSeguro().nullable(),
  })
  .strict()
  .superRefine((lote, ctx) => {
    verificarJanelaFeedAmazon(lote, ctx);
    if ((lote.commitAposMs === null) !== (lote.esperaAteMs === null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'commitAposMs e esperaAteMs andam juntos: ambos null ou ambos definidos',
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

/** Every jobs-queue payload of the feed core. */
export const tarefaLoteAmazonSchema = z.discriminatedUnion('tipo', [
  tarefaEnviarFeedAmazonSchema,
  tarefaResultadoFeedAmazonSchema,
  tarefaIncertoFeedAmazonSchema,
  tarefaRecuperarFeedAmazonSchema,
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
