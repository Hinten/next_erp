import { z } from 'zod';

/**
 * Zod shapes for Mercado Pago payloads (OAuth + REST resources). Tolerant by
 * design (MP silently changes fields): unknown keys ride through
 * `.passthrough()`, response fields are mostly `.nullable().optional()`, and only
 * the identifiers we actually key on are required. A field MP renames or drops
 * therefore degrades gracefully instead of throwing.
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
    expires_in: z.number(),
    scope: z.string().nullable().optional(),
    user_id: z.number().int().nullable().optional(),
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
    status: z.number().optional(),
  })
  .passthrough();
export type TokenError = z.infer<typeof tokenErrorSchema>;

/* -------------------------------------------------------------------------- */
/*                              REST resources                                */
/* -------------------------------------------------------------------------- */

/** `GET /users/me` — only the fields we key on (connected-account panel). */
export const mpUserSchema = z
  .object({
    id: z.number().int(),
    nickname: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
  })
  .passthrough();
export type MpUser = z.infer<typeof mpUserSchema>;

/** One `refunds[]` entry of a payment. */
export const mpPaymentRefundSchema = z
  .object({
    amount: z.number().nullable().optional(),
  })
  .passthrough();

/** One `fee_details[]` entry (MP's cut, taxes, financing fee…). */
export const mpPaymentFeeDetailSchema = z
  .object({
    amount: z.number().nullable().optional(),
    type: z.string().nullable().optional(),
  })
  .passthrough();

/** One `charges_details[]` entry — the itemized charge/refund ledger. */
export const mpPaymentChargeDetailSchema = z
  .object({
    amounts: z
      .object({
        original: z.number().nullable().optional(),
        refunded: z.number().nullable().optional(),
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
    id: z.number().int(),
    status: z.string().nullable().optional(),
    status_detail: z.string().nullable().optional(),
    live_mode: z.boolean().nullable().optional(),
    external_reference: z.string().nullable().optional(),
    transaction_amount: z.number().nullable().optional(),
    shipping_cost: z.number().nullable().optional(),
    transaction_details: z.record(z.string(), z.unknown()).nullable().optional(),
    installments: z.number().nullable().optional(),
    payment_type_id: z.string().nullable().optional(),
    payment_method_id: z.string().nullable().optional(),
    date_created: z.string().nullable().optional(),
    date_approved: z.string().nullable().optional(),
    date_last_updated: z.string().nullable().optional(),
    refunds: z.array(mpPaymentRefundSchema).nullable().optional(),
    fee_details: z.array(mpPaymentFeeDetailSchema).nullable().optional(),
    charges_details: z.array(mpPaymentChargeDetailSchema).nullable().optional(),
    marketplace_fee: z.number().nullable().optional(),
    card: mpPaymentCardSchema.nullable().optional(),
    authorization_code: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    collector_id: z.union([z.string(), z.number()]).nullable().optional(),
    payer: mpPaymentPayerSchema.nullable().optional(),
  })
  .passthrough();
export type MpPayment = z.infer<typeof mpPaymentSchema>;
