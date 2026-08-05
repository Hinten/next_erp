import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';
import { outerRefSchema } from './shared/outerRef';
import type { CollectionMetadata } from './types';

// Mirror `PERM.integracao` from @delfrance/auth (duplicated locally to avoid a
// circular dep — same approach as cargo.ts / deposito.ts).
const PERM_INTEGRACAO_READ = 1n << 56n;
const PERM_INTEGRACAO_WRITE = 1n << 57n;
const PERM_INTEGRACAO_DELETE = 1n << 58n;

/**
 * ⚠️ **DUAL-RUN ONLY — delete with the Flutter decommission (#829).**
 *
 * `questionsML` (TOP-LEVEL) — pre-sale buyer questions on a listing, written by
 * the legacy Mercado Livre backend's `questions` notification handler
 * (`.old/…/mercado_livre/lib/src/tasks.dart:1379`, `getQuestionMercadoLivre`).
 *
 * **This collection has no consumer in the new app and never will.** The port
 * routes questions into the registered `chat` / `mensagem` domains instead
 * (#532, #533) — which is what the legacy model already anticipated, carrying
 * `toEstadoConversa()` and `_AnswerML.toMensagem()` helpers. Today the port's
 * `questions` topic is a recognised no-op (#813).
 *
 * It exists here for one reason: literal parity with the legacy ruleset
 * (`match /questionsML`, perm code `mb`, `.old/firestore.rules:219-224`), so
 * that deploying the generated ruleset cannot deny the legacy app anything it
 * has today. Every reference to it in `.old/` is backend-side (Admin SDK, rules
 * exempt) — the Flutter client never reads or writes it — so the practical blast
 * radius of NOT having this block is nil; it is registered defensively. See #783.
 *
 * Schema is `.passthrough()` and permissive: nothing in this repo validates
 * these docs on write, and reads must tolerate whatever the legacy backend
 * stored. Ported from `QuestionML` (`.old/…/models.dart:6525-6633`), wire facts
 * from the generated codec (`models.g.dart:1941-1965`).
 */

/** Legacy `StatusQuestionMl` (`.old/…/models.dart:6482-6515`), stored verbatim. */
export const statusQuestionMercadoLivreSchema = z.enum([
  'unanswered',
  'answered',
  'closed_unanswered',
  'banned',
]);
export type StatusQuestionMercadoLivre = z.infer<typeof statusQuestionMercadoLivreSchema>;

/**
 * Named members of {@link statusQuestionMercadoLivreSchema}. Required by the
 * `delfrance/prefer-schema-enum` lint rule, which fires for any Zod enum
 * carrying a companion constant like this one.
 */
export const STATUS_QUESTION_MERCADO_LIVRE = {
  unanswered: 'unanswered',
  answered: 'answered',
  closedUnanswered: 'closed_unanswered',
  banned: 'banned',
} as const satisfies Record<string, StatusQuestionMercadoLivre>;

/**
 * Legacy `StatusAnswerMl` (`.old/…/models.dart:6678-6690`). Wire values are
 * UPPERCASE, unlike the question status above — the legacy `fromString` upcased
 * the input before matching, so both apps only ever stored these three.
 */
export const statusAnswerMercadoLivreSchema = z.enum(['ACTIVE', 'DISABLED', 'BANNED']);
export type StatusAnswerMercadoLivre = z.infer<typeof statusAnswerMercadoLivreSchema>;

/** Named members of {@link statusAnswerMercadoLivreSchema}. */
export const STATUS_ANSWER_MERCADO_LIVRE = {
  active: 'ACTIVE',
  disabled: 'DISABLED',
  banned: 'BANNED',
} as const satisfies Record<string, StatusAnswerMercadoLivre>;

/**
 * The seller's answer (`_AnswerML`, `.old/…/models.dart:6721-6755`).
 *
 * ⚠️ `date_created` / `last_updated` are **ISO-8601 strings** here
 * (`DateTime.parse(json[...] as String)` / `.toIso8601String()`,
 * `models.g.dart:2003-2015`) — NOT the epoch-millis ints the parent document
 * uses for the identically named fields. The asymmetry is real and load-bearing:
 * modelling these with `millisSinceEpoch()` would normalize them to a number,
 * and a number written back here makes the legacy Dart decoder throw.
 */
export const answerMercadoLivreSchema = z
  .object({
    text: z.string(),
    status: statusAnswerMercadoLivreSchema,
    /** ISO-8601 string — see the asymmetry note above. */
    date_created: z.string().nullable().default(null),
    /** ISO-8601 string — see the asymmetry note above. */
    last_updated: z.string().nullable().default(null),
  })
  .passthrough();
export type AnswerMercadoLivre = z.infer<typeof answerMercadoLivreSchema>;

/** Buyer phone (`_PhoneML`, `.old/…/models.dart:6791-6804`). */
export const phoneMercadoLivreSchema = z
  .object({
    number: z.string(),
    area_code: z.string(),
  })
  .passthrough();
export type PhoneMercadoLivre = z.infer<typeof phoneMercadoLivreSchema>;

/** The asking buyer (`_FromMl`, `.old/…/models.dart:6765-6789`). */
export const fromMercadoLivreSchema = z
  .object({
    id: z.number().int(),
    answered_questions: z.number().int().nullable().default(null),
    first_name: z.string().nullable().default(null),
    last_name: z.string().nullable().default(null),
    phone: phoneMercadoLivreSchema.nullable().default(null),
    email: z.string().nullable().default(null),
  })
  .passthrough();
export type FromMercadoLivre = z.infer<typeof fromMercadoLivreSchema>;

export const questionMercadoLivreSchema = z
  .object({
    /** `documents/integracao/<contaId>` — the owning ML account. */
    contaMercadoLivreQuestionOuterRef: outerRefSchema.nullable().default(null),
    /** The ML question id. Also the Firestore doc id in the legacy writer. */
    id: z.number().int(),
    seller_id: z.number().int(),
    buyer_id: z.number().int().nullable().default(null),
    /** The listing the question is about, e.g. `MLB123456789`. */
    item_id: z.string(),
    deleted_from_listing: z.boolean().nullable().default(null),
    suspected_spam: z.boolean().nullable().default(null),
    status: statusQuestionMercadoLivreSchema,
    hold: z.boolean().nullable().default(null),
    text: z.string(),
    app_id: z.string().nullable().default(null),
    /** Epoch millis int — contrast `answer.date_created`, an ISO string. */
    date_created: millisSinceEpoch().nullable().default(null),
    /** Epoch millis int — contrast `answer.last_updated`, an ISO string. */
    last_updated: millisSinceEpoch().nullable().default(null),
    answer: answerMercadoLivreSchema.nullable().default(null),
    from: fromMercadoLivreSchema.nullable().default(null),
  })
  .passthrough();
export type QuestionMercadoLivre = z.infer<typeof questionMercadoLivreSchema>;

export const questionMercadoLivreMeta: CollectionMetadata = {
  collectionPath: 'questionsML',
  // DUAL-RUN grant (#829) — see the docstring above. Legacy perm code `mb`;
  // reusing the `integracao` bits keeps existing claim-holders working, exactly
  // as `brandShopee` does.
  permissions: {
    read: PERM_INTEGRACAO_READ,
    write: PERM_INTEGRACAO_WRITE,
    delete: PERM_INTEGRACAO_DELETE,
  },
};

export const questionMercadoLivre = {
  schema: questionMercadoLivreSchema,
  meta: questionMercadoLivreMeta,
};
