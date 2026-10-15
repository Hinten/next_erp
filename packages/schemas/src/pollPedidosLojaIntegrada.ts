import { z } from 'zod';
import { motivoImportacaoParadaLiSchema } from './aviso';
import { dataModificacaoLiSchema, numeroPedidoLiSchema } from './notificacaoLojaIntegrada';
import { millisSinceEpoch } from './shared/datetime';

/**
 * `pollPedidosLojaIntegrada/{integracaoId}` (TOP-LEVEL) — the per-conta state of
 * the Loja Integrada 5-minute order poller (master plan step 3, PR 3-e): its
 * durable cursor, its single-flight lease, the orders it already enqueued, and
 * its failure counter. ONE document per conta, doc id = `integracaoId`.
 *
 * ## The cursor is Loja Integrada's own NAIVE text, never an epoch
 *
 * `cursor` is the value the search filter takes, `AAAA-MM-DDTHH:MM:SS`: whole
 * seconds, no fraction, no offset. Which zone the platform reads it in is
 * unknown until a capture settles it, so it is never converted to an instant;
 * the poller does its window arithmetic on the naive fields, zone-free. Fixed
 * width, so string order is time order. Null until the first lease anchors the
 * bootstrap bound here.
 *
 * ## `vistos`: numero → the canonical stamp last enqueued
 *
 * Each value is LI's stamp in the canonical 26-character form
 * (`dataModificacaoLiSchema`), or {@link MARCA_DATA_ILEGIVEL_LI} when the row's
 * stamp could not be read (that row is enqueued once, not on every tick). The
 * poller enqueues a row only when its stamp is newer than this, which is what
 * stops the newest order from being re-enqueued on every idle tick of the
 * overlap. ⚠️ The values are compared AS STRINGS, so a non-canonical value
 * would break the order: both grammars are enforced here, on write and read.
 *
 * ## The lease and the clocks are MILLISECONDS
 *
 * `emExecucaoAteMs` (0 = free) and `execucaoId` (null = free) are the lease;
 * `ultimaVarreduraEmMs` is when a run last finished. `apps/loja-integrada` keeps
 * µs to its one avisos module, so nothing here is µs.
 *
 * ## Admin-only / default-deny
 *
 * NOT registered in `ALL_DOMAINS` and no Meta, so the rules generator emits no
 * match block and no client can read it. Only the nested
 * `apps/loja-integrada/functions` codebase (Admin SDK) touches it, every write
 * under a native precondition (no transaction). Unknown keys are STRIPPED.
 * A bare schema, never a `{ schema, meta }` export (`registry.test.ts`).
 */

/** The cursor grammar: LI's naive `AAAA-MM-DDTHH:MM:SS`, 19 characters. */
export const CURSOR_POLL_LI_REGEX =
  /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/;

export const cursorPollLiSchema = z.string().regex(CURSOR_POLL_LI_REGEX);

/**
 * The `vistos` value for a row whose stamp could not be read. ASCII `?` sorts
 * after every digit, so code must never compare it with a stamp as a string:
 * the poller treats it explicitly.
 */
export const MARCA_DATA_ILEGIVEL_LI = '?';

/** One `vistos` value: a canonical stamp, or the unreadable marker. */
export const vistoPollLiSchema = z.union([
  dataModificacaoLiSchema,
  z.literal(MARCA_DATA_ILEGIVEL_LI),
]);
export type VistoPollLi = z.infer<typeof vistoPollLiSchema>;

export const pollPedidosLojaIntegradaSchema = z.object({
  /** LI's naive `AAAA-MM-DDTHH:MM:SS`; moves forward only, on a fully drained, consistent window. */
  cursor: cursorPollLiSchema.nullable().default(null),
  /** The lease's expiry (ms); 0 = no run holds it. */
  emExecucaoAteMs: millisSinceEpoch().default(0),
  /** The run holding the lease; null = none. */
  execucaoId: z.string().min(1).nullable().default(null),
  /** When a run last finished, or a refusal was last recorded (ms). */
  ultimaVarreduraEmMs: millisSinceEpoch().nullable().default(null),
  /** The last counted failure, as the import-stopped aviso's motivo code; null after a clean run. */
  ultimoErro: motivoImportacaoParadaLiSchema.nullable().default(null),
  /** Consecutive counted failures; the aviso thresholds read it. */
  falhasSeguidas: z.number().int().nonnegative().default(0),
  /** numero → the stamp last enqueued (see the module header). */
  vistos: z.record(numeroPedidoLiSchema, vistoPollLiSchema).default({}),
});

export type PollPedidosLojaIntegrada = z.infer<typeof pollPedidosLojaIntegradaSchema>;
