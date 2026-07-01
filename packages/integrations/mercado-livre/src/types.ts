import { z } from 'zod';

/**
 * Zod shapes for Mercado Livre OAuth. Tolerant by design (user point #3 — ML
 * silently changes fields): unknown keys ride through `.passthrough()`, and
 * only the fields we actually consume are required.
 */

/**
 * Response of `POST /oauth/token` for both `authorization_code` and
 * `refresh_token` grants. `expires_in` is in **seconds** (ML sends 21600 = 6h).
 * ML returns a fresh `refresh_token` on every call (single-use rotation).
 * See: developers.mercadolivre.com.br — Autenticação e Autorização.
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
 * OAuth error body (`400`/`401`): `{ error, error_description, status, cause }`.
 * `invalid_grant` means the authorization code / refresh token is expired,
 * revoked, or already used → re-consent required.
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
