import { z } from 'zod';
import { outerRefSchema } from '../../shared/outerRef';

/**
 * Typed write-side schemas for the Shopee listing link docs —
 * `produtos/{id}/prodshopee/{docId}` and
 * `produtos/{id}/variashopee/{docId}` — in the EXACT old Flutter wire shape
 * (`ProdutoShopee` / `VariacaoShopee`, shopee `models.dart`): the migrated
 * corpus is stored in exactly this shape, so it has to be read and written
 * that way.
 *
 * These are deliberately NOT DomainSchemas and NOT in `ALL_DOMAINS`: the loose
 * pass-through subcollection domains in `subcollections.ts` (leaf names
 * `prodshopee` / `variashopee` — verified against the compiled
 * `models.odm.g.dart`, #289) already cover the Firestore rules (client reads,
 * parent produto permissions); these typed shapes exist for the Admin-SDK
 * writer (the future apps/shopee publish flow), which bypasses rules but must
 * not drift from the Flutter wire format.
 *
 * Wire notes (from the parity audit, #289 + #363):
 *  - `violations` is the banned-item push outcome (`processarPushShopee`
 *    code 6 → `item_status: 'UNLIST'`, `violations: reason_list`), not
 *    something the create/update flow itself writes on a normal publish.
 *    ⚠️ `item_status` used to be listed here as push-only too; since step 9
 *    (#1517) the product IMPORT writes it as well — see
 *    {@link shopeeItemStatusSchema} for the two writers and their ordering;
 *  - most nested blobs (`description_info`, `logistic_info`, `wholesale`,
 *    `complaint_policy`, `attributes`) are raw Shopee API pass-through JSON
 *    the audit didn't fully enumerate field-by-field — kept loosely typed
 *    here on purpose (wire tolerance over strictness);
 *  - `violations` items mirror the banned-item push payload's
 *    `ReasonListBannedItemPush` shape (`days_to_fix`, `suggestion`,
 *    `violation_reason`, `violation_type`).
 */

/**
 * Shopee `item_status` — the SIX wire values (`guide 31` §ItemStatus, and the
 * same list on `get_item_list`, `get_item_base_info`, `search_item`,
 * `get_item_violation_info`, `get_kit_item_info`). Widened from
 * `NORMAL`/`UNLIST` by step 9 (#1517).
 *
 * ⚠️ TWO writers now, and no ordering guard beyond "last read wins":
 *  - the banned-item push (code 6) writes `UNLIST` + `violations` — step 3's
 *    handler;
 *  - the product IMPORT writes whatever `get_item_base_info` just reported —
 *    step 9.
 * Both are re-derived from a fresh read of the same fact, so a replay in either
 * order converges. An earlier revision of this docblock called the field
 * push-only; that was true before step 9 and is now false.
 *
 * ⚠️ `SELLER_DELETE` / `SHOPEE_DELETE` are members because the wire has them,
 * NOT because anything writes them: the import REFUSES a deleted listing
 * outright (`ShopeeImportBlockedError`, motivo `item-deletado`) — never a
 * produto from a deleted listing — and the push writes only `UNLIST`.
 *
 * ⚠️ The pre-2024 `DELETED` spelling (`announcement 769`/`841`, effective
 * 2024-01-18) is deliberately ABSENT. A migrated link doc may still hold it;
 * nothing on the import path parses a stored link (the existing raw is spread,
 * never `parseRead`), and the first re-import replaces it with a live value.
 * What a stored `DELETED` does today is on record in `shopeeLink.test.ts`:
 * it fails `safeParse`, so `parseSoftRead` (`packages/data/src/zodParse.ts`)
 * logs one warning and hands the RAW document back unchanged — it neither
 * drops the key nor throws.
 */
export const shopeeItemStatusSchema = z.enum([
  'NORMAL',
  'BANNED',
  'UNLIST',
  'REVIEWING',
  'SELLER_DELETE',
  'SHOPEE_DELETE',
]);
export type ShopeeItemStatus = z.infer<typeof shopeeItemStatusSchema>;

