import { z } from 'zod';
import { sellingPartnerIdValido } from './contaAmazon';
import { notificationResilienceFields } from './shared/notificationResilience';

/**
 * `notificacoesAmazon` (TOP-LEVEL) — the **failures-only** backlog of the Amazon
 * reads queue `filaLeituraAmazon` (master plan step 3, D4/D5). A task that
 * settled writes NOTHING; a document lands here only when it could not be
 * processed: the task exhausted its retries or its enqueue failed (`failed`), a
 * precondition outside this system is not met yet — the read switch off, no
 * conta for the seller, the conta parked or its credential missing, the step-5
 * importer not deployed yet (`deferred`, the daily lane re-drives it) — or the
 * outcome is terminal (`parked`).
 *
 * ## Two producers, one task: the payload is a discriminated union on `origem`
 *
 *  - `push` — the HTTPS receiver (PR 3-c), from an `ORDER_CHANGE` notification
 *    the AWS relay forwards: the seller, the order, Amazon's `NotificationId`
 *    and its `PublishTime` in MILLISECONDS (`publishTimeMs`);
 *  - `poll` — the 15-minute backstop poll (step 4): the conta it listed, the
 *    order, and the row's `lastUpdatedTime` in MICROSECONDS (`lastUpdatedUs`).
 *
 * Both are shipped NOW, before either producer exists: the shared pipeline
 * DROPS a payload its task schema refuses (no persist, no retry), so a producer
 * that ships against a schema missing its variant loses every notification in
 * silence. `tipo` is a one-member enum (`pedido`) so steps 9 and 12a extend the
 * task without reshaping a stored row.
 *
 * `publishTimeMs` and `lastUpdatedUs` only ever NAME a document (the poll's doc
 * id): step 5's watermark comes from `getOrder`, never from a payload. They are
 * plain safe integers — never the tolerant `millisSinceEpoch()` builders, whose
 * coercion would rewrite a µs value into ms and so change a document id.
 *
 * ## The payload is IDS ONLY, and unknown keys are STRIPPED — a declared departure
 *
 * ⚠️ The `webhook-notifications` skill tells a channel to `.passthrough()` the
 * task and collection schemas and to normalize-then-`safeParse` the wire body
 * (#810). This channel deliberately does NOT (step-3 plan §3 decision 29, Loja
 * Integrada's identical choice): the push body carries buyer PII and D5 forbids
 * mapping it, the task re-fetches the order (`getOrder`, step 5), so a dead-letter
 * row needs only the routing ids to re-derive everything, and a field nobody
 * declared is a field nobody reviewed for what it may carry. Every object here
 * strips; the producers build the payload field by field.
 *
 * ⚠️ Every field a later step adds must be optional or defaulted: tasks in
 * flight survive a deploy, and a task whose payload no longer parses is DROPPED.
 *
 * ## The grammars — each is what makes a document id path-safe
 *
 *  - `NotificationId`: 1–128 characters of visible ASCII without `/`. Amazon's
 *    model types it as a bare `string` with a UUID example only, so a narrower
 *    pattern would be a guess that silently drops every push the day it differs
 *    (the `sellingPartnerIdValido` rule; step-3 plan §3 decision 34). The doc id
 *    is `push:<NotificationId>`, so `.`, `..` and `__x__` are safe ids too.
 *  - `AmazonOrderId`: the model's own "3-7-7 format".
 *  - `sellerId`: `sellingPartnerIdValido` (exact, never trimmed or folded).
 *  - `contaId`: the conta-id grammar of `apps/amazon/lib/amazon/core/idConta.ts`
 *    (that module may import nothing, so the grammar is restated here and a test
 *    in the app pins the two sources equal).
 *
 * Admin-only / default-deny: NOT registered in `ALL_DOMAINS`, no Meta, so the
 * rules generator emits no match block and no client can read it. Exported
 * bare: never a combined `{ schema, meta }` value (`registry.test.ts`).
 */

/** What a reads-queue task asks for — the field the functions codebase dispatches on. */
export const tipoTarefaAmazonSchema = z.enum(['pedido']);
export type TipoTarefaAmazon = z.infer<typeof tipoTarefaAmazonSchema>;

/** Named members of {@link tipoTarefaAmazonSchema} — see `delfrance/prefer-schema-enum`. */
export const TIPO_TAREFA_AMAZON = {
  pedido: 'pedido',
} as const satisfies Record<string, TipoTarefaAmazon>;

/** Who produced the notification: the receiver (`push`) or the backstop poll (`poll`). */
export const origemNotificacaoAmazonSchema = z.enum(['push', 'poll']);
export type OrigemNotificacaoAmazon = z.infer<typeof origemNotificacaoAmazonSchema>;

/** Named members of {@link origemNotificacaoAmazonSchema} — see `delfrance/prefer-schema-enum`. */
export const ORIGEM_NOTIFICACAO_AMAZON = {
  push: 'push',
  poll: 'poll',
} as const satisfies Record<string, OrigemNotificacaoAmazon>;

