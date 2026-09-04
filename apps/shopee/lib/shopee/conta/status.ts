/**
 * The wire shape of `GET /api/marketplace/shopee/conta`.
 *
 * ## Two clocks, never one
 *
 * A Shopee conta has TWO independent expiries and conflating them is the defect
 * the legacy Flutter app shipped:
 *
 *  - the **authorization** (`expireTime`, 7–365 days) — the seller's consent. It
 *    is what `get_shops_by_partner` reports, it needs no token to read, and its
 *    lapse means a re-consent.
 *  - the **access token** (`credencial.expiraEm`, ~4 hours) — a refreshable
 *    detail. Its lapse means nothing to the operator once step 2's refresh
 *    exists.
 *
 * The legacy app rendered "Conectado" from the 4-hour one and never read the
 * other, so an authorization about to lapse looked identical to a healthy conta
 * until the day everything stopped.
 *
 * ⚠️ **`apps/web` cannot import this module** — it has no dependency edge to any
 * `apps/*`, and none is possible. Step 21 mirrors these shapes in
 * `apps/web/lib/shopee/wire.ts`, the way `apps/web/lib/mercado-livre/wire.ts`
 * already mirrors the ML ones. That mirror is a KNOWN duplication: name it in
 * its header, point it back here, and keep the field names identical so a drift
 * is visible in a diff rather than at runtime.
 */
import { z } from 'zod';

export const shopeeLojaSchema = z.object({
  shopName: z.string().nullable(),
  region: z.string().nullable(),
  status: z.enum(['BANNED', 'FROZEN', 'NORMAL']).nullable(),
});
export type ShopeeLoja = z.infer<typeof shopeeLojaSchema>;

export const shopeeContaStatusSchema = z.object({
  connected: z.boolean(),
  shopId: z.number().int().nullable(),
  mainAccountId: z.number().int().nullable(),
  /** Milliseconds — when the seller granted the authorization. */
  authTime: z.number().int().nullable(),
  /** Milliseconds — when the AUTHORIZATION lapses. */
  expireTime: z.number().int().nullable(),
  diasParaExpirar: z.number().int().nullable(),
  /** `null` while the access token is dead — `get_shop_info` needs a live one. */
  loja: shopeeLojaSchema.nullable(),
  /** The OTHER clock. `null` when no credential is stored at all. */
  credencial: z.object({ expiraEm: z.number().int(), expirada: z.boolean() }).nullable(),
});
export type ShopeeContaStatus = z.infer<typeof shopeeContaStatusSchema>;

/**
 * The disconnected answer, served at HTTP 200.
 *
 * ⚠️ Not an error status. Rendering the disconnected state is the whole point of
 * this route, so a conta that was never connected must not look like a failure
 * to the browser.
 */
export const CONTA_DESCONECTADA: ShopeeContaStatus = {
  connected: false,
  shopId: null,
  mainAccountId: null,
  authTime: null,
  expireTime: null,
  diasParaExpirar: null,
  loja: null,
  credencial: null,
};

/** A day, in milliseconds. */
const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Whole days until the AUTHORIZATION lapses.
 *
 * `Math.floor`, so the last partial day reads `0` rather than `1` — an operator
 * told "1 day left" on the morning it expires would plan for tomorrow. Negative
 * past the expiry, which is a real state: the authorization is gone but the
 * conta document still names the shop.
 */
export function diasParaExpirar(expireTimeMs: number, now: number = Date.now()): number {
  return Math.floor((expireTimeMs - now) / DIA_MS);
}
