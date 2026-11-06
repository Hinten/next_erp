/**
 * The Easy Ship scheduling's task contract (step 15, PR 15-b): the payload of
 * the `processAmazonEasyShipSchedule` queue, its ladders and bounds, the THREE
 * pure builders that are the only way a payload is ever made, and the task
 * NAME of an entry enqueue. Unwired here: the producer, the two entries and the
 * handler that enqueue and read it arrive in 15-c.
 *
 * ## What the payload carries
 *
 * `{ pedidoId, contaId, orderId, origem, espera, pausas }` and nothing else,
 * every field REQUIRED. Unlike the NF-e task's, it carries the conta and the
 * order: the handler PROVES them against the pedido id before any read
 * (`makePedidoIdAmazon(contaId, orderId) === pedidoId`), so the valve and its
 * canary are consulted with ZERO Firestore reads. Never a URL, a token, a
 * tracking or package id, or any Amazon text: a Cloud Tasks payload is visible
 * in the console and in the dispatch logs.
 *
 * - `origem` — which observation enqueued the chain: `aceite-nfe` (the NF-e
 *   task saw Amazon accept the invoice) or `importacao` (the order import read
 *   an order ready to schedule).
 * - `espera` — re-reads spent waiting for the ORDER-level invoice status to
 *   mirror an acceptance the Delivery API already reported, 0 …
 *   {@link ESPERA_ACEITE_AGENDAMENTO_AMAZON_S}`.length`. Only an `aceite-nfe`
 *   chain waits: an `importacao` one was enqueued by a read that already showed
 *   the order-level acceptance.
 * - `pausas` — re-enqueues spent on a 429 (no queue attempt spent), 0 …
 *   {@link PAUSAS_AGENDAMENTO_AMAZON_S}`.length`.
 *
 * ## The copy rules (pinned by the builders' tests)
 *
 * - Only {@link tarefaInicialAgendamentoAmazon} — the two entries — mints
 *   `espera: 0, pausas: 0` from nothing.
 * - {@link esperaAgendamentoAmazon} adds 1 to `espera` and RESETS `pausas`.
 * - {@link pausaAgendamentoAmazon} adds 1 to `pausas` and keeps everything else.
 * - A builder answers `null` at its bound (the caller's last-chance rule
 *   answers it) and throws a `RangeError` only on a programming error (an id
 *   outside its grammar). No call site builds a payload literal.
 *
 * ## The task NAME: one per OBSERVATION, never per pedido
 *
 * {@link idDaTarefaDeAgendamentoAmazon} names an ENTRY enqueue after the one
 * observation that produced it (step-15 plan §3 decision 3): the NF-e
 * dispatch's own task id for `aceite-nfe`, the pedido and the import read's
 * order clock (`watermarkUs`) for `importacao`. Cloud Tasks refuses a name for
 * about an hour after its task RAN, whatever that run concluded, so a name
 * derived from the pedido alone would swallow every later observation of the
 * same order for that hour — an import that sees the order ready right after
 * an earlier task ended without scheduling (the valve, the mirror lag, an
 * outage) would land nowhere. A redelivery of the SAME observation keeps its
 * name and dedupes; a new observation always lands. The re-enqueues of a chain
 * (`espera`, `pausa`) are UNNAMED: a name would refuse the next rung.
 *
 * ⚠️ `.strict()`: this queue has exactly the producers this folder names (the
 * two entries and the handler's own re-enqueues), so a payload carrying
 * anything more is a producer this module does not know.
 */
import { sha256Hex } from '@delfrance/data/admin';
import { CONTA_ID_AMAZON_REGEX, PEDIDO_AMAZON_REGEX } from '@delfrance/schemas';
import { z } from 'zod';

/* ---------------------------------- the queue --------------------------------- */

/** The queue. */
export const FILA_AGENDAMENTO_AMAZON = 'processAmazonEasyShipSchedule';

/** The queue's attempts (`retryConfig.maxAttempts`, pinned in 15-c). */
export const TENTATIVAS_AGENDAMENTO_AMAZON = 4;

/** The delay, in SECONDS, of the entry from the NF-e acceptance. */
export const ATRASO_AGENDAMENTO_DO_ACEITE_S = 60;

/**
 * The waits, in SECONDS, for the order-level invoice status to mirror the
 * Delivery API's acceptance, indexed by the incoming `espera` (≈ 42 min in all).
 * At `espera === ESPERA_ACEITE_AGENDAMENTO_AMAZON_S.length` the bound is reached.
 */
export const ESPERA_ACEITE_AGENDAMENTO_AMAZON_S = [120, 600, 1800] as const;

/**
 * The 429 pauses, in SECONDS, indexed by the incoming `pausas` (≈ 15.5 min in
 * all). At `pausas === PAUSAS_AGENDAMENTO_AMAZON_S.length` the bound is reached.
 */
export const PAUSAS_AGENDAMENTO_AMAZON_S = [30, 60, 120, 240, 480] as const;

/* --------------------------------- the origin --------------------------------- */

/** Which observation enqueued a chain (module header). */
export const origemAgendamentoAmazonSchema = z.enum(['aceite-nfe', 'importacao']);

export type OrigemAgendamentoAmazon = z.infer<typeof origemAgendamentoAmazonSchema>;

