import { z } from 'zod';
import { outerRefSchema } from '../../shared/outerRef';

/**
 * Typed write-side schema for the Magalu listing link doc —
 * `produtos/{id}/produtoMagalu2/{docId}` — in the EXACT old Flutter wire
 * shape (`ProdutoMagalu`, magalu_open_api `models.dart`): dual-run
 * coexistence means the Flutter app keeps reading the docs the new app
 * writes.
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

/** `produtos/{id}/produtoMagalu2/{docId}` — the Magalu listing link doc. */
export const produtoMagaluLinkSchema = z
  .object({
    // Required account link — the `(contaMagaluOuterRef, sku)` lookup key of
    // the #363 updateSku flow (legacy required ctor param).
    contaMagaluOuterRef: outerRefSchema,
    status: statusProdutoMagaluSchema.nullable().default(null),
    groupId: z.string().nullable().default(null),
    sku: z.string().nullable().default(null),
    // Legacy `final String title` is required/non-nullable — the Flutter
    // reader does `json['title'] as String` with no null guard; a null here
    // crashes the still-running app during dual-run.
    title: z.string().min(1),
    type: z.string().default('product'),
    description: z.string().nullable().default(null),
    attributes: z.array(z.record(z.string(), z.unknown())).nullable().default(null),
    datasheet: z.array(z.record(z.string(), z.unknown())).nullable().default(null),
    extra_data: z.array(z.record(z.string(), z.unknown())).nullable().default(null),
  })
  .passthrough();
export type ProdutoMagaluLink = z.infer<typeof produtoMagaluLinkSchema>;
