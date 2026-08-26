import { z } from 'zod';

import { wireInt, wireNumber } from '@delfrance/core/wire';

/**
 * Zod shapes for Mercado Pago payloads (OAuth + REST resources). Tolerant by
 * design (MP silently changes fields): unknown keys ride through
 * `.passthrough()`, response fields are mostly `.nullable().optional()`, and only
 * the identifiers we actually key on are required. A field MP renames or drops
 * therefore degrades gracefully instead of throwing.
 *
 * ⚠️ **Every numeric field goes through `wireNumber()` / `wireInt()`**
 * (`@delfrance/core/wire`), never a bare `z.number()`, because a quoted number
 * that meets a `z.number()` rejects the WHOLE resource, not just that field.
 *
 * ⚠️ This is not an exposure inferred by similarity — it is the object that
 * actually drifted, reached through the other door. On 2026-08-21,
 * `GET /collections/174034247387` answered with `order_id` as the string
 * `"2000018052464608"`; the payment never imported, the pedido stuck at
 * `emProcessamento`, and Cloud Tasks retried identically until the notification
 * parked (#1087). The resource behind `/collections/{id}` is a **Mercado Pago
 * payment** — the very one `api.ts` fetches as `GET /v1/payments/{id}` (#1251).
 * The helper carries the autopsy and the reason `z.coerce.number()` is not the
 * answer (it reads `''` and `null` as **0**, and these are money fields).
 * Enforced by
 * `packages/config-eslint/rules/integration-response-numbers-tolerant.test.js`.
 *
 * ⚠️ The two `z.union([z.string(), z.number()])` fields — `payer.id` and
 * `collector_id` — are the OLDER, per-field form of the same tolerance and stay
 * as they are. Both are identifiers every consumer compares as STRINGS
 * (`notificacao.ts` runs `collector_id` through the shared `asInt` before
 * comparing it). Do not "unify" them onto the helper.
 *
 * ⚠️ **This file holds RESPONSE schemas only** — there is not one request schema
 * in it; MP's outbound bodies are `URLSearchParams` built in `oauth.ts`. That is
 * what makes the blanket tolerance above safe: widening a shape here can never
 * make this ERP SEND a coerced value to MP.
 */

/**
 * Response of `POST /oauth/token` for both `authorization_code` and
 * `refresh_token` grants. `expires_in` is in **seconds** (MP sends 15552000 =
 * ~180d for the long-lived token). MP returns a fresh `refresh_token` on
 * every call. See: developers.mercadopago.com — Autenticação e autorização.
 */
export const tokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    token_type: z.string().min(1),
    expires_in: wireNumber(),
    scope: z.string().nullable().optional(),
    user_id: wireInt().nullable().optional(),
    refresh_token: z.string().min(1),
  })
  .passthrough();
export type TokenResponse = z.infer<typeof tokenResponseSchema>;

/**
 * OAuth error body (`400`/`401`). We surface `error` / `error_description` /
 * `message` / `status`; any other keys MP sends (e.g. a `cause` array) ride
 * through `.passthrough()` untyped. `invalid_grant` means the authorization
 * code / refresh token is expired, revoked, or already used → re-consent needed.
 */
export const tokenErrorSchema = z
  .object({
    error: z.string().optional(),
    error_description: z.string().optional(),
    message: z.string().optional(),
    status: wireNumber().optional(),
  })
  .passthrough();
export type TokenError = z.infer<typeof tokenErrorSchema>;

/* -------------------------------------------------------------------------- */
/*                              REST resources                                */
/* -------------------------------------------------------------------------- */

/** `GET /users/me` — only the fields we key on (connected-account panel). */
export const mpUserSchema = z
  .object({
    id: wireInt(),
    nickname: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
  })
  .passthrough();
export type MpUser = z.infer<typeof mpUserSchema>;

/** One `refunds[]` entry of a payment. */
export const mpPaymentRefundSchema = z
  .object({
    amount: wireNumber().nullable().optional(),
  })
  .passthrough();

/** One `fee_details[]` entry (MP's cut, taxes, financing fee…). */
export const mpPaymentFeeDetailSchema = z
  .object({
    amount: wireNumber().nullable().optional(),
    type: z.string().nullable().optional(),
  })
  .passthrough();

/** One `charges_details[]` entry — the itemized charge/refund ledger. */
export const mpPaymentChargeDetailSchema = z
  .object({
    amounts: z
      .object({
        original: wireNumber().nullable().optional(),
        refunded: wireNumber().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    accounts: z
      .object({
        from: z.string().nullable().optional(),
        to: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

/** The `card` block on a card payment — only what the conta panel/mapper key on. */
export const mpPaymentCardSchema = z
  .object({
    last_four_digits: z.string().nullable().optional(),
    cardholder: z
      .object({ name: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

/** The `payer` block — the paying MP user. */
export const mpPaymentPayerSchema = z
  .object({
    id: z.union([z.string(), z.number()]).nullable().optional(),
    email: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * `GET /v1/payments/{id}` — deliberately a subset: only the fields the
 * charge/refund mapper (#367) and the conta panel need are required (`id`);
 * everything else is `.nullable().optional()` so an MP field rename never
 * fails the whole parse.
 */
export const mpPaymentSchema = z
  .object({
    id: wireInt(),
    status: z.string().nullable().optional(),
    status_detail: z.string().nullable().optional(),
    live_mode: z.boolean().nullable().optional(),
    external_reference: z.string().nullable().optional(),
    transaction_amount: wireNumber().nullable().optional(),
    shipping_cost: wireNumber().nullable().optional(),
    transaction_details: z.record(z.string(), z.unknown()).nullable().optional(),
    // ⚠️ `wireNumber()`, NOT `wireInt()` — the sweep is tolerance only and keeps
    // every modifier this field already had. Adding `.int()` here would MOVE the
    // failure rather than fix it: `mpPaymentToPagamento` writes `parcelas` into
    // `pagamentoSchema` (`int().min(1)`) from inside the pedido transaction, and
    // a ZodError raised there reads as transient to the notification pipeline,
    // which retries until the delivery parks. The mapper already clamps with
    // `Number.isFinite` + `Math.max(1, Math.trunc(...))`, which is the right
    // place for it. Same call as the ML sibling (#1249).
    installments: wireNumber().nullable().optional(),
    payment_type_id: z.string().nullable().optional(),
    payment_method_id: z.string().nullable().optional(),
    date_created: z.string().nullable().optional(),
    date_approved: z.string().nullable().optional(),
    date_last_updated: z.string().nullable().optional(),
    refunds: z.array(mpPaymentRefundSchema).nullable().optional(),
    fee_details: z.array(mpPaymentFeeDetailSchema).nullable().optional(),
    charges_details: z.array(mpPaymentChargeDetailSchema).nullable().optional(),
    marketplace_fee: wireNumber().nullable().optional(),
    card: mpPaymentCardSchema.nullable().optional(),
    authorization_code: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    collector_id: z.union([z.string(), z.number()]).nullable().optional(),
    payer: mpPaymentPayerSchema.nullable().optional(),
  })
  .passthrough();
export type MpPayment = z.infer<typeof mpPaymentSchema>;