/** `NotificationId`: visible ASCII (`!`–`~`) WITHOUT `/` (0x2F), 1 to 128 characters. */
export const NOTIFICATION_ID_AMAZON_REGEX = /^[\x21-\x2E\x30-\x7E]{1,128}$/;

/** `AmazonOrderId`: the model's "3-7-7 format" — ASCII digits only. */
export const PEDIDO_AMAZON_REGEX = /^[0-9]{3}-[0-9]{7}-[0-9]{7}$/;

/**
 * A conta id: letters, digits, `_` and `-`, 1 to 128 (every auto-id fits).
 * Restated from the app's `ID_DE_CONTA` (`apps/amazon/lib/amazon/core/idConta.ts`),
 * which a package cannot import; the app's `notificacao.test.ts` pins the two
 * sources and flags equal.
 */
export const CONTA_ID_AMAZON_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

export const notificationIdAmazonSchema = z.string().regex(NOTIFICATION_ID_AMAZON_REGEX);
export const pedidoAmazonSchema = z.string().regex(PEDIDO_AMAZON_REGEX);
export const contaIdAmazonSchema = z.string().regex(CONTA_ID_AMAZON_REGEX);
export const sellerIdAmazonSchema = z
  .string()
  .refine((v) => sellingPartnerIdValido(v), { message: 'selling_partner_id inválido' });

/** A non-negative SAFE integer: `String(n)` is plain digits, never an exponent. */
function inteiroSeguro() {
  return z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
}

/**
 * Every wire field, shared by the persisted document and the task payload so
 * the two cannot drift. A FUNCTION returning fresh builders, the
 * `notificationResilienceFields` shape — never a `{ schema, meta }` value.
 */
export function camposNotificacaoAmazon() {
  return {
    tipo: tipoTarefaAmazonSchema,
    origem: origemNotificacaoAmazonSchema,
    sellerId: sellerIdAmazonSchema,
    amazonOrderId: pedidoAmazonSchema,
    /** push only. */
    notificationId: notificationIdAmazonSchema,
    /** push only — `NotificationMetadata.PublishTime`, MILLISECONDS. */
    publishTimeMs: inteiroSeguro(),
    /** poll only. */
    contaId: contaIdAmazonSchema,
    /** poll only — the row's `lastUpdatedTime`, MICROSECONDS. */
    lastUpdatedUs: inteiroSeguro(),
  };
}

const campos = camposNotificacaoAmazon();

/**
 * The reads-queue task payload: one variant per producer (module header).
 * Every variant STRIPS unknown keys, so a push payload carrying a stray
 * `contaId` parses to exactly its six fields.
 */
export const tarefaAmazonSchema = z.discriminatedUnion('origem', [
  z.object({
    tipo: campos.tipo,
    origem: z.literal(ORIGEM_NOTIFICACAO_AMAZON.push),
    sellerId: campos.sellerId,
    amazonOrderId: campos.amazonOrderId,
    notificationId: campos.notificationId,
    publishTimeMs: campos.publishTimeMs,
  }),
  z.object({
    tipo: campos.tipo,
    origem: z.literal(ORIGEM_NOTIFICACAO_AMAZON.poll),
    sellerId: campos.sellerId,
    amazonOrderId: campos.amazonOrderId,
    contaId: campos.contaId,
    lastUpdatedUs: campos.lastUpdatedUs,
  }),
]);
export type TarefaAmazon = z.infer<typeof tarefaAmazonSchema>;

/**
 * The persisted failure document: every field of BOTH variants (the ones the
 * row's variant does not carry stay `null`) plus the shared resilience block.
 *
 * ⚠️ A plain `z.object`, never a union or a refined object: the shared store's
 * `mark` and `redrive` are partial merges, and `parseMergePatch` needs a
 * `ZodObject` it can `.partial()`. The variant invariant is the writer's (the
 * app builds the fields from a payload that passed {@link tarefaAmazonSchema})
 * and the reader's (the sweep re-parses each row STRICTLY with it).
 */
export const notificacaoAmazonSchema = z.object({
  tipo: campos.tipo,
  origem: campos.origem,
  sellerId: campos.sellerId,
  amazonOrderId: campos.amazonOrderId,
  notificationId: campos.notificationId.nullable().default(null),
  publishTimeMs: campos.publishTimeMs.nullable().default(null),
  contaId: campos.contaId.nullable().default(null),
  lastUpdatedUs: campos.lastUpdatedUs.nullable().default(null),
  // ---- Local resilience fields (shared; not on any provider's wire) -------
  // Written/read blind by the pipeline in `@delfrance/data/admin/notifications`.
  ...notificationResilienceFields(),
});

export type NotificacaoAmazon = z.infer<typeof notificacaoAmazonSchema>;
