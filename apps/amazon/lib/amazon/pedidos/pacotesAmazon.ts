/**
 * The Easy Ship package tokens that signal a REVERSED sale (master plan step 5,
 * PR 5-c; D17): exported ONCE, here. Step 5's sale-state classifier
 * (`vendaAmazon.ts`) imports it, and step 7's freight table (PR 7) asserts its
 * reversal rows are exactly this set — never a second list.
 *
 * Matched EXACTLY (`Object.hasOwn`): no trim, no case fold, so `'LOST '` or
 * `'lost'` is not a reversal, and neither is an inherited name such as
 * `'constructor'`. The token → freight-estado table is wholly PR 7's.
 */

/** `packages[].packageStatus.detailedStatus` values that reverse the sale. */
export const DETAILED_STATUS_REVERSAO = Object.freeze({
  REJECTED_BY_BUYER: true,
  UNDELIVERABLE: true,
  RETURNING_TO_SELLER: true,
  RETURNED_TO_SELLER: true,
  LOST: true,
  DAMAGED: true,
} as const);

export type DetailedStatusReversao = keyof typeof DETAILED_STATUS_REVERSAO;

/** Whether a package token is one of {@link DETAILED_STATUS_REVERSAO}, exactly. */
export function ehDetailedStatusReversao(token: unknown): token is DetailedStatusReversao {
  return typeof token === 'string' && Object.hasOwn(DETAILED_STATUS_REVERSAO, token);
}
