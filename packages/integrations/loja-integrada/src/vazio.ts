/**
 * The provider's empty string `''`, read as `null` on an OPTIONAL leaf of the
 * Loja Integrada response schemas. The ONE copy of that rule: `types.ts` (the
 * paging envelope) and `pedidoTipos.ts` (the order import) both import it, and
 * neither keeps its own. Package-local on purpose — not exported from the
 * package root, and not in the core wire module, whose `toNumberish` must keep
 * refusing `''` for every other channel.
 *
 * Which leaves get it is each schema's decision, written where the leaf is
 * declared. This module only says what the rule does.
 *
 * ## Why
 *
 * The provider writes "nothing" as `''`: the sanitized captures keep every
 * empty string as it arrived, and on most of the captured orders they carry
 * one at text leaves of the buyer, of the delivery address and of the order's
 * own note. No numeric or object leaf was empty in them, but the same
 * serializer writes those too, and the cost of being wrong is out of all
 * proportion: `toNumberish` hands `''` to `z.number()` UNCHANGED (it is not a
 * number, and the core must never read it as 0), and the client validates the
 * whole body before anyone reads a field. One empty `meta.total_count` would
 * refuse a whole page; one empty weight on one line would park a whole order,
 * forever. `.nullable()` does not help: `''` is not `null`.
 *
 * ## What it does NOT widen
 *
 *  - Only the exact `''`. A whitespace-only string is still handed to the
 *    schema, so a numeric leaf refuses it: the captures hold none, and a blank
 *    the provider never sends is a drift worth seeing.
 *  - A non-empty string that is not one number (`'abc'`, a pt-BR comma) is
 *    still refused by `wireNumber()` / `wireInt()`, and `'2.5'` by `wireInt()`.
 *    This is not `z.unknown()`.
 *  - Never `0`: `''` means the provider sent nothing, and a zero would be a
 *    value it did not send (a total of zero claims an EMPTY window).
 *
 * ⚠️ The `.optional()` sits OUTSIDE the preprocess, so an absent key never
 * reaches it and stays `undefined`.
 */
import { wireInt, wireNumber } from '@delfrance/core/wire';
import { z } from 'zod';

/** An optional `schema` whose exact `''` reads as `null`; absent stays `undefined`. */
export function vazioComoNulo<T extends z.ZodType>(schema: T) {
  return z.preprocess((v) => (v === '' ? null : v), schema.nullable()).optional();
}

/** {@link vazioComoNulo} over `wireNumber()`: an optional amount, weight or size. */
export const numeroOpcional = () => vazioComoNulo(wireNumber());

/** {@link vazioComoNulo} over `wireInt()`: an optional count or id. */
export const inteiroOpcional = () => vazioComoNulo(wireInt());
