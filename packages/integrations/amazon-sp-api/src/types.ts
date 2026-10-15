/**
 * Amazon wire schemas — RESPONSE shapes only, and only the ones something in
 * this package consumes today:
 *
 * - the LWA token response (both exchanges),
 * - the LWA error body (its `error` code only),
 * - the SP-API `errors[]` envelope (its `code`s only, for the observer).
 *
 * Every operation's own schema (Orders, Sellers, Listings, …) arrives with the
 * step that first consumes it, written from the models
 * (`amzn/selling-partner-api-models`) and checked against captured responses.
 *
 * ## Passthrough
 *
 * Every object is `.passthrough()`: Amazon adds fields without notice, and a
 * schema that stripped them would hide exactly the drift a later step needs to
 * see.
 *
 * ## Declare only what is read
 *
 * ⚠️ The LWA error declares `error` and nothing else; the SP-API envelope
 * declares `errors[].code` and nothing else. `error_description`, `message` and
 * `details` are free text that echoes request values, and must never reach an
 * error — a declared field is an invitation to carry it. They survive the parse
 * through passthrough only.
 *
 * ## Numbers
 *
 * ⚠️ This is the ONLY file under `src/` that uses Zod for numbers, and every one
 * goes through `wireInt()` from `@delfrance/core/wire`: a serializer that quotes
 * a field must not cost the whole token (#1087). Enforced by
 * `packages/config-eslint/rules/integration-response-numbers-tolerant.test.js`,
 * which scans every file under `src/` and anchors on `expires_in` here.
 * ⚠️ Keep the anchored field on its own short line, so Prettier never wraps it
 * out of the guard's line-based scan.
 */
import { wireInt } from '@delfrance/core/wire';
import { z } from 'zod';

/**
 * A successful LWA token response [D:connecting-to-the-selling-partner-api]:
 * `{ access_token, token_type: 'bearer', expires_in: 3600, refresh_token }`.
 *
 * - `token_type` is a plain string, not a `'bearer'` literal: the access token
 *   travels in `x-amz-access-token`, where the type is never used, and a case
 *   change must not fail the exchange.
 * - `expires_in` is read, never assumed to be 3600 ("typically 3600").
 * - `refresh_token` is OPTIONAL here: the authorization-code exchange always
 *   returns it, while the docs disagree on whether a refresh exchange echoes
 *   it. `lwa.ts` requires it for the code exchange.
 */
export const lwaTokenRespostaSchema = z
  .object({
    access_token: z.string().min(1),
    token_type: z.string(),
    expires_in: wireInt(),
    refresh_token: z.string().min(1).optional(),
  })
  .passthrough();

export type LwaTokenResposta = z.infer<typeof lwaTokenRespostaSchema>;

/**
 * An unsuccessful LWA token response: `{ error, error_description, error_uri? }`.
 * Only `error` is declared; `lerCodigoErroLwa` (`errors.ts`) maps it to a closed
 * set.
 */
export const lwaErroSchema = z
  .object({
    error: z.string(),
  })
  .passthrough();

export type LwaErro = z.infer<typeof lwaErroSchema>;

/**
 * The SP-API error envelope: `{ errors: [{ code, message, details? }] }`.
 *
 * Both model generations put the list under a top-level `errors` key (newer
 * APIs as `ErrorList`, older ones as an optional `errors` on the response), so
 * one envelope covers both. Only `code` is declared, and it is free-form
 * (`'InvalidInput'`, `'Invalid Input'`, `'Unauthorized'`, `'400'`): the client
 * classifies by HTTP status, never by code, and hands the codes to the observer.
 *
 * ⚠️ The models' own sandbox answers some 400s with `{}` — no `errors` key —
 * so a failed parse here is normal, and reads as "no codes".
 */
export const spApiErrosSchema = z
  .object({
    errors: z.array(
      z
        .object({
          code: z.string(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type SpApiErros = z.infer<typeof spApiErrosSchema>;