/** Named members of {@link shopeeItemStatusSchema} — the Shopee wire codes. */
export const SHOPEE_ITEM_STATUS = {
  normal: 'NORMAL',
  banned: 'BANNED',
  unlist: 'UNLIST',
  reviewing: 'REVIEWING',
  sellerDelete: 'SELLER_DELETE',
  shopeeDelete: 'SHOPEE_DELETE',
} as const satisfies Record<string, ShopeeItemStatus>;

/** Shopee variation `model_status` (models.dart). */
export const shopeeModelStatusSchema = z.enum(['MODEL_NORMAL', 'MODEL_UNAVAILABLE']);
export type ShopeeModelStatus = z.infer<typeof shopeeModelStatusSchema>;

/** Named members of {@link shopeeModelStatusSchema} — the Shopee variation wire codes. */
export const SHOPEE_MODEL_STATUS = {
  normal: 'MODEL_NORMAL',
  unavailable: 'MODEL_UNAVAILABLE',
} as const satisfies Record<string, ShopeeModelStatus>;

/** One banned-item violation reason (`ReasonListBannedItemPush`, #363). */
export const shopeeViolationReasonWireSchema = z
  .object({
    days_to_fix: z.number().int().nullable().default(null),
    suggestion: z.string().nullable().default(null),
    violation_reason: z.string().nullable().default(null),
    violation_type: z.string().nullable().default(null),
  })
  .passthrough();
export type ShopeeViolationReasonWire = z.infer<typeof shopeeViolationReasonWireSchema>;

/** `produtos/{id}/prodshopee/{docId}` — the Shopee listing link doc. */
export const produtoShopeeLinkSchema = z
  .object({
    // Required account link — the `(contaProdutoShopeeOuterRef, sku)` lookup
    // key of the #363 notification processors (legacy required ctor param).
    // ⚠️ Neither schema in this file DECLARES `sku`, so that sentence names
    // half a key this repo cannot write typed; step 9's import writes no `sku`
    // on either link doc rather than persist an untyped one through
    // `.passthrough()`. Recorded as a follow-up, not fixed here.
    contaProdutoShopeeOuterRef: outerRefSchema,
    item_name: z.string().min(1),
    item_id: z.number().int().nullable().default(null),
    category_id: z.number().int().nullable().default(null),
    description: z.string().nullable().default(null),
    description_type: z.string().nullable().default(null),
    // Rich-description blob (paragraphs/images) — not fully enumerated by the audit.
    description_info: z.record(z.string(), z.unknown()).nullable().default(null),
    attributes: z.array(z.unknown()).nullable().default(null),
    complaint_policy: z.record(z.string(), z.unknown()).nullable().default(null),
    pre_order: z.record(z.string(), z.unknown()).nullable().default(null),
    item_status: shopeeItemStatusSchema.nullable().default(null),
    logistic_info: z.array(z.unknown()).nullable().default(null),
    wholesale: z.array(z.unknown()).nullable().default(null),
    brand_id: z.number().int().nullable().default(null),
    item_dangerous: z.number().int().nullable().default(null),
    /** Banned-item push reasons — Flutter writes this even when null (`errors`-style). */
    violations: z.array(shopeeViolationReasonWireSchema).nullable().default(null),
  })
  .passthrough();
export type ProdutoShopeeLink = z.infer<typeof produtoShopeeLinkSchema>;

/** `produtos/{childId}/variashopee/{docId}` — a variation link doc. */
export const variacaoShopeeLinkSchema = z
  .object({
    // Required links back to the owning account and the parent listing doc
    // (legacy required ctor params).
    contaVariacaoShopeeOuterRef: outerRefSchema,
    produtoShopeeOuterRef: outerRefSchema,
    model_id: z.number().int(),
    tier_index: z.array(z.number().int()).default([]),
    promotion_id: z.number().int().nullable().default(null),
    model_status: shopeeModelStatusSchema.nullable().default(null),
  })
  .passthrough();
export type VariacaoShopeeLink = z.infer<typeof variacaoShopeeLinkSchema>;
