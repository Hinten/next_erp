import { z } from 'zod';
import { outerRefSchema } from '../../shared/outerRef';

/**
 * Typed write-side schema for the Magalu listing link doc —
 * `produtos/{id}/produtoMagalu2/{docId}` — in the EXACT old Flutter wire
 * shape (`ProdutoMagalu`, magalu_open_api `models.dart`): the migrated corpus
 * is stored in exactly this shape, so it has to be read and written that
 * way.
 *
 * This is deliberately NOT a DomainSchema and NOT in `ALL_DOMAINS`: the loose
 * pass-through subcollection domain in `subcollections.ts` (leaf name
 * `produtoMagalu2` — verified against the compiled `models.odm.g.dart`, #289)
 * already covers the Firestore rules (client reads, parent produto
 * permissions); this typed shape exists for the Admin-SDK writer (the future
 * apps/magalu publish flow + `portfolios_sku` notification processor, #363),
 * which bypasses rules but must not drift from the Flutter wire format.
 *
 * Wire notes (from the parity audit, #289 + #363):
 *  - `status` is the raw `StatusProdutoMagalu.fromJson` code from the
 *    `portfolios_sku` webhook (`updateSku`); a `null` inbound status falls
 *    back to `published` in the legacy handler, but the field itself stays
 *    nullable here since Flutter also writes it null on creation;
 *  - Magalu listings have no parent produto on the channel side — `groupId`
 *    substitutes;
 *  - `attributes` / `datasheet` / `extra_data` are generic `Attribute[]`
 *    pass-through blobs the audit didn't fully enumerate — kept loosely
 *    typed here on purpose (wire tolerance over strictness).
 */

/** `StatusProdutoMagalu` — the 13 wire codes (#363). */
export const statusProdutoMagaluSchema = z.enum([
  'new',
  'policies_approved',
  'policies_blocked',
  'policies_blocked_price',
  'policies_info',
  'policies_warn',
  'promotion_finished',
  'promotion_started',
  'published',
  'publishing_error',
  'unpublished',
  'inactivated',
  'enviado_arakene',
]);
export type StatusProdutoMagalu = z.infer<typeof statusProdutoMagaluSchema>;

/** Named members of {@link statusProdutoMagaluSchema} — camelCase of each wire code. */
export const STATUS_PRODUTO_MAGALU = {
  new: 'new',
  policiesApproved: 'policies_approved',
  policiesBlocked: 'policies_blocked',
  policiesBlockedPrice: 'policies_blocked_price',
  policiesInfo: 'policies_info',
  policiesWarn: 'policies_warn',
  promotionFinished: 'promotion_finished',
  promotionStarted: 'promotion_started',
  published: 'published',
  publishingError: 'publishing_error',
  unpublished: 'unpublished',
  inactivated: 'inactivated',
  enviadoArakene: 'enviado_arakene',
} as const satisfies Record<string, StatusProdutoMagalu>;

/** `produtos/{id}/produtoMagalu2/{docId}` — the Magalu listing link doc. */
export const produtoMagaluLinkSchema = z
  .object({
    // Required account link — the `(contaMagaluOuterRef, sku)` lookup key of
    // the #363 updateSku flow (legacy required ctor param).
    contaMagaluOuterRef: outerRefSchema,
    status: statusProdutoMagaluSchema.nullable().default(null),
    groupId: z.string().nullable().default(null),
    sku: z.string().nullable().default(null),
    // Legacy `final String title` is required/non-nullable. ⚠️ The stated reason
    // — a null crashing the legacy reader's `json['title'] as String` — is void
    // (no dual run, root `CLAUDE.md` rule 8). Kept: Magalu itself rejects a
    // titleless product, and relaxing a `.min()` on a collection field changes
    // read behaviour, so it is not a drive-by edit.
    title: z.string().min(1),
    type: z.string().default('product'),
    description: z.string().nullable().default(null),
    attributes: z.array(z.record(z.string(), z.unknown())).nullable().default(null),
    datasheet: z.array(z.record(z.string(), z.unknown())).nullable().default(null),
    extra_data: z.array(z.record(z.string(), z.unknown())).nullable().default(null),
  })
  .passthrough();
export type ProdutoMagaluLink = z.infer<typeof produtoMagaluLinkSchema>;
