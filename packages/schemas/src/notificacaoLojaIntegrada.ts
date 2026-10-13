import { z } from 'zod';
import { notificationResilienceFields } from './shared/notificationResilience';

/**
 * `notificacoesLojaIntegrada` (TOP-LEVEL) — the **failures-only** backlog of the
 * Loja Integrada reads queue (master plan step 3). A task that settled writes
 * NOTHING; a document lands here only when it could not be processed: the task
 * exhausted its retries (`failed`), a precondition outside this system is not
 * met yet — the read switch off, the conta inactive, its token missing, corrupt
 * or refused (`deferred`, the daily lane re-drives it, and a token save pulls
 * it back at once) — or the outcome is terminal (`parked`).
 *
 * ## The payload is IDS ONLY, and unknown keys are STRIPPED
 *
 * A notification names an order; the importer re-fetches it (D13). So the
 * wire fields are four identifiers and LI's own modification stamp, and the
 * object STRIPS anything else instead of passing it through: a field nobody
 * declared is a field nobody reviewed for what it may carry.
 *
 * ⚠️ Every field a later step adds must be optional or defaulted. Tasks in
 * flight survive a deploy, and a task whose payload no longer parses is DROPPED
 * by the shared pipeline (`handleTask`).
 *
 * ## Every segment of the document id is validated here
 *
 * The id is `<contaId>:<numero>:<origem>:<digits of the stamp | ->` (built in
 * `apps/loja-integrada/lib/lojaIntegrada/notificacoes/notificacao.ts`). Each
 * part is constrained by the regex below, which is what makes every refusal a
 * doc-id guard exists for — `/`, `.`, `..`, `__x__`, an empty segment, a
 * 1 500-byte id — unreachable by construction.
 *
 * Admin-only / default-deny: NOT registered in `ALL_DOMAINS`, no Meta, so the
 * rules generator emits no match block and no client can read it.
 */

/** What a reads-queue task asks for — the field the functions codebase dispatches on. */
export const tipoTarefaLiSchema = z.enum(['pedido']);
export type TipoTarefaLi = z.infer<typeof tipoTarefaLiSchema>;

/** Named members of {@link tipoTarefaLiSchema} — see `delfrance/prefer-schema-enum`. */
export const TIPO_TAREFA_LI = {
  pedido: 'pedido',
} as const satisfies Record<string, TipoTarefaLi>;

/** Who produced the notification: the 5-minute poller, or (step 4) the order webhook. */
export const origemNotificacaoLiSchema = z.enum(['poll', 'webhook']);
export type OrigemNotificacaoLi = z.infer<typeof origemNotificacaoLiSchema>;

/** Named members of {@link origemNotificacaoLiSchema} — see `delfrance/prefer-schema-enum`. */
export const ORIGEM_NOTIFICACAO_LI = {
  poll: 'poll',
  webhook: 'webhook',
} as const satisfies Record<string, OrigemNotificacaoLi>;

/** A conta id as every Loja Integrada surface accepts it (the canary grammar of step 2b). */
export const CONTA_ID_LI_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

/** A pedido `numero`: a positive integer in decimal, no leading zero, at most 16 digits. */
export const NUMERO_PEDIDO_LI_REGEX = /^[1-9][0-9]{0,15}$/;

/**
 * Loja Integrada's own modification stamp, CANONICAL: its naive local form to
 * the microsecond, always 26 characters (`AAAA-MM-DDTHH:MM:SS.ffffff`). Fixed
 * width, so string order is time order. Which zone it is in is unknown until
 * capture C5; nothing decides anything on it in step 3 or 5 — the importer
 * watermarks on the stamp of its own GET.
 *
 * Step 4 widens this for the webhook's UTC form; the field is
 * `.nullable().default(null)`, so a task already in flight still parses.
 */
export const DATA_MODIFICACAO_LI_REGEX =
  /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{6}$/;

export const contaIdLiSchema = z.string().regex(CONTA_ID_LI_REGEX);

/** `numero`: the decimal grammar AND a safe integer (16 digits can pass 2^53). */
export const numeroPedidoLiSchema = z
  .string()
  .regex(NUMERO_PEDIDO_LI_REGEX)
  .refine((v) => Number.isSafeInteger(Number(v)), { message: 'numero acima de 2^53 - 1' });

export const dataModificacaoLiSchema = z.string().regex(DATA_MODIFICACAO_LI_REGEX);

/**
 * The wire fields, shared by the persisted document and the task payload (the
 * app's task schema is `z.object(camposNotificacaoLi())`), so the two cannot
 * drift. A FUNCTION returning fresh builders, the `notificationResilienceFields`
 * shape — never a `{ schema, meta }` value (`registry.test.ts`).
 */
export function camposNotificacaoLi() {
  return {
    tipo: tipoTarefaLiSchema,
    contaId: contaIdLiSchema,
    numero: numeroPedidoLiSchema,
    origem: origemNotificacaoLiSchema,
    dataModificacaoLi: dataModificacaoLiSchema.nullable().default(null),
  };
}

export const notificacaoLojaIntegradaSchema = z.object({
  ...camposNotificacaoLi(),
  // ---- Local resilience fields (shared; not on any provider's wire) -------
  // Written/read blind by the pipeline in `@delfrance/data/admin/notifications`.
  ...notificationResilienceFields(),
});

export type NotificacaoLojaIntegrada = z.infer<typeof notificacaoLojaIntegradaSchema>;
