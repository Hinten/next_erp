import { z } from 'zod';
import { outerRefSchema } from '../../shared/outerRef';

/**
 * Typed write-side schemas for the Shopee listing link docs —
 * `produtos/{id}/prodshopee/{docId}` and
 * `produtos/{id}/variashopee/{docId}` — in the EXACT old Flutter wire shape
 * (`ProdutoShopee` / `VariacaoShopee`, shopee `models.dart`): dual-run
 * coexistence means the Flutter app keeps reading the docs the new app
 * writes.
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
 *  - `item_status` (`NORMAL`/`UNLIST`) and `violations` are the banned-item
 *    push outcome (`processarPushShopee` code 6 → `item_status: 'UNLIST'`,
 *    `violations: reason_list`), not something the create/update flow itself
 *    writes on a normal publish;
 *  - most nested blobs (`description_info`, `logistic_info`, `wholesale`,
 *    `complaint_policy`, `attributes`) are raw Shopee API pass-through JSON
 *    the audit didn't fully enumerate field-by-field — kept loosely typed
 *    here on purpose (wire tolerance over strictness);
 *  - `violations` items mirror the banned-item push payload's
 *    `ReasonListBannedItemPush` shape (`days_to_fix`, `suggestion`,
 *    `violation_reason`, `violation_type`).
 */

/** Shopee `item_status` (models.dart) — set by the banned-item push handler. */
export const shopeeItemStatusSchema = z.enum(['NORMAL', 'UNLIST']);
export type ShopeeItemStatus = z.infer<typeof shopeeItemStatusSchema>;

/** Named members of {@link shopeeItemStatusSchema} — the Shopee wire codes. */
export const SHOPEE_ITEM_STATUS = {
  normal: 'NORMAL',
  unlist: 'UNLIST',
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
