import { z } from 'zod';
import { motivoImportacaoParadaAmazonSchema } from './aviso';
import { pedidoAmazonSchema } from './notificacaoAmazon';
import { millisSinceEpoch } from './shared/datetime';

/**
 * `pollPedidosAmazon/{integracaoId}` (TOP-LEVEL) — the per-conta state of the
 * Amazon 15-minute backstop poll (master plan step 4, PR 4-a): its durable
 * cursor, the drain it may resume, the orders it already enqueued, its
 * single-flight lease and its failure counter. ONE document per conta, doc id =
 * `integracaoId`.
 *
 * ## The cursor is MILLISECONDS of Amazon's own clock
 *
 * `cursorMs` is an instant Amazon stamped (`lastUpdatedTime`, the max row of a
 * fully drained window), CAPPED at the drain's start minus five minutes, never
 * our wall clock (§4.ii fixes cursor stamps as ms). It moves FORWARD only. Null
 * until a lease anchors the bootstrap (`now − AMAZON_POLL_LOOKBACK_H`): the
 * lease's `create`, or the expired-lease `update` on a document whose cursor a
 * W7 re-bootstrap deleted. A strict non-negative safe integer — never the
 * tolerant `millisSinceEpoch()` builder, whose coercion would silently rewrite
 * a hand-edited µs value into a different cursor.
 *
 * ## `pendente`: a drain to RESUME
 *
 * A run that stopped mid-window (five pages read with a next one announced, its
 * deadline reached, a counted failure) stores where it stood:
 *
 *  - `paginationToken` — the token that FETCHES the page to read next; `null`
 *    = page 1 of the stored window (a run stopped before or inside it);
 *  - `lastUpdatedAfter` and `marketplaceIds` — the EXACT strings that window
 *    sent: Amazon refuses a token whose other parameters differ, so a resume
 *    resends them byte-identical and never recomputes them;
 *  - `inicioDrenagemMs` — when the window's first page was requested: the cap
 *    of the cursor that window may advance to;
 *  - `tokenEmMs` — when the token arrived (Amazon expires it after 24 h; the
 *    poll discards it after 23);
 *  - `paginas` — the pages that window has read so far, across runs (a window
 *    that reaches the poll's page bound is a malformed answer, counted);
 *  - `linhaInvalida` — an earlier run of this window read a row it could not
 *    parse. The run that COMPLETES the window then counts `resposta-invalida`
 *    and keeps the cursor, exactly as if it had read that row itself: the flag
 *    is how an invalid row on page 1 still blocks the advance when page 6 is
 *    read an hour later. Absent = `false`.
 *
 * ## `vistos`: orderId → the `lastUpdatedTime` last enqueued, in µs
 *
 * What stops every idle tick from re-enqueuing the ten-minute overlap: a row is
 * enqueued only when its stamp is NEWER than this. MICROSECONDS, because they
 * are compared exactly and Amazon's ISO stamps may carry sub-millisecond digits:
 * two changes inside one millisecond must stay distinct. The same µs value names
 * the poll's failure document (`poll:<conta>:<order>:<µs>`).
 *
 * ## The lease and the bookkeeping clocks are MILLISECONDS
 *
 * `emExecucaoAteMs` (0 = free) and `execucaoId` (null = free) are the lease;
 * `ultimaVarreduraEmMs` is when a run last finished or recorded a refusal.
 * `apps/amazon` keeps µs aviso clocks to its one avisos module.
 *
 * ## Admin-only / default-deny
 *
 * NOT registered in `ALL_DOMAINS` and no Meta, so the rules generator emits no
 * match block and no client can read it. Only the nested `apps/amazon/functions`
 * codebase (Admin SDK) touches it, every write under a native precondition (no
 * multi-document atomic write). Unknown keys are STRIPPED. A bare schema, never
 * a `{ schema, meta }` export (`registry.test.ts`).
 */

/** A non-negative SAFE integer: what every compared number here is. */
function inteiroSeguro() {
  return z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
}

/** `lastUpdatedAfter` as the poll builds it: whole seconds, UTC, `Z` (`isoSegundosZ`). */
export const LAST_UPDATED_AFTER_POLL_AMAZON_REGEX =
  /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$/;

/** `marketplaceIds` as one comma-separated string of marketplace ids. */
export const MARKETPLACE_IDS_POLL_AMAZON_REGEX = /^[A-Z0-9]{1,32}(?:,[A-Z0-9]{1,32}){0,49}$/;

/** A truncated or stopped drain to resume (module header). */
export const pendentePollAmazonSchema = z.object({
  /** The token that fetches the next page; null = page 1 of the stored window. Opaque. */
  paginationToken: z.string().min(1).nullable(),
  /** The exact string the window sent. */
  lastUpdatedAfter: z.string().regex(LAST_UPDATED_AFTER_POLL_AMAZON_REGEX),
  /** The exact CSV the window sent. */
  marketplaceIds: z.string().regex(MARKETPLACE_IDS_POLL_AMAZON_REGEX),
  /** ms — when the window's first page was requested. */
  inicioDrenagemMs: inteiroSeguro(),
  /** ms — when the stored token arrived (for a null token: when the window was first stored). */
  tokenEmMs: inteiroSeguro(),
  /** Pages the window has read so far, across runs. */
  paginas: inteiroSeguro(),
  /** An earlier run of this window read an invalid row: its completion counts it (module header). */
  linhaInvalida: z.boolean().default(false),
});
export type PendentePollAmazon = z.infer<typeof pendentePollAmazonSchema>;

export const pollPedidosAmazonSchema = z.object({
  /** ms of Amazon's `lastUpdatedTime`, capped; forward only (module header). */
  cursorMs: inteiroSeguro().nullable().default(null),
  /** A drain to resume, or null (module header). */
  pendente: pendentePollAmazonSchema.nullable().default(null),
  /** orderId → the µs `lastUpdatedTime` last enqueued (module header). */
  vistos: z.record(pedidoAmazonSchema, inteiroSeguro()).default({}),
  /** The lease's expiry (ms); 0 = no run holds it. */
  emExecucaoAteMs: millisSinceEpoch().default(0),
  /** The run holding the lease; null = none. */
  execucaoId: z.string().min(1).nullable().default(null),
  /** When a run last finished, or a refusal was last recorded (ms). */
  ultimaVarreduraEmMs: millisSinceEpoch().nullable().default(null),
  /** The last COUNTED failure, as the import-stopped aviso's motivo code; null after a clean run. */
  ultimoErro: motivoImportacaoParadaAmazonSchema.nullable().default(null),
  /** Consecutive counted failures; the aviso thresholds read it. */
  falhasSeguidas: z.number().int().nonnegative().default(0),
});

export type PollPedidosAmazon = z.infer<typeof pollPedidosAmazonSchema>;
