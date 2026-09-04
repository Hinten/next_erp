/**
 * Zod schemas for every JSON body the `apps/shopee` backend answers with, and
 * the public types inferred from them.
 *
 * ## ⚠️ This file is a KNOWN duplication — say so, and keep the names identical
 *
 * The same shapes are declared in `apps/shopee/lib/shopee/conta/status.ts`,
 * whose docblock mandates this mirror: `apps/web` has no dependency edge to any
 * `apps/*` and none is possible, so a browser surface that needs a backend shape
 * has exactly two options — share it, or write it twice. The field names here
 * are IDENTICAL to that module's, which is the whole point: a drift then shows
 * up in a diff instead of at runtime.
 *
 * ⚠️ This header must not describe what the OTHER copy does beyond naming it.
 * A comment asserting the behaviour of a file the compiler cannot see is the
 * smell root `CLAUDE.md` names — the copies drift *toward plausible* and read
 * correct while disagreeing (#1369). What this file owns is the shape the
 * BROWSER will accept; `status.ts` owns what the backend sends.
 *
 * ## The two clocks, mirrored
 *
 * A Shopee conta has two independent expiries and this schema keeps them apart:
 * `expireTime` / `diasParaExpirar` are the **authorization** (7–365 days, the
 * seller's consent — its lapse means a re-consent), while `credencial.expiraEm`
 * is the **access token** (~4 hours, refreshable). They are different fields
 * with different units of meaning, and nothing here folds one into the other.
 *
 * ## Three rules these schemas follow (the same three as `lib/mercado-livre/wire.ts`)
 *
 * 1. ⚠️ **Unknown keys pass.** Zod 4 objects strip by default and nothing here
 *    is `.strict()`. `apps/web` calls the DEPLOYED channel backend, so the
 *    browser is routinely OLDER *or* NEWER than the thing answering it — a
 *    strict object would turn every forward deploy into an outage.
 * 2. ⚠️ **Nothing is optional today, and that is a measured claim rather than a
 *    default.** All four return paths of `GET /api/marketplace/shopee/conta` are
 *    total over these eight keys (they all spread `CONTA_DESCONECTADA`), so
 *    there is no field a deployed backend can omit. **The maintenance rule:**
 *    when a field is added to `status.ts`, declare it here as
 *    `.optional()`/`.default(…)` with the fallback the panel already applies —
 *    an OLDER backend answering a NEWER browser is the risk, and a required
 *    field is what turns that skew into a dead screen.
 * 3. ⚠️ **Numbers are tolerant when the value ORIGINATES outside our own
 *    arithmetic** (`wireInt()` from `@delfrance/core/wire`) and strict
 *    (`z.number()`) when the backend computed it. `shopId` / `mainAccountId` are
 *    read out of Firestore through the SOFT `parseRead`, which hands back the
 *    RAW document on a schema mismatch — so a legacy quoted id reaches this wire
 *    unchanged; `authTime` / `expireTime` are Shopee's own seconds multiplied
 *    into milliseconds. `diasParaExpirar` and `credencial.expiraEm` are ours: a
 *    string there is our serialisation bug and should be loud (#1087 is the
 *    worked example of the opposite mistake costing a whole response).
 */
import { z } from 'zod';

import { wireInt } from '@delfrance/core/wire';

/**
 * `get_shop_info`'s projection — the SIDE read, absent (`loja: null`) whenever
 * the ~4-hour access token is dead.
 */
export const shopeeLojaSchema = z.object({
  shopName: z.string().nullable(),
  region: z.string().nullable(),
  /**
   * ⚠️ `.catch(null)` and NOT a widened `z.string()`: Shopee documents three
   * lifecycle values today and may add a fourth, and the badge this drives is
   * one line of a panel. A member we do not know degrades to "no badge" — it
   * must never cost the operator the whole conta read.
   *
   * ⚠️ The catch is scoped to THIS field. A malformed sibling (`shopName: 42`)
   * still rejects the object, which is what keeps the tolerance from being
   * blanket `z.any()`.
   */
  status: z.enum(['BANNED', 'FROZEN', 'NORMAL']).nullable().catch(null),
});
export type ShopeeLoja = z.infer<typeof shopeeLojaSchema>;

/** The body of `GET /api/marketplace/shopee/conta?integracaoId=…` (always 200). */
export const shopeeContaStatusSchema = z.object({
  connected: z.boolean(),
  /** Shopee's shop id, denormalised onto the integração — provider-origin. */
  shopId: wireInt().nullable(),
  /** Set instead of `shopId` when the consent was main-account-scoped. */
  mainAccountId: wireInt().nullable(),
  /** Milliseconds — when the seller granted the AUTHORIZATION. */
  authTime: wireInt().nullable(),
  /** Milliseconds — when the AUTHORIZATION lapses. */
  expireTime: wireInt().nullable(),
  /** Whole days to that lapse, floored by the backend. Ours, hence strict. */
  diasParaExpirar: z.number().int().nullable(),
  /** `null` while the access token is dead — `get_shop_info` needs a live one. */
  loja: shopeeLojaSchema.nullable(),
  /** The OTHER clock. `null` when no credential is stored at all. */
  credencial: z.object({ expiraEm: z.number().int(), expirada: z.boolean() }).nullable(),
});
export type ShopeeContaStatus = z.infer<typeof shopeeContaStatusSchema>;

/**
 * The body of `GET /api/marketplace/shopee/oauth/start?integracaoId=…`.
 *
 * ⚠️ `.min(1)` is load-bearing: the only consumer hands this straight to
 * `window.location.assign`, and `assign('')` does not fail — it silently
 * RELOADS the current page, so the operator clicks "Conectar conta" and lands
 * back where they started with no error anywhere.
 */
export const oauthStartResponseSchema = z.object({ authorizeUrl: z.string().min(1) });
export type ShopeeOauthStart = z.infer<typeof oauthStartResponseSchema>;