/** The closed set of {@link OrigemAgendamentoAmazon}, so code names an origin instead of spelling it. */
export const ORIGEM_AGENDAMENTO_AMAZON = {
  aceiteNfe: 'aceite-nfe',
  importacao: 'importacao',
} as const satisfies Record<string, OrigemAgendamentoAmazon>;

/* --------------------------------- the payload -------------------------------- */

/** A pedido id: the Amazon importer's sha256 digest, lowercase hex. */
const PEDIDO_ID = /^[0-9a-f]{64}$/;

/** The Cloud Tasks body (module header). */
export const tarefaAgendamentoAmazonSchema = z
  .object({
    pedidoId: z.string().regex(PEDIDO_ID),
    contaId: z.string().regex(CONTA_ID_AMAZON_REGEX),
    orderId: z.string().regex(PEDIDO_AMAZON_REGEX),
    origem: origemAgendamentoAmazonSchema,
    espera: z.number().int().min(0).max(ESPERA_ACEITE_AGENDAMENTO_AMAZON_S.length),
    pausas: z.number().int().min(0).max(PAUSAS_AGENDAMENTO_AMAZON_S.length),
  })
  .strict();

export type TarefaAgendamentoAmazon = z.infer<typeof tarefaAgendamentoAmazonSchema>;

/* --------------------------------- the builders -------------------------------- */

/**
 * The FIRST payload of a chain: nothing spent. The two entries', and nobody
 * else's.
 *
 * @throws {RangeError} an id outside its grammar (the message names the
 *   grammar, never the value).
 */
export function tarefaInicialAgendamentoAmazon(
  pedidoId: string,
  contaId: string,
  orderId: string,
  origem: OrigemAgendamentoAmazon,
): TarefaAgendamentoAmazon {
  if (!PEDIDO_ID.test(pedidoId)) {
    throw new RangeError('tarefaAgendamento.ts: pedidoId fora da gramática (64 hex minúsculos)');
  }
  if (!CONTA_ID_AMAZON_REGEX.test(contaId)) {
    throw new RangeError('tarefaAgendamento.ts: contaId fora da gramática de id de conta');
  }
  if (!PEDIDO_AMAZON_REGEX.test(orderId)) {
    throw new RangeError('tarefaAgendamento.ts: orderId fora da gramática 3-7-7');
  }
  return { pedidoId, contaId, orderId, origem, espera: 0, pausas: 0 };
}

/**
 * The next wait for the order-level acceptance: `espera + 1`, `pausas` reset,
 * everything else COPIED. `null` at the bound — the caller's last-chance rule
 * answers it.
 */
export function esperaAgendamentoAmazon(
  t: TarefaAgendamentoAmazon,
): TarefaAgendamentoAmazon | null {
  if (t.espera >= ESPERA_ACEITE_AGENDAMENTO_AMAZON_S.length) return null;
  return {
    pedidoId: t.pedidoId,
    contaId: t.contaId,
    orderId: t.orderId,
    origem: t.origem,
    espera: t.espera + 1,
    pausas: 0,
  };
}

/**
 * The same dispatch again after a 429: `pausas + 1`, everything else KEPT.
 * `null` at the pause bound — the caller's last-chance rule answers it.
 */
export function pausaAgendamentoAmazon(t: TarefaAgendamentoAmazon): TarefaAgendamentoAmazon | null {
  if (t.pausas >= PAUSAS_AGENDAMENTO_AMAZON_S.length) return null;
  return {
    pedidoId: t.pedidoId,
    contaId: t.contaId,
    orderId: t.orderId,
    origem: t.origem,
    espera: t.espera,
    pausas: t.pausas + 1,
  };
}

/* ---------------------------------- the name ---------------------------------- */

/**
 * The ONE observation an entry enqueue is named after (module header): the
 * NF-e dispatch that saw the acceptance, or the import read that saw the order
 * ready.
 */
export type ObservacaoAgendamentoAmazon =
  | {
      readonly origem: typeof ORIGEM_AGENDAMENTO_AMAZON.aceiteNfe;
      /** The NF-e dispatch's own Cloud Tasks id. */
      readonly idTarefaNfe: string;
    }
  | {
      readonly origem: typeof ORIGEM_AGENDAMENTO_AMAZON.importacao;
      readonly pedidoId: string;
      /** The import read's order clock, µs (`lastUpdatedTime`). */
      readonly watermarkUs: number;
    };

/**
 * The entry's task name: a pure function of ONE observation, never of the
 * pedido alone (module header). Uniform 64 lowercase hex, inside the Cloud
 * Tasks id grammar. The two origins hash under distinct prefixes, so an
 * `aceite-nfe` and an `importacao` entry of the same pedido never share a name.
 */
export function idDaTarefaDeAgendamentoAmazon(observacao: ObservacaoAgendamentoAmazon): string {
  if (observacao.origem === ORIGEM_AGENDAMENTO_AMAZON.aceiteNfe) {
    return sha256Hex(`agendamento:aceite:${observacao.idTarefaNfe}`);
  }
  return sha256Hex(
    `agendamento:importacao:${observacao.pedidoId}:${String(observacao.watermarkUs)}`,
  );
}
