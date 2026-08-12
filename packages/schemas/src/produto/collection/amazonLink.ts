import { z } from 'zod';
import { outerRefSchema } from '../../shared/outerRef';
import { millisSinceEpoch } from '../../shared/datetime';

/**
 * Typed write-side schema for the Amazon listing link doc —
 * `produtos/{id}/prodAmazon/{docId}` — in the EXACT old Flutter wire shape
 * (`ProdutoAmazon`, amazon `models.dart`): dual-run coexistence means the
 * Flutter app keeps reading the docs the new app writes.
 *
 * This is deliberately NOT a DomainSchema and NOT in `ALL_DOMAINS`: the loose
 * pass-through subcollection domain in `subcollections.ts` (leaf name
 * `prodAmazon` — verified against the compiled `models.odm.g.dart`, #289)
 * already covers the Firestore rules (client reads, parent produto
 * permissions); this typed shape exists for the Admin-SDK writer (the future
 * apps/amazon publish flow + notification processor, #363), which bypasses
 * rules but must not drift from the Flutter wire format.
 *
 * Wire notes (from the parity audit, #289 + #363):
 *  - `submitStatus` / `listingStatus` use the raw SP-API uppercase codes
 *    (`SUBMIT_STATUS.fromJson` / `LISTING_STATUS.fromJson`) — `ACCEPTED` |
 *    `INVALID` | `VALID` and `BUYABLE` | `DISCOVERABLE` respectively;
 *  - `issues` are raw SP-API issue objects (`code`, `message`, `severity`,
 *    `attributeNames`, `categories`, #363) — typed loosely here (extra keys
 *    pass through) since the audit didn't need the full SP-API issue schema;
 *  - on a 404 from `getListingsItem` the notification processor resets the
 *    child doc to `asin: null, retrySubmitDate: null, issues: null,
 *    submitStatus: null, listingStatus: []` (#363), so every optional field
 *    below must stay nullable to represent that reset.
 */

/** Amazon `SUBMIT_STATUS` wire codes (models.dart). */
export const amazonSubmitStatusSchema = z.enum(['ACCEPTED', 'INVALID', 'VALID']);
export type AmazonSubmitStatus = z.infer<typeof amazonSubmitStatusSchema>;

/** Named members of {@link amazonSubmitStatusSchema} — the SP-API wire codes. */
export const AMAZON_SUBMIT_STATUS = {
  accepted: 'ACCEPTED',
  invalid: 'INVALID',
  valid: 'VALID',
} as const satisfies Record<string, AmazonSubmitStatus>;

/** Amazon `LISTING_STATUS` wire codes (models.dart). */
export const amazonListingStatusSchema = z.enum(['BUYABLE', 'DISCOVERABLE']);
export type AmazonListingStatus = z.infer<typeof amazonListingStatusSchema>;

/** Named members of {@link amazonListingStatusSchema} — the SP-API wire codes. */
export const AMAZON_LISTING_STATUS = {
  buyable: 'BUYABLE',
  discoverable: 'DISCOVERABLE',
} as const satisfies Record<string, AmazonListingStatus>;

/** One raw SP-API listing issue (`code`, `message`, `severity`, ..., #363). */
export const amazonIssueWireSchema = z
  .object({
    code: z.string().nullable().default(null),
    message: z.string().nullable().default(null),
    severity: z.string().nullable().default(null),
    attributeNames: z.array(z.string()).nullable().default(null),
    categories: z.array(z.string()).nullable().default(null),
  })
  .passthrough();
export type AmazonIssueWire = z.infer<typeof amazonIssueWireSchema>;

/** `produtos/{id}/prodAmazon/{docId}` — the Amazon listing link doc. */
export const produtoAmazonLinkSchema = z
  .object({
    // Required account link — the `(contaAmazonOuterRef, sku)` lookup key of
    // the #363 notification processors (legacy required ctor param).
    contaAmazonOuterRef: outerRefSchema,
    name: z.string().min(1),
    sku: z.string().min(1),
    asin: z.string().nullable().default(null),
    marketplaceIds: z.array(z.string()).default(['A2Q3Y263D00KWC']),
    productType: z.string().nullable().default(null),
    productTypeVersion: z.string().nullable().default(null),
    // Raw SP-API attributes JSON — pass-through, not fully enumerated by the audit.
    productDataJson: z.record(z.string(), z.unknown()).nullable().default(null),
    productDataAllFields: z.array(z.string()).nullable().default(null),
    submitStatus: amazonSubmitStatusSchema.nullable().default(null),
    listingStatus: z.array(amazonListingStatusSchema).nullable().default(null),
    issues: z.array(amazonIssueWireSchema).nullable().default(null),
    retrySubmitDate: millisSinceEpoch().nullable().default(null),
  })
  .passthrough();
export type ProdutoAmazonLink = z.infer<typeof produtoAmazonLinkSchema>;
