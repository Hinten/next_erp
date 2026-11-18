import { criacaoKitShopeeMeta, criacaoKitShopeeSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin handle for the TOP-LEVEL `kitCriacaoShopee` lease (#1912) — the
 * single-flight of a native Shopee kit CREATE: `apps/shopee`'s
 * `kits/criacaoKitEmCurso.ts` takes it before any create arm reads the links,
 * stamps it right before `add_kit_item`, and deletes it once the run knows
 * what happened. Doc id = `idDaCriacaoDeKit(integracaoId, produtoId)`.
 *
 * ⚠️ MILLISECONDS everywhere. Every write is tier 0/1 of root rule 7 — a
 * `create()` that loses `ALREADY_EXISTS`, or an `update`/`delete` under the
 * `lastUpdateTime` of the read it was decided on — so there is no multi-document
 * atomic block to inventory. (Said without the API's identifier: the inventory
 * guard greps every source file for it.)
 *
 * Admin-only / default-deny (see `criacaoKitShopeeMeta` — the schema is not in
 * `ALL_DOMAINS`), so there is no client access and no generated rules block.
 * No TTL policy: a released lease is deleted, and at most ONE expired document
 * per (conta, kit produto) can remain, overwritten by the next takeover (the
 * `feedsAmazonEmCurso` precedent).
 */
export const kitCriacaoShopeeCollection = defineAdminCollection({
  path: criacaoKitShopeeMeta.collectionPath,
  schema: criacaoKitShopeeSchema,
});
